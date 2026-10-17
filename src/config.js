import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path of the repository root, derived from this module's location
 * (NOT from process.cwd()), so the app behaves identically from any directory.
 */
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Always load <repo>/.env, regardless of the working directory (DOTENV_CONFIG_PATH may
// point elsewhere, mainly for tests). Real environment variables take precedence over the file.
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || path.join(projectRoot, '.env'), quiet: true });

/** Resolve a user-supplied path relative to the repository root. */
export function resolveFromRoot(value, fallback) {
  const chosen = value && value.trim() ? value.trim() : fallback;
  return path.isAbsolute(chosen) ? chosen : path.resolve(projectRoot, chosen);
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parsePositiveInt(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

export const config = {
  projectRoot,
  host: process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
  port: Number.parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databasePath: resolveFromRoot(process.env.DATABASE_PATH, 'data/report.db'),
  reportsDir: resolveFromRoot(process.env.REPORTS_DIR, 'reports'),
  // Separate account/session metadata and isolated per-user uploaded datasets.
  authDatabasePath: resolveFromRoot(process.env.AUTH_DATABASE_PATH, 'data/auth.sqlite'),
  customDataDir: resolveFromRoot(process.env.CUSTOM_DATA_DIR, 'custom-data'),
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || '',
  templatePath: path.join(projectRoot, 'templates', 'executive-report.hbs'),
  reportCurrency: process.env.REPORT_CURRENCY || 'USD',
  companyName: process.env.COMPANY_NAME || 'The Little Shop',

  // API protection. When set, every endpoint except /health requires
  // `Authorization: Bearer <API_AUTH_TOKEN>`.
  apiAuthToken: process.env.API_AUTH_TOKEN || '',

  // Scheduler
  enableScheduler: parseBoolean(process.env.ENABLE_SCHEDULER, false),
  reportCronSchedule: process.env.REPORT_CRON_SCHEDULE || '0 8 * * 1',
  reportTimezone: process.env.REPORT_TIMEZONE || 'UTC',

  // Email
  emailEnabled: parseBoolean(process.env.EMAIL_ENABLED, false),
  // Resend API key. Read from the environment only; never hard-coded or logged.
  resendApiKey: process.env.RESEND_API_KEY || '',
  emailFrom: process.env.EMAIL_FROM || '',
  emailTo: (process.env.EMAIL_TO || '').split(',').map((value) => value.trim()).filter(Boolean),
  emailClaimTimeoutMs: parsePositiveInt('EMAIL_CLAIM_TIMEOUT_MS', process.env.EMAIL_CLAIM_TIMEOUT_MS, 10 * 60 * 1000),

  // CSV import limits (see README, "Importing sales data")
  importMaxFileBytes: parsePositiveInt('IMPORT_MAX_FILE_MB', process.env.IMPORT_MAX_FILE_MB, 5) * 1024 * 1024,
  importMaxRows: parsePositiveInt('IMPORT_MAX_ROWS', process.env.IMPORT_MAX_ROWS, 50_000),

  // Browser / PDF rendering
  chromeExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '',
  puppeteerNoSandbox: parseBoolean(process.env.PUPPETEER_NO_SANDBOX, false),
  pdfChartTimeoutMs: parsePositiveInt('PDF_CHART_TIMEOUT_MS', process.env.PDF_CHART_TIMEOUT_MS, 15000),

  // Reports left in "pending" longer than this are marked failed at startup.
  staleReportAfterMs: parsePositiveInt('STALE_REPORT_AFTER_MS', process.env.STALE_REPORT_AFTER_MS, 15 * 60 * 1000),
};

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
