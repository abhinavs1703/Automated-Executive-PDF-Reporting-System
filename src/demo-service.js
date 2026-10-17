import { getDemoDatabase, getDemoReportsDir } from './demo-db.js';
import { getOrdersOverview } from './orders-overview.js';
import { getReportData } from './analytics.js';
import { generateReport } from './report-service.js';

export async function getDemoAnalytics({ startDate, endDate } = {}) {
  return getReportData({ database: getDemoDatabase(), startDate, endDate });
}

export async function getDemoOrdersOverview({ latest = 10 } = {}) {
  return getOrdersOverview(getDemoDatabase(), { latest });
}

export async function getDemoRecentReports({ limit = 10 } = {}) {
  const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 10;
  return getDemoDatabase().prepare(`
    SELECT id, status, file_url AS file, from_date AS startDate, to_date AS endDate,
           email_status AS emailStatus, created_at AS createdAt,
           error, error_stage AS errorStage, email_error AS emailError
    FROM reports
    ORDER BY created_at DESC
    LIMIT ?
  `).all(safeLimit).map((report) => ({
    ...report,
    file: `/api/reports/${report.id}/file`,
  }));
}

/** Public demo generation is always email-free, regardless of caller-supplied flags. */
export async function createDemoReport({ startDate, endDate } = {}) {
  const database = getDemoDatabase();
  const report = await generateReport({
    database,
    startDate,
    endDate,
    sendEmail: false,
    resendEmail: false,
    outputDir: getDemoReportsDir(),
  });
  return {
    ...report,
    file: `/api/reports/${report.id}/file`,
    email: { status: 'not_requested' },
  };
}
