import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { config, projectRoot } from './config.js';
import { createApp as createLocalApp } from './app.js';
import { createDatabase } from './db.js';
import { getDemoDatabase, getDemoReportsDir } from './demo-db.js';
import { buildAnalyticsFilter, ReportPeriodError, validateDateRange } from './analytics.js';
import { generateReport } from './report-service.js';
import { CustomCsvError, mapCustomCsv, previewCustomCsv } from './custom-csv.js';
import { getOrganizationAnalytics, getWorkspaceCurrency, resolveWorkspacePeriod } from './organization-workspace.js';
import { acquireWorkspaceDatabase, invalidateWorkspaceDatabase, addCsvOrdersToDatabase, validateSingleCurrency, FREE_MAX_IMPORT_FILES_PER_ORGANIZATION, FREE_MAX_SOURCE_ROWS_PER_ORGANIZATION } from './cloud-workspace.js';
import { SupabaseCloudStore, CloudStoreError } from './cloud-store.js';
import { exchangeGoogleCode, verifyGoogleIdToken } from './google-oauth.js';
import { appendCookie, clearCookie, clearSessionCookie, createAuthRateLimiter, deriveRequestOrigin, getSafeUploadFilename, readCookie, requireCsrf, requireSameOrigin, sessionCookieName, setSessionCookie } from './web-auth.js';

const publicDir = path.join(projectRoot, 'dashboard', 'public');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GOOGLE_STATE_COOKIE = 'execubrief_google_state';
const GOOGLE_NONCE_COOKIE = 'execubrief_google_nonce';
const GOOGLE_FLOW_TTL_SECONDS = 600;
const MAX_ACTIVE_PDFS = 1;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const b64json = (value) => Buffer.from(value, 'base64url').toString('utf8');

function safeReportTitle(value) {
  if (typeof value !== 'string') throw new CustomCsvError('Enter a report title.');
  const title = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title || title.length > 100) throw new CustomCsvError('Report title must contain 1 to 100 characters.');
  return title;
}
function safeCurrency(value) {
  const currency = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) throw new CustomCsvError('Choose a valid three-letter currency code.');
  try { new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(0); }
  catch { throw new CustomCsvError('The selected currency is not supported.'); }
  return currency;
}
function decodeHeaderJson(req, header, message) {
  const encoded = req.get(header) || '';
  if (!encoded || encoded.length > 12000) throw new CustomCsvError(message);
  let parsed;
  try { parsed = JSON.parse(b64json(encoded)); } catch { throw new CustomCsvError(message); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CustomCsvError(message);
  return parsed;
}
function readCsvBody(req, res) {
  if (!Buffer.isBuffer(req.body)) { res.status(415).json({ error: 'Send the CSV file with Content-Type: text/csv.' }); return null; }
  if (!req.body.length || req.body.length > config.importMaxFileBytes) {
    res.status(413).json({ error: `The CSV must be non-empty and no larger than ${Math.floor(config.importMaxFileBytes / (1024 * 1024))} MB.` }); return null;
  }
  const text = req.body.toString('utf8');
  if (text.includes('\u0000')) { res.status(400).json({ error: 'The uploaded file does not look like a text CSV.' }); return null; }
  return text;
}
function organizationForSql(user) {
  const organization = user?.organization;
  return organization ? { id: organization.id, name: organization.name, report_currency: organization.reportCurrency || null } : null;
}
function reportJson(row) {
  let summary = null;
  try { summary = row?.summaryJson ? JSON.parse(row.summaryJson) : null; } catch { summary = null; }
  if (!row) return null;
  return {
    id: row.id, title: row.title, sourceFile: row.sourceFile, rowCount: row.rowCount,
    rowsReceived: row.rowsReceived, duplicatesSkipped: row.duplicatesSkipped, invalidRows: row.invalidRows,
    currency: row.currency, status: row.status, startDate: row.startDate, endDate: row.endDate,
    createdAt: row.createdAt, summary,
    error: row.status === 'failed' ? 'Report generation failed. Check the CSV and try again.' : null,
    ...(row.status === 'completed' ? { file: `/api/custom/reports/${row.id}/file`, download: `/api/custom/reports/${row.id}/download` } : {}),
  };
}
function importJson(row) {
  return {
    id: row.id, sourceFile: row.sourceFile, fileHash: row.fileHash,
    rowsReceived: row.rowsReceived, rowsImported: row.rowsImported, rowsSkipped: row.rowsSkipped,
    duplicatesSkipped: row.duplicatesSkipped, invalidRows: row.invalidRows,
    minDate: row.minDate, maxDate: row.maxDate, importedAt: row.importedAt, status: row.status, error: row.error,
  };
}
function timingSafeEqualText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function datePeriod(startDate, endDate, maxDays = 93) {
  if (typeof startDate !== 'string' || typeof endDate !== 'string') throw new ReportPeriodError('Start and end dates must use YYYY-MM-DD format.');
  validateDateRange(startDate, endDate);
  const days = Math.round((Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86400000) + 1;
  if (days > maxDays) throw new ReportPeriodError(`Choose a reporting period of ${maxDays} days or fewer.`);
  return { startDate, endDate };
}

export function createCloudApp({ store = new SupabaseCloudStore(), localApp = createLocalApp(), tempRoot = path.join(os.tmpdir(), 'execubrief-cloud') } = {}) {
  const app = express();
  const authLimiter = createAuthRateLimiter({ limit: 10 });
  const previewLimiter = createAuthRateLimiter({ limit: 20 });
  const importLimiter = createAuthRateLimiter({ limit: 8 });
  const reportLimiter = createAuthRateLimiter({ limit: 3 });
  let activePdfs = 0;
  const rateCheck = (req, res, limiter, key = null) => {
    const result = limiter.allow(key || req.ip || req.socket.remoteAddress || 'unknown');
    if (!result.allowed) { res.set('Retry-After', String(result.retryAfterSeconds)); res.status(429).json({ error: 'Too many requests. Wait a little while and try again.' }); return false; }
    return true;
  };

  app.disable('x-powered-by');
  app.set('trust proxy', config.nodeEnv === 'production' ? 1 : false);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: '32kb', strict: true }));

  async function sessionMiddleware(req, res, next) {
    try {
      const raw = readCookie(req, sessionCookieName());
      req.authSessionToken = raw;
      if (!raw) return next();
      const session = await store.resolveSession(raw);
      if (!session) { clearSessionCookie(res); return next(); }
      req.authUser = session.user;
      req.authCsrfToken = session.csrfToken;
      return next();
    } catch (error) { return next(error); }
  }
  const authenticated = (req, res) => {
    if (!req.authUser?.id || !req.authUser?.organization?.id) {
      res.status(401).json({ error: 'Sign in to use your private reporting workspace.' });
      return false;
    }
    return true;
  };
  const sessionJson = async (res, user) => {
    if (!user?.id || !user?.organization?.id) throw new CloudStoreError('Account could not be linked to an organisation.', { status: 500, code: 'ACCOUNT_WORKSPACE_MISSING' });
    const session = await store.createSession(user.id, user.organization.id);
    setSessionCookie(res, session);
    return res.json({ user, csrfToken: session.csrfToken });
  };
  const googleRedirectUri = (req) => config.googleRedirectUri || `${deriveRequestOrigin(req)}/auth/google/callback`;

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', mode: 'cloud-free' }));
  app.get('/ready', async (_req, res) => {
    try {
      if (typeof store.checkReadiness === 'function') await store.checkReadiness();
      else await store.select('organizations', { select: 'id', limit: '1' });
      return res.status(200).json({ status: 'ready' });
    } catch { return res.status(503).json({ status: 'not_ready', message: 'Cloud database or private file storage is unavailable.' }); }
  });
  app.get('/api/auth/config', (_req, res) => res.json({ googleEnabled: Boolean(config.googleClientId && config.googleClientSecret) }));
  app.get('/api/auth/me', sessionMiddleware, (req, res) => {
    if (!req.authUser) return res.status(401).json({ error: 'Not signed in.' });
    return res.json({ user: req.authUser, csrfToken: req.authCsrfToken });
  });
  app.post('/api/auth/register', requireSameOrigin, async (req, res) => {
    if (!rateCheck(req, res, authLimiter)) return;
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const user = await store.register({ email: body.email, password: body.password, name: body.name, organizationName: body.organizationName });
      return await sessionJson(res, user);
    } catch (error) {
      if (error instanceof CloudStoreError) return res.status(error.status).json({ error: error.message });
      console.warn('[Cloud Auth] Registration failed.');
      return res.status(503).json({ error: 'Could not create the account. Check cloud database setup and try again.' });
    }
  });
  app.post('/api/auth/login', requireSameOrigin, async (req, res) => {
    if (!rateCheck(req, res, authLimiter)) return;
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const user = await store.login({ email: body.email, password: body.password });
      return await sessionJson(res, user);
    } catch (error) {
      if (error instanceof CloudStoreError) return res.status(error.status).json({ error: error.message });
      console.warn('[Cloud Auth] Login failed.');
      return res.status(503).json({ error: 'Sign-in is temporarily unavailable. Please try again.' });
    }
  });
  app.post('/api/auth/logout', sessionMiddleware, (req, res, next) => {
    if (!authenticated(req, res)) return;
    return requireCsrf(req, res, async () => {
      try { await store.revokeSession(req.authSessionToken); clearSessionCookie(res); return res.status(200).json({ status: 'signed_out' }); }
      catch (error) { return next(error); }
    });
  });

  app.get('/auth/google', (req, res) => {
    if (!(config.googleClientId && config.googleClientSecret)) return res.redirect(303, '/login?error=google-not-configured');
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    appendCookie(res, GOOGLE_STATE_COOKIE, state, { maxAgeSeconds: GOOGLE_FLOW_TTL_SECONDS });
    appendCookie(res, GOOGLE_NONCE_COOKIE, nonce, { maxAgeSeconds: GOOGLE_FLOW_TTL_SECONDS });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: config.googleClientId, redirect_uri: googleRedirectUri(req), response_type: 'code', scope: 'openid email profile', state, nonce, prompt: 'select_account' }).toString();
    return res.redirect(302, url.toString());
  });
  app.get('/auth/google/callback', async (req, res) => {
    const expectedState = readCookie(req, GOOGLE_STATE_COOKIE); const expectedNonce = readCookie(req, GOOGLE_NONCE_COOKIE);
    clearCookie(res, GOOGLE_STATE_COOKIE); clearCookie(res, GOOGLE_NONCE_COOKIE);
    if (!(config.googleClientId && config.googleClientSecret)) return res.redirect(303, '/login?error=google-not-configured');
    if (req.query.error || !timingSafeEqualText(req.query.state, expectedState) || !expectedNonce || typeof req.query.code !== 'string') return res.redirect(303, '/login?error=google-state');
    try {
      const token = await exchangeGoogleCode({ code: req.query.code, clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: googleRedirectUri(req) });
      const identity = await verifyGoogleIdToken(token, { audience: config.googleClientId, nonce: expectedNonce });
      const user = await store.getOrCreateGoogleUser({ sub: identity.sub, email: identity.email, name: identity.name, picture: identity.picture, emailVerified: identity.emailVerified });
      const session = await store.createSession(user.id, user.organization.id);
      setSessionCookie(res, session);
      return res.redirect(303, '/workspace');
    } catch (error) {
      if (error instanceof CloudStoreError && error.code === 'GOOGLE_EMAIL_UNVERIFIED') return res.redirect(303, '/login?error=google-unverified');
      console.warn('[Cloud Auth] Google sign-in failed.');
      return res.redirect(303, '/login?error=google');
    }
  });
  const authPage = (req, res) => {
    if (req.authUser) return res.redirect(303, '/workspace');
    res.set('Cache-Control', 'no-store');
    return res.sendFile(path.join(publicDir, 'auth.html'));
  };
  app.get('/login', sessionMiddleware, authPage);
  app.get('/signup', sessionMiddleware, authPage);
  app.get('/workspace', sessionMiddleware, (req, res) => {
    if (!req.authUser) return res.redirect(303, '/login?next=%2Fworkspace');
    res.set('Cache-Control', 'no-store'); return res.sendFile(path.join(publicDir, 'organization-dashboard.html'));
  });
  app.get('/custom-reports', sessionMiddleware, (req, res) => {
    if (!req.authUser) return res.redirect(303, '/login?next=%2Fcustom-reports');
    res.set('Cache-Control', 'no-store'); return res.sendFile(path.join(publicDir, 'custom-reports.html'));
  });

  app.post('/api/custom/csv/preview', sessionMiddleware, requireCsrf, express.raw({ type: ['text/csv', 'application/csv'], limit: config.importMaxFileBytes }), (req, res) => {
    if (!authenticated(req, res) || !rateCheck(req, res, previewLimiter)) return;
    const csvText = readCsvBody(req, res); if (csvText === null) return;
    try {
      const preview = previewCustomCsv(csvText, { maxRows: config.importMaxRows });
      let selectedMapping = preview.suggestedMapping;
      const encoded = req.get('x-execubrief-preview-mapping');
      if (encoded) {
        const mapping = decodeHeaderJson(req, 'x-execubrief-preview-mapping', 'The selected column mapping could not be read.');
        selectedMapping = mapping;
      }
      const requiredOk = ['date', 'amount', 'product'].every((field) => typeof selectedMapping[field] === 'string' && selectedMapping[field] && preview.headers.includes(selectedMapping[field]));
      preview.selectedMapping = selectedMapping;
      if (!requiredOk) {
        preview.validationError = 'Choose columns for date, amount/revenue, and product, then recheck the mapping to detect available dates.';
        preview.validation = { invalidRows: 0, duplicateRows: 0, invalidRowExamples: [], duplicateRowExamples: [] };
        return res.json(preview);
      }
      try {
        const mapped = mapCustomCsv(csvText, selectedMapping, { maxRows: config.importMaxRows, uploadId: 'preview', skipInvalidRows: true, skipDuplicateLineItems: true });
        preview.validRowCount = mapped.rowCount; preview.rowsReceived = mapped.rowsReceived;
        preview.validation = { invalidRows: mapped.invalidRows.length, duplicateRows: mapped.duplicateRows.length, invalidRowExamples: mapped.invalidRows.slice(0, 8), duplicateRowExamples: mapped.duplicateRows.slice(0, 8) };
        if (mapped.minDate && mapped.maxDate) {
          preview.availablePeriod = { startDate: mapped.minDate, endDate: mapped.maxDate };
          const maxMs = Date.parse(`${mapped.maxDate}T00:00:00Z`); const minMs = Date.parse(`${mapped.minDate}T00:00:00Z`);
          const candidate = new Date(maxMs - 92 * 86400000).toISOString().slice(0, 10);
          preview.suggestedPeriod = { startDate: minMs > Date.parse(`${candidate}T00:00:00Z`) ? mapped.minDate : candidate, endDate: mapped.maxDate, limited: false };
        } else preview.validationError = mapped.invalidRows[0]?.reason || 'No valid dates were found in the mapped date column.';
        const currencies = [...new Set(mapped.orders.map((order) => order.currency).filter(Boolean))];
        preview.detectedCurrency = currencies.length === 1 ? currencies[0] : null; preview.multipleCurrencies = currencies.length > 1 ? currencies : [];
        if (!mapped.rowCount) preview.validationError = mapped.invalidRows[0]?.reason || 'No valid data rows were found.';
        else if (currencies.length > 1) preview.validationError = `This file contains multiple currencies (${currencies.join(', ')}). Split it by currency.`;
      } catch (error) {
        if (!(error instanceof CustomCsvError)) throw error;
        preview.validationError = error.message; preview.validation = { invalidRows: 1, duplicateRows: 0, invalidRowExamples: [{ row: error.row, reason: error.message }], duplicateRowExamples: [] };
      }
      return res.json(preview);
    } catch (error) { if (error instanceof CustomCsvError) return res.status(400).json({ error: error.message, row: error.row }); return res.status(400).json({ error: 'Could not read this CSV. Check the file format and column headers.' }); }
  });

  app.get('/api/organization/analytics', sessionMiddleware, async (req, res) => {
    if (!authenticated(req, res)) return;
    let built;
    try {
      const organization = organizationForSql(req.authUser);
      built = await acquireWorkspaceDatabase(store, organization);
      const data = getOrganizationAnalytics({ database: built.database, organization,
        startDate: typeof req.query.startDate === 'string' ? req.query.startDate : undefined,
        endDate: typeof req.query.endDate === 'string' ? req.query.endDate : undefined,
        currency: getWorkspaceCurrency(built.database) || organization.report_currency || 'USD',
        filters: { category: typeof req.query.category === 'string' ? req.query.category : undefined, region: typeof req.query.region === 'string' ? req.query.region : undefined },
      });
      return res.json(data);
    } catch (error) {
      if (error instanceof ReportPeriodError || error.code === 'INVALID_PERIOD' || error instanceof CustomCsvError) return res.status(400).json({ error: error.message });
      if (error instanceof CloudStoreError) return res.status(error.status).json({ error: error.message });
      console.warn('[Cloud Workspace] Analytics failed.'); return res.status(503).json({ error: 'Organisation analytics are temporarily unavailable.' });
    } finally { try { built?.release(); } catch { /* no-op */ } }
  });
  app.get('/api/organization/imports', sessionMiddleware, async (req, res) => {
    if (!authenticated(req, res)) return;
    try { return res.json({ imports: (await store.listImports(req.authUser.organization.id, req.query.limit)).map(importJson) }); }
    catch (error) { if (error instanceof CloudStoreError) return res.status(error.status).json({ error: error.message }); console.warn('[Cloud Workspace] Import list failed.'); return res.status(503).json({ error: 'Organisation import history is unavailable.' }); }
  });
  app.post('/api/organization/imports', sessionMiddleware, requireCsrf, express.raw({ type: ['text/csv', 'application/csv'], limit: config.importMaxFileBytes }), async (req, res) => {
    if (!authenticated(req, res) || !rateCheck(req, res, importLimiter, req.authUser.organization.id)) return;
    const csvText = readCsvBody(req, res); if (csvText === null) return;
    let options;
    try { options = decodeHeaderJson(req, 'x-execubrief-import-options', 'Import settings are missing or invalid.'); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    try {
      const filename = getSafeUploadFilename(options.filename || req.get('x-upload-filename') || 'upload.csv');
      if (!options.columns || typeof options.columns !== 'object' || Array.isArray(options.columns)) return res.status(400).json({ error: 'Choose a column mapping before importing.' });
      const currency = safeCurrency(options.currency || 'USD');
      const organization = await store.getOrganization(req.authUser.organization.id);
      const fileHash = sha256(csvText);
      const previous = await store.getImportByHash(organization.id, fileHash);
      if (previous) return res.status(200).json({ duplicateFile: true, import: importJson(previous), message: 'This exact file was already imported. No additional rows were added.' });
      const existingImports = await store.listImports(organization.id, FREE_MAX_IMPORT_FILES_PER_ORGANIZATION + 1);
      const existingRows = existingImports.reduce((total, item) => total + Number(item.rowsReceived || 0), 0);
      const existingWorkspaceCurrency = organization.report_currency || existingImports[0]?.currency || null;
      if (existingImports.length >= FREE_MAX_IMPORT_FILES_PER_ORGANIZATION) return res.status(413).json({ error: `The free workspace supports at most ${FREE_MAX_IMPORT_FILES_PER_ORGANIZATION} CSV files per organisation.` });
      if (existingRows + Number(previewCustomCsv(csvText, { maxRows: config.importMaxRows }).rowCount) > FREE_MAX_SOURCE_ROWS_PER_ORGANIZATION) return res.status(413).json({ error: `The free workspace supports at most ${FREE_MAX_SOURCE_ROWS_PER_ORGANIZATION.toLocaleString()} source rows per organisation.` });
      const mapped = mapCustomCsv(csvText, options.columns, { maxRows: config.importMaxRows, uploadId: fileHash.slice(0, 24), skipInvalidRows: true, skipDuplicateLineItems: true });
      if (!mapped.rowCount || !mapped.minDate || !mapped.maxDate) return res.status(422).json({ error: mapped.invalidRows[0]?.reason || 'No valid rows remain after validation.', validation: { invalidRows: mapped.invalidRows.slice(0, 10), duplicateRows: mapped.duplicateRows.slice(0, 10) } });
      validateSingleCurrency(mapped, currency);
      if (existingWorkspaceCurrency && existingWorkspaceCurrency !== currency) return res.status(409).json({ error: `This workspace uses ${existingWorkspaceCurrency}. Convert the source file before importing; ExecuBrief does not convert currencies.` });
      const storagePath = `${organization.id}/csv/${fileHash}.csv`;
      await store.uploadObject(storagePath, Buffer.from(csvText, 'utf8'), 'text/csv');
      let created;
      try {
        created = await store.createImport({
          id: crypto.randomUUID(), organization_id: organization.id, source_file: filename, file_sha256: fileHash,
          storage_path: storagePath, mapping_json: options.columns, currency,
          rows_imported: mapped.rowCount, rows_skipped: mapped.duplicateRows.length + mapped.invalidRows.length,
          rows_received: mapped.rowsReceived, duplicates_skipped: mapped.duplicateRows.length,
          invalid_rows: mapped.invalidRows.length, min_date: mapped.minDate, max_date: mapped.maxDate,
          status: mapped.invalidRows.length || mapped.duplicateRows.length ? 'partial' : 'completed',
          error: mapped.invalidRows[0]?.reason || null, imported_at: new Date().toISOString(),
        });
      } catch (error) {
        // Storage upload and database insert cannot be one atomic transaction. First check
        // whether the record actually landed (for example, a network timeout after commit).
        // Never delete a hash-addressed object if the durable import row may reference it.
        const concurrent = await store.getImportByHash(organization.id, fileHash).catch(() => null);
        if (concurrent) {
          invalidateWorkspaceDatabase(organization.id);
          return res.status(200).json({ duplicateFile: true, import: importJson(concurrent), message: 'This exact file was already imported. No additional rows were added.' });
        }
        // Only compensate for an explicit, non-unique remote rejection. For ambiguous
        // network/5xx failures prefer a private orphan object over dangling import metadata.
        if (error.remoteCode && error.remoteCode !== '23505' && error.status && error.status < 500) {
          await store.removeObject(storagePath).catch(() => {});
        }
        throw error;
      }
      invalidateWorkspaceDatabase(organization.id);
      if (!organization.report_currency) await store.updateOrganizationCurrency(organization.id, currency).catch(() => { console.warn('[Cloud Workspace] Currency metadata update is deferred; import metadata remains authoritative.'); });
      const item = importJson(created);
      return res.status(201).json({ import: item, ...item, analyticsAvailable: true, validation: { invalidRows: mapped.invalidRows.slice(0, 10), duplicateRows: mapped.duplicateRows.slice(0, 10) }, message: `Imported ${mapped.rowCount.toLocaleString()} row(s); ${mapped.duplicateRows.length} duplicate(s) and ${mapped.invalidRows.length} invalid row(s) were skipped.` });
    } catch (error) {
      if (error instanceof CustomCsvError || error instanceof CloudStoreError) return res.status(error.status || 400).json({ error: error.message });
      console.warn('[Cloud Workspace] CSV import failed.'); return res.status(503).json({ error: 'CSV import could not be completed. Check the cloud storage configuration and retry.' });
    }
  });

  async function makeCloudReport({ organization, userId, database, title, currency, startDate, endDate, filters = {}, sourceFile, rowCount, rowsReceived = rowCount, duplicatesSkipped = 0, invalidRows = 0 }) {
    // mkdtemp requires its parent directory to exist; Render's /tmp path may be empty
    // after a cold start, so create the private temp root before making a per-report dir.
    await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const tmp = await fs.mkdtemp(path.join(tempRoot, 'pdf-'));
    let generated;
    let storagePath;
    const jobId = crypto.randomUUID();
    try {
      await fs.mkdir(tmp, { recursive: true });
      const filterSpec = buildAnalyticsFilter(filters);
      const analytics = (args) => {
        const data = getOrganizationAnalytics({ database, organization, startDate: args.startDate, endDate: args.endDate, currency, filters: filterSpec });
        data.metadata.companyName = title; data.metadata.reportTitle = title; data.metadata.currency = currency;
        return data;
      };
      generated = await generateReport({ database, startDate, endDate, sendEmail: false, resendEmail: false, outputDir: tmp, analytics });
      const pdfBytes = await fs.readFile(generated.pdfPath);
      if (pdfBytes.length < 1000 || pdfBytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('PDF renderer did not produce a valid PDF.');
      storagePath = `${organization.id}/reports/${generated.id}.pdf`;
      await store.uploadObject(storagePath, pdfBytes, 'application/pdf');
      const record = await store.createCustomReport({ id: generated.id, userId, organizationId: organization.id, jobId, title, sourceFile, storagePath, rowCount, rowsReceived, duplicatesSkipped, invalidRows, currency, startDate: generated.reportPeriod.startDate, endDate: generated.reportPeriod.endDate, status: 'completed', summary: generated.summary, createdAt: generated.createdAt });
      return reportJson(record);
    } catch (error) {
      // A network error may occur after the report row committed. Check durable metadata
      // before any cleanup so a completed report never points at a deleted PDF object.
      if (generated?.id) {
        const committed = await store.getCustomReport(organization.id, generated.id).catch(() => null);
        if (committed?.status === 'completed' && committed.storagePath === storagePath) return reportJson(committed);
      }
      if (storagePath && error?.remoteCode && error.status && error.status < 500) {
        await store.removeObject(storagePath).catch(() => {});
      }
      const failedId = generated?.id || (UUID_PATTERN.test(error?.reportId || '') ? error.reportId : null);
      if (failedId) {
        await store.createCustomReport({ id: failedId, userId, organizationId: organization.id, jobId, title, sourceFile, rowCount, rowsReceived, duplicatesSkipped, invalidRows, currency, startDate, endDate, status: 'failed', error: 'Report generation failed.', createdAt: new Date().toISOString() }).catch(() => {});
      }
      throw error;
    } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
  }

  app.post('/api/organization/reports', sessionMiddleware, requireCsrf, async (req, res) => {
    if (!authenticated(req, res)) return;
    if (activePdfs >= MAX_ACTIVE_PDFS) return res.status(503).json({ error: 'The free PDF renderer is busy. Please retry shortly.' });
    if (!rateCheck(req, res, reportLimiter, req.authUser.organization.id)) return;
    activePdfs += 1;
    let built;
    try {
      const organization = organizationForSql(req.authUser); const databaseOrg = organization;
      built = await acquireWorkspaceDatabase(store, databaseOrg);
      const dataRange = resolveWorkspacePeriod(built.database, req.body?.startDate, req.body?.endDate, { defaultDays: 30 });
      if (!dataRange.range.hasData || !dataRange.period) return res.status(400).json({ error: 'Import a valid CSV into this organisation before generating a report.' });
      const currency = safeCurrency(req.body?.currency || getWorkspaceCurrency(built.database) || 'USD');
      if (getWorkspaceCurrency(built.database) && currency !== getWorkspaceCurrency(built.database)) return res.status(400).json({ error: `This workspace uses ${getWorkspaceCurrency(built.database)}. Currency conversion is not supported.` });
      const analytics = getOrganizationAnalytics({ database: built.database, organization, startDate: dataRange.period.startDate, endDate: dataRange.period.endDate, currency });
      const report = await makeCloudReport({ organization, userId: req.authUser.id, database: built.database,
        title: safeReportTitle(req.body?.title || `${organization.name} Executive Brief`), currency,
        startDate: dataRange.period.startDate, endDate: dataRange.period.endDate,
        filters: { category: req.body?.category, region: req.body?.region },
        sourceFile: `${analytics.importHealth.successfulFiles} organisation import(s)`,
        rowCount: built.rowCount, rowsReceived: analytics.importHealth.rowsImported,
        duplicatesSkipped: analytics.importHealth.duplicatesSkipped, invalidRows: analytics.importHealth.invalidRows,
      });
      return res.status(201).json(report);
    } catch (error) {
      if (error instanceof ReportPeriodError || error instanceof CustomCsvError || error instanceof CloudStoreError) return res.status(error.status || 400).json({ error: error.message });
      console.warn('[Cloud Workspace] PDF generation failed.'); return res.status(500).json({ error: 'The organisation PDF could not be generated. Check the Chromium setup and cloud storage.' });
    } finally { try { built?.release(); } catch { /* no-op */ } activePdfs = Math.max(0, activePdfs - 1); }
  });

  app.get('/api/custom/reports', sessionMiddleware, async (req, res) => {
    if (!authenticated(req, res)) return;
    try { return res.json({ reports: (await store.listCustomReports(req.authUser.organization.id, req.query.limit)).map(reportJson) }); }
    catch (error) { if (error instanceof CloudStoreError) return res.status(error.status).json({ error: error.message }); console.warn('[Cloud Reports] History failed.'); return res.status(503).json({ error: 'Report history is unavailable.' }); }
  });
  app.post('/api/custom/reports', sessionMiddleware, requireCsrf, express.raw({ type: ['text/csv', 'application/csv'], limit: config.importMaxFileBytes }), async (req, res) => {
    if (!authenticated(req, res)) return;
    if (activePdfs >= MAX_ACTIVE_PDFS) return res.status(503).json({ error: 'The free PDF renderer is busy. Please retry shortly.' });
    if (!rateCheck(req, res, reportLimiter, req.authUser.organization.id)) return;
    const csvText = readCsvBody(req, res); if (csvText === null) return;
    let options; let database;
    activePdfs += 1;
    try {
      options = decodeHeaderJson(req, 'x-execubrief-options', 'Report settings are missing or invalid.');
      const filename = getSafeUploadFilename(options.filename || req.get('x-upload-filename') || 'upload.csv');
      const title = safeReportTitle(options.title); const currency = safeCurrency(options.currency);
      const mapped = mapCustomCsv(csvText, options.columns, { maxRows: config.importMaxRows, uploadId: sha256(csvText).slice(0, 24), skipInvalidRows: true, skipDuplicateLineItems: true });
      if (!mapped.rowCount || !mapped.minDate || !mapped.maxDate) return res.status(400).json({ error: mapped.invalidRows[0]?.reason || 'No valid rows remain after validation.' });
      validateSingleCurrency(mapped, currency);
      if (Boolean(options.startDate) !== Boolean(options.endDate)) return res.status(400).json({ error: 'Provide both start and end dates, or leave both blank.' });
      const selected = options.startDate && options.endDate ? datePeriod(options.startDate, options.endDate) : (() => {
        const maxMs = Date.parse(`${mapped.maxDate}T00:00:00.000Z`); const minMs = Date.parse(`${mapped.minDate}T00:00:00.000Z`);
        const candidate = new Date(maxMs - 92 * 86400000).toISOString().slice(0, 10);
        return datePeriod(minMs > Date.parse(`${candidate}T00:00:00.000Z`) ? mapped.minDate : candidate, mapped.maxDate);
      })();
      if (selected.startDate < mapped.minDate || selected.endDate > mapped.maxDate) return res.status(400).json({ error: `Choose dates within the CSV coverage ${mapped.minDate} to ${mapped.maxDate}.` });
      database = createDatabase(':memory:');
      database.exec('CREATE TABLE IF NOT EXISTS workspace_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
      database.prepare("INSERT OR REPLACE INTO workspace_metadata(key,value) VALUES ('kind','execubrief-cloud-custom-pdf-v1')").run();
      database.prepare("INSERT OR REPLACE INTO workspace_metadata(key,value) VALUES ('organization_id',?)").run(req.authUser.organization.id);
      database.prepare("INSERT OR REPLACE INTO workspace_metadata(key,value) VALUES ('report_currency',?)").run(currency);
      addCsvOrdersToDatabase(database, mapped, currency);
      const report = await makeCloudReport({ organization: organizationForSql(req.authUser), userId: req.authUser.id, database,
        title, currency, startDate: selected.startDate, endDate: selected.endDate, sourceFile: filename,
        rowCount: mapped.rowCount, rowsReceived: mapped.rowsReceived, duplicatesSkipped: mapped.duplicateRows.length, invalidRows: mapped.invalidRows.length });
      return res.status(201).json(report);
    } catch (error) {
      if (error instanceof CustomCsvError || error instanceof ReportPeriodError || error instanceof CloudStoreError) return res.status(error.status || 400).json({ error: error.message, row: error.row ?? null });
      console.warn('[Cloud Reports] Custom report failed.'); return res.status(500).json({ error: 'The custom PDF could not be generated. Check the CSV, Chromium and cloud storage settings.' });
    } finally { try { database?.close(); } catch { /* no-op */ } activePdfs = Math.max(0, activePdfs - 1); }
  });
  app.get('/api/custom/reports/:id', sessionMiddleware, async (req, res) => {
    if (!authenticated(req, res)) return;
    if (!UUID_PATTERN.test(req.params.id)) return res.status(404).json({ error: 'Custom report not found.' });
    try { const row = await store.getCustomReport(req.authUser.organization.id, req.params.id); return row ? res.json(reportJson(row)) : res.status(404).json({ error: 'Custom report not found.' }); }
    catch (error) { if (error instanceof CloudStoreError) return res.status(error.status).json({ error: error.message }); return res.status(503).json({ error: 'Report status is unavailable.' }); }
  });
  const pdfRoute = async (req, res) => {
    if (!authenticated(req, res)) return;
    if (!UUID_PATTERN.test(req.params.id)) return res.status(404).json({ error: 'Custom report not found.' });
    try {
      const row = await store.getCustomReport(req.authUser.organization.id, req.params.id);
      if (!row || row.status !== 'completed' || !row.storagePath) return res.status(404).json({ error: 'PDF not found.' });
      const bytes = await store.downloadObject(row.storagePath);
      if (bytes.length < 5 || Buffer.from(bytes).subarray(0, 5).toString('ascii') !== '%PDF-') return res.status(503).json({ error: 'Stored report is not a valid PDF.' });
      res.set({ 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(bytes.length) });
      const fileName = `execubrief-${row.id}.pdf`;
      res.set('Content-Disposition', req.path.endsWith('/download') ? `attachment; filename="${fileName}"` : `inline; filename="${fileName}"`);
      return res.status(200).send(Buffer.from(bytes));
    } catch (error) { if (error instanceof CloudStoreError) return res.status(error.status).json({ error: error.message }); console.warn('[Cloud Reports] PDF retrieval failed.'); return res.status(503).json({ error: 'Report file is temporarily unavailable.' }); }
  };
  app.get('/api/custom/reports/:id/file', sessionMiddleware, pdfRoute);
  app.get('/api/custom/reports/:id/download', sessionMiddleware, pdfRoute);

  // The existing local app supplies the read-only synthetic demo homepage and demo APIs.
  // Its SQLite/PDF paths are set to /tmp in the free Render Blueprint and may reset on wake.
  app.use(localApp);
  app.use((error, req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Malformed JSON request body.' });
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
    const apiRequest = req.path.startsWith('/api/') || req.path.startsWith('/auth/');
    console.warn(`[Cloud HTTP] Request failed on ${req.method} ${req.path}.`);
    if (apiRequest) return res.status(503).json({ error: error instanceof CloudStoreError ? error.message : 'The cloud reporting service is temporarily unavailable.' });
    return res.status(500).type('text/plain').send('ExecuBrief is temporarily unavailable. Please try again.');
  });
  return app;
}
