import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from './db.js';
import { buildAnalyticsFilter, getReportData, ReportPeriodError, validateDateRange } from './analytics.js';
import { DAY_MS } from './dates.js';

const WORKSPACE_MARKER = 'execubrief-organization-workspace-v1';
const ORG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const iso = (value) => value ? String(value).slice(0, 10) : null;
const number = (value) => Number(value ?? 0);
const round2 = (value) => Math.round((number(value) + Number.EPSILON) * 100) / 100;

export class WorkspaceError extends Error {
  constructor(message, status = 400, code = 'WORKSPACE_ERROR') {
    super(message);
    this.name = 'WorkspaceError';
    this.status = status;
    this.code = code;
  }
}

function inDirectory(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function validateOrganizationId(organizationId) {
  if (typeof organizationId !== 'string' || !ORG_ID_PATTERN.test(organizationId)) {
    throw new WorkspaceError('Your organisation workspace could not be identified. Sign out and sign in again.', 403, 'ORGANIZATION_REQUIRED');
  }
}

function workspaceFile(customDataDir, organizationId) {
  validateOrganizationId(organizationId);
  return path.resolve(customDataDir, organizationId, 'workspace.sqlite');
}

function verifyExistingWorkspace(databasePath, organizationId) {
  const probe = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tableExists = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_metadata'").get();
    if (!tableExists) throw new WorkspaceError('An existing file occupies this workspace path but is not a marked ExecuBrief workspace. No data was changed; choose a different CUSTOM_DATA_DIR or review the file.', 409, 'WORKSPACE_PATH_COLLISION');
    const marker = probe.prepare("SELECT value FROM workspace_metadata WHERE key = 'kind'").get();
    const orgMarker = probe.prepare("SELECT value FROM workspace_metadata WHERE key = 'organization_id'").get();
    if (marker?.value !== WORKSPACE_MARKER || orgMarker?.value !== organizationId) {
      throw new WorkspaceError('The workspace database marker did not match this organisation. Access was refused to protect existing data.', 409, 'WORKSPACE_MARKER_MISMATCH');
    }
  } finally { probe.close(); }
}

export async function openOrganizationWorkspace(customDataDir, organizationId) {
  validateOrganizationId(organizationId);
  const root = path.resolve(customDataDir);
  const organizationRoot = path.join(root, organizationId);
  const databasePath = workspaceFile(root, organizationId);
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await fs.promises.realpath(root);
  await fs.promises.mkdir(organizationRoot, { recursive: true, mode: 0o700 });
  const realOrganizationRoot = await fs.promises.realpath(organizationRoot);
  if (!inDirectory(realRoot, realOrganizationRoot)) {
    throw new WorkspaceError('The organisation workspace resolves outside the configured private data directory.', 500, 'WORKSPACE_PATH_UNSAFE');
  }
  if (fs.existsSync(databasePath)) {
    const fileStat = await fs.promises.lstat(databasePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.nlink > 1) {
      throw new WorkspaceError('The workspace database path is a link or non-regular file. Access was refused to protect private data.', 409, 'WORKSPACE_PATH_COLLISION');
    }
    const realDatabasePath = await fs.promises.realpath(databasePath);
    if (!inDirectory(realOrganizationRoot, realDatabasePath)) {
      throw new WorkspaceError('The workspace database resolves outside its organisation directory. Access was refused.', 409, 'WORKSPACE_PATH_UNSAFE');
    }
    verifyExistingWorkspace(databasePath, organizationId);
  }

  const database = createDatabase(databasePath);
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS workspace_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO workspace_metadata(key, value) VALUES ('kind', '${WORKSPACE_MARKER}');
      CREATE INDEX IF NOT EXISTS idx_import_batches_hash ON import_batches(file_sha256);
    `);
    const existingOrg = database.prepare("SELECT value FROM workspace_metadata WHERE key = 'organization_id'").get();
    if (existingOrg && existingOrg.value !== organizationId) {
      throw new WorkspaceError('The workspace database belongs to another organisation. Access was refused.', 409, 'WORKSPACE_MARKER_MISMATCH');
    }
    database.prepare("INSERT OR IGNORE INTO workspace_metadata(key,value) VALUES ('organization_id', ?)").run(organizationId);
    return { database, organizationRoot: realOrganizationRoot, databasePath };
  } catch (error) {
    try { database.close(); } catch { /* no-op */ }
    throw error;
  }
}

export function closeOrganizationWorkspace(workspace) {
  try { workspace?.database?.close(); } catch { /* already closed */ }
}

export function getWorkspaceCurrency(database) {
  return database.prepare("SELECT value FROM workspace_metadata WHERE key = 'report_currency'").get()?.value || null;
}

export function setWorkspaceCurrency(database, currency) {
  database.prepare("INSERT INTO workspace_metadata(key,value) VALUES ('report_currency', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(currency);
}

export function getWorkspaceDateRange(database) {
  const row = database.prepare(`SELECT MIN(DATE(created_at)) AS min_date, MAX(DATE(created_at)) AS max_date, COUNT(*) AS line_items,
    COUNT(DISTINCT COALESCE(order_id, 'LEGACY-' || id)) AS orders FROM orders`).get();
  if (!row || !row.line_items || !row.min_date || !row.max_date) {
    return { hasData: false, availablePeriod: null, lineItems: 0, orders: 0 };
  }
  return {
    hasData: true,
    availablePeriod: { startDate: iso(row.min_date), endDate: iso(row.max_date) },
    lineItems: number(row.line_items),
    orders: number(row.orders),
  };
}

export function resolveWorkspacePeriod(database, requestedStart, requestedEnd, { defaultDays = 30 } = {}) {
  const range = getWorkspaceDateRange(database);
  if (!range.hasData) return { range, period: null };
  if ((requestedStart && !requestedEnd) || (!requestedStart && requestedEnd)) {
    throw new ReportPeriodError('Provide both a start date and an end date. Available dates are shown above the date controls.');
  }
  let period;
  if (requestedStart && requestedEnd) period = { startDate: requestedStart, endDate: requestedEnd };
  else {
    const maxMs = Date.parse(`${range.availablePeriod.endDate}T00:00:00.000Z`);
    const minMs = Date.parse(`${range.availablePeriod.startDate}T00:00:00.000Z`);
    const candidateStart = new Date(maxMs - (defaultDays - 1) * DAY_MS).toISOString().slice(0, 10);
    period = {
      startDate: minMs > Date.parse(`${candidateStart}T00:00:00.000Z`) ? range.availablePeriod.startDate : candidateStart,
      endDate: range.availablePeriod.endDate,
    };
  }
  validateDateRange(period.startDate, period.endDate);
  if (period.startDate < range.availablePeriod.startDate || period.endDate > range.availablePeriod.endDate) {
    throw new ReportPeriodError(`Choose dates within the imported data range (${range.availablePeriod.startDate} to ${range.availablePeriod.endDate}).`);
  }
  return { range, period };
}

function comparisonPercent(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null;
  return Number((((current - previous) / Math.abs(previous)) * 100).toFixed(1));
}

function queryProfitAndCustomers(database, startDate, endDate, filterSpec) {
  return database.prepare(`
    SELECT
      COUNT(*) AS total_rows,
      COUNT(DISTINCT CASE WHEN customer IS NOT NULL AND TRIM(customer) <> '' AND LOWER(TRIM(customer)) <> 'not provided' THEN customer END) AS customers,
      SUM(gross_profit) AS gross_profit,
      COUNT(gross_profit) AS gross_profit_rows,
      SUM(quantity) AS units,
      COUNT(quantity) AS quantity_rows,
      SUM(cost) AS cost,
      COUNT(cost) AS cost_rows
    FROM orders WHERE DATE(created_at) BETWEEN ? AND ?${filterSpec.sql}
  `).get(startDate, endDate, ...filterSpec.params);
}

function aggregateDimension(database, column, startDate, endDate, filterSpec) {
  const allowed = new Set(['region', 'sales_channel', 'business_unit', 'customer_segment', 'country']);
  if (!allowed.has(column)) return [];
  return database.prepare(`SELECT ${column} AS label, ROUND(SUM(amount),2) AS revenue, COUNT(DISTINCT order_id) AS orders
    FROM orders WHERE DATE(created_at) BETWEEN ? AND ?${filterSpec.sql} AND ${column} IS NOT NULL AND TRIM(${column}) <> ''
    GROUP BY ${column} ORDER BY revenue DESC, label ASC LIMIT 8`).all(startDate, endDate, ...filterSpec.params)
    .map((row) => ({ label: row.label, revenue: number(row.revenue), orders: number(row.orders) }));
}


function getOrganizationFilterOptions(database) {
  const categories = database.prepare(`SELECT DISTINCT COALESCE(NULLIF(TRIM(category), ''), product) AS value
    FROM orders WHERE COALESCE(NULLIF(TRIM(category), ''), product) IS NOT NULL
      AND TRIM(COALESCE(NULLIF(TRIM(category), ''), product)) <> ''
    ORDER BY value COLLATE NOCASE LIMIT 100`).all().map((row) => row.value);
  const regions = database.prepare(`SELECT DISTINCT TRIM(region) AS value
    FROM orders WHERE region IS NOT NULL AND TRIM(region) <> ''
    ORDER BY value COLLATE NOCASE LIMIT 100`).all().map((row) => row.value);
  return { categories, regions };
}

function getImportHealth(database) {
  const summary = database.prepare(`SELECT
    COUNT(*) AS attempts,
    SUM(CASE WHEN status IN ('completed','partial') AND rows_imported > 0 THEN 1 ELSE 0 END) AS successful_files,
    COALESCE(SUM(CASE WHEN status IN ('completed','partial') THEN rows_imported ELSE 0 END),0) AS rows_imported,
    COALESCE(SUM(duplicates_skipped),0) AS duplicates_skipped,
    COALESCE(SUM(invalid_rows),0) AS invalid_rows,
    MAX(imported_at) AS latest_import_at
    FROM import_batches`).get();
  return {
    attempts: number(summary.attempts),
    successfulFiles: number(summary.successful_files),
    rowsImported: number(summary.rows_imported),
    duplicatesSkipped: number(summary.duplicates_skipped),
    invalidRows: number(summary.invalid_rows),
    latestImportAt: summary.latest_import_at || null,
  };
}

export function listWorkspaceImports(database, limit = 25) {
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 25));
  return database.prepare(`SELECT id, source_file AS sourceFile, file_sha256 AS fileHash,
    rows_received AS rowsReceived, rows_imported AS rowsImported, rows_skipped AS rowsSkipped,
    duplicates_skipped AS duplicatesSkipped, invalid_rows AS invalidRows, status,
    min_date AS minDate, max_date AS maxDate, imported_at AS importedAt, error
    FROM import_batches ORDER BY imported_at DESC, id DESC LIMIT ?`).all(safeLimit);
}

export function getOrganizationAnalytics({ database, organization, startDate, endDate, currency, filters = {} } = {}) {
  const filterSpec = buildAnalyticsFilter(filters);
  const { range, period } = resolveWorkspacePeriod(database, startDate, endDate);
  const filterOptions = getOrganizationFilterOptions(database);
  const workspaceCurrency = currency || getWorkspaceCurrency(database) || 'USD';
  const importHealth = getImportHealth(database);
  if (!range.hasData) {
    return {
      organization: { id: organization?.id, name: organization?.name || 'Your organisation' },
      hasData: false, availablePeriod: null, selectedPeriod: null, currency: workspaceCurrency,
      summary: { totalRevenue: 0, totalOrders: 0, averageOrderValue: 0, customerCount: null, grossProfit: null, grossMarginPercent: null, totalUnits: null },
      previousSummary: null, dailyTrend: [], topProducts: [], categoryRevenue: [], regions: [], channels: [], businessSignals: [], importHealth,
      filterOptions, filters: { category: filterSpec.category || null, region: filterSpec.region || null },
    };
  }

  const data = getReportData({ database, startDate: period.startDate, endDate: period.endDate, filters: filterSpec });
  const currentMetrics = queryProfitAndCustomers(database, period.startDate, period.endDate, filterSpec);
  const previousMetrics = queryProfitAndCustomers(database, data.previousSummary.startDate, data.previousSummary.endDate, filterSpec);
  const customersAvailable = number(currentMetrics.customers) > 0;
  const profitAvailable = number(currentMetrics.total_rows) > 0 && number(currentMetrics.gross_profit_rows) === number(currentMetrics.total_rows);
  const revenue = number(data.summary.totalRevenue);
  const grossProfit = profitAvailable ? round2(currentMetrics.gross_profit) : null;
  const grossMarginPercent = profitAvailable && revenue !== 0 ? Number((grossProfit / revenue * 100).toFixed(1)) : null;
  const enrichedSummary = {
    ...data.summary,
    customerCount: customersAvailable ? number(currentMetrics.customers) : null,
    grossProfit,
    grossMarginPercent,
    grossProfitChangePercent: profitAvailable && number(previousMetrics.total_rows) > 0 && number(previousMetrics.gross_profit_rows) === number(previousMetrics.total_rows)
      ? comparisonPercent(grossProfit, round2(previousMetrics.gross_profit)) : null,
    totalUnits: number(currentMetrics.quantity_rows) > 0 ? round2(currentMetrics.units) : null,
  };
  const topRegions = aggregateDimension(database, 'region', period.startDate, period.endDate, filterSpec);
  const channels = aggregateDimension(database, 'sales_channel', period.startDate, period.endDate, filterSpec);
  const signals = [];
  if (data.summary.revenueChangePercent !== null) {
    const direction = data.summary.revenueChangePercent > 0 ? 'increased' : data.summary.revenueChangePercent < 0 ? 'decreased' : 'was unchanged';
    signals.push({ kind: data.summary.revenueChangePercent > 0 ? 'positive' : data.summary.revenueChangePercent < 0 ? 'negative' : 'neutral',
      title: `Revenue ${direction} ${Math.abs(data.summary.revenueChangePercent)}%`,
      detail: `Compared with ${data.previousSummary.startDate} to ${data.previousSummary.endDate}.`,
      metric: `${workspaceCurrency} ${number(data.summary.totalRevenue).toLocaleString('en-US', { maximumFractionDigits: 2 })}` });
  } else {
    signals.push({ kind: 'neutral', title: 'Comparison baseline unavailable', detail: 'A percentage change needs a previous period with non-zero revenue.', metric: `${workspaceCurrency} ${number(data.summary.totalRevenue).toLocaleString('en-US', { maximumFractionDigits: 2 })}` });
  }
  const leadingCategory = data.categoryRevenue?.[0];
  if (leadingCategory && revenue > 0) {
    const share = Number((leadingCategory.revenue / revenue * 100).toFixed(1));
    signals.push({ kind: 'insight', title: `${leadingCategory.category} leads category revenue`, detail: 'Share is calculated against total revenue for the selected period.', metric: `${share}% of revenue` });
  }
  const leadingRegion = topRegions[0];
  if (leadingRegion && revenue > 0) {
    signals.push({ kind: 'insight', title: `${leadingRegion.label} is the leading region`, detail: 'Ranked by imported line-item revenue for the selected period.', metric: `${workspaceCurrency} ${leadingRegion.revenue.toLocaleString('en-US', { maximumFractionDigits: 2 })}` });
  }

  return {
    ...data,
    organization: { id: organization?.id, name: organization?.name || 'Your organisation' },
    hasData: true,
    availablePeriod: range.availablePeriod,
    selectedPeriod: period,
    currency: workspaceCurrency,
    summary: enrichedSummary,
    metadata: { ...data.metadata, companyName: organization?.name || 'Your organisation', currency: workspaceCurrency },
    regions: topRegions,
    channels,
    filterOptions,
    filters: { category: filterSpec.category || null, region: filterSpec.region || null },
    businessSignals: signals,
    importHealth,
  };
}

export function getWorkspaceOverview(database, { organization, currency } = {}) {
  return getOrganizationAnalytics({ database, organization, currency });
}

export function insertWorkspaceImport(database, { sourceFile, fileHash, mapping, mapped, currency, csvText, now = new Date() }) {
  const importedAt = now.toISOString();
  const existingCurrency = getWorkspaceCurrency(database);
  const databaseHasRows = Number(database.prepare('SELECT COUNT(*) AS n FROM orders').get().n) > 0;
  if (existingCurrency && existingCurrency !== currency && databaseHasRows) {
    throw new WorkspaceError(`This workspace reports in ${existingCurrency}. The selected import currency is ${currency}; no currency conversion is performed. Convert the source data before importing it.`, 409, 'CURRENCY_MISMATCH');
  }
  const presentCurrencies = [...new Set(mapped.orders.map((order) => order.currency).filter(Boolean))];
  if (presentCurrencies.some((value) => value !== currency)) {
    throw new WorkspaceError(`The CSV contains ${presentCurrencies.join(', ')} but the selected workspace currency is ${currency}. No foreign-exchange conversion is performed.`, 400, 'CSV_CURRENCY_MISMATCH');
  }
  const mappingJson = JSON.stringify(mapping);
  const previous = database.prepare(`SELECT id, source_file AS sourceFile, rows_imported AS rowsImported, rows_received AS rowsReceived,
    duplicates_skipped AS duplicatesSkipped, invalid_rows AS invalidRows, min_date AS minDate, max_date AS maxDate,
    imported_at AS importedAt, status FROM import_batches
    WHERE file_sha256 = ? AND mapping_json = ? AND status IN ('completed','partial') AND rows_imported > 0
    ORDER BY id DESC LIMIT 1`).get(fileHash, mappingJson);
  if (previous) {
    const duplicateResult = database.prepare(`INSERT INTO import_batches
      (source_file,file_sha256,rows_imported,rows_skipped,imported_at,status,rows_received,duplicates_skipped,invalid_rows,min_date,max_date,error,mapping_json)
      VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sourceFile, fileHash, mapped.rowsReceived, importedAt, 'duplicate', mapped.rowsReceived,
        mapped.rowsReceived, 0, previous.minDate, previous.maxDate,
        'This exact file and column mapping were already imported. No rows were added.', mappingJson);
    return { duplicateFile: true, batchId: Number(duplicateResult.lastInsertRowid), sourceFile,
      rowsReceived: mapped.rowsReceived, rowsImported: 0, duplicatesSkipped: mapped.rowsReceived, invalidRows: 0,
      minDate: previous.minDate, maxDate: previous.maxDate, importedAt, status: 'duplicate', error: 'This exact file and column mapping were already imported. No rows were added.' };
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    const batchInsert = database.prepare(`INSERT INTO import_batches
      (source_file,file_sha256,rows_imported,rows_skipped,imported_at,status,rows_received,duplicates_skipped,invalid_rows,min_date,max_date,error,mapping_json)
      VALUES (?,?,0,0,?,'pending',?,?,?, ?,?,?,?)`);
    batchInsert.run(sourceFile, fileHash, importedAt, mapped.rowsReceived, mapped.duplicateRows.length, mapped.invalidRows.length,
      mapped.minDate, mapped.maxDate, null, mappingJson);
    const batchId = Number(database.prepare('SELECT last_insert_rowid() AS id').get().id);
    const insert = database.prepare(`INSERT OR IGNORE INTO orders
      (order_id,line_item_id,customer,product,amount,created_at,category,import_batch_id,region,country,business_unit,sales_channel,
       customer_segment,quantity,unit_price,discount_percent,cost,gross_profit,gross_margin_percent,source_currency,sales_rep,payment_status,fulfillment_status,source_system)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let rowsImported = 0;
    let duplicatesSkipped = mapped.duplicateRows.length;
    for (const order of mapped.orders) {
      const result = insert.run(
        order.orderId, order.lineItemId, order.customer || 'Not provided', order.product, order.amount,
        `${order.createdAt}T12:00:00.000Z`, order.category, batchId, order.region, order.country, order.businessUnit,
        order.salesChannel, order.customerSegment, order.quantity, order.unitPrice, order.discountPercent, order.cost,
        order.grossProfit, order.grossMarginPercent, order.currency || currency, order.salesRep, order.paymentStatus,
        order.fulfillmentStatus, order.sourceSystem,
      );
      if (Number(result.changes) > 0) rowsImported += 1;
      else duplicatesSkipped += 1;
    }
    const status = rowsImported === 0 ? 'duplicate' : (mapped.invalidRows.length ? 'partial' : 'completed');
    const skipped = duplicatesSkipped + mapped.invalidRows.length;
    const error = mapped.invalidRows.length
      ? `${mapped.invalidRows.length} invalid row(s) were skipped; first issue: ${mapped.invalidRows[0].reason.slice(0, 240)}`
      : (rowsImported === 0 ? 'All rows were duplicates; no new records were added.' : null);
    database.prepare(`UPDATE import_batches SET rows_imported=?,rows_skipped=?,duplicates_skipped=?,invalid_rows=?,status=?,error=? WHERE id=?`)
      .run(rowsImported, skipped, duplicatesSkipped, mapped.invalidRows.length, status, error, batchId);
    database.exec('COMMIT');
    if (!existingCurrency) setWorkspaceCurrency(database, currency);
    return {
      batchId, sourceFile, fileHash, rowsReceived: mapped.rowsReceived, rowsImported, rowsSkipped: skipped,
      duplicatesSkipped, invalidRows: mapped.invalidRows.length, invalidRowDetails: mapped.invalidRows.slice(0, 10),
      minDate: mapped.minDate, maxDate: mapped.maxDate, importedAt, status, error,
      workspaceCurrency: existingCurrency || currency,
    };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* rollback can fail if SQLite already ended the transaction */ }
    throw error;
  }
}

export function recordFailedWorkspaceImport(database, { sourceFile, fileHash, mapping = null, rowsReceived = 0, invalidRows = 1, minDate = null, maxDate = null, error, now = new Date() }) {
  const importedAt = now.toISOString();
  const mappingJson = mapping ? JSON.stringify(mapping) : null;
  const result = database.prepare(`INSERT INTO import_batches
    (source_file,file_sha256,rows_imported,rows_skipped,imported_at,status,rows_received,duplicates_skipped,invalid_rows,min_date,max_date,error,mapping_json)
    VALUES (?, ?, 0, ?, ?, 'failed', ?, 0, ?, ?, ?, ?, ?)`).run(
      sourceFile, fileHash, rowsReceived, importedAt, rowsReceived, invalidRows, minDate, maxDate,
      String(error || 'Import validation failed.').slice(0, 500), mappingJson,
    );
  return { batchId: Number(result.lastInsertRowid), sourceFile, status: 'failed', rowsReceived, rowsImported: 0,
    duplicatesSkipped: 0, invalidRows, minDate, maxDate, importedAt, error: String(error || 'Import validation failed.').slice(0, 500) };
}
