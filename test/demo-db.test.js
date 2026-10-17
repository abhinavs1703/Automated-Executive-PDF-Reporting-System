import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const initScript = path.join(root, 'scripts', 'init-demo.js');

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function cleanEnv(overrides) {
  const env = { ...process.env, DOTENV_CONFIG_PATH: path.join(os.tmpdir(), `execubrief-no-env-${process.pid}`), ...overrides };
  for (const key of ['ENABLE_SCHEDULER', 'EMAIL_ENABLED', 'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_TO']) delete env[key];
  return env;
}

function runInit(env) {
  return spawnSync(process.execPath, [initScript], { cwd: os.tmpdir(), encoding: 'utf8', env: cleanEnv(env) });
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'execubrief-demo-db-'));
}

test('demo initialization is repeatable and does not touch private SQLite data', () => {
  const dir = makeTempDir();
  const privateDbPath = path.join(dir, 'private.db');
  const demoDbPath = path.join(dir, 'demo', 'demo-report.db');
  const privateReportsDir = path.join(dir, 'private-reports');
  const demoReportsDir = path.join(dir, 'demo', 'reports');
  const privateDb = createDatabase(privateDbPath);
  privateDb.prepare(`INSERT INTO orders (order_id, line_item_id, customer, product, amount, created_at, category)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('PRIVATE-1', 'PRIVATE-L1', 'Private Fixture', 'Private Product', 1234, '2026-10-01T10:00:00Z', 'Private');
  privateDb.close();
  const privateHashBefore = hashFile(privateDbPath);

  try {
    const env = {
      DATABASE_PATH: privateDbPath,
      REPORTS_DIR: privateReportsDir,
      DEMO_DATABASE_PATH: demoDbPath,
      DEMO_REPORTS_DIR: demoReportsDir,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
    };
    const first = runInit(env);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /synthetic demo storage is initialized/i);
    assert.equal(fs.existsSync(demoDbPath), true);
    assert.equal(fs.existsSync(demoReportsDir), true);
    const demoDb = createDatabase(demoDbPath);
    const before = demoDb.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT order_id) AS orders FROM orders').get();
    assert.equal(before.n, 240);
    assert.ok(before.orders > 0);
    demoDb.close();
    const demoHashBefore = hashFile(demoDbPath);

    const second = runInit(env);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    const check = createDatabase(demoDbPath);
    const after = check.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT order_id) AS orders FROM orders').get();
    check.close();
    assert.deepEqual(after, before, 'repeat initialization must not duplicate sample orders');
    assert.equal(hashFile(demoDbPath), demoHashBefore, 'repeat initialization should not rewrite the seeded demo database');
    assert.equal(hashFile(privateDbPath), privateHashBefore, 'private database bytes must remain unchanged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('demo initialization refuses a path equal to the private database path', () => {
  const dir = makeTempDir();
  const privateDbPath = path.join(dir, 'private.db');
  const privateDb = createDatabase(privateDbPath);
  privateDb.prepare(`INSERT INTO orders (order_id, line_item_id, customer, product, amount, created_at, category)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('PRIVATE-1', 'PRIVATE-L1', 'Private Fixture', 'Private Product', 99, '2026-10-01T10:00:00Z', 'Private');
  privateDb.close();
  const before = hashFile(privateDbPath);
  try {
    const result = runInit({
      DATABASE_PATH: privateDbPath,
      REPORTS_DIR: path.join(dir, 'private-reports'),
      DEMO_DATABASE_PATH: privateDbPath,
      DEMO_REPORTS_DIR: path.join(dir, 'demo-reports'),
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be different from DATABASE_PATH/i);
    assert.equal(hashFile(privateDbPath), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('demo initialization refuses an existing unmarked database without migrating or exposing it', () => {
  const dir = makeTempDir();
  const unknownDbPath = path.join(dir, 'unknown.db');
  const unknownDb = createDatabase(unknownDbPath);
  unknownDb.prepare(`INSERT INTO orders (order_id, line_item_id, customer, product, amount, created_at, category)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('UNKNOWN-1', 'UNKNOWN-L1', 'Unknown Fixture', 'Unknown Product', 9, '2026-10-01T10:00:00Z', 'Unknown');
  unknownDb.close();
  const before = hashFile(unknownDbPath);
  try {
    const result = runInit({
      DATABASE_PATH: path.join(dir, 'private.db'),
      REPORTS_DIR: path.join(dir, 'private-reports'),
      DEMO_DATABASE_PATH: unknownDbPath,
      DEMO_REPORTS_DIR: path.join(dir, 'demo-reports'),
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not marked as synthetic demo data/i);
    assert.equal(hashFile(unknownDbPath), before, 'unknown database must not be migrated or seeded');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
