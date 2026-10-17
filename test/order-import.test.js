import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabaseReadOnly } from '../src/db.js';
import {
  ImportDatabaseError, ImportFileError, formatImportSummary, importOrders, readImportFile, resolveImportPath,
} from '../src/order-import.js';
import { COMMITTED_SAMPLE_CSV, HEADER, SAMPLE_CSV, countRows, csvText, importText, root, workspace } from './support/import-helpers.js';

const GOOD_ROWS = [
  'ORD-1,L-1,Avery,Keyboard,49.99,2026-09-28T10:00:00Z,Accessories',
  'ORD-1,L-2,Avery,Mouse,19.01,2026-09-28T10:00:00Z,Accessories',
  'ORD-2,L-3,Jordan,Monitor,300,2026-09-29,Displays',
];
const GOOD = csvText(HEADER, ...GOOD_ROWS);

// ------------------------------------------------------------------ valid import

test('a valid CSV is imported: rows, normalised dates, batch record and summary counts', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    const result = importText(ws, db, GOOD);
    assert.equal(result.status, 'imported');
    assert.deepEqual(result.counts, { recordsRead: 3, blankRowsSkipped: 0, validRows: 3, rejectedRows: 0, newRows: 3, duplicatesSkipped: 0, imported: 3 });
    assert.equal(result.ordersInFile, 2);
    assert.equal(result.newOrders, 2);
    assert.equal(result.newRevenue, 369);
    assert.deepEqual(result.period, { start: '2026-09-28', end: '2026-09-29' });
    assert.ok(result.batchId > 0);

    const rows = db.prepare('SELECT order_id, line_item_id, customer, product, amount, created_at, category, import_batch_id FROM orders ORDER BY line_item_id').all().map((r) => ({ ...r }));
    assert.deepEqual(rows[0], { order_id: 'ORD-1', line_item_id: 'L-1', customer: 'Avery', product: 'Keyboard', amount: 49.99, created_at: '2026-09-28T10:00:00.000Z', category: 'Accessories', import_batch_id: result.batchId });
    assert.equal(rows[2].created_at, '2026-09-29T00:00:00.000Z');

    const batch = db.prepare('SELECT * FROM import_batches').get();
    assert.equal(batch.source_file, result.file.name, 'only the file NAME is stored, not the full path');
    assert.equal(batch.rows_imported, 3);
    assert.match(batch.file_sha256, /^[0-9a-f]{64}$/);
    assert.equal(batch.file_sha256, result.file.sha256);
  } finally { db.close(); ws.cleanup(); }
});

test('the bundled sample file imports cleanly: 18 line items in 12 orders', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    const result = importOrders({ database: db, filePath: SAMPLE_CSV, now: new Date('2026-10-11T12:00:00Z') });
    assert.equal(result.status, 'imported');
    assert.equal(result.counts.imported, 18);
    assert.equal(result.newOrders, 12);
    assert.equal(result.newRevenue, 2570.21);
    assert.deepEqual(result.period, { start: '2026-09-28', end: '2026-10-04' });
    assert.deepEqual(result.errors, []);
    const names = db.prepare('SELECT product, customer FROM orders').all().map((r) => `${r.product}|${r.customer}`);
    assert.ok(names.includes('USB-C Cable, 2 m|CUST-1001'), 'quoted comma preserved');
    assert.ok(names.includes('Café Carry Case "Pro"|CUST-1008'), 'escaped quotes and UTF-8 preserved');
    assert.ok(names.includes('Mechanical Keyboard|Zoë Example'));
    assert.ok(names.includes('USB-C Multi-Port Dock|Müller Demo GmbH'));
  } finally { db.close(); ws.cleanup(); }
});

test('files saved by Excel (UTF-8 BOM, Windows line endings, trailing blank line) import correctly', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    const excelStyle = `\uFEFF${HEADER}\r\n${GOOD_ROWS.join('\r\n')}\r\n\r\n`;
    const result = importText(ws, db, excelStyle);
    assert.equal(result.status, 'imported');
    assert.equal(result.counts.imported, 3);
    assert.equal(result.counts.blankRowsSkipped, 1);
  } finally { db.close(); ws.cleanup(); }
});

// ------------------------------------------------------------------ strict all-or-nothing

test('any rejected row rejects the whole file: valid rows are NOT imported', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    const result = importText(ws, db, csvText(HEADER, GOOD_ROWS[0], 'ORD-9,L-9,Casey,Dock,abc,2026-09-28,Connectivity', GOOD_ROWS[2]));
    assert.equal(result.status, 'rejected');
    assert.equal(result.counts.rejectedRows, 1);
    assert.equal(result.counts.validRows, 2);
    assert.equal(result.counts.imported, 0);
    assert.equal(result.errors[0].row, 3);
    assert.equal(countRows(db), 0, 'nothing was written');
    assert.equal(countRows(db, 'import_batches'), 0);
  } finally { db.close(); ws.cleanup(); }
});

test('duplicate line_item_id inside the file: rejected, nothing written', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    const result = importText(ws, db, csvText(HEADER, GOOD_ROWS[0], 'ORD-5,L-1,Casey,Dock,9,2026-09-28,Connectivity'));
    assert.equal(result.status, 'rejected');
    assert.match(result.errors[0].message, /Duplicate line_item_id "L-1".*row 2/);
    assert.equal(result.errors[0].row, 3);
    assert.equal(countRows(db), 0);
  } finally { db.close(); ws.cleanup(); }
});

// ------------------------------------------------------------------ duplicates against the database

test('re-importing the same file is safe: identical rows are skipped, never duplicated', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    assert.equal(importText(ws, db, GOOD).status, 'imported');
    const before = db.prepare('SELECT * FROM orders ORDER BY id').all().map((r) => ({ ...r }));

    const again = importText(ws, db, GOOD);
    assert.equal(again.status, 'nothing-new');
    assert.equal(again.counts.duplicatesSkipped, 3);
    assert.equal(again.counts.imported, 0);
    assert.equal(again.errors.length, 0);
    assert.match(again.warnings.map((w) => w.message).join('\n'), /already imported on .*import batch #1/);

    assert.equal(countRows(db), 3);
    assert.equal(countRows(db, 'import_batches'), 1, 'no batch is recorded when nothing new was imported');
    assert.deepEqual(db.prepare('SELECT * FROM orders ORDER BY id').all().map((r) => ({ ...r })), before, 'existing data is byte-for-byte unchanged');
  } finally { db.close(); ws.cleanup(); }
});

test('a file mixing already-imported and new rows imports only the new ones', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    importText(ws, db, csvText(HEADER, GOOD_ROWS[0]));
    const result = importText(ws, db, GOOD);
    assert.equal(result.status, 'imported');
    assert.equal(result.counts.duplicatesSkipped, 1);
    assert.equal(result.counts.imported, 2);
    assert.equal(countRows(db), 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE line_item_id = ?').get('L-1').n, 1);
  } finally { db.close(); ws.cleanup(); }
});

test('the same line_item_id with DIFFERENT data is a conflict: rejected, nothing overwritten or imported', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    importText(ws, db, csvText(HEADER, GOOD_ROWS[0]));
    const changed = csvText(HEADER, 'ORD-1,L-1,Avery,Keyboard,59.99,2026-09-28T10:00:00Z,Accessories', 'ORD-7,L-7,Newbie,Dock,10,2026-09-30,Connectivity');
    const result = importText(ws, db, changed);
    assert.equal(result.status, 'rejected');
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].row, 2);
    assert.match(result.errors[0].message, /"L-1" already exists in the database with different data \(different amount\)/);
    assert.match(result.errors[0].message, /never overwritten/);
    assert.equal(db.prepare("SELECT amount FROM orders WHERE line_item_id = 'L-1'").get().amount, 49.99, 'the stored amount is untouched');
    assert.equal(countRows(db), 1, 'the other (valid, new) row was not imported either');
  } finally { db.close(); ws.cleanup(); }
});

test('conflicts name every differing field', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    importText(ws, db, csvText(HEADER, GOOD_ROWS[0]));
    const result = importText(ws, db, csvText(HEADER, 'ORD-2,L-1,Someone Else,Mouse,49.99,2026-09-28T10:00:00Z,Accessories'));
    assert.match(result.errors[0].message, /different order_id, customer, product\)/);
  } finally { db.close(); ws.cleanup(); }
});

test('existing legacy/seeded rows are never touched by an import and cannot collide with it', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    db.prepare('INSERT INTO orders (customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?)').run('Old', 'Old Product', 5, '2026-01-01T00:00:00.000Z', 'Old');
    const before = { ...db.prepare('SELECT * FROM orders').get() };
    assert.equal(before.order_id, `LEGACY-${before.id}`);
    assert.equal(importText(ws, db, GOOD).status, 'imported');
    assert.deepEqual({ ...db.prepare('SELECT * FROM orders WHERE id = ?').get(before.id) }, before);
    assert.equal(countRows(db), 4);
  } finally { db.close(); ws.cleanup(); }
});

// ------------------------------------------------------------------ dry run

test('dry run writes NOTHING: the database file is byte-for-byte identical afterwards', () => {
  const ws = workspace();
  const db = ws.openDb();
  importText(ws, db, csvText(HEADER, GOOD_ROWS[0]));
  db.close();
  const before = ws.dbHash();
  const file = ws.writeCsv('dry.csv', GOOD);

  const readOnly = openDatabaseReadOnly(ws.dbPath);
  try {
    const result = importOrders({ database: readOnly, filePath: file, dryRun: true, now: new Date('2026-10-11T12:00:00Z') });
    assert.equal(result.status, 'dry-run-ok');
    assert.equal(result.dryRun, true);
    assert.equal(result.counts.newRows, 2, 'it reports what WOULD be imported');
    assert.equal(result.counts.duplicatesSkipped, 1);
    assert.equal(result.counts.imported, 0);
    assert.equal(result.batchId, null);
  } finally { readOnly.close(); }
  assert.equal(ws.dbHash(), before, 'the database file was not modified');

  const check = ws.openDb();
  try {
    assert.equal(countRows(check), 1);
    assert.equal(countRows(check, 'import_batches'), 1);
  } finally { check.close(); ws.cleanup(); }
});

test('a dry run cannot write even by accident: the read-only handle refuses writes', () => {
  const ws = workspace();
  ws.openDb().close();
  const readOnly = openDatabaseReadOnly(ws.dbPath);
  try {
    assert.throws(() => readOnly.exec("INSERT INTO orders (customer, product, amount, created_at) VALUES ('a','b',1,'2026-01-01')"), /readonly/i);
  } finally { readOnly.close(); ws.cleanup(); }
});

test('dry run still reports every problem, including conflicts with stored data', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    importText(ws, db, csvText(HEADER, GOOD_ROWS[0]));
    const result = importText(ws, db, csvText(HEADER, 'ORD-1,L-1,Avery,Keyboard,1.00,2026-09-28T10:00:00Z,Accessories', 'ORD-8,L-8,A,B,-3,2026-09-28,C'), { dryRun: true });
    assert.equal(result.status, 'rejected');
    assert.deepEqual(result.errors.map((e) => e.row), [2, 3]);
    assert.equal(result.counts.rejectedRows, 2);
  } finally { db.close(); ws.cleanup(); }
});

test('dry run works with no database at all (and creates none)', () => {
  const ws = workspace();
  try {
    const file = ws.writeCsv('x.csv', GOOD);
    const result = importOrders({ database: null, filePath: file, dryRun: true, now: new Date('2026-10-11T12:00:00Z') });
    assert.equal(result.status, 'dry-run-ok');
    assert.equal(result.counts.newRows, 3);
    assert.equal(fs.existsSync(ws.dbPath), false);
    assert.equal(openDatabaseReadOnly(ws.dbPath), null);
  } finally { ws.cleanup(); }
});

// ------------------------------------------------------------------ transactions

test('a database failure part-way through rolls the WHOLE batch back and the database stays usable', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    importText(ws, db, csvText(HEADER, 'ORD-0,L-0,Existing,Thing,1,2026-09-27,Misc'));
    // A real SQLite failure on the 3rd of 4 inserts (no mocking of the importer).
    db.exec("CREATE TRIGGER fail_on_marker BEFORE INSERT ON orders WHEN NEW.line_item_id = 'L-BOOM' BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;");
    const text = csvText(HEADER, 'ORD-1,L-1,A,P,10,2026-09-28,C', 'ORD-1,L-2,A,P,20,2026-09-28,C', 'ORD-2,L-BOOM,B,P,30,2026-09-29,C', 'ORD-3,L-4,C,P,40,2026-09-30,C');

    assert.throws(() => importText(ws, db, text), (error) => {
      assert.ok(error instanceof ImportDatabaseError);
      assert.match(error.message, /rolled back \(nothing was imported\).*simulated disk failure/);
      return true;
    });
    assert.equal(countRows(db), 1, 'L-1 and L-2 (inserted before the failure) were rolled back');
    assert.equal(countRows(db, 'import_batches'), 1, 'the batch record was rolled back too');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE import_batch_id = 2').get().n, 0);

    // Not stuck in a transaction: the corrected file imports normally afterwards.
    db.exec('DROP TRIGGER fail_on_marker');
    assert.equal(importText(ws, db, text).status, 'imported');
    assert.equal(countRows(db), 5);
  } finally { db.close(); ws.cleanup(); }
});

test('the database unique index is a second line of defence against duplicate line items', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    importText(ws, db, csvText(HEADER, GOOD_ROWS[0]));
    assert.throws(() => db.prepare("INSERT INTO orders (order_id, line_item_id, customer, product, amount, created_at, category) VALUES ('X','L-1','a','b',1,'2026-01-01','c')").run(), /UNIQUE/i);
  } finally { db.close(); ws.cleanup(); }
});

// ------------------------------------------------------------------ files and paths

test('file limits: size and encoding problems are explained and nothing is read as data', () => {
  const ws = workspace();
  try {
    const big = ws.writeCsv('big.csv', csvText(HEADER, GOOD_ROWS[0]).padEnd(2000, ' '));
    assert.throws(() => readImportFile(big, { maxBytes: 1000 }), (e) => e instanceof ImportFileError && e.code === 'IMPORT_TOO_LARGE' && /raise IMPORT_MAX_FILE_MB/.test(e.message));

    assert.throws(() => readImportFile(ws.writeCsv('empty.csv', '')), (e) => e.code === 'IMPORT_EMPTY');

    const utf16 = path.join(ws.dir, 'utf16.csv');
    fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(HEADER, 'utf16le')]));
    assert.throws(() => readImportFile(utf16), (e) => e.code === 'IMPORT_ENCODING' && /UTF-16/.test(e.message) && /CSV UTF-8/.test(e.message));

    const latin1 = path.join(ws.dir, 'latin1.csv');
    fs.writeFileSync(latin1, Buffer.concat([Buffer.from(`${HEADER}\nORD-1,L-1,Zo`), Buffer.from([0xeb]), Buffer.from(',P,1,2026-09-28,C\n')]));
    assert.throws(() => readImportFile(latin1), (e) => e.code === 'IMPORT_ENCODING' && /not valid UTF-8/.test(e.message));

    const xlsx = path.join(ws.dir, 'workbook.csv');
    fs.writeFileSync(xlsx, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]));
    assert.throws(() => readImportFile(xlsx), (e) => e.code === 'IMPORT_ENCODING' && /Excel workbook/.test(e.message));
  } finally { ws.cleanup(); }
});

test('a file locked by another program (e.g. open in Excel) gives a plain explanation, not a crash', (t) => {
  const ws = workspace();
  try {
    const file = ws.writeCsv('locked.csv', GOOD);
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error(`${code}: resource busy or locked`), { code }); });
      assert.throws(() => readImportFile(file), (e) => e instanceof ImportFileError && e.code === 'IMPORT_LOCKED' && new RegExp(code).test(e.message) && /open in Excel/.test(e.message), code);
      t.mock.restoreAll();
    }
    t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('weird failure'), { code: 'EIO' }); });
    assert.throws(() => readImportFile(file), (e) => e.code === 'IMPORT_UNREADABLE' && /weird failure/.test(e.message));
  } finally { t.mock.restoreAll(); ws.cleanup(); }
});

test('the row limit applies to real imports', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    const rows = Array.from({ length: 4 }, (_, i) => `ORD-${i},L-${i},A,P,1,2026-09-28,C`);
    const result = importText(ws, db, csvText(HEADER, ...rows), { maxRows: 3 });
    assert.equal(result.status, 'rejected');
    assert.match(result.errors[0].message, /4 data rows, which is more than the allowed maximum of 3/);
    assert.equal(countRows(db), 0);
  } finally { db.close(); ws.cleanup(); }
});

test('path safety: only existing regular .csv files are accepted; relative paths resolve from the cwd, then the repo root', () => {
  const ws = workspace();
  try {
    const file = ws.writeCsv('mine.csv', GOOD);
    const real = fs.realpathSync(file);
    assert.equal(resolveImportPath(file), real, 'absolute path');
    assert.equal(resolveImportPath('mine.csv', { cwd: ws.dir, root }), real, 'relative to the typed-in folder');
    assert.equal(resolveImportPath(path.join('examples', 'sample-orders.csv'), { cwd: ws.dir, root }), fs.realpathSync(COMMITTED_SAMPLE_CSV), 'falls back to the repository root');
    assert.equal(resolveImportPath('MINE.CSV'.toLowerCase(), { cwd: ws.dir, root }), real);

    const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
    assert.equal(code(() => resolveImportPath('', { cwd: ws.dir, root })), 'IMPORT_USAGE');
    assert.equal(code(() => resolveImportPath('nope.csv', { cwd: ws.dir, root })), 'IMPORT_NOT_FOUND');
    assert.equal(code(() => resolveImportPath('bad\0name.csv', { cwd: ws.dir, root })), 'IMPORT_USAGE');
    assert.equal(code(() => resolveImportPath(ws.dir)), 'IMPORT_NOT_FILE', 'a folder is not a file');
    assert.equal(code(() => resolveImportPath(path.join(root, 'package.json'))), 'IMPORT_EXTENSION');
    fs.writeFileSync(path.join(ws.dir, '.env'), 'RESEND_API_KEY=re_fake');
    assert.equal(code(() => resolveImportPath(path.join(ws.dir, '.env'))), 'IMPORT_EXTENSION', 'secrets files can never be read as imports');
    fs.writeFileSync(path.join(ws.dir, 'data.xlsx'), 'x');
    assert.equal(code(() => resolveImportPath(path.join(ws.dir, 'data.xlsx'))), 'IMPORT_EXTENSION');
  } finally { ws.cleanup(); }
});

test('a symlink named .csv that points at a non-CSV file is refused', (t) => {
  const ws = workspace();
  try {
    const target = path.join(ws.dir, 'secret.txt');
    fs.writeFileSync(target, 'secret');
    const link = path.join(ws.dir, 'innocent.csv');
    try { fs.symlinkSync(target, link); } catch { t.skip('symlinks need extra privileges on this system'); return; }
    assert.throws(() => resolveImportPath(link), (e) => e.code === 'IMPORT_EXTENSION');
  } finally { ws.cleanup(); }
});

// ------------------------------------------------------------------ messages

test('the printed summary has counts, row numbers, causes and the next step', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    const rejected = formatImportSummary(importText(ws, db, csvText(HEADER, GOOD_ROWS[0], 'ORD-9,L-9,A,P,-5,2026-02-30,C')), { currency: 'USD' }).join('\n');
    assert.match(rejected, /Valid rows\s+1/);
    assert.match(rejected, /Rejected rows\s+1/);
    assert.match(rejected, /Row 3\s+\[amount\] amount "-5" is negative/);
    assert.match(rejected, /Row 3\s+\[created_at\] created_at "2026-02-30" is not a real calendar date/);
    assert.match(rejected, /RESULT: REJECTED\. Nothing was imported/);

    const dry = formatImportSummary(importText(ws, db, GOOD, { dryRun: true }), { currency: 'USD' }).join('\n');
    assert.match(dry, /DRY RUN - nothing is written/);
    assert.match(dry, /Would import\s+3\s+2 order\(s\), USD 369\.00/);
    assert.match(dry, /npm run import:orders -- ".*\.csv"/);

    const done = formatImportSummary(importText(ws, db, GOOD), { currency: 'USD' }).join('\n');
    assert.match(done, /Newly imported rows\s+3\s+2 order\(s\), USD 369\.00/);
    assert.match(done, /npm run report -- --start 2026-09-28 --end 2026-09-29/);
    assert.match(done, /npm run orders:summary/);
  } finally { db.close(); ws.cleanup(); }
});

test('long problem lists are truncated unless --all-errors is requested', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    const rows = Array.from({ length: 40 }, (_, i) => `ORD-${i},L-${i},A,P,bad,2026-09-28,C`);
    const result = importText(ws, db, csvText(HEADER, ...rows));
    assert.equal(result.errors.length, 40);
    const short = formatImportSummary(result).join('\n');
    assert.match(short, /\.\.\. and 15 more\. Add --all-errors/);
    assert.doesNotMatch(formatImportSummary(result, { allErrors: true }).join('\n'), /and \d+ more/);
  } finally { db.close(); ws.cleanup(); }
});
