import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openAuthStore, AuthError } from '../src/auth-store.js';

const password = 'a-sufficiently-long-test-password';

test('auth store registers accounts with normalized email, hashed passwords, and an opaque session', async () => {
  const store = openAuthStore(':memory:');
  try {
    const user = await store.register({ email: '  Person@Example.com ', password, name: 'Test Person' });
    assert.equal(user.email, 'person@example.com');
    assert.equal(user.name, 'Test Person');
    assert.equal(user.organization.name, "Test Person's workspace");
    assert.equal(user.organization.role, 'owner');
    const session = store.createSession(user.id);
    assert.ok(session.rawToken.length >= 32);
    assert.ok(session.csrfToken.length >= 32);
    assert.equal(store.resolveSession(session.rawToken).user.id, user.id);
    assert.equal(store.resolveSession('invalid-token'), null);
    store.revokeSession(session.rawToken);
    assert.equal(store.resolveSession(session.rawToken), null);
  } finally { store.close(); }
});

test('auth store rejects duplicate accounts and incorrect passwords without disclosing account state at login', async () => {
  const store = openAuthStore(':memory:');
  try {
    await store.register({ email: 'person@example.com', password, name: 'Test Person' });
    await assert.rejects(store.register({ email: 'PERSON@example.com', password, name: 'Other' }), (error) => error instanceof AuthError && error.status === 409);
    await assert.rejects(store.login({ email: 'person@example.com', password: 'wrong password' }), (error) => error instanceof AuthError && error.status === 401 && /Email or password is incorrect/.test(error.message));
    await assert.rejects(store.login({ email: 'missing@example.com', password }), (error) => error instanceof AuthError && error.status === 401 && /Email or password is incorrect/.test(error.message));
  } finally { store.close(); }
});

test('auth store enforces password length and links a verified Google identity to an existing email', async () => {
  const store = openAuthStore(':memory:');
  try {
    await assert.rejects(store.register({ email: 'person@example.com', password: 'short', name: '' }), AuthError);
    const user = await store.register({ email: 'person@example.com', password, name: 'Person', organizationName: 'Northwind Analytics' });
    assert.equal(user.organization.name, 'Northwind Analytics');
    assert.match(user.organization.slug, /^northwind-analytics-/);
    const linked = store.getOrCreateGoogleUser({ sub: 'google-sub-123', email: 'person@example.com', name: 'Person Google', picture: 'https://example.com/p.png', emailVerified: true });
    assert.equal(linked.id, user.id);
    assert.equal(linked.name, 'Person Google');
    await assert.rejects(Promise.resolve().then(() => store.getOrCreateGoogleUser({ sub: 'sub-2', email: 'unverified@example.com', name: 'User', emailVerified: false })), AuthError);
  } finally { store.close(); }
});

test('file-backed auth storage opens without an internal config error and keeps organisation metadata', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'execubrief-auth-store-'));
  const databasePath = path.join(directory, 'auth.sqlite');
  let store;
  try {
    store = openAuthStore(databasePath);
    const user = await store.register({ email: 'path-check@example.com', password, name: 'Path Check', organizationName: 'Contoso Group' });
    const session = store.createSession(user.id, user.organization.id);
    const resolved = store.resolveSession(session.rawToken);
    assert.equal(resolved.user.organization.id, user.organization.id);
    assert.equal(resolved.user.organization.name, 'Contoso Group');
    store.close();
    store = null;
    assert.ok((await fs.stat(databasePath)).isFile());
  } finally {
    try { store?.close(); } catch { /* store already closed */ }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('legacy users and reports are assigned a private workspace by additive migration', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'execubrief-auth-migration-'));
  const databasePath = path.join(directory, 'auth.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
        password_salt TEXT, password_hash TEXT, google_sub TEXT UNIQUE, picture TEXT, created_at TEXT NOT NULL);
      CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE custom_reports (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL, title TEXT NOT NULL, source_file TEXT NOT NULL, row_count INTEGER NOT NULL,
        currency TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
        from_date TEXT, to_date TEXT, created_at TEXT NOT NULL, summary_json TEXT, error TEXT);
      INSERT INTO users (id,email,name,created_at) VALUES ('legacy-user','legacy@example.com','Legacy User','2026-01-01T00:00:00.000Z');
      INSERT INTO custom_reports (id,user_id,job_id,title,source_file,row_count,currency,status,created_at)
        VALUES ('legacy-report','legacy-user','legacy-job','Legacy report','legacy.csv',1,'USD','completed','2026-01-02T00:00:00.000Z');
    `);
  } finally { legacy.close(); }

  let store;
  try {
    store = openAuthStore(databasePath);
    const user = await store.login({ email: 'legacy@example.com', password: 'a-password-never-set' }).catch((error) => error);
    assert.ok(user instanceof AuthError, 'legacy account must not gain an implicit password');
    const info = store.database.prepare(`SELECT r.organization_id, o.name FROM custom_reports r JOIN organizations o ON o.id = r.organization_id WHERE r.id = 'legacy-report'`).get();
    assert.ok(info.organization_id);
    assert.match(info.name, /Legacy User/);
    assert.equal(store.listCustomReports(info.organization_id).length, 1);
  } finally {
    try { store?.close(); } catch { /* store already closed */ }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('custom report history is scoped to the creating user', async () => {
  const store = openAuthStore(':memory:');
  try {
    const one = await store.register({ email: 'one@example.com', password, name: 'One' });
    const two = await store.register({ email: 'two@example.com', password, name: 'Two' });
    store.createCustomReport({ id: '11111111-1111-4111-8111-111111111111', userId: one.id, jobId: 'job', title: 'One report', sourceFile: 'one.csv', rowCount: 1, currency: 'USD', startDate: '2026-01-01', endDate: '2026-01-01' });
    assert.equal(store.listCustomReports(one.id).length, 1);
    assert.equal(store.listCustomReports(two.id).length, 0);
    assert.equal(store.getCustomReport(two.id, '11111111-1111-4111-8111-111111111111'), null);
  } finally { store.close(); }
});
