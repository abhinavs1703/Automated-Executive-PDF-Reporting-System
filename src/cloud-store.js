import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const PASSWORD_BYTES = 64;
const PASSWORD_SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class CloudStoreError extends Error {
  constructor(message, { status = 503, code = 'CLOUD_STORE_ERROR' } = {}) {
    super(message);
    this.name = 'CloudStoreError';
    this.status = status;
    this.code = code;
  }
}

function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length > 254) throw new CloudStoreError('Enter a valid email address.', { status: 400, code: 'INVALID_EMAIL' });
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CloudStoreError('Enter a valid email address.', { status: 400, code: 'INVALID_EMAIL' });
  return email;
}
function normalizeName(value, email) {
  const name = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return (name || email.split('@')[0]).slice(0, 120);
}
function normalizeOrganizationName(value, displayName, email) {
  const name = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const result = name || `${displayName}'s workspace`;
  if (result.length > 100) throw new CloudStoreError('Organisation name must be 100 characters or fewer.', { status: 400, code: 'INVALID_ORGANIZATION' });
  if (!result) throw new CloudStoreError(`Enter an organisation name (for example, ${email.split('@')[1]} team).`, { status: 400, code: 'INVALID_ORGANIZATION' });
  return result;
}
function safePicture(value) {
  return typeof value === 'string' && value.startsWith('https://') && value.length <= 2048 ? value : null;
}
function safeObjectPath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('..') || /[\u0000-\u001f\\]/.test(value)) {
    throw new CloudStoreError('Invalid cloud storage path.', { status: 400, code: 'INVALID_STORAGE_PATH' });
  }
  return value.split('/').map((part) => encodeURIComponent(part)).join('/');
}
function safeUser(user, organization) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture || null,
    created_at: user.created_at,
    organization: organization ? { id: organization.id, name: organization.name, reportCurrency: organization.report_currency || null } : null,
  };
}
function rowReport(row) {
  if (!row) return null;
  return {
    id: row.id, createdByUserId: row.user_id, organizationId: row.organization_id,
    job_id: row.job_id, title: row.title, sourceFile: row.source_file,
    rowCount: Number(row.row_count || 0), rowsReceived: Number(row.rows_received || 0),
    duplicatesSkipped: Number(row.duplicates_skipped || 0), invalidRows: Number(row.invalid_rows || 0),
    currency: row.currency, status: row.status, startDate: row.start_date, endDate: row.end_date,
    createdAt: row.created_at, storagePath: row.storage_path, summaryJson: row.summary_json ? JSON.stringify(row.summary_json) : null,
    error: row.error || null,
  };
}
function rowImport(row) {
  return {
    id: row.id, sourceFile: row.source_file, fileHash: row.file_sha256, storagePath: row.storage_path,
    mappingJson: row.mapping_json, currency: row.currency,
    rowsImported: Number(row.rows_imported || 0), rowsSkipped: Number(row.rows_skipped || 0),
    rowsReceived: Number(row.rows_received || 0), duplicatesSkipped: Number(row.duplicates_skipped || 0),
    invalidRows: Number(row.invalid_rows || 0), minDate: row.min_date, maxDate: row.max_date,
    status: row.status, error: row.error || null, importedAt: row.imported_at,
  };
}

/** Supabase REST/Storage adapter. The service-role key is only ever used on the server. */
export class SupabaseCloudStore {
  constructor({ url = process.env.SUPABASE_URL, serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    bucket = process.env.SUPABASE_STORAGE_BUCKET || 'execubrief-private', fetchImpl = fetch } = {}) {
    if (!url || !serviceRoleKey) throw new CloudStoreError('SUPABASE_URL and SUPABASE_SECRET_KEY are required for cloud mode.', { status: 500, code: 'CLOUD_CONFIG_MISSING' });
    let parsed;
    try { parsed = new URL(url); } catch { throw new CloudStoreError('SUPABASE_URL is invalid.', { status: 500, code: 'CLOUD_CONFIG_INVALID' }); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new CloudStoreError('SUPABASE_URL must be an HTTP(S) project URL without embedded credentials.', { status: 500, code: 'CLOUD_CONFIG_INVALID' });
    if (parsed.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new CloudStoreError('Supabase must use HTTPS in production.', { status: 500, code: 'CLOUD_CONFIG_INVALID' });
    this.baseUrl = parsed.origin;
    this.serviceRoleKey = serviceRoleKey;
    this.bucket = bucket;
    this.fetchImpl = fetchImpl;
  }

  async request(url, { method = 'GET', body, headers = {}, responseType = 'json' } = {}) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          apikey: this.serviceRoleKey,
          // Current sb_secret_* keys are API keys, not JWTs. Supabase says to send
          // them on apikey only; legacy service_role JWTs retain Bearer compatibility.
          ...(!this.serviceRoleKey.startsWith('sb_secret_') ? { Authorization: `Bearer ${this.serviceRoleKey}` } : {}),
          Accept: 'application/json',
          ...(body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      throw new CloudStoreError('Cloud database or storage could not be reached. Check the Supabase project status and network.', { status: 503, code: 'CLOUD_UNREACHABLE' });
    }
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      let detail = {};
      try { detail = JSON.parse(raw); } catch { /* do not echo raw server response */ }
      const error = new CloudStoreError('Cloud persistence request failed. Check the Supabase schema, bucket and service configuration.', {
        status: response.status === 409 ? 409 : response.status === 400 ? 400 : response.status === 401 || response.status === 403 ? 503 : 503,
        code: typeof detail.code === 'string' ? detail.code : 'CLOUD_REQUEST_FAILED',
      });
      error.remoteCode = typeof detail.code === 'string' ? detail.code : null;
      error.remoteMessage = typeof detail.message === 'string' ? detail.message.slice(0, 300) : null;
      throw error;
    }
    if (responseType === 'bytes') return new Uint8Array(await response.arrayBuffer());
    if (response.status === 204) return null;
    const raw = await response.text();
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { throw new CloudStoreError('Supabase returned an unexpected response.', { status: 503, code: 'CLOUD_RESPONSE_INVALID' }); }
  }

  tableUrl(table, params = {}) {
    if (!/^[a-z_]+$/.test(table)) throw new CloudStoreError('Invalid table name.', { status: 500 });
    const url = new URL(`/rest/v1/${table}`, this.baseUrl);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    return url.toString();
  }
  async select(table, params = {}) { return (await this.request(this.tableUrl(table, params))) || []; }
  async checkReadiness() {
    await this.select('organizations', { select: 'id', limit: '1' });
    await this.request(new URL(`/storage/v1/bucket/${encodeURIComponent(this.bucket)}`, this.baseUrl).toString());
    return true;
  }
  async insert(table, row) {
    const rows = await this.request(this.tableUrl(table), { method: 'POST', body: row, headers: { Prefer: 'return=representation' } });
    return Array.isArray(rows) ? rows[0] : rows;
  }
  async insertMany(table, rows) {
    if (!rows.length) return [];
    return (await this.request(this.tableUrl(table), { method: 'POST', body: rows, headers: { Prefer: 'return=representation' } })) || [];
  }
  async update(table, filters, patch) {
    return (await this.request(this.tableUrl(table, { ...filters, select: '*' }), { method: 'PATCH', body: patch, headers: { Prefer: 'return=representation' } })) || [];
  }
  async remove(table, filters) { return this.request(this.tableUrl(table, filters), { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); }
  async rpc(name, parameters) {
    if (!/^execubrief_[a-z_]+$/.test(name)) throw new CloudStoreError('Invalid cloud RPC name.', { status: 500 });
    return this.request(new URL(`/rest/v1/rpc/${name}`, this.baseUrl).toString(), { method: 'POST', body: parameters });
  }
  async uploadObject(objectPath, bytes, contentType) {
    const encoded = safeObjectPath(objectPath);
    return this.request(new URL(`/storage/v1/object/${encodeURIComponent(this.bucket)}/${encoded}`, this.baseUrl).toString(), {
      method: 'POST', body: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), responseType: 'json',
      headers: { 'Content-Type': contentType, 'x-upsert': 'true', 'cache-control': 'no-store' },
    });
  }
  async downloadObject(objectPath) {
    const encoded = safeObjectPath(objectPath);
    return this.request(new URL(`/storage/v1/object/${encodeURIComponent(this.bucket)}/${encoded}`, this.baseUrl).toString(), { responseType: 'bytes' });
  }
  async removeObject(objectPath) {
    const encoded = safeObjectPath(objectPath);
    return this.request(new URL(`/storage/v1/object/${encodeURIComponent(this.bucket)}/${encoded}`, this.baseUrl).toString(), { method: 'DELETE' });
  }

  async register({ email: rawEmail, password, name, organizationName }) {
    const email = normalizeEmail(rawEmail);
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new CloudStoreError('Use a password between 12 and 128 characters.', { status: 400, code: 'INVALID_PASSWORD' });
    const displayName = normalizeName(name, email);
    const displayOrganizationName = normalizeOrganizationName(organizationName, displayName, email);
    const passwordSalt = crypto.randomBytes(16).toString('hex');
    const passwordHash = Buffer.from(await scrypt(password, passwordSalt, PASSWORD_BYTES, PASSWORD_SCRYPT)).toString('hex');
    const userId = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    const slugBase = displayOrganizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'organization';
    let created;
    try {
      created = await this.rpc('execubrief_register_user', {
        p_user_id: userId, p_organization_id: organizationId, p_email: email, p_name: displayName,
        p_password_salt: passwordSalt, p_password_hash: passwordHash,
        p_organization_name: displayOrganizationName, p_slug: `${slugBase}-${organizationId.slice(0, 8)}`,
      });
    } catch (error) {
      if (error.remoteCode === '23505' || /already exists/i.test(error.remoteMessage || '')) {
        throw new CloudStoreError('An account with that email already exists. Sign in instead.', { status: 409, code: 'EMAIL_EXISTS' });
      }
      throw error;
    }
    return safeUser(created?.user, created?.organization);
  }

  async login({ email: rawEmail, password }) {
    let email;
    try { email = normalizeEmail(rawEmail); } catch { throw new CloudStoreError('Email or password is incorrect.', { status: 401, code: 'INVALID_CREDENTIALS' }); }
    const rows = await this.select('app_users', { select: 'id,email,name,password_salt,password_hash,picture,created_at', email: `eq.${email}`, limit: '1' });
    const row = rows[0];
    if (!row || !row.password_salt || !row.password_hash || typeof password !== 'string' || password.length > 128) {
      await scrypt(String(password || 'invalid'), 'execubrief-dummy-salt', PASSWORD_BYTES, PASSWORD_SCRYPT);
      throw new CloudStoreError('Email or password is incorrect.', { status: 401, code: 'INVALID_CREDENTIALS' });
    }
    const candidate = Buffer.from(await scrypt(password, row.password_salt, PASSWORD_BYTES, PASSWORD_SCRYPT));
    const expected = Buffer.from(row.password_hash, 'hex');
    if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) throw new CloudStoreError('Email or password is incorrect.', { status: 401, code: 'INVALID_CREDENTIALS' });
    const membership = await this.select('organization_memberships', { select: 'organization_id,role,created_at', user_id: `eq.${row.id}`, order: 'created_at.asc', limit: '1' });
    if (!membership[0]) throw new CloudStoreError('This account has no organisation workspace. Contact support.', { status: 403, code: 'NO_ORGANIZATION' });
    const orgRows = await this.select('organizations', { select: 'id,name,report_currency', id: `eq.${membership[0].organization_id}`, limit: '1' });
    return safeUser(row, orgRows[0]);
  }

  async getOrCreateGoogleUser({ sub, email: rawEmail, name, picture, emailVerified }) {
    if (typeof sub !== 'string' || !sub || sub.length > 255) throw new CloudStoreError('Google did not return a valid account identifier.', { status: 401, code: 'GOOGLE_IDENTITY_INVALID' });
    if (emailVerified !== true) throw new CloudStoreError('Google must confirm this email address before sign-in.', { status: 401, code: 'GOOGLE_EMAIL_UNVERIFIED' });
    const email = normalizeEmail(rawEmail);
    const safeImage = safePicture(picture);
    const displayName = normalizeName(name, email);
    const orgId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const slugBase = `${displayName}-workspace`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'google-workspace';
    let result;
    try {
      result = await this.rpc('execubrief_google_user', {
        p_user_id: userId, p_organization_id: orgId, p_email: email, p_name: displayName,
        p_google_sub: sub, p_picture: safeImage, p_organization_name: `${displayName}'s workspace`.slice(0, 100),
        p_slug: `${slugBase}-${orgId.slice(0, 8)}`,
      });
    } catch (error) {
      if (error.remoteCode === '23505' || /linked to another Google account/i.test(error.remoteMessage || '')) {
        throw new CloudStoreError('This email is already linked to a different Google account.', { status: 409, code: 'GOOGLE_ACCOUNT_CONFLICT' });
      }
      throw error;
    }
    return safeUser(result?.user, result?.organization);
  }

  async createSession(userId, organizationId) {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
    await this.insert('auth_sessions', {
      token_hash: tokenHash, user_id: userId, organization_id: organizationId,
      csrf_token: csrfToken, created_at: createdAt.toISOString(), expires_at: expiresAt.toISOString(),
    });
    return { rawToken, csrfToken, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000), expiresAt: expiresAt.toISOString() };
  }

  async resolveSession(rawToken) {
    if (typeof rawToken !== 'string' || rawToken.length < 24 || rawToken.length > 256) return null;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const record = await this.rpc('execubrief_resolve_session', { p_token_hash: tokenHash });
    if (!record?.user?.id || !record?.organization?.id || !record?.csrf_token) return null;
    return { user: safeUser(record.user, record.organization), csrfToken: record.csrf_token };
  }

  async revokeSession(rawToken) {
    if (typeof rawToken !== 'string' || !rawToken) return;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await this.remove('auth_sessions', { token_hash: `eq.${tokenHash}` });
  }

  async deleteExpiredSessions() {
    await this.remove('auth_sessions', { expires_at: `lte.${new Date().toISOString()}` });
  }

  async getOrganization(organizationId) {
    const rows = await this.select('organizations', { select: 'id,name,slug,report_currency,created_at', id: `eq.${organizationId}`, limit: '1' });
    return rows[0] || null;
  }

  async updateOrganizationCurrency(organizationId, currency) {
    const rows = await this.update('organizations', { id: `eq.${organizationId}` }, { report_currency: currency });
    return rows[0] || null;
  }

  async listImports(organizationId, limit = 50) {
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 25));
    const rows = await this.select('workspace_imports', {
      select: 'id,organization_id,source_file,file_sha256,storage_path,mapping_json,currency,rows_imported,rows_skipped,rows_received,duplicates_skipped,invalid_rows,min_date,max_date,status,error,imported_at',
      organization_id: `eq.${organizationId}`, order: 'imported_at.desc', limit: String(safeLimit),
    });
    return rows.map(rowImport);
  }

  async getImportByHash(organizationId, fileHash) {
    const rows = await this.select('workspace_imports', { select: '*', organization_id: `eq.${organizationId}`, file_sha256: `eq.${fileHash}`, limit: '1' });
    return rows[0] ? rowImport(rows[0]) : null;
  }

  async createImport(row) {
    const inserted = await this.insert('workspace_imports', row);
    return inserted ? rowImport(inserted) : null;
  }

  async createCustomReport(row) {
    const inserted = await this.insert('custom_reports', {
      id: row.id, user_id: row.userId, organization_id: row.organizationId, job_id: row.jobId,
      title: row.title, source_file: row.sourceFile, storage_path: row.storagePath || null,
      row_count: row.rowCount, rows_received: row.rowsReceived, duplicates_skipped: row.duplicatesSkipped,
      invalid_rows: row.invalidRows, currency: row.currency, start_date: row.startDate || null,
      end_date: row.endDate || null, status: row.status, summary_json: row.summary || null,
      error: row.error || null, created_at: row.createdAt || new Date().toISOString(),
    });
    return rowReport(inserted);
  }

  async updateCustomReport(organizationId, reportId, patch) {
    const update = {};
    const names = { status: 'status', startDate: 'start_date', endDate: 'end_date', summary: 'summary_json', error: 'error', storagePath: 'storage_path' };
    for (const [key, column] of Object.entries(names)) if (Object.prototype.hasOwnProperty.call(patch, key)) update[column] = key === 'summary' ? patch[key] : patch[key];
    const rows = await this.update('custom_reports', { id: `eq.${reportId}`, organization_id: `eq.${organizationId}` }, update);
    return rowReport(rows[0]);
  }

  async getCustomReport(organizationId, reportId) {
    const rows = await this.select('custom_reports', { select: '*', id: `eq.${reportId}`, organization_id: `eq.${organizationId}`, limit: '1' });
    return rowReport(rows[0]);
  }

  async listCustomReports(organizationId, limit = 25) {
    const safeLimit = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 25));
    const rows = await this.select('custom_reports', { select: '*', organization_id: `eq.${organizationId}`, order: 'created_at.desc', limit: String(safeLimit) });
    return rows.map(rowReport);
  }
}
