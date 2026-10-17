import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ESM specifiers must be URLs, not raw file paths: on Windows an absolute path such as
 * C:\\repo\\src\\config.js is rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME.
 * pathToFileURL() produces a valid file:// URL on every platform.
 */
const moduleUrl = (relativePath) => pathToFileURL(path.join(root, relativePath)).href;

/** Run a snippet of ESM in a child process whose working directory is NOT the repo root. */
function runElsewhere(code, env = {}) {
  const cwd = os.tmpdir();
  assert.notEqual(path.resolve(cwd), root);
  return execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], {
    cwd, encoding: 'utf8', env: { ...process.env, DATABASE_PATH: '', REPORTS_DIR: '', ...env },
  });
}

test('config paths and assets resolve from the repository, not the working directory', () => {
  const out = JSON.parse(runElsewhere(`
    import { config } from ${JSON.stringify(moduleUrl('src/config.js'))};
    console.log(JSON.stringify({ root: config.projectRoot, db: config.databasePath, reports: config.reportsDir, template: config.templatePath }));
  `));
  assert.equal(out.root, root);
  assert.equal(out.db, path.join(root, 'data', 'report.db'));
  assert.equal(out.reports, path.join(root, 'reports'));
  assert.equal(out.template, path.join(root, 'templates', 'executive-report.hbs'));
});

test('buildHtmlReport finds the template and the bundled Chart.js from another working directory', () => {
  const html = runElsewhere(`
    import { buildHtmlReport } from ${JSON.stringify(moduleUrl('src/renderer.js'))};
    import { createDatabase } from ${JSON.stringify(moduleUrl('src/db.js'))};
    import { getReportData } from ${JSON.stringify(moduleUrl('src/analytics.js'))};
    const database = createDatabase(':memory:');
    const data = getReportData({ database, startDate: '2026-09-28', endDate: '2026-10-04' });
    const out = await buildHtmlReport(data);
    console.log(JSON.stringify({ length: out.length, hasChart: out.includes('Chart.js v4'), hasTitle: out.includes('Weekly Executive') }));
  `);
  const parsed = JSON.parse(html);
  assert.ok(parsed.length > 100_000, 'Chart.js bundle is inlined');
  assert.equal(parsed.hasChart, true);
  assert.equal(parsed.hasTitle, true);
});

test('relative DATABASE_PATH / REPORTS_DIR are anchored to the repository root', () => {
  const out = JSON.parse(runElsewhere(`
    import { config } from ${JSON.stringify(moduleUrl('src/config.js'))};
    console.log(JSON.stringify({ db: config.databasePath, reports: config.reportsDir }));
  `, { DATABASE_PATH: 'data/custom.db', REPORTS_DIR: 'out/pdfs' }));
  assert.equal(out.db, path.join(root, 'data', 'custom.db'));
  assert.equal(out.reports, path.join(root, 'out', 'pdfs'));
});

test('seed script works from another working directory (temporary database)', async () => {
  const dbPath = path.join(os.tmpdir(), `seed-check-${process.pid}.db`);
  const output = execFileSync(process.execPath, ['--no-warnings', path.join(root, 'scripts/seed.js')], {
    cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, DATABASE_PATH: dbPath },
  });
  assert.match(output, /Seeded 240/);
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(dbPath);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 240);
  assert.equal(database.prepare('SELECT COUNT(DISTINCT category) AS n FROM orders').get().n, 5);
  database.close();
  const { rmSync } = await import('node:fs');
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
});
