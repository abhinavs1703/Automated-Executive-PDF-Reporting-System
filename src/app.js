import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import express from 'express';
import path from 'node:path';
import { config, projectRoot } from './config.js';
import { createDatabase, getDefaultDatabase } from './db.js';
import { getDemoDatabase, getDemoDatabasePath, getDemoReportsDir } from './demo-db.js';
import { buildAnalyticsFilter, getReportData, ReportPeriodError, validateDateRange } from './analytics.js';
import { generateReport } from './report-service.js';
import { bearerAuth } from './auth.js';
import { AuthError, getAuthStore } from './auth-store.js';
import { CustomCsvError, mapCustomCsv, previewCustomCsv } from './custom-csv.js';
import { closeOrganizationWorkspace, getOrganizationAnalytics, getWorkspaceCurrency, getWorkspaceDateRange, insertWorkspaceImport, listWorkspaceImports, openOrganizationWorkspace, recordFailedWorkspaceImport, resolveWorkspacePeriod, setWorkspaceCurrency, WorkspaceError } from './organization-workspace.js';
import { exchangeGoogleCode, verifyGoogleIdToken } from './google-oauth.js';
import { appendCookie, clearCookie, clearSessionCookie, createAuthRateLimiter, deriveRequestOrigin, getSafeUploadFilename, readCookie, requireAuthenticated, requireCsrf, requireSameOrigin, resolveSession, setSessionCookie } from './web-auth.js';

const dashboardPublicDir = path.join(projectRoot, 'dashboard', 'public');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const REPORT_COLUMNS = `id, status, file_url AS file, from_date AS startDate, to_date AS endDate,
  email_status AS emailStatus, created_at AS createdAt, error, error_stage AS errorStage, email_error AS emailError`;
const DEMO_RATE_WINDOW_MS = 15 * 60 * 1000;
const DEMO_RATE_MAX = 5;
const DEMO_MAX_CONCURRENT_REPORTS = 2;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const GOOGLE_STATE_COOKIE = 'execubrief_google_state';
const GOOGLE_NONCE_COOKIE = 'execubrief_google_nonce';
const GOOGLE_FLOW_TTL_SECONDS = 600;
const CUSTOM_MAX_ACTIVE_REPORTS = 1;
const CUSTOM_GENERATION_RATE_MAX = 3;

function pathsOverlap(first, second) {
  return isWithinDirectory(first, second) || isWithinDirectory(second, first);
}

function assertCustomStorageSafety(customDataDir = config.customDataDir) {
  const customRoot = path.resolve(customDataDir);
  const authPath = path.resolve(config.authDatabasePath);
  const privateDatabase = path.resolve(config.databasePath);
  const demoDatabase = path.resolve(getDemoDatabasePath());
  const blocked = [
    config.databasePath,
    config.authDatabasePath,
    getDemoDatabasePath(),
    config.reportsDir,
    getDemoReportsDir(),
    dashboardPublicDir,
    path.join(projectRoot, 'templates'),
  ].map((value) => path.resolve(value));

  if (authPath === privateDatabase || authPath === demoDatabase || privateDatabase === demoDatabase) {
    throw new Error('AUTH_DATABASE_PATH, DATABASE_PATH, and DEMO_DATABASE_PATH must point to separate files.');
  }
  for (const target of blocked.filter((value) => value !== authPath)) {
    if (pathsOverlap(customRoot, target)) {
      throw new Error('CUSTOM_DATA_DIR overlaps protected application storage. Choose a separate, private directory.');
    }
  }
  if (isWithinDirectory(customRoot, authPath) || isWithinDirectory(authPath, customRoot)) {
    throw new Error('CUSTOM_DATA_DIR and AUTH_DATABASE_PATH must remain separate.');
  }
}

function getStore(options, customDataDir = config.customDataDir) {
  if (options.authStore) return options.authStore;
  assertCustomStorageSafety(customDataDir);
  return getAuthStore();
}

function timingSafeStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

function decodeCustomOptions(req) {
  const encoded = req.get('x-execubrief-options') || '';
  if (!encoded || encoded.length > 12000) throw new CustomCsvError('Report settings are missing or too large. Preview the CSV and try again.');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw new CustomCsvError('Report settings could not be read. Preview the CSV and try again.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CustomCsvError('Report settings are invalid.');
  return {
    title: safeReportTitle(parsed.title),
    currency: safeCurrency(parsed.currency),
    columns: parsed.columns,
    startDate: parsed.startDate || undefined,
    endDate: parsed.endDate || undefined,
    filename: getSafeUploadFilename(parsed.filename || req.get('x-upload-filename') || 'upload.csv'),
  };
}

function decodePreviewMapping(req) {
  const encoded = req.get('x-execubrief-preview-mapping') || '';
  if (!encoded) return null;
  if (encoded.length > 12000) throw new CustomCsvError('Column mapping is too large.');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw new CustomCsvError('The selected column mapping could not be read.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CustomCsvError('The selected column mapping is invalid.');
  return parsed;
}

function decodeImportOptions(req) {
  const encoded = req.get('x-execubrief-import-options') || '';
  if (!encoded || encoded.length > 12000) throw new CustomCsvError('Import settings are missing. Preview the CSV and retry.');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw new CustomCsvError('Import settings could not be read. Preview the CSV and retry.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CustomCsvError('Import settings are invalid.');
  if (!parsed.columns || typeof parsed.columns !== 'object' || Array.isArray(parsed.columns)) throw new CustomCsvError('Choose the column mapping before importing.');
  return {
    columns: parsed.columns,
    currency: safeCurrency(parsed.currency || 'USD'),
    filename: getSafeUploadFilename(parsed.filename || req.get('x-upload-filename') || 'upload.csv'),
  };
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertSingleSourceCurrency(mapped, selectedCurrency) {
  const currencies = [...new Set(mapped.orders.map((order) => order.currency).filter(Boolean))];
  if (currencies.length > 1) throw new CustomCsvError(`This CSV contains multiple currencies (${currencies.join(', ')}). Separate the file by currency before importing; ExecuBrief does not apply foreign-exchange conversion.`);
  if (currencies.length === 1 && currencies[0] !== selectedCurrency) {
    throw new CustomCsvError(`The CSV's currency is ${currencies[0]}, but the selected report currency is ${selectedCurrency}. Select ${currencies[0]} instead. No currency conversion is performed.`);
  }
}

function latestWorkspacePeriod(minDate, maxDate, days = 90) {
  const minMs = Date.parse(`${minDate}T00:00:00.000Z`);
  const maxMs = Date.parse(`${maxDate}T00:00:00.000Z`);
  const requestedStart = new Date(maxMs - (days - 1) * 86400000).toISOString().slice(0, 10);
  const startDate = minMs > Date.parse(`${requestedStart}T00:00:00.000Z`) ? minDate : requestedStart;
  return { startDate, endDate: maxDate };
}

function latestReportPeriod(minDate, maxDate) {
  const minMs = Date.parse(`${minDate}T00:00:00.000Z`);
  const maxMs = Date.parse(`${maxDate}T00:00:00.000Z`);
  const requestedStart = new Date(maxMs - 92 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const startDate = minMs > Date.parse(`${requestedStart}T00:00:00.000Z`) ? minDate : requestedStart;
  return { startDate, endDate: maxDate, limited: startDate !== minDate };
}

function customReportShape(row) {
  let summary = null;
  try { summary = row.summaryJson ? JSON.parse(row.summaryJson) : null; } catch { summary = null; }
  const id = row.id;
  return {
    id,
    title: row.title,
    sourceFile: row.sourceFile,
    rowCount: row.rowCount,
    rowsReceived: Number(row.rowsReceived ?? row.rowCount ?? 0),
    duplicatesSkipped: Number(row.duplicatesSkipped ?? 0),
    invalidRows: Number(row.invalidRows ?? 0),
    currency: row.currency,
    status: row.status,
    startDate: row.startDate,
    endDate: row.endDate,
    createdAt: row.createdAt,
    summary,
    error: row.status === 'failed' ? 'Report generation failed. Check your CSV columns and values, then try again.' : null,
    ...(row.status === 'completed' ? { file: `/api/custom/reports/${id}/file`, download: `/api/custom/reports/${id}/download` } : {}),
  };
}

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function reportFilePath(reportPath, reportsDir) {
  const absolutePath = path.resolve(reportPath);
  if (!isWithinDirectory(reportsDir, absolutePath)) return null;
  return absolutePath;
}

function validateBodyPeriod(body) {
  const { startDate, endDate } = body;
  if ((startDate !== undefined && typeof startDate !== 'string') || (endDate !== undefined && typeof endDate !== 'string')) {
    throw new ReportPeriodError('startDate and endDate must be strings in YYYY-MM-DD format.');
  }
  if (Boolean(startDate) !== Boolean(endDate)) {
    throw new ReportPeriodError('Provide both startDate and endDate for a custom reporting period, or omit both to use the previous complete week.');
  }
  if (startDate && endDate) validateDateRange(startDate, endDate);
}

function validateQueryPeriod(query) {
  const { startDate, endDate } = query;
  if ((startDate !== undefined && typeof startDate !== 'string') || (endDate !== undefined && typeof endDate !== 'string')) {
    throw new ReportPeriodError('startDate and endDate must be strings in YYYY-MM-DD format.');
  }
  if (Boolean(startDate) !== Boolean(endDate)) {
    throw new ReportPeriodError('Provide both startDate and endDate for a custom reporting period, or omit both to use the previous complete week.');
  }
  if (startDate && endDate) validateDateRange(startDate, endDate);
  return { startDate, endDate };
}

function publicReportShape(row, database) {
  let summary = null;
  if (row.status === 'completed' && row.startDate && row.endDate) {
    const data = getReportData({ database, startDate: row.startDate, endDate: row.endDate });
    summary = data.summary;
  }
  return {
    ...row,
    file: `/api/reports/${row.id}/file`,
    download: `/api/reports/${row.id}/download`,
    summary,
    emailStatus: 'not_requested',
    emailError: null,
    error: row.status === 'failed' ? 'Report generation failed.' : null,
  };
}

function createDemoRateLimiter() {
  const requestsByClient = new Map();
  return {
    allow(clientId, now = Date.now()) {
      const recent = (requestsByClient.get(clientId) ?? []).filter((timestamp) => now - timestamp < DEMO_RATE_WINDOW_MS);
      if (recent.length >= DEMO_RATE_MAX) {
        requestsByClient.set(clientId, recent);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((DEMO_RATE_WINDOW_MS - (now - recent[0])) / 1000)) };
      }
      recent.push(now);
      requestsByClient.set(clientId, recent);
      if (requestsByClient.size > 2000) {
        for (const [key, timestamps] of requestsByClient) {
          if (timestamps.every((timestamp) => now - timestamp >= DEMO_RATE_WINDOW_MS)) requestsByClient.delete(key);
        }
      }
      return { allowed: true };
    },
  };
}

/**
 * Build the application without opening a database or starting a listener.
 * Private reporting dependencies are injectable so the same routes can be tested
 * without touching a developer's local database or sending real email.
 */
export function createApp(options = {}) {
  const app = express();
  const authToken = options.authToken ?? config.apiAuthToken;
  const privateReportsDir = path.resolve(options.reportsDir ?? config.reportsDir);
  const privateDatabase = () => options.database ?? getDefaultDatabase();
  const privateGenerate = options.generate ?? ((args) => generateReport(args));
  const privateAuth = bearerAuth(authToken);

  // Optional injection is useful for isolated demo-route tests; production uses only
  // getDemoDatabase(), whose storage marker and paths are checked before access.
  const demoDatabase = () => options.demoDatabase ?? getDemoDatabase();
  const demoReportsDir = () => path.resolve(options.demoReportsDir ?? getDemoReportsDir());
  const customDataDirectory = path.resolve(options.customDataDir ?? config.customDataDir);
  const customGenerate = options.customGenerate ?? ((args) => generateReport(args));
  const demoGenerate = options.demoGenerate ?? ((args) => generateReport({
    ...args,
    database: demoDatabase(),
    outputDir: demoReportsDir(),
    sendEmail: false,
    resendEmail: false,
  }));
  const demoRateLimiter = createDemoRateLimiter();
  const demoIdempotency = new Map();
  const authLimiter = createAuthRateLimiter({ limit: 10 });
  const csvPreviewLimiter = createAuthRateLimiter({ limit: 20 });
  const customReportLimiter = createAuthRateLimiter({ limit: CUSTOM_GENERATION_RATE_MAX });
  let activeDemoReports = 0;
  let activeCustomReports = 0;
  const sessionMiddleware = resolveSession(() => getStore(options, customDataDirectory));

  app.disable('x-powered-by');
  app.set('trust proxy', config.nodeEnv === 'production' ? 1 : false);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'self'; base-uri 'self'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: '32kb', strict: true }));

  // Liveness is deliberately database-free and public for hosting health checks.
  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  // Public demo configuration contains display options only; never credentials or paths.
  app.get('/api/config', (_req, res) => res.json({ companyName: 'ExecuBrief', reportCurrency: config.reportCurrency, theme: 'corporate', demo: true }));

  // Account and Google sign-in routes are additive. The public demo dashboard and its
  // existing synthetic-data endpoints remain separate from authenticated custom reporting.
  app.get('/api/auth/config', (_req, res) => res.json({ googleEnabled: Boolean(config.googleClientId && config.googleClientSecret) }));

  app.get('/api/auth/me', sessionMiddleware, (req, res) => {
    if (!req.authUser) return res.status(401).json({ error: 'Not signed in.' });
    return res.json({ user: req.authUser, csrfToken: req.authCsrfToken });
  });

  const issueAccountSession = (res, store, user) => {
    const session = store.createSession(user.id, user.organization?.id);
    setSessionCookie(res, session);
    return res.json({ user, csrfToken: session.csrfToken });
  };
  const authRateCheck = (req, res, limiter = authLimiter) => {
    const result = limiter.allow(req.ip || req.socket.remoteAddress || 'unknown');
    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfterSeconds));
      res.status(429).json({ error: 'Too many attempts. Wait a little while and try again.' });
      return false;
    }
    return true;
  };

  app.post('/api/auth/register', requireSameOrigin, async (req, res, next) => {
    if (!authRateCheck(req, res)) return;
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const store = getStore(options);
      const user = await store.register({ email: body.email, password: body.password, name: body.name, organizationName: body.organizationName });
      return issueAccountSession(res, store, user);
    } catch (error) {
      if (error instanceof AuthError) return res.status(error.status).json({ error: error.message });
      return next(error);
    }
  });

  app.post('/api/auth/login', requireSameOrigin, async (req, res, next) => {
    if (!authRateCheck(req, res)) return;
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const store = getStore(options);
      const user = await store.login({ email: body.email, password: body.password });
      return issueAccountSession(res, store, user);
    } catch (error) {
      if (error instanceof AuthError) return res.status(error.status).json({ error: error.message });
      return next(error);
    }
  });

  app.post('/api/auth/logout', sessionMiddleware, requireAuthenticated, requireCsrf, (req, res, next) => {
    try {
      getStore(options).revokeSession(req.authSessionToken);
      clearSessionCookie(res);
      return res.status(200).json({ status: 'signed_out' });
    } catch (error) { return next(error); }
  });

  const googleConfigured = () => Boolean(config.googleClientId && config.googleClientSecret);
  const googleRedirectUri = (req) => config.googleRedirectUri || `${deriveRequestOrigin(req)}/auth/google/callback`;
  app.get('/auth/google', (req, res) => {
    if (!googleConfigured()) return res.redirect(303, '/login?error=google-not-configured');
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    appendCookie(res, GOOGLE_STATE_COOKIE, state, { maxAgeSeconds: GOOGLE_FLOW_TTL_SECONDS });
    appendCookie(res, GOOGLE_NONCE_COOKIE, nonce, { maxAgeSeconds: GOOGLE_FLOW_TTL_SECONDS });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: googleRedirectUri(req),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      prompt: 'select_account',
    }).toString();
    return res.redirect(302, url.toString());
  });

  app.get('/auth/google/callback', async (req, res) => {
    const expectedState = readCookie(req, GOOGLE_STATE_COOKIE);
    const expectedNonce = readCookie(req, GOOGLE_NONCE_COOKIE);
    clearCookie(res, GOOGLE_STATE_COOKIE);
    clearCookie(res, GOOGLE_NONCE_COOKIE);
    if (!googleConfigured()) return res.redirect(303, '/login?error=google-not-configured');
    if (req.query.error || !timingSafeStringEqual(req.query.state, expectedState) || !expectedNonce || typeof req.query.code !== 'string') {
      return res.redirect(303, '/login?error=google-state');
    }
    try {
      const token = await exchangeGoogleCode({
        code: req.query.code,
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        redirectUri: googleRedirectUri(req),
      });
      const identity = await verifyGoogleIdToken(token, { audience: config.googleClientId, nonce: expectedNonce });
      const store = getStore(options);
      const user = store.getOrCreateGoogleUser({
        sub: identity.sub,
        email: identity.email,
        name: identity.name,
        picture: identity.picture,
        emailVerified: identity.emailVerified,
      });
      const session = store.createSession(user.id, user.organization?.id);
      setSessionCookie(res, session);
      return res.redirect(303, '/workspace');
    } catch (error) {
      if (error instanceof AuthError && error.code === 'GOOGLE_EMAIL_UNVERIFIED') return res.redirect(303, '/login?error=google-unverified');
      // Do not expose token exchange errors, provider responses, or account details in URLs or logs.
      console.warn('[Auth] Google sign-in could not be completed.');
      return res.redirect(303, '/login?error=google');
    }
  });

  const loginPage = (req, res) => {
    if (req.authUser) return res.redirect(303, '/workspace');
    res.set('Cache-Control', 'no-store');
    return res.sendFile(path.join(dashboardPublicDir, 'auth.html'));
  };
  app.get('/login', sessionMiddleware, loginPage);
  app.get('/signup', sessionMiddleware, loginPage);

  app.get('/custom-reports', sessionMiddleware, (req, res) => {
    if (!req.authUser) return res.redirect(303, '/login?next=%2Fcustom-reports');
    res.set('Cache-Control', 'no-store');
    return res.sendFile(path.join(dashboardPublicDir, 'custom-reports.html'));
  });

  app.get('/workspace', sessionMiddleware, (req, res) => {
    if (!req.authUser) return res.redirect(303, '/login?next=%2Fworkspace');
    res.set('Cache-Control', 'no-store');
    return res.sendFile(path.join(dashboardPublicDir, 'organization-dashboard.html'));
  });

  const rawCsvBody = (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      res.status(415).json({ error: 'Send the CSV file using Content-Type: text/csv.' });
      return null;
    }
    if (!req.body.length || req.body.length > config.importMaxFileBytes) {
      res.status(413).json({ error: `The CSV must be non-empty and no larger than ${Math.floor(config.importMaxFileBytes / (1024 * 1024))} MB.` });
      return null;
    }
    const text = req.body.toString('utf8');
    if (text.includes('\u0000')) {
      res.status(400).json({ error: 'The uploaded file does not look like a text CSV.' });
      return null;
    }
    return text;
  };

  app.get('/api/organization/analytics', sessionMiddleware, requireAuthenticated, async (req, res) => {
    let workspace;
    try {
      assertCustomStorageSafety(customDataDirectory);
      workspace = await openOrganizationWorkspace(customDataDirectory, req.authUser.organization?.id);
      const data = getOrganizationAnalytics({
        database: workspace.database,
        organization: req.authUser.organization,
        startDate: typeof req.query.startDate === 'string' ? req.query.startDate : undefined,
        endDate: typeof req.query.endDate === 'string' ? req.query.endDate : undefined,
        currency: getWorkspaceCurrency(workspace.database) || 'USD',
        filters: {
          category: typeof req.query.category === 'string' ? req.query.category : undefined,
          region: typeof req.query.region === 'string' ? req.query.region : undefined,
        },
      });
      return res.json(data);
    } catch (error) {
      if (error instanceof ReportPeriodError || error.code === 'INVALID_PERIOD') return res.status(400).json({ error: error.message });
      if (error instanceof WorkspaceError) return res.status(error.status).json({ error: error.message });
      console.warn('[Workspace] Analytics query failed.');
      return res.status(503).json({ error: 'Organisation analytics could not be calculated. Check workspace storage and imported data.' });
    } finally { closeOrganizationWorkspace(workspace); }
  });

  app.get('/api/organization/imports', sessionMiddleware, requireAuthenticated, async (req, res) => {
    let workspace;
    try {
      assertCustomStorageSafety(customDataDirectory);
      workspace = await openOrganizationWorkspace(customDataDirectory, req.authUser.organization?.id);
      return res.json({ imports: listWorkspaceImports(workspace.database, req.query.limit) });
    } catch (error) {
      if (error instanceof WorkspaceError) return res.status(error.status).json({ error: error.message });
      console.warn('[Workspace] Import history could not be loaded.');
      return res.status(503).json({ error: 'Organisation import history is unavailable.' });
    } finally { closeOrganizationWorkspace(workspace); }
  });

  app.post('/api/organization/imports', sessionMiddleware, requireAuthenticated, requireCsrf,
    express.raw({ type: ['text/csv', 'application/csv'], limit: config.importMaxFileBytes }),
    async (req, res) => {
      if (!authRateCheck(req, res, csvPreviewLimiter)) return;
      const csvText = rawCsvBody(req, res);
      if (csvText === null) return;
      let importOptions;
      try { importOptions = decodeImportOptions(req); }
      catch (error) { return res.status(400).json({ error: error.message || 'Import settings are invalid.' }); }

      let workspace;
      let mapped;
      const fileHash = sha256Text(csvText);
      try {
        assertCustomStorageSafety(customDataDirectory);
        workspace = await openOrganizationWorkspace(customDataDirectory, req.authUser.organization?.id);
        mapped = mapCustomCsv(csvText, importOptions.columns, {
          maxRows: config.importMaxRows,
          uploadId: fileHash.slice(0, 24),
          skipInvalidRows: true,
          skipDuplicateLineItems: true,
        });
        if (mapped.rowCount === 0) {
          const failure = recordFailedWorkspaceImport(workspace.database, {
            sourceFile: importOptions.filename, fileHash, mapping: importOptions.columns, rowsReceived: mapped.rowsReceived,
            invalidRows: Math.max(1, mapped.invalidRows.length + mapped.duplicateRows.length), minDate: mapped.minDate, maxDate: mapped.maxDate,
            error: mapped.invalidRows[0]?.reason || 'No valid rows remained after validation.',
          });
          return res.status(422).json({ error: failure.error, import: failure, validation: { invalidRows: mapped.invalidRows.slice(0, 10), duplicateRows: mapped.duplicateRows.slice(0, 10) } });
        }
        assertSingleSourceCurrency(mapped, importOptions.currency);
        const result = insertWorkspaceImport(workspace.database, {
          sourceFile: importOptions.filename, fileHash, mapping: importOptions.columns, mapped,
          currency: importOptions.currency, csvText,
        });
        return res.status(result.duplicateFile ? 200 : 201).json({
          ...result,
          validation: { invalidRows: mapped.invalidRows.slice(0, 10), duplicateRows: mapped.duplicateRows.slice(0, 10) },
          analyticsAvailable: true,
          message: result.duplicateFile ? result.error : `Imported ${result.rowsImported.toLocaleString()} row(s); ${result.duplicatesSkipped.toLocaleString()} duplicate(s) and ${result.invalidRows.toLocaleString()} invalid row(s) were skipped.`,
        });
      } catch (error) {
        let statusCode = 400;
        if (error instanceof WorkspaceError) statusCode = error.status;
        else if (!(error instanceof CustomCsvError)) statusCode = 500;
        let failureImport = null;
        if (workspace?.database) {
          try {
            const sample = (() => { try { return previewCustomCsv(csvText, { maxRows: config.importMaxRows }); } catch { return null; } })();
            failureImport = recordFailedWorkspaceImport(workspace.database, {
              sourceFile: importOptions.filename, fileHash, mapping: importOptions.columns,
              rowsReceived: sample?.rowCount || mapped?.rowsReceived || 0,
              invalidRows: Math.max(1, mapped?.invalidRows?.length || 0),
              minDate: mapped?.minDate || null, maxDate: mapped?.maxDate || null,
              error: error.message || 'Import validation failed.',
            });
          } catch { /* Preserve the original validation result if audit recording is unavailable. */ }
        }
        if (error instanceof CustomCsvError || error instanceof WorkspaceError) {
          return res.status(statusCode).json({ error: error.message, row: error.row ?? null, import: failureImport });
        }
        console.warn('[Workspace] Import failed before completion.');
        return res.status(500).json({ error: 'The CSV could not be imported. Check the file, column mapping, workspace storage and server logs.', import: failureImport });
      } finally { closeOrganizationWorkspace(workspace); }
    });

  app.post('/api/organization/reports', sessionMiddleware, requireAuthenticated, requireCsrf, async (req, res) => {
    if (activeCustomReports >= CUSTOM_MAX_ACTIVE_REPORTS) {
      res.set('Retry-After', '5');
      return res.status(503).json({ error: 'The PDF renderer is busy. Please retry shortly.' });
    }
    let workspace;
    let keepFiles = false;
    let jobDir = null;
    let reportOptions;
    let period;
    try {
      assertCustomStorageSafety(customDataDirectory);
      workspace = await openOrganizationWorkspace(customDataDirectory, req.authUser.organization?.id);
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const range = resolveWorkspacePeriod(workspace.database, body.startDate, body.endDate, { defaultDays: 30 });
      if (!range.range.hasData || !range.period) return res.status(400).json({ error: 'Import a valid CSV into this organisation before generating a workspace report.' });
      period = range.period;
      const currency = safeCurrency(body.currency || getWorkspaceCurrency(workspace.database) || 'USD');
      const workspaceCurrency = getWorkspaceCurrency(workspace.database) || currency;
      if (workspaceCurrency !== currency) return res.status(400).json({ error: `This workspace data is in ${workspaceCurrency}. Choose ${workspaceCurrency}; ExecuBrief does not convert currencies.` });
      const filterSpec = buildAnalyticsFilter({ category: body.category, region: body.region });
      reportOptions = {
        title: safeReportTitle(body.title || `${req.authUser.organization?.name || 'Organisation'} Executive Brief`),
        currency,
        filters: { category: filterSpec.category, region: filterSpec.region },
      };
      activeCustomReports += 1;
      const jobId = crypto.randomUUID();
      const reportDir = path.join(workspace.organizationRoot, jobId, 'reports');
      jobDir = path.dirname(reportDir);
      await fs.mkdir(reportDir, { recursive: true, mode: 0o700 });
      const totalRows = Number(workspace.database.prepare('SELECT COUNT(*) AS n FROM orders').get().n);
      const importHealth = getOrganizationAnalytics({ database: workspace.database, organization: req.authUser.organization, currency }).importHealth;
      const sourceFile = `${importHealth.successfulFiles} organisation import(s)`;
      const workspaceAnalytics = (args) => {
        const data = getOrganizationAnalytics({ database: workspace.database, organization: req.authUser.organization,
          startDate: args.startDate, endDate: args.endDate, currency, filters: reportOptions.filters });
        data.metadata.companyName = reportOptions.title;
        data.metadata.reportTitle = reportOptions.title;
        data.metadata.currency = currency;
        return data;
      };
      let generated;
      try {
        generated = await customGenerate({ database: workspace.database, startDate: period.startDate, endDate: period.endDate,
          sendEmail: false, resendEmail: false, outputDir: reportDir, analytics: workspaceAnalytics });
      } catch (error) {
        const failedId = error.reportId && UUID_PATTERN.test(error.reportId) ? error.reportId : crypto.randomUUID();
        const store = getStore(options);
        store.createCustomReport({ id: failedId, userId: req.authUser.id, organizationId: req.authUser.organization?.id,
          jobId, title: reportOptions.title, sourceFile, rowCount: totalRows, rowsReceived: totalRows, currency,
          startDate: period.startDate, endDate: period.endDate, createdAt: new Date().toISOString() });
        store.updateCustomReport(failedId, req.authUser.organization?.id, { status: 'failed', startDate: period.startDate,
          endDate: period.endDate, error: 'Report generation failed.' });
        return res.status(500).json({ error: 'The workspace data was accepted, but the PDF renderer failed. Confirm Puppeteer/Chromium is installed, then retry without re-uploading the CSV.' });
      }
      const store = getStore(options);
      store.createCustomReport({ id: generated.id, userId: req.authUser.id, organizationId: req.authUser.organization?.id,
        jobId, title: reportOptions.title, sourceFile, rowCount: totalRows, rowsReceived: totalRows, currency,
        startDate: generated.reportPeriod.startDate, endDate: generated.reportPeriod.endDate, createdAt: generated.createdAt });
      store.updateCustomReport(generated.id, req.authUser.organization?.id, { status: 'completed', startDate: generated.reportPeriod.startDate,
        endDate: generated.reportPeriod.endDate, summary: generated.summary, error: null });
      keepFiles = true;
      return res.status(201).json(customReportShape(store.getCustomReport(req.authUser.organization?.id, generated.id)));
    } catch (error) {
      if (error instanceof ReportPeriodError || error instanceof WorkspaceError || error instanceof CustomCsvError) {
        return res.status(error.status || 400).json({ error: error.message });
      }
      console.warn('[Workspace] Report generation failed.');
      return res.status(500).json({ error: 'The organisation report could not be generated. Check the imported data and PDF renderer setup.' });
    } finally {
      if (workspace) closeOrganizationWorkspace(workspace);
      if (jobDir && !keepFiles) await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
      if (activeCustomReports > 0 && reportOptions) activeCustomReports = Math.max(0, activeCustomReports - 1);
    }
  });

  app.post('/api/custom/csv/preview', sessionMiddleware, requireAuthenticated, requireCsrf,
    express.raw({ type: ['text/csv', 'application/csv'], limit: config.importMaxFileBytes }),
    (req, res) => {
      if (!authRateCheck(req, res, csvPreviewLimiter)) return;
      const csvText = rawCsvBody(req, res);
      if (csvText === null) return;
      try {
        const preview = previewCustomCsv(csvText, { maxRows: config.importMaxRows });
        const selectedMapping = decodePreviewMapping(req) || preview.suggestedMapping;
        const requiredMappingAvailable = ['date', 'amount', 'product'].every((field) => typeof selectedMapping[field] === 'string' && selectedMapping[field] && preview.headers.includes(selectedMapping[field]));
        if (!requiredMappingAvailable) {
          preview.validationError = 'Choose columns for date, amount/revenue, and product, then recheck the mapping to detect available dates.';
          preview.validation = { invalidRows: 0, duplicateRows: 0, invalidRowExamples: [], duplicateRowExamples: [] };
          preview.selectedMapping = selectedMapping;
          return res.status(200).json(preview);
        }
        try {
          const mapped = mapCustomCsv(csvText, selectedMapping, {
            maxRows: config.importMaxRows, uploadId: 'preview', skipInvalidRows: true, skipDuplicateLineItems: true,
          });
          preview.selectedMapping = selectedMapping;
          preview.validRowCount = mapped.rowCount;
          preview.rowsReceived = mapped.rowsReceived;
          preview.validation = {
            invalidRows: mapped.invalidRows.length,
            duplicateRows: mapped.duplicateRows.length,
            invalidRowExamples: mapped.invalidRows.slice(0, 8),
            duplicateRowExamples: mapped.duplicateRows.slice(0, 8),
          };
          if (mapped.minDate && mapped.maxDate) {
            preview.availablePeriod = { startDate: mapped.minDate, endDate: mapped.maxDate };
            preview.suggestedPeriod = latestReportPeriod(mapped.minDate, mapped.maxDate);
          } else {
            preview.validationError = mapped.invalidRows[0]?.reason || 'No valid dates were found in the mapped date column.';
          }
          const currencies = [...new Set(mapped.orders.map((order) => order.currency).filter(Boolean))];
          preview.detectedCurrency = currencies.length === 1 ? currencies[0] : null;
          preview.multipleCurrencies = currencies.length > 1 ? currencies : [];
          if (!mapped.rowCount) preview.validationError = mapped.invalidRows[0]?.reason || 'No valid data rows were found. Check your date, amount, and product mappings.';
          else if (currencies.length > 1) preview.validationError = `This file contains multiple currencies (${currencies.join(', ')}). Separate it by currency; ExecuBrief does not convert currencies.`;
        } catch (error) {
          if (!(error instanceof CustomCsvError)) throw error;
          preview.selectedMapping = selectedMapping;
          preview.validationError = error.message;
          preview.validation = { invalidRows: 1, duplicateRows: 0, invalidRowExamples: [{ row: error.row, reason: error.message }], duplicateRowExamples: [] };
        }
        return res.status(200).json(preview);
      } catch (error) {
        if (error instanceof CustomCsvError) return res.status(400).json({ error: error.message, row: error.row });
        console.warn('[Custom CSV] Preview failed.');
        return res.status(400).json({ error: 'Could not read this CSV. Check the file format and column headers.' });
      }
    });

  app.get('/api/custom/reports', sessionMiddleware, requireAuthenticated, (req, res, next) => {
    try {
      const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit ?? '25', 10) || 25));
      const rows = getStore(options).listCustomReports(req.authUser.organization?.id, limit);
      return res.json({ reports: rows.map(customReportShape) });
    } catch (error) { return next(error); }
  });

  app.post('/api/custom/reports', sessionMiddleware, requireAuthenticated, requireCsrf,
    express.raw({ type: ['text/csv', 'application/csv'], limit: config.importMaxFileBytes }),
    async (req, res) => {
      const rate = customReportLimiter.allow(req.authUser.organization?.id || req.authUser.id);
      if (!rate.allowed) {
        res.set('Retry-After', String(rate.retryAfterSeconds));
        return res.status(429).json({ error: 'You have generated several custom reports recently. Wait a little while and try again.' });
      }
      if (activeCustomReports >= CUSTOM_MAX_ACTIVE_REPORTS) {
        res.set('Retry-After', '5');
        return res.status(503).json({ error: 'The PDF renderer is busy. Please retry shortly.' });
      }
      const csvText = rawCsvBody(req, res);
      if (csvText === null) return;
      let reportOptions;
      let mapped;
      try {
        reportOptions = decodeCustomOptions(req);
        mapped = mapCustomCsv(csvText, reportOptions.columns, { maxRows: config.importMaxRows, uploadId: crypto.randomUUID(), skipInvalidRows: true, skipDuplicateLineItems: true });
      } catch (error) {
        if (error instanceof CustomCsvError) return res.status(400).json({ error: error.message, row: error.row });
        return res.status(400).json({ error: 'CSV validation failed. Check the selected columns and values.' });
      }

      if (!mapped.rowCount || !mapped.minDate || !mapped.maxDate) {
        return res.status(400).json({ error: mapped.invalidRows[0]?.reason || 'No valid rows remain after checking the date, amount, and product columns.', invalidRows: mapped.invalidRows.slice(0, 8), duplicatesSkipped: mapped.duplicateRows.length });
      }
      try { assertSingleSourceCurrency(mapped, reportOptions.currency); }
      catch (error) { return res.status(400).json({ error: error.message }); }

      if ((reportOptions.startDate !== undefined && typeof reportOptions.startDate !== 'string') || (reportOptions.endDate !== undefined && typeof reportOptions.endDate !== 'string')) {
        return res.status(400).json({ error: 'Start and end dates must use YYYY-MM-DD format.' });
      }
      if (Boolean(reportOptions.startDate) !== Boolean(reportOptions.endDate)) {
        return res.status(400).json({ error: 'Provide both start and end dates, or leave both blank.' });
      }
      let period;
      try {
        period = reportOptions.startDate && reportOptions.endDate
          ? { startDate: reportOptions.startDate, endDate: reportOptions.endDate, limited: false }
          : latestReportPeriod(mapped.minDate, mapped.maxDate);
        validateDateRange(period.startDate, period.endDate);
      } catch (error) {
        if (error instanceof ReportPeriodError || error.code === 'INVALID_PERIOD') return res.status(400).json({ error: error.message });
        return res.status(400).json({ error: 'The uploaded date range is invalid.' });
      }
      if (period.startDate < mapped.minDate || period.endDate > mapped.maxDate) {
        return res.status(400).json({ error: `Choose dates within the uploaded data range (${mapped.minDate} to ${mapped.maxDate}). The selected range must be fully covered by available data.` });
      }
      const userId = req.authUser.id;
      const organizationId = req.authUser.organization?.id;
      if (!organizationId) return res.status(403).json({ error: 'Your account is not linked to an organisation workspace. Sign in again or contact the administrator.' });
      if (activeCustomReports >= CUSTOM_MAX_ACTIVE_REPORTS) return res.status(503).json({ error: 'The PDF renderer is busy. Please retry shortly.' });
      activeCustomReports += 1;
      const jobId = crypto.randomUUID();
      const reportDir = customDataDirectory;
      const organizationDir = path.join(reportDir, organizationId);
      const jobDir = path.join(organizationDir, jobId);
      const databasePath = path.join(jobDir, 'source.sqlite');
      const outputDir = path.join(jobDir, 'reports');
      let database;
      let keepFiles = false;
      try {
        assertCustomStorageSafety(customDataDirectory);
        await fs.mkdir(jobDir, { recursive: true, mode: 0o700 });
        const realRoot = await fs.realpath(reportDir);
        const realJobDir = await fs.realpath(jobDir);
        if (!isWithinDirectory(realRoot, realJobDir)) throw new Error('Custom data directory failed its safety check.');
        database = createDatabase(databasePath);
        const insert = database.prepare(`INSERT INTO orders
          (order_id,line_item_id,customer,product,amount,created_at,category,region,country,business_unit,sales_channel,customer_segment,
           quantity,unit_price,discount_percent,cost,gross_profit,gross_margin_percent,source_currency,sales_rep,payment_status,fulfillment_status,source_system)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        database.exec('BEGIN IMMEDIATE');
        try {
          for (const order of mapped.orders) {
            insert.run(order.orderId, order.lineItemId, order.customer || 'Not provided', order.product, order.amount,
              `${order.createdAt}T12:00:00.000Z`, order.category, order.region, order.country, order.businessUnit, order.salesChannel,
              order.customerSegment, order.quantity, order.unitPrice, order.discountPercent, order.cost, order.grossProfit,
              order.grossMarginPercent, order.currency || reportOptions.currency, order.salesRep, order.paymentStatus, order.fulfillmentStatus, order.sourceSystem);
          }
          database.exec('COMMIT');
        } catch (error) {
          try { database.exec('ROLLBACK'); } catch { /* transaction already ended */ }
          throw error;
        }

        const customAnalytics = (args) => {
          const data = getReportData(args);
          data.metadata.companyName = reportOptions.title;
          data.metadata.reportTitle = reportOptions.title;
          data.metadata.currency = reportOptions.currency;
          return data;
        };
        let generated;
        try {
          generated = await customGenerate({
            database,
            startDate: period.startDate,
            endDate: period.endDate,
            sendEmail: false,
            resendEmail: false,
            outputDir,
            analytics: customAnalytics,
          });
        } catch (error) {
          const failedId = error.reportId && UUID_PATTERN.test(error.reportId) ? error.reportId : crypto.randomUUID();
          const store = getStore(options);
          store.createCustomReport({
            id: failedId, userId, organizationId, jobId, title: reportOptions.title, sourceFile: reportOptions.filename,
            rowCount: mapped.rowCount, rowsReceived: mapped.rowsReceived, duplicatesSkipped: mapped.duplicateRows.length, invalidRows: mapped.invalidRows.length, currency: reportOptions.currency, startDate: period.startDate,
            endDate: period.endDate, createdAt: new Date().toISOString(),
          });
          store.updateCustomReport(failedId, organizationId, { status: 'failed', startDate: period.startDate, endDate: period.endDate, error: 'Report generation failed.' });
          keepFiles = false;
          console.warn(`[Custom PDF] Report rendering failed at ${error.stage || 'unknown'} stage.`);
          return res.status(500).json({ error: 'The CSV was accepted, but the PDF could not be rendered. Check the local Chromium/Puppeteer setup and try again.' });
        }

        const store = getStore(options);
        store.createCustomReport({
          id: generated.id, userId, organizationId, jobId, title: reportOptions.title, sourceFile: reportOptions.filename,
          rowCount: mapped.rowCount, rowsReceived: mapped.rowsReceived, duplicatesSkipped: mapped.duplicateRows.length, invalidRows: mapped.invalidRows.length, currency: reportOptions.currency, startDate: generated.reportPeriod.startDate,
          endDate: generated.reportPeriod.endDate, createdAt: generated.createdAt,
        });
        store.updateCustomReport(generated.id, organizationId, {
          status: 'completed', startDate: generated.reportPeriod.startDate, endDate: generated.reportPeriod.endDate,
          summary: generated.summary, error: null,
        });
        keepFiles = true;
        const row = store.getCustomReport(organizationId, generated.id);
        return res.status(201).json(customReportShape(row));
      } catch (error) {
        if (error instanceof CustomCsvError) return res.status(400).json({ error: error.message, row: error.row });
        console.warn('[Custom PDF] Request failed before a report was saved.');
        return res.status(500).json({ error: 'The custom report could not be completed. Check the CSV and server configuration, then try again.' });
      } finally {
        try { database?.close(); } catch { /* no open database */ }
        if (!keepFiles) await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
        activeCustomReports = Math.max(0, activeCustomReports - 1);
      }
    });

  app.get('/api/custom/reports/:id', sessionMiddleware, requireAuthenticated, (req, res, next) => {
    if (!UUID_PATTERN.test(req.params.id)) return res.status(404).json({ error: 'Custom report not found.' });
    try {
      const row = getStore(options).getCustomReport(req.authUser.organization?.id, req.params.id);
      if (!row) return res.status(404).json({ error: 'Custom report not found.' });
      return res.json(customReportShape(row));
    } catch (error) { return next(error); }
  });

  const customPdfHandler = async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) return res.status(404).json({ error: 'Custom report not found.' });
    let row;
    try { row = getStore(options).getCustomReport(req.authUser.organization?.id, req.params.id); }
    catch { return res.status(503).json({ error: 'Custom report storage is temporarily unavailable.' }); }
    if (!row || row.status !== 'completed') return res.status(404).json({ error: 'Custom report file not found.' });
    const organizationRoot = path.resolve(customDataDirectory, req.authUser.organization?.id || 'missing-organisation');
    const candidates = [{ root: organizationRoot }];
    // Preserve access to reports created before the organisation-scoped storage migration.
    // A legacy user directory may only be used by its original creator, never another org member.
    if (row.createdByUserId && row.createdByUserId === req.authUser.id) {
      candidates.push({ root: path.resolve(customDataDirectory, req.authUser.id) });
    }
    let absolutePath = null;
    for (const candidate of candidates) {
      const candidatePath = path.resolve(candidate.root, row.job_id, 'reports', `${row.id}.pdf`);
      if (!isWithinDirectory(candidate.root, candidatePath) || path.basename(candidatePath) !== `${row.id}.pdf`) continue;
      try {
        const [stat, realFile, realRoot] = await Promise.all([fs.stat(candidatePath), fs.realpath(candidatePath), fs.realpath(candidate.root)]);
        if (stat.isFile() && isWithinDirectory(realRoot, realFile)) {
          absolutePath = candidatePath;
          break;
        }
      } catch { /* Try the next allowed storage location. */ }
    }
    if (!absolutePath) return res.status(404).json({ error: 'Custom report file not found.' });
    res.set({ 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const filename = `execubrief-${row.id}.pdf`;
    if (req.path.endsWith('/download')) return res.download(absolutePath, filename, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    return res.sendFile(absolutePath, { headers: { 'Content-Disposition': `inline; filename="${filename}"` } });
  };
  app.get('/api/custom/reports/:id/file', sessionMiddleware, requireAuthenticated, customPdfHandler);
  app.get('/api/custom/reports/:id/download', sessionMiddleware, requireAuthenticated, customPdfHandler);

  const analyticsHandler = (req, res) => {
    try {
      const { startDate, endDate } = validateQueryPeriod(req.query);
      const reportData = getReportData({ database: demoDatabase(), startDate, endDate });
      return res.status(200).json(reportData);
    } catch (error) {
      if (error instanceof ReportPeriodError || error.code === 'INVALID_PERIOD') {
        return res.status(400).json({ error: error.message });
      }
      console.error('[Demo API] Analytics request failed.');
      return res.status(503).json({ error: 'Demo analytics are temporarily unavailable.' });
    }
  };
  app.get('/api/analytics', analyticsHandler);
  app.get('/api/demo/summary', analyticsHandler);

  const demoReportsHandler = (req, res) => {
    try {
      const database = demoDatabase();
      const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit ?? '10', 10) || 10));
      const rows = database.prepare(`SELECT ${REPORT_COLUMNS} FROM reports ORDER BY created_at DESC LIMIT ?`).all(limit);
      return res.status(200).json({ reports: rows.map((row) => publicReportShape(row, database)) });
    } catch (error) {
      console.error('[Demo API] Report history request failed.');
      return res.status(503).json({ error: 'Demo report history is temporarily unavailable.' });
    }
  };
  app.get('/api/reports', demoReportsHandler);
  app.get('/api/demo/reports', demoReportsHandler);

  const generateDemoHandler = async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    try {
      validateBodyPeriod(body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const suppliedKey = req.get('idempotency-key') ?? body.idempotencyKey;
    if (suppliedKey !== undefined && (typeof suppliedKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(suppliedKey))) {
      return res.status(400).json({ error: 'Idempotency-Key must be 1-128 characters from A-Z a-z 0-9 . _ : -' });
    }

    const clientId = req.ip || req.socket.remoteAddress || 'unknown';
    const idempotencyId = suppliedKey ? `${clientId}:${suppliedKey}` : null;
    if (idempotencyId) {
      const cached = demoIdempotency.get(idempotencyId);
      if (cached && cached.expiresAt > Date.now()) {
        try {
          const report = await cached.promise;
          return res.status(200).json({ ...report, idempotentReplay: true });
        } catch {
          demoIdempotency.delete(idempotencyId);
        }
      } else if (cached) {
        demoIdempotency.delete(idempotencyId);
      }
    }

    const rate = demoRateLimiter.allow(clientId);
    if (!rate.allowed) {
      res.set('Retry-After', String(rate.retryAfterSeconds));
      return res.status(429).json({ error: 'Demo report generation limit reached. Please try again later.' });
    }
    if (activeDemoReports >= DEMO_MAX_CONCURRENT_REPORTS) {
      res.set('Retry-After', '5');
      return res.status(503).json({ error: 'The report renderer is busy. Please retry shortly.' });
    }

    activeDemoReports += 1;
    const generation = (async () => {
      const report = await demoGenerate({
        startDate: body.startDate,
        endDate: body.endDate,
        // Public requests can never turn on email delivery, even if the body asks for it.
        sendEmail: false,
        resendEmail: false,
        database: demoDatabase(),
        outputDir: demoReportsDir(),
      });
      return {
        id: report.id,
        status: report.status,
        file: `/api/reports/${report.id}/file`,
        download: `/api/reports/${report.id}/download`,
        createdAt: report.createdAt,
        reportPeriod: report.reportPeriod,
        summary: report.summary,
        email: { status: 'not_requested' },
      };
    })();

    if (idempotencyId) {
      demoIdempotency.set(idempotencyId, { expiresAt: Date.now() + IDEMPOTENCY_TTL_MS, promise: generation });
    }
    try {
      const report = await generation;
      return res.status(201).json(report);
    } catch (error) {
      if (idempotencyId) demoIdempotency.delete(idempotencyId);
      if (error instanceof ReportPeriodError || error.code === 'INVALID_PERIOD') {
        return res.status(400).json({ error: error.message });
      }
      console.error(`[Demo API] Report generation failed (${error.stage ?? 'unknown'}).`);
      return res.status(500).json({ error: 'Report generation failed. Please try again later.' });
    } finally {
      activeDemoReports = Math.max(0, activeDemoReports - 1);
    }
  };
  app.post('/api/reports/generate', generateDemoHandler);
  app.post('/api/demo/reports', generateDemoHandler);

  const demoReportStatusHandler = (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) return res.status(404).json({ error: 'Report not found.' });
    try {
      const database = demoDatabase();
      const row = database.prepare(`SELECT ${REPORT_COLUMNS} FROM reports WHERE id = ?`).get(req.params.id);
      if (!row) return res.status(404).json({ error: 'Report not found.' });
      return res.status(200).json(publicReportShape(row, database));
    } catch {
      return res.status(503).json({ error: 'Demo report status is temporarily unavailable.' });
    }
  };
  app.get('/api/reports/:id', demoReportStatusHandler);
  app.get('/api/demo/reports/:id', demoReportStatusHandler);

  const demoPdfHandler = async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) return res.status(404).json({ error: 'Report not found.' });
    let report;
    try {
      report = demoDatabase().prepare('SELECT id, path, status FROM reports WHERE id = ?').get(req.params.id);
    } catch {
      return res.status(503).json({ error: 'Demo report storage is temporarily unavailable.' });
    }
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    if (report.status !== 'completed') return res.status(409).json({ error: 'The report is not ready.', status: report.status });

    const absolutePath = reportFilePath(report.path, demoReportsDir());
    if (!absolutePath || path.basename(absolutePath) !== `${req.params.id}.pdf`) {
      return res.status(404).json({ error: 'Report file not found.' });
    }
    try {
      const [stat, realFile, realDirectory] = await Promise.all([
        fs.stat(absolutePath), fs.realpath(absolutePath), fs.realpath(demoReportsDir()),
      ]);
      if (!stat.isFile() || !isWithinDirectory(realDirectory, realFile)) return res.status(404).json({ error: 'Report file not found.' });
    } catch {
      return res.status(404).json({ error: 'The PDF file is missing from demo storage.' });
    }
    res.set({ 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const filename = `executive-report-${req.params.id}.pdf`;
    if (req.path.endsWith('/download')) return res.download(absolutePath, filename, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    return res.sendFile(absolutePath, { headers: { 'Content-Disposition': `inline; filename="${filename}"` } });
  };
  app.get('/api/reports/:id/file', demoPdfHandler);
  app.get('/api/reports/:id/download', demoPdfHandler);
  app.get('/api/demo/reports/:id/file', demoPdfHandler);
  app.get('/api/demo/reports/:id/download', demoPdfHandler);

  // Private/admin API. These routes use only the private database and are bearer-protected
  // whenever API_AUTH_TOKEN is configured; production startup requires that token.
  app.get('/reports', privateAuth, (_req, res) => {
    const rows = privateDatabase().prepare(`SELECT ${REPORT_COLUMNS} FROM reports ORDER BY created_at DESC LIMIT 50`).all();
    return res.json({ reports: rows });
  });

  app.post('/reports', privateAuth, async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const { startDate, endDate, sendEmail = false, resendEmail = false } = body;
    const idempotencyKey = req.get('idempotency-key') ?? body.idempotencyKey;

    if (typeof sendEmail !== 'boolean') return res.status(400).json({ error: 'sendEmail must be a boolean.' });
    if (typeof resendEmail !== 'boolean') return res.status(400).json({ error: 'resendEmail must be a boolean.' });
    try {
      validateBodyPeriod({ startDate, endDate });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))) {
      return res.status(400).json({ error: 'Idempotency-Key must be 1-128 characters from A-Z a-z 0-9 . _ : -' });
    }

    let generated;
    try {
      generated = await privateGenerate({
        startDate,
        endDate,
        sendEmail,
        resendEmail,
        idempotencyKey,
        database: privateDatabase(),
        outputDir: privateReportsDir,
      });
    } catch (error) {
      if (error instanceof ReportPeriodError || error.code === 'INVALID_PERIOD') {
        return res.status(400).json({ error: error.message });
      }
      console.error(`[HTTP] Report generation failed (${error.stage ?? 'unknown'}).`);
      return res.status(500).json({ error: 'Report generation failed.', stage: error.stage ?? 'unknown', reportId: error.reportId });
    }

    if (generated.email?.status === 'failed') return res.status(502).json(generated);
    return res.status(201).json(generated);
  });

  app.get('/reports/:id', privateAuth, (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) return res.status(404).json({ error: 'Report not found.' });
    const report = privateDatabase().prepare(`SELECT ${REPORT_COLUMNS} FROM reports WHERE id = ?`).get(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    return res.json(report);
  });

  app.get('/reports/:id/file', privateAuth, async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) return res.status(404).json({ error: 'Report not found.' });
    const report = privateDatabase().prepare('SELECT id, path, status FROM reports WHERE id = ?').get(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    if (report.status !== 'completed') return res.status(409).json({ error: 'The report is not ready.', status: report.status });

    const absolutePath = reportFilePath(report.path, privateReportsDir);
    if (!absolutePath) return res.status(500).json({ error: 'The report file path is outside the configured reports directory.' });
    try {
      const [stat, realFile, realDirectory] = await Promise.all([
        fs.stat(absolutePath), fs.realpath(absolutePath), fs.realpath(privateReportsDir),
      ]);
      if (!stat.isFile() || !isWithinDirectory(realDirectory, realFile)) return res.status(404).json({ error: 'The PDF file is missing from disk.' });
    } catch {
      return res.status(404).json({ error: 'The PDF file is missing from disk.' });
    }
    res.set({ 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.download(absolutePath, `executive-report-${req.params.id}.pdf`);
  });

  app.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.sendFile(path.join(dashboardPublicDir, 'index.html'));
  });
  app.get('/vendor/chart.umd.js', (_req, res) => {
    const chartBundle = path.join(projectRoot, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
    return res.sendFile(chartBundle, (error) => {
      if (error && !res.headersSent) res.status(503).type('text/plain').send('Local chart assets are unavailable. Install the project dependencies and restart ExecuBrief.');
    });
  });
  app.use(express.static(dashboardPublicDir, { index: false, fallthrough: true, maxAge: config.nodeEnv === 'production' ? '1h' : 0 }));

  app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Malformed JSON request body.' });
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
    const errorName = typeof error?.name === 'string' ? error.name.slice(0, 40) : 'Error';
    const errorCode = typeof error?.code === 'string' ? `, code=${error.code.slice(0, 40)}` : '';
    console.error(`[HTTP] Unhandled request error (${errorName}${errorCode}).`);
    return res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}
