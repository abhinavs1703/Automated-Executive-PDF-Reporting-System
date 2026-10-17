import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function columnNames(database, tableName) {
  return database.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
}

function ensureColumn(database, tableName, columnName, definition) {
  if (!columnNames(database, tableName).includes(columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

/**
 * Order / line-item identifiers (added for CSV import). Safe to run on every start:
 *  - adds the nullable columns to databases created by earlier versions;
 *  - gives every pre-existing row a deterministic legacy ID derived from its primary key
 *    (LEGACY-<id>), so old data is NOT collapsed into one order: each old row stays its own order;
 *  - installs a trigger that gives the same legacy IDs to any later row inserted without IDs
 *    (older code paths and tests), so the ID columns are never NULL;
 *  - then enforces line_item_id uniqueness, which is what makes duplicate detection reliable.
 * The "LEGACY-" prefix is reserved: the CSV importer refuses IDs that start with it.
 */
function migrateOrderIdentifiers(database) {
  database.exec('BEGIN IMMEDIATE');
  try {
    ensureColumn(database, 'orders', 'order_id', 'TEXT');
    ensureColumn(database, 'orders', 'line_item_id', 'TEXT');
    ensureColumn(database, 'orders', 'import_batch_id', 'INTEGER REFERENCES import_batches(id)');
    database.exec("UPDATE orders SET order_id = 'LEGACY-' || id WHERE order_id IS NULL OR order_id = '';");
    database.exec("UPDATE orders SET line_item_id = 'LEGACY-' || id WHERE line_item_id IS NULL OR line_item_id = '';");
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_orders_legacy_ids
      AFTER INSERT ON orders
      WHEN NEW.order_id IS NULL OR NEW.line_item_id IS NULL
      BEGIN
        UPDATE orders
        SET order_id = COALESCE(order_id, 'LEGACY-' || NEW.id),
            line_item_id = COALESCE(line_item_id, 'LEGACY-' || NEW.id)
        WHERE id = NEW.id;
      END;
    `);
    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_line_item_id ON orders(line_item_id);');
    database.exec('CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);');
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function createDatabase(databasePath = ':memory:') {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer TEXT NOT NULL,
      product TEXT NOT NULL,
      amount REAL NOT NULL CHECK(amount >= 0),
      created_at TEXT NOT NULL,
      category TEXT,
      region TEXT,
      country TEXT,
      business_unit TEXT,
      sales_channel TEXT,
      customer_segment TEXT,
      quantity REAL,
      unit_price REAL,
      discount_percent REAL,
      cost REAL,
      gross_profit REAL,
      gross_margin_percent REAL,
      source_currency TEXT,
      sales_rep TEXT,
      payment_status TEXT,
      fulfillment_status TEXT,
      source_system TEXT
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL DEFAULT '',
      file_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      from_date TEXT,
      to_date TEXT,
      email_status TEXT NOT NULL DEFAULT 'not_requested',
      error TEXT,
      error_stage TEXT,
      email_error TEXT
    );

    -- One row per real (non-dry-run) CSV import, for traceability.
    CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      rows_imported INTEGER NOT NULL,
      rows_skipped INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      rows_received INTEGER NOT NULL DEFAULT 0,
      duplicates_skipped INTEGER NOT NULL DEFAULT 0,
      invalid_rows INTEGER NOT NULL DEFAULT 0,
      min_date TEXT,
      max_date TEXT,
      error TEXT,
      mapping_json TEXT
    );

    -- Ledger that makes email delivery idempotent: one row per logical delivery
    -- (reporting period + recipients, or a caller-supplied idempotency key).
    CREATE TABLE IF NOT EXISTS email_deliveries (
      delivery_key TEXT PRIMARY KEY,
      report_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('sending', 'sent', 'failed')),
      claimed_at TEXT NOT NULL,
      completed_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      error TEXT
    );
  `);

  // Migrate the original project schema safely if its database is reused.
  ensureColumn(database, 'orders', 'category', 'TEXT');
  for (const [column, definition] of [
    ['region', 'TEXT'], ['country', 'TEXT'], ['business_unit', 'TEXT'], ['sales_channel', 'TEXT'],
    ['customer_segment', 'TEXT'], ['quantity', 'REAL'], ['unit_price', 'REAL'], ['discount_percent', 'REAL'],
    ['cost', 'REAL'], ['gross_profit', 'REAL'], ['gross_margin_percent', 'REAL'], ['source_currency', 'TEXT'],
    ['sales_rep', 'TEXT'], ['payment_status', 'TEXT'], ['fulfillment_status', 'TEXT'], ['source_system', 'TEXT'],
  ]) ensureColumn(database, 'orders', column, definition);
  for (const [column, definition] of [
    ['status', "TEXT NOT NULL DEFAULT 'completed'"], ['rows_received', 'INTEGER NOT NULL DEFAULT 0'],
    ['duplicates_skipped', 'INTEGER NOT NULL DEFAULT 0'], ['invalid_rows', 'INTEGER NOT NULL DEFAULT 0'],
    ['min_date', 'TEXT'], ['max_date', 'TEXT'], ['error', 'TEXT'], ['mapping_json', 'TEXT'],
  ]) ensureColumn(database, 'import_batches', column, definition);
  ensureColumn(database, 'reports', 'from_date', 'TEXT');
  ensureColumn(database, 'reports', 'to_date', 'TEXT');
  ensureColumn(database, 'reports', 'email_status', "TEXT NOT NULL DEFAULT 'not_requested'");
  ensureColumn(database, 'reports', 'error', 'TEXT');
  ensureColumn(database, 'reports', 'error_stage', 'TEXT');
  ensureColumn(database, 'reports', 'email_error', 'TEXT');
  database.exec("UPDATE orders SET category = product WHERE category IS NULL OR category = '';");
  migrateOrderIdentifiers(database);

  database.exec('CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);');
  database.exec('CREATE INDEX IF NOT EXISTS idx_orders_category ON orders(category);');
  database.exec('CREATE INDEX IF NOT EXISTS idx_orders_region ON orders(region);');
  database.exec('CREATE INDEX IF NOT EXISTS idx_orders_source_currency ON orders(source_currency);');
  database.exec('CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at);');
  database.exec('CREATE INDEX IF NOT EXISTS idx_import_batches_time ON import_batches(imported_at DESC);');
  return database;
}

/**
 * Open an EXISTING database file read-only, without creating it or running migrations.
 * Returns null when the file does not exist. Used by commands that must never write
 * (CSV dry run, orders summary): SQLite itself rejects any write on this handle.
 */
export function openDatabaseReadOnly(databasePath = config.databasePath) {
  if (!fs.existsSync(databasePath)) return null;
  return new DatabaseSync(databasePath, { readOnly: true });
}

let defaultDatabase;

/**
 * Lazily opened application database. Importing this module has no side
 * effects (no file is created) until a caller actually needs the database.
 */
export function getDefaultDatabase() {
  defaultDatabase ??= createDatabase(config.databasePath);
  return defaultDatabase;
}

export function closeDefaultDatabase() {
  if (defaultDatabase) {
    try { defaultDatabase.close(); } catch { /* already closed */ }
    defaultDatabase = undefined;
  }
}
