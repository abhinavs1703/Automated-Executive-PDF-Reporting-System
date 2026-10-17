import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt);
const PASSWORD_BYTES = 64;
const PASSWORD_SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_AUTH_PATH = config.authDatabasePath;
const DEFAULT_PRIVATE_DB_PATH = config.databasePath;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthError extends Error {
  constructor(message, status = 400, code = 'AUTH_ERROR') {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function ensurePrivatePath(databasePath) {
  if (databasePath === ':memory:') return ':memory:';
  const candidate = path.isAbsolute(databasePath) ? path.resolve(databasePath) : path.resolve(config.projectRoot, databasePath);
  if (samePath(candidate, DEFAULT_PRIVATE_DB_PATH)) {
    throw new Error('AUTH_DATABASE_PATH must be separate from DATABASE_PATH.');
  }
  fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
  return candidate;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') throw new AuthError('Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new AuthError('Enter a valid email address.');
  return email;
}

function normalizeName(value, email) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (name.length > 100) throw new AuthError('Name must be 100 characters or fewer.');
  return name || email.split('@')[0].slice(0, 80);
}

function normalizeOrganizationName(value, displayName, email) {
  // Accounts created before organisation registration remain usable after the migration.
  if (value === undefined || value === null) return `${displayName || email.split('@')[0]}'s workspace`.slice(0, 100);
  if (typeof value !== 'string') throw new AuthError('Enter your organisation name.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) throw new AuthError('Organisation name must contain 2 to 100 characters.');
  return name;
}

function slugBase(name) {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'organisation';
}

function safeUser(row) {
  if (!row) return null;
  const organization = row.organization_id ? {
    id: row.organization_id,
    name: row.organization_name,
    slug: row.organization_slug,
    role: row.organization_role || 'member',
  } : null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture || null,
    createdAt: row.created_at,
    organization,
  };
}

const USER_WITH_ORGANIZATION_SQL = `
  SELECT u.*, o.id AS organization_id, o.name AS organization_name,
         o.slug AS organization_slug, m.role AS organization_role
  FROM users u
  LEFT JOIN organization_memberships m ON m.user_id = u.id
  LEFT JOIN organizations o ON o.id = m.organization_id
`;

function createOrganization(database, userId, name, role = 'owner') {
  const id = crypto.randomUUID();
  const slug = `${slugBase(name)}-${crypto.randomBytes(4).toString('hex')}`;
  const createdAt = new Date().toISOString();
  database.prepare('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)')
    .run(id, name, slug, createdAt);
  database.prepare('INSERT INTO organization_memberships (organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
    .run(id, userId, role, createdAt);
  return { id, name, slug, role };
}

function columnsFor(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function migrateOrganizations(database) {
  // Additive migrations only: existing users, sessions, and reports are preserved.
  if (!columnsFor(database, 'auth_sessions').has('organization_id')) {
    database.exec('ALTER TABLE auth_sessions ADD COLUMN organization_id TEXT REFERENCES organizations(id)');
  }
  if (!columnsFor(database, 'custom_reports').has('organization_id')) {
    database.exec('ALTER TABLE custom_reports ADD COLUMN organization_id TEXT REFERENCES organizations(id)');
  }
  for (const [column, definition] of [
    ['rows_received', 'INTEGER NOT NULL DEFAULT 0'],
    ['duplicates_skipped', 'INTEGER NOT NULL DEFAULT 0'],
    ['invalid_rows', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (!columnsFor(database, 'custom_reports').has(column)) {
      database.exec(`ALTER TABLE custom_reports ADD COLUMN ${column} ${definition}`);
    }
  }

  const unassigned = database.prepare(`
    SELECT u.id, u.email, u.name FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM organization_memberships m WHERE m.user_id = u.id)
  `).all();
  for (const user of unassigned) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const name = normalizeOrganizationName(undefined, user.name, user.email);
      const organization = createOrganization(database, user.id, name);
      database.prepare('UPDATE custom_reports SET organization_id = ? WHERE user_id = ? AND organization_id IS NULL')
        .run(organization.id, user.id);
      database.prepare('UPDATE auth_sessions SET organization_id = ? WHERE user_id = ? AND organization_id IS NULL')
        .run(organization.id, user.id);
      database.exec('COMMIT');
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  database.exec(`
    UPDATE custom_reports
    SET organization_id = (
      SELECT m.organization_id FROM organization_memberships m
      WHERE m.user_id = custom_reports.user_id
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at
      LIMIT 1
    )
    WHERE organization_id IS NULL;

    UPDATE auth_sessions
    SET organization_id = (
      SELECT m.organization_id FROM organization_memberships m
      WHERE m.user_id = auth_sessions.user_id
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at
      LIMIT 1
    )
    WHERE organization_id IS NULL;

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_custom_reports_user_created ON custom_reports(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_custom_reports_org_created ON custom_reports(organization_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memberships_user ON organization_memberships(user_id, created_at);
  `);
}

export function openAuthStore(databasePath = DEFAULT_AUTH_PATH) {
  const target = ensurePrivatePath(databasePath);
  const database = new DatabaseSync(target);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_salt TEXT,
      password_hash TEXT,
      google_sub TEXT UNIQUE,
      picture TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organization_memberships (
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id TEXT REFERENCES organizations(id),
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS custom_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id TEXT REFERENCES organizations(id),
      job_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source_file TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      rows_received INTEGER NOT NULL DEFAULT 0,
      duplicates_skipped INTEGER NOT NULL DEFAULT 0,
      invalid_rows INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
      from_date TEXT,
      to_date TEXT,
      created_at TEXT NOT NULL,
      summary_json TEXT,
      error TEXT
    );
  `);
  migrateOrganizations(database);

  const getUserById = (userId) => safeUser(database.prepare(`${USER_WITH_ORGANIZATION_SQL}
    WHERE u.id = ?
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at
    LIMIT 1`).get(userId));
  const getUserByEmail = (email) => safeUser(database.prepare(`${USER_WITH_ORGANIZATION_SQL}
    WHERE u.email = ?
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at
    LIMIT 1`).get(email));
  const getUserByGoogleSub = (sub) => safeUser(database.prepare(`${USER_WITH_ORGANIZATION_SQL}
    WHERE u.google_sub = ?
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at
    LIMIT 1`).get(sub));

  function resolveOrganizationId(organizationOrUserId) {
    const direct = database.prepare('SELECT id FROM organizations WHERE id = ?').get(organizationOrUserId);
    if (direct) return direct.id;
    const membership = database.prepare(`SELECT organization_id FROM organization_memberships WHERE user_id = ?
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, created_at LIMIT 1`).get(organizationOrUserId);
    return membership?.organization_id || null;
  }

  return {
    database,
    async register({ email: rawEmail, password, name, organizationName }) {
      const email = normalizeEmail(rawEmail);
      if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
        throw new AuthError('Use a password between 12 and 128 characters.');
      }
      const displayName = normalizeName(name, email);
      const displayOrganizationName = normalizeOrganizationName(organizationName, displayName, email);
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = Buffer.from(await scrypt(password, salt, PASSWORD_BYTES, PASSWORD_SCRYPT)).toString('hex');
      const user = {
        id: crypto.randomUUID(), email, name: displayName, password_salt: salt, password_hash: passwordHash,
        picture: null, created_at: new Date().toISOString(),
      };
      let transaction = false;
      try {
        database.exec('BEGIN IMMEDIATE');
        transaction = true;
        database.prepare('INSERT INTO users (id,email,name,password_salt,password_hash,created_at) VALUES (?,?,?,?,?,?)')
          .run(user.id, user.email, user.name, user.password_salt, user.password_hash, user.created_at);
        createOrganization(database, user.id, displayOrganizationName);
        database.exec('COMMIT');
        transaction = false;
      } catch (error) {
        if (transaction) {
          try { database.exec('ROLLBACK'); } catch { /* transaction already ended */ }
        }
        if (String(error.message).includes('UNIQUE constraint failed: users.email')) {
          throw new AuthError('An account with that email already exists. Sign in instead.', 409, 'EMAIL_EXISTS');
        }
        throw error;
      }
      return getUserById(user.id);
    },
    async login({ email: rawEmail, password }) {
      let email;
      try { email = normalizeEmail(rawEmail); } catch { throw new AuthError('Email or password is incorrect.', 401, 'INVALID_CREDENTIALS'); }
      const row = database.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!row || !row.password_salt || !row.password_hash || typeof password !== 'string' || password.length > 128) {
        await scrypt(String(password || 'invalid'), 'execubrief-dummy-salt', PASSWORD_BYTES, PASSWORD_SCRYPT);
        throw new AuthError('Email or password is incorrect.', 401, 'INVALID_CREDENTIALS');
      }
      const candidate = Buffer.from(await scrypt(password, row.password_salt, PASSWORD_BYTES, PASSWORD_SCRYPT));
      const expected = Buffer.from(row.password_hash, 'hex');
      if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
        throw new AuthError('Email or password is incorrect.', 401, 'INVALID_CREDENTIALS');
      }
      return getUserById(row.id);
    },
    getOrCreateGoogleUser({ sub, email: rawEmail, name, picture, emailVerified }) {
      if (typeof sub !== 'string' || !sub || sub.length > 255) throw new AuthError('Google did not return a valid account identifier.', 401, 'GOOGLE_IDENTITY_INVALID');
      if (emailVerified !== true) throw new AuthError('Google must confirm this email address before sign-in.', 401, 'GOOGLE_EMAIL_UNVERIFIED');
      const email = normalizeEmail(rawEmail);
      const safePicture = typeof picture === 'string' && picture.startsWith('https://') && picture.length <= 2048 ? picture : null;
      const bySub = getUserByGoogleSub(sub);
      if (bySub) return bySub;
      const byEmail = database.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (byEmail) {
        if (byEmail.google_sub && byEmail.google_sub !== sub) throw new AuthError('This email is already linked to a different Google account.', 409, 'GOOGLE_ACCOUNT_CONFLICT');
        database.prepare('UPDATE users SET google_sub = ?, name = ?, picture = COALESCE(?, picture) WHERE id = ?')
          .run(sub, normalizeName(name, email), safePicture, byEmail.id);
        return getUserById(byEmail.id);
      }
      const user = { id: crypto.randomUUID(), email, name: normalizeName(name, email), picture: safePicture, created_at: new Date().toISOString() };
      let transaction = false;
      try {
        database.exec('BEGIN IMMEDIATE');
        transaction = true;
        database.prepare('INSERT INTO users (id,email,name,google_sub,picture,created_at) VALUES (?,?,?,?,?,?)')
          .run(user.id, user.email, user.name, sub, user.picture, user.created_at);
        createOrganization(database, user.id, `${user.name}'s workspace`.slice(0, 100));
        database.exec('COMMIT');
        transaction = false;
      } catch (error) {
        if (transaction) {
          try { database.exec('ROLLBACK'); } catch { /* transaction already ended */ }
        }
        // A concurrent first-time OAuth callback may have inserted the same email or Google sub.
        if (String(error.message).includes('UNIQUE constraint failed')) {
          const existing = getUserByGoogleSub(sub) || getUserByEmail(email);
          if (existing) return existing;
        }
        throw error;
      }
      return getUserById(user.id);
    },
    createSession(userId, requestedOrganizationId) {
      const user = getUserById(userId);
      const organizationId = requestedOrganizationId || user?.organization?.id;
      const isMember = organizationId && database.prepare('SELECT 1 FROM organization_memberships WHERE user_id = ? AND organization_id = ?')
        .get(userId, organizationId);
      if (!user || !isMember) throw new AuthError('Your account is not a member of that organisation.', 403, 'ORGANIZATION_ACCESS_DENIED');
      const rawToken = crypto.randomBytes(32).toString('base64url');
      const csrfToken = crypto.randomBytes(32).toString('base64url');
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
      database.prepare('INSERT INTO auth_sessions (token_hash,user_id,organization_id,csrf_token,created_at,expires_at) VALUES (?,?,?,?,?,?)')
        .run(sha256(rawToken), userId, organizationId, csrfToken, createdAt.toISOString(), expiresAt.toISOString());
      return { rawToken, csrfToken, organizationId, expiresAt: expiresAt.toISOString(), maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) };
    },
    resolveSession(rawToken) {
      if (typeof rawToken !== 'string' || rawToken.length < 32 || rawToken.length > 128) return null;
      const row = database.prepare(`
        SELECT s.token_hash, s.csrf_token, s.expires_at, u.id, u.email, u.name, u.picture, u.created_at,
               o.id AS organization_id, o.name AS organization_name, o.slug AS organization_slug,
               m.role AS organization_role
        FROM auth_sessions s
        JOIN users u ON u.id = s.user_id
        JOIN organization_memberships m ON m.user_id = u.id AND m.organization_id = s.organization_id
        JOIN organizations o ON o.id = s.organization_id
        WHERE s.token_hash = ? AND s.expires_at > ?
      `).get(sha256(rawToken), new Date().toISOString());
      return row ? { user: safeUser(row), csrfToken: row.csrf_token, expiresAt: row.expires_at } : null;
    },
    revokeSession(rawToken) {
      if (typeof rawToken !== 'string' || rawToken.length < 32 || rawToken.length > 128) return;
      database.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(rawToken));
    },
    listCustomReports(organizationOrUserId, limit = 25) {
      const organizationId = resolveOrganizationId(organizationOrUserId);
      if (!organizationId) return [];
      return database.prepare(`SELECT id, user_id AS createdByUserId, organization_id AS organizationId, job_id, title,
        source_file AS sourceFile, row_count AS rowCount, rows_received AS rowsReceived,
        duplicates_skipped AS duplicatesSkipped, invalid_rows AS invalidRows, currency, status,
        from_date AS startDate, to_date AS endDate, created_at AS createdAt,
        summary_json AS summaryJson, error
        FROM custom_reports WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(organizationId, Math.min(50, Math.max(1, limit)));
    },
    getCustomReport(organizationOrUserId, reportId) {
      const organizationId = resolveOrganizationId(organizationOrUserId);
      if (!organizationId) return null;
      return database.prepare(`SELECT id, user_id AS createdByUserId, organization_id AS organizationId, job_id, title, source_file AS sourceFile, row_count AS rowCount,
        rows_received AS rowsReceived, duplicates_skipped AS duplicatesSkipped, invalid_rows AS invalidRows,
        currency, status, from_date AS startDate, to_date AS endDate, created_at AS createdAt, summary_json AS summaryJson, error
        FROM custom_reports WHERE organization_id = ? AND id = ?`).get(organizationId, reportId) || null;
    },
    createCustomReport(report) {
      const organizationId = report.organizationId || resolveOrganizationId(report.userId);
      if (!organizationId) throw new AuthError('An organisation workspace is required to save this report.', 400, 'ORGANIZATION_REQUIRED');
      const membership = database.prepare('SELECT 1 FROM organization_memberships WHERE organization_id = ? AND user_id = ?')
        .get(organizationId, report.userId);
      if (!membership) throw new AuthError('You are not a member of this organisation.', 403, 'ORGANIZATION_ACCESS_DENIED');
      database.prepare(`INSERT INTO custom_reports
        (id,user_id,organization_id,job_id,title,source_file,row_count,rows_received,duplicates_skipped,invalid_rows,currency,status,from_date,to_date,created_at,summary_json,error)
        VALUES (?,?,?,?,?,?,?,?,?, ?,?,'pending',?,?,?,NULL,NULL)`)
        .run(report.id, report.userId, organizationId, report.jobId, report.title, report.sourceFile, report.rowCount,
          report.rowsReceived ?? report.rowCount, report.duplicatesSkipped ?? 0, report.invalidRows ?? 0, report.currency,
          report.startDate ?? null, report.endDate ?? null, report.createdAt ?? new Date().toISOString());
    },
    updateCustomReport(reportId, organizationOrUserId, update) {
      const organizationId = resolveOrganizationId(organizationOrUserId);
      if (!organizationId) return { changes: 0 };
      return database.prepare(`UPDATE custom_reports SET status = ?, from_date = ?, to_date = ?, summary_json = ?, error = ? WHERE id = ? AND organization_id = ?`)
        .run(update.status, update.startDate ?? null, update.endDate ?? null, update.summary ? JSON.stringify(update.summary) : null,
          update.error ?? null, reportId, organizationId);
    },
    deleteExpiredSessions(now = new Date().toISOString()) {
      return database.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now).changes;
    },
    close() { database.close(); },
  };
}

let defaultStore;
export function getAuthStore() {
  if (!defaultStore) defaultStore = openAuthStore(DEFAULT_AUTH_PATH);
  return defaultStore;
}
export function closeAuthStore() {
  try { defaultStore?.close(); } catch { /* already closed */ }
  defaultStore = undefined;
}
export const authLimits = Object.freeze({ sessionTtlMs: SESSION_TTL_MS });
