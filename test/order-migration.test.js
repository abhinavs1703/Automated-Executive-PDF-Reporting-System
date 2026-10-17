import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../src/db.js';
import { getReportData } from '../src/analytics.js';
import { countRows, csvText, HEADER, root, runScript, workspace } from './support/import-helpers.js';

/** The schema as it was BEFORE order_id / line_item_id existed. */
function createOldDatabase(file, { withCategory = true } = {}) {
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, customer TEXT NOT NULL, product TEXT NOT NULL, amount REAL NOT NULL CHECK(amount >= 0), created_at TEXT NOT NULL${withCategory ? ', category TEXT' : ''});`);
  const insert = old.prepare(`INSERT INTO orders (customer, product, amount, created_at${withCategory ? ', category' : ''}) VALUES (?, ?, ?, ?${withCategory ? ', ?' : ''})`);
  const args = (...a) => (withCategory ? a : a.slice(0, 4));
  // Three IDENTICAL rows plus two others: they must remain five separate orders.
  for (let i = 0; i < 3; i += 1) insert.run(...args('Avery', 'Keyboard', 100, '2026-09-28T10:00:00.000Z', 'Accessories'));
  insert.run(...args('Jordan', 'Monitor', 400, '2026-09-29T10:00:00.000Z', 'Displays'));
  insert.run(...args('Morgan', 'Mouse', 50, '2026-09-22T10:00:00.000Z', 'Accessories'));
  old.close();
}

test('migration of an old database: every existing row stays its own order (deterministic LEGACY- IDs)', () => {
  const ws = workspace();
  try {
    createOldDatabase(ws.dbPath);
    let reader;
    try {
      reader = new DatabaseSync(ws.dbPath);
      const beforeRows = reader.prepare('SELECT * FROM orders ORDER BY id').all().length;
      assert.equal(beforeRows, 5);
    } finally { if (reader) reader.close(); }

    const db = createDatabase(ws.dbPath);
    try {
      const rows = db.prepare('SELECT id, order_id, line_item_id, import_batch_id, customer, amount FROM orders ORDER BY id').all().map((r) => ({ ...r }));
      assert.equal(rows.length, 5, 'no rows lost');
      assert.deepEqual(rows.map((r) => r.order_id), ['LEGACY-1', 'LEGACY-2', 'LEGACY-3', 'LEGACY-4', 'LEGACY-5']);
      assert.deepEqual(rows.map((r) => r.line_item_id), ['LEGACY-1', 'LEGACY-2', 'LEGACY-3', 'LEGACY-4', 'LEGACY-5']);
      assert.ok(rows.every((r) => r.import_batch_id === null));
      assert.equal(new Set(rows.map((r) => r.order_id)).size, 5, 'not collapsed into one order');

      const { summary } = getReportData({ database: db, startDate: '2026-09-28', endDate: '2026-10-04' });
      assert.deepEqual([summary.totalOrders, summary.totalRevenue, summary.averageOrderValue], [4, 700, 175], 'identical to the pre-migration meaning: one order per row');
    } finally { db.close(); }
  } finally { ws.cleanup(); }
});

test('migration also handles the oldest schema (no category column) and is idempotent', () => {
  const ws = workspace();
  try {
    createOldDatabase(ws.dbPath, { withCategory: false });
    const first = createDatabase(ws.dbPath);
    const snapshot = first.prepare('SELECT * FROM orders ORDER BY id').all().map((r) => ({ ...r }));
    assert.equal(snapshot.length, 5);
    assert.ok(snapshot.every((r) => r.category === r.product), 'category falls back to the product, as before');
    first.close();

    const second = createDatabase(ws.dbPath); // reopen: nothing may change
    try {
      assert.deepEqual(second.prepare('SELECT * FROM orders ORDER BY id').all().map((r) => ({ ...r })), snapshot);
    } finally { second.close(); }
  } finally { ws.cleanup(); }
});

test('after migration: unique line_item_id index, order_id index and the legacy-ID trigger exist', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    const objects = db.prepare("SELECT type, name FROM sqlite_master WHERE name IN ('idx_orders_line_item_id','idx_orders_order_id','trg_orders_legacy_ids')").all().map((r) => `${r.type}:${r.name}`).sort();
    assert.deepEqual(objects, ['index:idx_orders_line_item_id', 'index:idx_orders_order_id', 'trigger:trg_orders_legacy_ids']);
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_orders_line_item_id'").get().sql, /UNIQUE/i);
  } finally { db.close(); ws.cleanup(); }
});

test('rows inserted without IDs after migration (older code paths) get their own legacy order; partial IDs are completed', () => {
  const db = createDatabase(':memory:');
  try {
    const insert = db.prepare('INSERT INTO orders (customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?)');
    insert.run('a', 'p', 1, '2026-09-28T00:00:00.000Z', 'c');
    insert.run('a', 'p', 1, '2026-09-28T00:00:00.000Z', 'c');
    db.prepare("INSERT INTO orders (order_id, customer, product, amount, created_at, category) VALUES ('MY-ORDER', 'b', 'p', 2, '2026-09-28T00:00:00.000Z', 'c')").run();
    const rows = db.prepare('SELECT id, order_id, line_item_id FROM orders ORDER BY id').all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { id: 1, order_id: 'LEGACY-1', line_item_id: 'LEGACY-1' },
      { id: 2, order_id: 'LEGACY-2', line_item_id: 'LEGACY-2' },
      { id: 3, order_id: 'MY-ORDER', line_item_id: 'LEGACY-3' },
    ]);
  } finally { db.close(); }
});

test('rows that already have real IDs are not rewritten by the migration', () => {
  const ws = workspace();
  const db = ws.openDb();
  db.prepare("INSERT INTO orders (order_id, line_item_id, customer, product, amount, created_at, category) VALUES ('ORD-9','L-9','a','p',3,'2026-09-28T00:00:00.000Z','c')").run();
  db.close();
  const again = createDatabase(ws.dbPath);
  try {
    assert.deepEqual({ ...again.prepare('SELECT order_id, line_item_id FROM orders').get() }, { order_id: 'ORD-9', line_item_id: 'L-9' });
  } finally { again.close(); ws.cleanup(); }
});

// ------------------------------------------------------------------ seed script

test('seed script: creates multi-line orders with IDs; running it again replaces only sample data', () => {
  const ws = workspace();
  try {
    const env = { DATABASE_PATH: ws.dbPath };
    const first = runScript('seed.js', [], { env });
    assert.equal(first.code, 0, first.output);
    assert.match(first.stdout, /Seeded 240 deterministic sample line items in \d+ orders/);

    const db = ws.openDb();
    try {
      assert.equal(countRows(db), 240);
      const orders = db.prepare('SELECT COUNT(DISTINCT order_id) AS n FROM orders').get().n;
      assert.ok(orders > 100 && orders < 240, `grouped into ${orders} orders`);
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM (SELECT order_id FROM orders GROUP BY order_id HAVING COUNT(*) > 1)').get().n > 10, 'several multi-line orders');
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE order_id NOT LIKE 'SEED-O-%' OR line_item_id NOT LIKE 'SEED-L-%'").get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(DISTINCT line_item_id) AS n FROM orders').get().n, 240, 'line item IDs are unique');
      // The report agrees with an independent SQL count of distinct orders.
      const independent = db.prepare("SELECT COUNT(DISTINCT order_id) AS n FROM orders WHERE DATE(created_at) BETWEEN date('now','-30 day') AND date('now')").get().n;
      const start = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const end = new Date().toISOString().slice(0, 10);
      assert.equal(getReportData({ database: db, startDate: start, endDate: end }).summary.totalOrders, independent);
    } finally { db.close(); }

    assert.equal(runScript('seed.js', [], { env }).code, 0, 'seeding again is allowed while only sample data exists');
    const after = ws.openDb();
    try { assert.equal(countRows(after), 240); } finally { after.close(); }
  } finally { ws.cleanup(); }
});

test('seed script REFUSES to run when imported data exists (it would delete it); --force overrides', () => {
  const ws = workspace();
  try {
    const env = { DATABASE_PATH: ws.dbPath };
    const csv = ws.writeCsv('real.csv', csvText(HEADER, 'ORD-1,L-1,Avery,Keyboard,49.99,2026-09-28T10:00:00Z,Accessories'));
    assert.equal(runScript('import-orders.js', [csv], { env }).code, 0);

    const refused = runScript('seed.js', [], { env });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Refusing to seed: the database contains 1 imported line item/);
    assert.match(refused.stderr, /--force/);
    const db = ws.openDb();
    try {
      assert.equal(countRows(db), 1, 'imported data is intact');
      assert.equal(db.prepare('SELECT line_item_id FROM orders').get().line_item_id, 'L-1');
    } finally { db.close(); }

    assert.equal(runScript('seed.js', ['--force'], { env }).code, 0);
    const forced = ws.openDb();
    try { assert.equal(countRows(forced), 240); } finally { forced.close(); }
  } finally { ws.cleanup(); }
});

test('the importer never runs the seed script: importing into an empty database adds only the file rows', () => {
  const ws = workspace();
  try {
    const result = runScript('import-orders.js', [path.join(root, 'examples', 'sample-orders.csv')], { env: { DATABASE_PATH: ws.dbPath } });
    assert.equal(result.code, 0, result.output);
    const db = ws.openDb();
    try {
      assert.equal(countRows(db), 18);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE order_id LIKE 'SEED-%'").get().n, 0);
    } finally { db.close(); }
  } finally { ws.cleanup(); }
  assert.ok(fs.existsSync(path.join(root, 'examples', 'sample-orders.csv')));
});
