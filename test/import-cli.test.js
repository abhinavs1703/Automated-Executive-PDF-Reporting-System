import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HEADER, SAMPLE_CSV, countRows, csvText, root, runScript, workspace } from './support/import-helpers.js';

/*
 * The scripts are run exactly as a user would run them (separate node processes, a working
 * directory that is NOT the repository root, no .env, no email settings).
 */

test('--help and usage errors', () => {
  const help = runScript('import-orders.js', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /npm run import:check/);
  assert.match(help.stdout, /order_id,line_item_id,customer,product,amount,created_at,category/);

  for (const args of [[], ['a.csv', 'b.csv'], ['--bogus', 'x.csv'], ['--max-rows', 'abc', 'x.csv']]) {
    const result = runScript('import-orders.js', args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.match(result.stderr, /ERROR:/);
    assert.match(result.stderr, /Usage|npm run import/);
  }
});

test('dry run from another folder, using a repo-relative path: validates, prints a summary, writes nothing, creates no database', () => {
  const ws = workspace();
  try {
    const result = runScript('import-orders.js', ['--dry-run', path.join('examples', 'sample-orders.csv')], { cwd: os.tmpdir(), env: { DATABASE_PATH: ws.dbPath } });
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /DRY RUN - nothing is written/);
    assert.match(result.stdout, /does not exist yet; a dry run does not create it/);
    assert.match(result.stdout, /Data rows read\s+18/);
    assert.match(result.stdout, /Valid rows\s+18/);
    assert.match(result.stdout, /Rejected rows\s+0/);
    assert.match(result.stdout, /Would import\s+18\s+12 order\(s\), USD 2,570\.21/);
    assert.match(result.stdout, /Orders in file\s+12/);
    assert.match(result.stdout, /RESULT: the file is valid/);
    assert.equal(fs.existsSync(ws.dbPath), false, 'no database file was created');
  } finally { ws.cleanup(); }
});

test('real import, then a second run is a harmless no-op (duplicate protection)', () => {
  const ws = workspace();
  try {
    const env = { DATABASE_PATH: ws.dbPath };
    const first = runScript('import-orders.js', [SAMPLE_CSV], { env });
    assert.equal(first.code, 0, first.output);
    assert.match(first.stdout, /Newly imported rows\s+18\s+12 order\(s\), USD 2,570\.21/);
    assert.match(first.stdout, /RESULT: imported 18 line item\(s\) in one transaction \(import batch #1\)/);
    assert.match(first.stdout, /npm run report -- --start 2026-09-28 --end 2026-10-04/);

    const hashAfterFirst = ws.dbHash();
    const second = runScript('import-orders.js', [SAMPLE_CSV], { env });
    assert.equal(second.code, 0, second.output);
    assert.match(second.stdout, /Already in database\s+18/);
    assert.match(second.stdout, /nothing new to import; every row is already in the database/);
    assert.match(second.stdout, /already imported on .* \(import batch #1\)/);
    assert.equal(ws.dbHash(), hashAfterFirst, 'the database file did not change at all');

    const db = ws.openDb();
    try {
      assert.equal(countRows(db), 18);
      assert.equal(countRows(db, 'import_batches'), 1);
    } finally { db.close(); }
  } finally { ws.cleanup(); }
});

test('an invalid file exits with code 1, lists row numbers and causes, and imports nothing', () => {
  const ws = workspace();
  try {
    const bad = ws.writeCsv('bad.csv', csvText(
      HEADER,
      'ORD-1,L-1,Avery,Keyboard,49.99,2026-09-28T10:00:00Z,Accessories',
      'ORD-2,L-2,Jordan,Mouse,-5,2026-09-28,Accessories',
      'ORD-3,L-3,Casey,Dock,12.5,28/09/2026,Connectivity',
      'ORD-4,L-1,Riley,Mat,3,2026-09-29,Workspace',
    ));
    const result = runScript('import-orders.js', [bad], { env: { DATABASE_PATH: ws.dbPath } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.stdout, /PROBLEMS \(3\)/);
    assert.match(result.stdout, /Row 3\s+\[amount\] amount "-5" is negative/);
    assert.match(result.stdout, /Row 4\s+\[created_at\] created_at "28\/09\/2026" is not a valid ISO date/);
    assert.match(result.stdout, /Row 5\s+\[line_item_id\] Duplicate line_item_id "L-1".*row 2/);
    assert.match(result.stdout, /RESULT: REJECTED\. Nothing was imported/);
    const db = ws.openDb();
    try { assert.equal(countRows(db), 0); } finally { db.close(); }
  } finally { ws.cleanup(); }
});

test('file-level failures exit with code 2 and a plain explanation', () => {
  const ws = workspace();
  try {
    const env = { DATABASE_PATH: ws.dbPath };
    const missing = runScript('import-orders.js', ['no-such-file.csv'], { env });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /File not found: no-such-file\.csv/);
    assert.match(missing.stderr, /Looked in:/);

    const notCsv = runScript('import-orders.js', [path.join(root, 'package.json')], { env });
    assert.equal(notCsv.code, 2);
    assert.match(notCsv.stderr, /Only \.csv files can be imported/);
    assert.match(notCsv.stderr, /CSV UTF-8/);

    const envFile = path.join(ws.dir, '.env');
    fs.writeFileSync(envFile, 'RESEND_API_KEY=re_not_a_real_secret_value');
    const secret = runScript('import-orders.js', [envFile], { env });
    assert.equal(secret.code, 2);
    assert.doesNotMatch(secret.output, /re_not_a_real_secret_value/, 'the contents of a non-CSV file are never read or echoed');

    const folder = runScript('import-orders.js', [ws.dir], { env });
    assert.equal(folder.code, 2);
    assert.match(folder.stderr, /is a folder, not a file/);

    const limited = runScript('import-orders.js', ['--dry-run', '--max-rows', '5', SAMPLE_CSV], { env });
    assert.equal(limited.code, 1);
    assert.match(limited.stdout, /18 data rows, which is more than the allowed maximum of 5/);

    const sized = runScript('import-orders.js', [SAMPLE_CSV], { env: { ...env, IMPORT_MAX_ROWS: '5' } });
    assert.equal(sized.code, 1, 'IMPORT_MAX_ROWS is honoured');
  } finally { ws.cleanup(); }
});

test('a relative file name works from the folder it was typed in (npm INIT_CWD) as well as from the repo root', () => {
  const ws = workspace();
  try {
    ws.writeCsv('mine.csv', csvText(HEADER, 'ORD-1,L-1,Avery,Keyboard,49.99,2026-09-28T10:00:00Z,Accessories'));
    const env = { DATABASE_PATH: ws.dbPath };
    // like `cd <folder>; npm run import:check -- mine.csv` (npm runs the script in the project root)
    const viaNpm = runScript('import-orders.js', ['--dry-run', 'mine.csv'], { cwd: root, env: { ...env, INIT_CWD: ws.dir } });
    assert.equal(viaNpm.code, 0, viaNpm.output);
    const direct = runScript('import-orders.js', ['--dry-run', 'mine.csv'], { cwd: ws.dir, env });
    assert.equal(direct.code, 0, direct.output);
    const quoted = runScript('import-orders.js', ['--dry-run', path.join(ws.dir, 'mine.csv')], { env });
    assert.equal(quoted.code, 0, quoted.output);
  } finally { ws.cleanup(); }
});

test('an Excel-style file (BOM, CRLF) imports through the CLI', () => {
  const ws = workspace();
  try {
    const file = ws.writeCsv('excel.csv', `\uFEFF${HEADER}\r\nORD-1,L-1,"Müller, Zoë",Keyboard,49.99,2026-09-28,Accessories\r\n`);
    const result = runScript('import-orders.js', [file], { env: { DATABASE_PATH: ws.dbPath } });
    assert.equal(result.code, 0, result.output);
    const db = ws.openDb();
    try { assert.equal(db.prepare('SELECT customer FROM orders').get().customer, 'Müller, Zoë'); } finally { db.close(); }
  } finally { ws.cleanup(); }
});

// ------------------------------------------------------------------ importing never emails, seeds or schedules

function localImports(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = fs.readFileSync(entry, 'utf8');
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) localImports(path.resolve(path.dirname(entry), match[1]), seen);
  return seen;
}

test('the import command cannot reach email, the scheduler, the server, the renderer or the seed script (static import graph)', () => {
  const files = [...localImports(path.join(root, 'scripts', 'import-orders.js'))].map((f) => path.relative(root, f).replace(/\\/g, '/'));
  for (const forbidden of ['src/email.js', 'src/cron.js', 'src/server.js', 'src/renderer.js', 'src/report-service.js', 'scripts/seed.js']) {
    assert.ok(!files.includes(forbidden), `import-orders.js must not (transitively) import ${forbidden}`);
  }
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /from\s+['"](resend|node-cron|express|puppeteer)['"]/, `${file} imports a delivery/server package`);
  }
  assert.ok(files.includes('src/order-import.js') && files.includes('src/order-validation.js') && files.includes('src/csv.js'));
});

test('even with email and scheduler variables enabled, importing sends nothing and starts nothing', () => {
  const ws = workspace();
  try {
    const result = runScript('import-orders.js', [SAMPLE_CSV], {
      env: { DATABASE_PATH: ws.dbPath, EMAIL_ENABLED: 'true', ENABLE_SCHEDULER: 'true', RESEND_API_KEY: 're_test_key_not_a_real_secret', EMAIL_FROM: 'a@example.com', EMAIL_TO: 'b@example.com' },
    });
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.output, /email|resend|scheduler/i);
    const db = ws.openDb();
    try {
      assert.equal(countRows(db, 'reports'), 0, 'no report was generated');
      assert.equal(countRows(db, 'email_deliveries'), 0, 'no email delivery was recorded');
    } finally { db.close(); }
  } finally { ws.cleanup(); }
});

// ------------------------------------------------------------------ verification command

test('orders:summary shows what was imported using the report definitions, and never writes', () => {
  const ws = workspace();
  try {
    const env = { DATABASE_PATH: ws.dbPath };
    const missing = runScript('orders-summary.js', [], { env });
    assert.equal(missing.code, 0);
    assert.match(missing.stdout, /There is no database yet/);
    assert.equal(fs.existsSync(ws.dbPath), false, 'the summary does not create a database');

    assert.equal(runScript('import-orders.js', [SAMPLE_CSV], { env }).code, 0);
    const before = ws.dbHash();
    const summary = runScript('orders-summary.js', ['--start', '2026-09-28', '--end', '2026-10-04', '--limit', '3'], { env });
    assert.equal(summary.code, 0, summary.output);
    assert.match(summary.stdout, /Line items:\s+18/);
    assert.match(summary.stdout, /Distinct orders:\s+12/);
    assert.match(summary.stdout, /Revenue:\s+USD 2,570\.21/);
    assert.match(summary.stdout, /Dates:\s+2026-09-28 to 2026-10-04/);
    assert.match(summary.stdout, /#1 .* sample-orders\.csv\s+18 rows, 12 orders \(skipped 0/);
    assert.match(summary.stdout, /Most recent 3 line item/);
    assert.match(summary.stdout, /Total orders:\s+12\s+\(distinct order IDs\)/);
    assert.match(summary.stdout, /Total revenue:\s+USD 2,570\.21/);
    assert.match(summary.stdout, /Average order value: USD 214\.18/);
    assert.equal(ws.dbHash(), before, 'read-only: the file is unchanged');

    assert.equal(runScript('orders-summary.js', ['--start', '2026-09-28'], { env }).code, 1);
  } finally { ws.cleanup(); }
});

// ------------------------------------------------------------------ report command arguments (validated before any browser starts)

test('npm run report: --start/--end are validated with clear messages (no browser needed)', () => {
  const ws = workspace();
  try {
    const env = { DATABASE_PATH: ws.dbPath, REPORTS_DIR: path.join(ws.dir, 'reports') };
    const cases = [
      [['--start', 'nope', '--end', 'nope'], /valid dates in YYYY-MM-DD/],
      [['--start', '2026-09-28'], /both startDate and endDate/],
      [['--end', '2026-10-04'], /both startDate and endDate/],
      [['--start', '2026-10-04', '--end', '2026-09-28'], /cannot be after/],
      [['--start'], /needs a date/],
      [['--strat', '2026-09-28'], /Unknown option "--strat"/],
    ];
    for (const [args, pattern] of cases) {
      const result = runScript('generate-report.js', args, { env });
      assert.equal(result.code, 1, JSON.stringify(args));
      assert.match(result.stderr, pattern, JSON.stringify(args));
    }
    // Rejected before anything was created: no PDF and no report record.
    const reportsDir = path.join(ws.dir, 'reports');
    assert.deepEqual(fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir) : [], []);
    const db = ws.openDb();
    try { assert.equal(countRows(db, 'reports'), 0); } finally { db.close(); }
  } finally { ws.cleanup(); }
});
