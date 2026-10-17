import { createDatabase } from './db.js';
import { mapCustomCsv, CustomCsvError } from './custom-csv.js';
import { setWorkspaceCurrency } from './organization-workspace.js';

export const FREE_MAX_IMPORT_FILES_PER_ORGANIZATION = 20;
export const FREE_MAX_SOURCE_ROWS_PER_ORGANIZATION = 50_000;
const ORDER_COLUMNS = `order_id,line_item_id,customer,product,amount,created_at,category,region,country,business_unit,sales_channel,
  customer_segment,quantity,unit_price,discount_percent,cost,gross_profit,gross_margin_percent,source_currency,sales_rep,
  payment_status,fulfillment_status,source_system`;
const ORDER_VALUES = `(${Array.from({ length: 23 }, () => '?').join(',')})`;

function mappingFrom(row) {
  if (row.mappingJson && typeof row.mappingJson === 'object') return row.mappingJson;
  try { return JSON.parse(String(row.mappingJson || '{}')); } catch { return {}; }
}

function insertOrder(statement, order, currency) {
  return statement.run(
    order.orderId, order.lineItemId, order.customer || 'Not provided', order.product, order.amount,
    `${order.createdAt}T12:00:00.000Z`, order.category, order.region, order.country, order.businessUnit,
    order.salesChannel, order.customerSegment, order.quantity, order.unitPrice, order.discountPercent,
    order.cost, order.grossProfit, order.grossMarginPercent, order.currency || currency, order.salesRep,
    order.paymentStatus, order.fulfillmentStatus, order.sourceSystem,
  );
}

/**
 * Rehydrates one organisation's analytics database from private CSV objects on demand.
 * The free web host has an ephemeral filesystem; CSV originals and reports stay in
 * Supabase Storage, while this SQLite database exists only in memory for one request.
 */
export async function buildWorkspaceDatabase(store, organization, { maxFiles = FREE_MAX_IMPORT_FILES_PER_ORGANIZATION,
  maxRows = FREE_MAX_SOURCE_ROWS_PER_ORGANIZATION, imports: suppliedImports } = {}) {
  const organizationId = organization?.id;
  if (typeof organizationId !== 'string' || !organizationId) throw new Error('An organisation is required to build its workspace.');
  const imports = suppliedImports ?? await store.listImports(organizationId, maxFiles + 1);
  if (imports.length > maxFiles) throw new Error(`The free demo supports at most ${maxFiles} CSV files per organisation. Remove older demonstration imports or upgrade the storage design before larger workloads.`);
  const sourceRows = imports.reduce((total, item) => total + Number(item.rowsReceived || 0), 0);
  if (sourceRows > maxRows) throw new Error(`The free demo supports at most ${maxRows.toLocaleString()} source rows per organisation to keep analytics and PDF rendering within free hosting limits.`);

  const database = createDatabase(':memory:');
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS workspace_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    database.prepare("INSERT OR REPLACE INTO workspace_metadata(key,value) VALUES ('kind','execubrief-cloud-rehydrated-v1')").run();
    database.prepare("INSERT OR REPLACE INTO workspace_metadata(key,value) VALUES ('organization_id',?)").run(organizationId);
    if (organization.report_currency) setWorkspaceCurrency(database, organization.report_currency);
    const insert = database.prepare(`INSERT OR IGNORE INTO orders (${ORDER_COLUMNS}) VALUES ${ORDER_VALUES}`);
    const batchInsert = database.prepare(`INSERT INTO import_batches
      (source_file,file_sha256,rows_imported,rows_skipped,imported_at,status,rows_received,duplicates_skipped,invalid_rows,
       min_date,max_date,error,mapping_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    for (const item of [...imports].reverse()) {
      const fileBytes = await store.downloadObject(item.storagePath);
      const csvText = Buffer.from(fileBytes).toString('utf8');
      const mapping = mappingFrom(item);
      const mapped = mapCustomCsv(csvText, mapping, {
        maxRows: maxRows,
        uploadId: item.fileHash.slice(0, 24),
        skipInvalidRows: true,
        skipDuplicateLineItems: true,
      });
      let crossFileDuplicates = 0;
      for (const order of mapped.orders) {
        const result = insertOrder(insert, order, item.currency);
        if (Number(result.changes) === 0) crossFileDuplicates += 1;
      }
      const invalidRows = Number(item.invalidRows || mapped.invalidRows.length);
      const duplicateCount = Number(item.duplicatesSkipped || mapped.duplicateRows.length) + crossFileDuplicates;
      const importedAt = item.importedAt || new Date().toISOString();
      batchInsert.run(
        item.sourceFile, item.fileHash, Math.max(0, mapped.rowCount - crossFileDuplicates),
        invalidRows + duplicateCount, importedAt,
        (invalidRows || duplicateCount) ? 'partial' : 'completed', mapped.rowsReceived,
        duplicateCount, invalidRows, mapped.minDate, mapped.maxDate, item.error || null,
        JSON.stringify(mapping),
      );
    }
    if (!organization.report_currency && imports[0]?.currency) setWorkspaceCurrency(database, imports[0].currency);
    return { database, imports, rowCount: Number(database.prepare('SELECT COUNT(*) AS n FROM orders').get().n) };
  } catch (error) {
    try { database.close(); } catch { /* closed while unwinding */ }
    throw error;
  }
}

export function addCsvOrdersToDatabase(database, mapped, currency) {
  const insert = database.prepare(`INSERT OR IGNORE INTO orders (${ORDER_COLUMNS}) VALUES ${ORDER_VALUES}`);
  let inserted = 0;
  let duplicates = 0;
  const seen = new Set();
  for (const order of mapped.orders) {
    if (seen.has(order.lineItemId)) { duplicates += 1; continue; }
    seen.add(order.lineItemId);
    const result = insertOrder(insert, order, currency);
    if (Number(result.changes) > 0) inserted += 1;
    else duplicates += 1;
  }
  return { inserted, duplicates };
}

export function validateSingleCurrency(mapped, selectedCurrency) {
  const currencies = [...new Set(mapped.orders.map((order) => order.currency).filter(Boolean))];
  if (currencies.length > 1) throw new CustomCsvError(`This CSV contains multiple currencies (${currencies.join(', ')}). Split the file by currency; ExecuBrief does not convert currencies.`);
  if (currencies.length === 1 && currencies[0] !== selectedCurrency) {
    throw new CustomCsvError(`The CSV currency is ${currencies[0]}, but ${selectedCurrency} was selected. Choose ${currencies[0]}; ExecuBrief does not convert currencies.`);
  }
}


// Render Free has an ephemeral filesystem. Keep a very small, short-lived in-memory
// SQLite cache so the app does not re-download every CSV from Supabase on each chart
// filter or report request. Each cache entry is scoped to exactly one organization.
const workspaceCache = new Map();
const WORKSPACE_CACHE_TTL_MS = 5 * 60 * 1000;
const WORKSPACE_CACHE_MAX_ORGANIZATIONS = 2;

function importSignature(imports) {
  return JSON.stringify(imports.map((item) => [item.id, item.fileHash, item.storagePath, item.importedAt, item.status, item.currency]));
}

function validateWorkspaceSize(imports, maxFiles, maxRows) {
  if (imports.length > maxFiles) throw new Error(`The free demo supports at most ${maxFiles} CSV files per organisation.`);
  const sourceRows = imports.reduce((total, item) => total + Number(item.rowsReceived || 0), 0);
  if (sourceRows > maxRows) throw new Error(`The free demo supports at most ${maxRows.toLocaleString()} source rows per organisation.`);
}

function retireCacheEntry(entry) {
  entry.retired = true;
  if (entry.references === 0) {
    try { entry.database.close(); } catch { /* already closed */ }
  }
}

function releaseCacheEntry(entry) {
  entry.references = Math.max(0, entry.references - 1);
  if (entry.retired && entry.references === 0) {
    try { entry.database.close(); } catch { /* already closed */ }
  }
  evictWorkspaceCache();
}

function evictWorkspaceCache() {
  const entries = [...workspaceCache.entries()]
    .filter(([, entry]) => entry.references === 0)
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  while (workspaceCache.size > WORKSPACE_CACHE_MAX_ORGANIZATIONS && entries.length) {
    const [organizationId, entry] = entries.shift();
    if (workspaceCache.get(organizationId) !== entry) continue;
    workspaceCache.delete(organizationId);
    retireCacheEntry(entry);
  }
}

/** Acquire a short-lived, per-organization in-memory DB rebuilt from private CSV objects.
 * Call release() in a finally block. Imports invalidate the cache for that org.
 */
export async function acquireWorkspaceDatabase(store, organization, options = {}) {
  const organizationId = organization?.id;
  if (typeof organizationId !== 'string' || !organizationId) throw new Error('An organisation is required to build its workspace.');
  const maxFiles = options.maxFiles ?? FREE_MAX_IMPORT_FILES_PER_ORGANIZATION;
  const maxRows = options.maxRows ?? FREE_MAX_SOURCE_ROWS_PER_ORGANIZATION;
  const imports = await store.listImports(organizationId, maxFiles + 1);
  validateWorkspaceSize(imports, maxFiles, maxRows);
  const signature = importSignature(imports);
  const now = Date.now();
  let entry = workspaceCache.get(organizationId);
  if (entry && !entry.retired && entry.signature === signature && now - entry.createdAt < WORKSPACE_CACHE_TTL_MS) {
    entry.references += 1;
    entry.lastUsedAt = now;
    return { ...entry, release: () => releaseCacheEntry(entry) };
  }
  if (entry) {
    workspaceCache.delete(organizationId);
    retireCacheEntry(entry);
  }
  const built = await buildWorkspaceDatabase(store, organization, { ...options, maxFiles, maxRows, imports });
  entry = { ...built, signature, createdAt: now, lastUsedAt: now, references: 1, retired: false };
  workspaceCache.set(organizationId, entry);
  evictWorkspaceCache();
  return { ...entry, release: () => releaseCacheEntry(entry) };
}

export function invalidateWorkspaceDatabase(organizationId) {
  const entry = workspaceCache.get(organizationId);
  if (!entry) return;
  workspaceCache.delete(organizationId);
  retireCacheEntry(entry);
}

export function clearWorkspaceDatabaseCache() {
  for (const [organizationId, entry] of workspaceCache) {
    workspaceCache.delete(organizationId);
    retireCacheEntry(entry);
  }
}
