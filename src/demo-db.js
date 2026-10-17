import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { createDatabase } from './db.js';

const DEMO_MARKER = 'execubrief-synthetic-demo-v1';
const PRODUCTS = [
  { product: 'Mechanical Keyboard', category: 'Accessories', base: 129.99 },
  { product: 'Ultra-wide Monitor', category: 'Displays', base: 499.00 },
  { product: 'Wireless Mouse', category: 'Accessories', base: 49.99 },
  { product: 'USB-C Multi-Port Dock', category: 'Connectivity', base: 89.50 },
  { product: 'Noise-Cancelling Headphones', category: 'Audio', base: 219.00 },
  { product: 'Ergonomic Desk Mat', category: 'Workspace', base: 34.95 },
];
const CUSTOMERS = Array.from({ length: 10 }, (_, index) => `Demo Customer ${String(index + 1).padStart(2, '0')}`);
const LINES_PER_ORDER = [1, 2, 1, 3];
const TOTAL_LINE_ITEMS = 240;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let demoDatabase;
let initialized = false;

function resolveDemoPath(value, fallback) {
  const candidate = value && value.trim() ? value.trim() : fallback;
  return path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(config.projectRoot, candidate);
}

export function getDemoDatabasePath() {
  return resolveDemoPath(process.env.DEMO_DATABASE_PATH, path.join('demo-data', 'demo-report.db'));
}

export function getDemoReportsDir() {
  return resolveDemoPath(process.env.DEMO_REPORTS_DIR, path.join('demo-data', 'reports'));
}

function isWithinOrSame(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function pathsOverlap(first, second) {
  return isWithinOrSame(first, second) || isWithinOrSame(second, first);
}

function canonicalPath(target) {
  const absolute = path.resolve(target);
  let cursor = absolute;
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return absolute;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.resolve(fs.realpathSync(cursor), ...suffix);
}

function assertDemoStorageIsolated(databasePath, reportsDir) {
  const demoDb = canonicalPath(databasePath);
  const demoOutput = canonicalPath(reportsDir);
  const privateDb = canonicalPath(config.databasePath);
  const privateOutput = canonicalPath(config.reportsDir);

  if (demoDb === privateDb) {
    throw new Error('DEMO_DATABASE_PATH must be different from DATABASE_PATH. Public demo storage cannot use the private database.');
  }
  if (pathsOverlap(demoOutput, privateOutput)) {
    throw new Error('DEMO_REPORTS_DIR must be separate from REPORTS_DIR. Public demo files cannot share the private report directory.');
  }
  if (isWithinOrSame(privateOutput, demoDb)) {
    throw new Error('DEMO_DATABASE_PATH cannot be placed inside the private reports directory.');
  }
  if (isWithinOrSame(demoOutput, privateDb)) {
    throw new Error('DEMO_REPORTS_DIR cannot contain the private database path.');
  }
  if (isWithinOrSame(demoOutput, demoDb) || isWithinOrSame(demoDb, demoOutput)) {
    throw new Error('The demo database and demo report output directory must be separate paths.');
  }
}

function assertExistingDatabaseIsMarked(databasePath) {
  const probe = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'demo_metadata'").get();
    if (!table) {
      throw new Error('The configured demo database exists but is not marked as synthetic demo data. Refusing to expose it. Choose a new DEMO_DATABASE_PATH or review the file manually.');
    }
    const marker = probe.prepare("SELECT value FROM demo_metadata WHERE key = 'kind'").get();
    if (marker?.value !== DEMO_MARKER) {
      throw new Error('The configured demo database marker is invalid. Refusing to expose this database as public demo data.');
    }
  } finally {
    probe.close();
  }
}

function markDatabaseAsDemo(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS demo_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const existing = database.prepare("SELECT value FROM demo_metadata WHERE key = 'kind'").get();
  if (existing && existing.value !== DEMO_MARKER) {
    throw new Error('Demo database marker mismatch. Refusing to expose this database.');
  }
  database.prepare("INSERT OR IGNORE INTO demo_metadata (key, value) VALUES ('kind', ?)").run(DEMO_MARKER);
}

function seedSyntheticOrders(database) {
  const count = Number(database.prepare('SELECT COUNT(*) AS n FROM orders').get().n);
  if (count > 0) return;

  const today = new Date();
  const midnightUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const insert = database.prepare(`
    INSERT INTO orders (order_id, line_item_id, customer, product, amount, created_at, category)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  database.exec('BEGIN IMMEDIATE');
  try {
    let lineItem = 0;
    let orderIndex = 0;
    while (lineItem < TOTAL_LINE_ITEMS) {
      const orderNumber = orderIndex + 1;
      const daysAgo = (orderIndex * 11) % 120;
      const timestamp = new Date(midnightUtc - daysAgo * MS_PER_DAY + (orderIndex % 24) * 60 * 60 * 1000).toISOString();
      const lines = Math.min(LINES_PER_ORDER[orderIndex % LINES_PER_ORDER.length], TOTAL_LINE_ITEMS - lineItem);
      for (let line = 1; line <= lines; line += 1) {
        const product = PRODUCTS[(lineItem * 7 + 2) % PRODUCTS.length];
        const priceAdjustment = 0.8 + ((lineItem * 13) % 41) / 100;
        const amount = Number((product.base * priceAdjustment).toFixed(2));
        const orderId = `DEMO-O-${String(orderNumber).padStart(4, '0')}`;
        const lineId = `DEMO-L-${String(orderNumber).padStart(4, '0')}-${line}`;
        insert.run(orderId, lineId, CUSTOMERS[orderIndex % CUSTOMERS.length], product.product, amount, timestamp, product.category);
        lineItem += 1;
      }
      orderIndex += 1;
    }
    database.exec('COMMIT');
    console.log(`[Demo DB] Seeded ${TOTAL_LINE_ITEMS} synthetic line items across ${orderIndex} demo orders.`);
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function initializeDemoDatabase(database) {
  markDatabaseAsDemo(database);
  const columns = database.prepare('PRAGMA table_info(orders)').all().map((column) => column.name);
  if (!columns.includes('order_id') || !columns.includes('line_item_id')) {
    throw new Error('Demo database schema is missing order identifiers. Refusing to migrate an unknown database as demo data.');
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_demo_created_at ON orders(created_at);');
  seedSyntheticOrders(database);
  initialized = true;
}

export function getDemoDatabase() {
  if (!demoDatabase) {
    const databasePath = getDemoDatabasePath();
    const reportsDir = getDemoReportsDir();
    assertDemoStorageIsolated(databasePath, reportsDir);

    // Existing files must carry our explicit synthetic-data marker before createDatabase()
    // is allowed to perform any schema migrations or writes.
    if (fs.existsSync(databasePath)) assertExistingDatabaseIsMarked(databasePath);
    demoDatabase = createDatabase(databasePath);
    try {
      initializeDemoDatabase(demoDatabase);
    } catch (error) {
      try { demoDatabase.close(); } catch { /* ignore a close error while failing closed */ }
      demoDatabase = undefined;
      initialized = false;
      throw error;
    }
  } else if (!initialized) {
    initializeDemoDatabase(demoDatabase);
  }
  return demoDatabase;
}

export function createDemoDatabase() {
  const databasePath = getDemoDatabasePath();
  const reportsDir = getDemoReportsDir();
  assertDemoStorageIsolated(databasePath, reportsDir);
  const database = getDemoDatabase();
  fs.mkdirSync(reportsDir, { recursive: true });
  return { database, databasePath, reportsDir };
}

export function closeDemoDatabase() {
  if (demoDatabase) {
    try { demoDatabase.close(); } catch { /* already closed */ }
  }
  demoDatabase = undefined;
  initialized = false;
}

export function isSyntheticDemoDatabase(database) {
  const row = database.prepare("SELECT value FROM demo_metadata WHERE key = 'kind'").get();
  return row?.value === DEMO_MARKER;
}
