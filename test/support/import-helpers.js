import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../../src/db.js';
import { importOrders } from '../../src/order-import.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
import { buildSampleOrdersCsv } from '../../src/sample-data.js';

/** The sample file that ships in the repository (its week changes when it is refreshed). */
export const COMMITTED_SAMPLE_CSV = path.join(root, 'examples', 'sample-orders.csv');

/**
 * A sample file for a FIXED week, generated into a temp folder, so tests never depend on which
 * week the committed example currently covers or on today's date.
 */
export const FIXTURE_WEEK = { startDate: '2026-09-28', endDate: '2026-10-04' };
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-fixture-'));
export const SAMPLE_CSV = path.join(fixtureDir, 'sample-orders.csv');
fs.writeFileSync(SAMPLE_CSV, buildSampleOrdersCsv(FIXTURE_WEEK.startDate));
process.on('exit', () => fs.rmSync(fixtureDir, { recursive: true, force: true }));
export const HEADER = 'order_id,line_item_id,customer,product,amount,created_at,category';

export const csvText = (...lines) => `${lines.join('\n')}\n`;

/** A temporary folder with a file-backed database and helpers; call cleanup() when done. */
export function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-test-'));
  const dbPath = path.join(dir, 'orders.db');
  const writeCsv = (name, text) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  };
  return {
    dir,
    dbPath,
    writeCsv,
    openDb: () => createDatabase(dbPath),
    dbHash: () => crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Import CSV text (written to a temp file) into `database`. */
export function importText(workspaceHandle, database, text, options = {}) {
  const filePath = workspaceHandle.writeCsv(`import-${Math.random().toString(36).slice(2)}.csv`, text);
  return importOrders({ database, filePath, now: new Date('2026-10-11T12:00:00Z'), ...options });
}

export const countRows = (database, table = 'orders') => Number(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

/** Run a project script in a child process, isolated from the developer's .env and email settings. */
export function runScript(script, args = [], { cwd = os.tmpdir(), env = {} } = {}) {
  const base = { ...process.env };
  for (const name of ['INIT_CWD', 'EMAIL_ENABLED', 'ENABLE_SCHEDULER', 'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_TO', 'DATABASE_PATH', 'REPORTS_DIR', 'IMPORT_MAX_ROWS', 'IMPORT_MAX_FILE_MB']) delete base[name];
  base.DOTENV_CONFIG_PATH = path.join(os.tmpdir(), `no-such-env-${process.pid}`);
  const result = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', script), ...args], {
    cwd, encoding: 'utf8', env: { ...base, ...env },
  });
  const normalise = (text) => (text ?? '').replace(/\r\n/g, '\n');
  return { code: result.status, stdout: normalise(result.stdout), stderr: normalise(result.stderr), output: normalise(result.stdout) + normalise(result.stderr) };
}
