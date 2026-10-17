import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDefaultDatabase } from './db.js';
import { config } from './config.js';
import { getReportData, validateDateRange, ReportPeriodError } from './analytics.js';
import { renderPdf } from './renderer.js';
import { sendReportEmail } from './email.js';
import { claimDelivery, computeDeliveryKey, markDeliveryFailed, markDeliverySent } from './email-ledger.js';

const truncate = (value, max = 1000) => String(value ?? '').slice(0, max);

function markReportFailed(database, reportId, stage, error) {
  try {
    database.prepare(`
      UPDATE reports
      SET status = 'failed', error_stage = ?, error = ?,
          email_status = CASE WHEN email_status = 'pending' THEN 'not_sent' ELSE email_status END
      WHERE id = ?
    `).run(stage, truncate(error?.message || 'Report generation failed.'), reportId);
  } catch (updateError) {
    // Never mask the original error with a bookkeeping failure.
    console.error(`[Report ${reportId}] Could not record failure state: ${updateError.message}`);
  }
}

/**
 * Mark reports stuck in "pending" (for example because the process was killed
 * mid-generation) as failed. Run at startup. Returns the number recovered.
 */
export function recoverStaleReports({ database = getDefaultDatabase(), olderThanMs = config.staleReportAfterMs, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  const result = database.prepare(`
    UPDATE reports
    SET status = 'failed', error_stage = 'interrupted',
        error = 'Report generation was interrupted before it finished (server stopped or timed out).',
        email_status = CASE WHEN email_status = 'pending' THEN 'not_sent' ELSE email_status END
    WHERE status = 'pending' AND created_at < ?
  `).run(cutoff);
  return Number(result.changes);
}

/**
 * Run the whole pipeline: SQL analytics -> JSON -> HTML -> PDF -> optional email.
 * Report status and email status are tracked independently.
 *
 * Email is only attempted after the PDF exists, and is idempotent: the same
 * period + recipients (or the same `idempotencyKey`) is sent at most once unless
 * `resendEmail` is true.
 */
export async function generateReport({
  database = getDefaultDatabase(),
  startDate,
  endDate,
  sendEmail = false,
  resendEmail = false,
  idempotencyKey,
  recipients = config.emailTo,
  outputDir = config.reportsDir,
  analytics = getReportData,
  pdfRenderer = renderPdf,
  emailSender = sendReportEmail,
  now = () => new Date(),
} = {}) {
  // Validate explicit periods before creating any database record.
  if (Boolean(startDate) !== Boolean(endDate)) {
    throw new ReportPeriodError('Provide both startDate and endDate for a custom reporting period, or omit both.');
  }
  if (startDate) validateDateRange(startDate, endDate);

  const reportId = crypto.randomUUID();
  const absoluteOutputDir = path.resolve(outputDir);
  const pdfPath = path.join(absoluteOutputDir, `${reportId}.pdf`);
  const fileUrl = `/reports/${reportId}/file`;
  const createdAt = now().toISOString();

  await fs.mkdir(absoluteOutputDir, { recursive: true });
  database.prepare(`
    INSERT INTO reports (id, path, file_url, status, created_at, from_date, to_date, email_status, error)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, NULL)
  `).run(reportId, pdfPath, fileUrl, createdAt, startDate ?? null, endDate ?? null, sendEmail ? 'pending' : 'not_requested');

  // ---- Stages 1-3: analytics -> HTML -> PDF. Any failure ends in status "failed". ----
  let stage = 'analytics';
  let reportData;
  try {
    reportData = analytics({ database, startDate, endDate });
    database.prepare('UPDATE reports SET from_date = ?, to_date = ? WHERE id = ?')
      .run(reportData.metadata.reportStart, reportData.metadata.reportEnd, reportId);
    stage = 'render';
    await pdfRenderer(reportData, pdfPath);
    stage = 'finalize';
    database.prepare("UPDATE reports SET status = 'completed' WHERE id = ?").run(reportId);
  } catch (error) {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    markReportFailed(database, reportId, stage, error);
    error.reportId = reportId;
    error.stage = stage;
    throw error;
  }

  // ---- Stage 4: email (only reached with a valid, completed PDF). ----
  let email = { status: 'not_requested' };
  if (sendEmail) {
    const key = computeDeliveryKey({
      startDate: reportData.metadata.reportStart,
      endDate: reportData.metadata.reportEnd,
      recipients,
      idempotencyKey,
    });
    let claim = { claimed: false, reason: 'in_progress' };
    try {
      claim = claimDelivery(database, { key, reportId, now: now(), staleMs: config.emailClaimTimeoutMs, resend: resendEmail });
    } catch (error) {
      email = { status: 'failed', error: truncate(error.message) };
    }

    if (claim.claimed) {
      try {
        const result = await emailSender({ pdfPath, reportData, to: recipients });
        markDeliverySent(database, { key, reportId, now: now() });
        email = { status: 'sent', attempt: claim.attempt, ...result };
      } catch (error) {
        markDeliveryFailed(database, { key, error: error.message || 'Email delivery failed.', now: now() });
        email = { status: 'failed', error: truncate(error.message || 'Email delivery failed.') };
      }
    } else if (email.status !== 'failed') {
      email = { status: 'skipped_duplicate', reason: claim.reason, originalReportId: claim.originalReportId };
    }

    try {
      database.prepare('UPDATE reports SET email_status = ?, email_error = ? WHERE id = ?')
        .run(email.status, email.status === 'failed' ? email.error : null, reportId);
    } catch (error) {
      console.error(`[Report ${reportId}] Could not record email status: ${error.message}`);
    }
  }

  return {
    id: reportId,
    status: 'completed',
    file: fileUrl,
    pdfPath,
    createdAt,
    reportPeriod: { startDate: reportData.metadata.reportStart, endDate: reportData.metadata.reportEnd },
    summary: reportData.summary,
    email,
  };
}
