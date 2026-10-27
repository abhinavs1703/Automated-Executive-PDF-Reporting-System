import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFile(path.join(root, relative), 'utf8');

test('free Render Blueprint uses cloud mode, health check, and no paid persistent disk', async () => {
  const render = await read('render.yaml');
  assert.match(render, /plan:\s*free\b/);
  assert.match(render, /startCommand:\s*npm run start:cloud/);
  assert.match(render, /healthCheckPath:\s*\/health/);
  assert.doesNotMatch(render, /^\s+disk:\s*$/m);
  assert.match(render, /SUPABASE_URL/);
  assert.match(render, /SUPABASE_SECRET_KEY/);
  assert.match(render, /EMAIL_ENABLED[\s\S]*?value:\s*"false"/);
  assert.match(render, /ENABLE_SCHEDULER[\s\S]*?value:\s*"false"/);
});

test('cloud migration defines private organisation tables and private file bucket', async () => {
  const sql = await read('supabase/migrations/0001_execubrief_cloud.sql');
  for (const table of ['organizations', 'app_users', 'organization_memberships', 'auth_sessions', 'workspace_imports', 'custom_reports']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}\\b`, 'i'));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  }
  assert.match(sql, /values\s*\('execubrief-private',\s*'execubrief-private',\s*false/i);
  assert.match(sql, /grant execute on function public\.execubrief_register_user[\s\S]*?to service_role/i);
  assert.match(sql, /security definer set search_path = pg_catalog, public/i, 'security-definer functions pin a system-first search path');
});

test('release template and ignore rules do not publish real secrets or local customer data', async () => {
  const env = await read('.env.example');
  const ignore = await read('.gitignore');
  assert.match(ignore, /(^|\n)\.env(\n|$)/);
  assert.match(ignore, /node_modules/);
  assert.match(ignore, /\*\.sqlite/);
  assert.match(env, /SUPABASE_URL=/);
  assert.match(env, /SUPABASE_SECRET_KEY=/);
  const keyLine = env.split(/\r?\n/).find((line) => line.startsWith('SUPABASE_SECRET_KEY='));
  assert.equal(keyLine, 'SUPABASE_SECRET_KEY=', 'the Supabase secret key must remain a blank placeholder');
  const legacyKeyLine = env.split(/\r?\n/).find((line) => line.startsWith('SUPABASE_SERVICE_ROLE_KEY='));
  assert.equal(legacyKeyLine, 'SUPABASE_SERVICE_ROLE_KEY=', 'legacy key compatibility must also remain a blank placeholder');
});


test('cloud PDF generation creates the ephemeral parent directory before mkdtemp', async () => {
  const cloudApp = await read('src/cloud-app.js');
  const mkdirAt = cloudApp.indexOf("await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });");
  const mkdtempAt = cloudApp.indexOf("const tmp = await fs.mkdtemp(path.join(tempRoot, 'pdf-'));");
  assert.ok(mkdirAt >= 0, 'must create the private temp root');
  assert.ok(mkdtempAt > mkdirAt, 'must create temp root before asking mkdtemp to use it');
});
