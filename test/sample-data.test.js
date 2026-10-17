import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSampleOrdersCsv, sampleWeekFor } from '../src/sample-data.js';
import { validateOrderCsv } from '../src/order-validation.js';
import { importOrders } from '../src/order-import.js';
import { createDatabase } from '../src/db.js';
import { COMMITTED_SAMPLE_CSV, FIXTURE_WEEK, countRows, root, runScript, workspace } from './support/import-helpers.js';

const NOW = new Date('2026-10-11T12:00:00Z');

test('the sample generator produces a valid file: 18 line items in 12 orders, no warnings', () => {
  const result = validateOrderCsv(buildSampleOrdersCsv('2026-10-05'), { now: NOW });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.rows.length, 18);
  assert.equal(new Set(result.rows.map((r) => r.orderId)).size, 12);
  assert.ok(result.rows.filter((r) => r.orderId.endsWith('-03')).length === 3, 'an order with three product lines');
  assert.ok(result.rows.some((r) => r.product === 'Café Carry Case "Pro"'), 'quotes and UTF-8');
  assert.ok(result.rows.some((r) => r.product === 'USB-C Cable, 2 m'), 'comma inside a quoted value');
  const days = result.rows.map((r) => r.createdAt.slice(0, 10));
  assert.deepEqual([...new Set(days)].sort(), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
});

test('the sample is deterministic; IDs carry the week, so other weeks never collide', () => {
  assert.equal(buildSampleOrdersCsv('2026-10-05'), buildSampleOrdersCsv('2026-10-05'));
  const a = validateOrderCsv(buildSampleOrdersCsv('2026-09-28'), { now: NOW }).rows;
  const b = validateOrderCsv(buildSampleOrdersCsv('2026-10-05'), { now: NOW }).rows;
  assert.equal(new Set([...a, ...b].map((r) => r.lineItemId)).size, 36);
  assert.equal(a[0].orderId, 'ORD-20260928-01');
  assert.equal(b[0].lineItemId, 'L-20261005-01-1');
  assert.throws(() => buildSampleOrdersCsv('05/10/2026'), /YYYY-MM-DD/);
  assert.throws(() => buildSampleOrdersCsv('2026-02-30'), /valid date/);
});

test('samples for two different weeks import side by side; importing the same week again changes nothing', () => {
  const ws = workspace();
  const db = ws.openDb();
  try {
    const week1 = ws.writeCsv('w1.csv', buildSampleOrdersCsv('2026-09-28'));
    const week2 = ws.writeCsv('w2.csv', buildSampleOrdersCsv('2026-10-05'));
    assert.equal(importOrders({ database: db, filePath: week1, now: NOW }).status, 'imported');
    assert.equal(importOrders({ database: db, filePath: week2, now: NOW }).status, 'imported', 'no conflicts between weeks');
    assert.equal(countRows(db), 36);
    assert.equal(db.prepare('SELECT COUNT(DISTINCT order_id) AS n FROM orders').get().n, 24);
    assert.equal(importOrders({ database: db, filePath: week2, now: NOW }).status, 'nothing-new');
    assert.equal(countRows(db), 36);
  } finally { db.close(); ws.cleanup(); }
});

test('"previous complete week" is Monday-Sunday (UTC): Monday, Wednesday and Sunday examples', () => {
  assert.deepEqual(sampleWeekFor(new Date('2026-10-12T00:00:00Z')), { startDate: '2026-10-05', endDate: '2026-10-11' });
  assert.deepEqual(sampleWeekFor(new Date('2026-10-14T15:00:00Z')), { startDate: '2026-10-05', endDate: '2026-10-11' });
  assert.deepEqual(sampleWeekFor(new Date('2026-10-11T23:59:00Z')), { startDate: '2026-09-28', endDate: '2026-10-04' });
});

test('the committed examples/sample-orders.csv: valid, synthetic, one full Monday-Sunday week, identical to the generator output', () => {
  const text = fs.readFileSync(COMMITTED_SAMPLE_CSV, 'utf8');
  const result = validateOrderCsv(text, { now: new Date('2026-12-31T00:00:00Z') });
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 18);
  assert.equal(new Set(result.rows.map((r) => r.orderId)).size, 12, 'multiple lines share an order');
  const multiLine = Object.values(Object.groupBy ? Object.groupBy(result.rows, (r) => r.orderId) : result.rows.reduce((acc, r) => { (acc[r.orderId] ||= []).push(r); return acc; }, {})).filter((lines) => lines.length > 1);
  assert.ok(multiLine.length >= 2, 'at least two orders have several product lines');

  const days = result.rows.map((r) => r.createdAt.slice(0, 10)).sort();
  const first = days[0];
  assert.equal(new Date(`${first}T00:00:00Z`).getUTCDay(), 1, 'the week starts on a Monday');
  assert.equal(days.at(-1), new Date(Date.parse(`${first}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10), 'and ends on the following Sunday');

  assert.equal(text.replace(/\r\n/g, '\n'), buildSampleOrdersCsv(first), 'regenerating that week gives exactly this file');
  for (const row of result.rows) {
    assert.match(row.customer, /^(CUST-\d{4}|Zoë Example|Müller Demo GmbH)$/, `"${row.customer}" is not an obviously synthetic customer`);
  }
});

// ------------------------------------------------------------------ generator script

test('npm run sample:csv: writes only a CSV file, with safe overwrite rules and a clear next step', () => {
  const ws = workspace();
  try {
    const out = path.join(ws.dir, 'week.csv');
    const made = runScript('generate-sample-csv.js', ['--out', out, '--start', '2026-10-05']);
    assert.equal(made.code, 0, made.output);
    assert.equal(fs.readFileSync(out, 'utf8'), buildSampleOrdersCsv('2026-10-05'));
    assert.match(made.stdout, /Sample orders for 2026-10-05 to 2026-10-11 \(12 orders, 18 line items\)\. Nothing was imported\./);
    assert.match(made.stdout, /npm run report -- --start 2026-10-05 --end 2026-10-11/);

    const again = runScript('generate-sample-csv.js', ['--out', out, '--start', '2026-10-05']);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already exists.*--force/);
    assert.equal(runScript('generate-sample-csv.js', ['--out', out, '--start', '2026-09-28', '--force']).code, 0);
    assert.equal(fs.readFileSync(out, 'utf8'), buildSampleOrdersCsv('2026-09-28'));

    assert.match(runScript('generate-sample-csv.js', ['--out', path.join(ws.dir, 'notes.txt')]).stderr, /must end in \.csv/);
    assert.match(runScript('generate-sample-csv.js', ['--out', path.join(ws.dir, 'no-such-folder', 'x.csv')]).stderr, /does not exist/);
    assert.match(runScript('generate-sample-csv.js', ['--start', 'tomorrow', '--out', path.join(ws.dir, 'y.csv')]).stderr, /YYYY-MM-DD/);
    assert.equal(runScript('generate-sample-csv.js', ['--bogus']).code, 1);
    assert.equal(runScript('generate-sample-csv.js', ['--help']).code, 0);
    assert.deepEqual(fs.readdirSync(ws.dir).sort(), ['week.csv'], 'only the requested file was created (no database, no reports)');
  } finally { ws.cleanup(); }
});

test('the generator script cannot touch the database, email or the scheduler (its imports)', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'generate-sample-csv.js'), 'utf8');
  const imported = [...source.matchAll(/import\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(imported.sort(), ['../src/config.js', '../src/sample-data.js', 'node:fs', 'node:path']);
  const transitive = fs.readFileSync(path.join(root, 'src', 'sample-data.js'), 'utf8');
  assert.deepEqual([...transitive.matchAll(/import\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]), ['./dates.js']);
});
