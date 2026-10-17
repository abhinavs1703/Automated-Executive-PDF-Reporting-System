import crypto from 'node:crypto';

/**
 * Email idempotency ledger.
 *
 * A "delivery" is identified by a key. By default the key is derived from the
 * reporting period and the recipient list, so repeating a request (client
 * retry, double click, scheduler restart) for the same period does not send the
 * same report to the same people twice. Callers may supply their own
 * idempotency key instead.
 *
 * Claiming is a compare-and-swap in SQLite, so it is also safe across multiple
 * processes sharing one database file.
 *
 * Known limitation (at-least-once edge): if the process dies after the email
 * provider (Resend) accepted the message but before the ledger row is marked "sent", the claim
 * goes stale after `staleMs` and a later request may send again.
 */

export function computeDeliveryKey({ startDate, endDate, recipients = [], idempotencyKey } = {}) {
  const material = idempotencyKey
    ? `explicit|${idempotencyKey}`
    : `period|${startDate}|${endDate}|${[...recipients].map((r) => r.toLowerCase()).sort().join(',')}`;
  return crypto.createHash('sha256').update(material).digest('hex');
}

/**
 * Try to claim the right to send. Returns
 *   { claimed: true, attempt }
 *   { claimed: false, reason: 'already_sent' | 'in_progress', originalReportId, completedAt }
 */
export function claimDelivery(database, { key, reportId, now = new Date(), staleMs, resend = false }) {
  const nowIso = now.toISOString();
  const inserted = database.prepare(`
    INSERT OR IGNORE INTO email_deliveries (delivery_key, report_id, status, claimed_at, attempts)
    VALUES (?, ?, 'sending', ?, 1)
  `).run(key, reportId, nowIso);
  if (inserted.changes === 1) return { claimed: true, attempt: 1 };

  const row = database.prepare('SELECT * FROM email_deliveries WHERE delivery_key = ?').get(key);
  const claimAge = now.getTime() - Date.parse(row.claimed_at);
  const isStaleSending = row.status === 'sending' && claimAge >= staleMs;

  const reclaimable = row.status === 'failed' || isStaleSending || (row.status === 'sent' && resend);
  if (reclaimable) {
    // Compare-and-swap on (status, claimed_at): only one contender wins.
    const swapped = database.prepare(`
      UPDATE email_deliveries
      SET status = 'sending', report_id = ?, claimed_at = ?, completed_at = NULL, error = NULL, attempts = attempts + 1
      WHERE delivery_key = ? AND status = ? AND claimed_at = ?
    `).run(reportId, nowIso, key, row.status, row.claimed_at);
    if (swapped.changes === 1) return { claimed: true, attempt: row.attempts + 1 };
  }

  const current = database.prepare('SELECT * FROM email_deliveries WHERE delivery_key = ?').get(key);
  return {
    claimed: false,
    reason: current.status === 'sent' ? 'already_sent' : 'in_progress',
    originalReportId: current.report_id,
    completedAt: current.completed_at,
  };
}

export function markDeliverySent(database, { key, reportId, now = new Date() }) {
  database.prepare(`
    UPDATE email_deliveries SET status = 'sent', completed_at = ?, error = NULL, report_id = ?
    WHERE delivery_key = ?
  `).run(now.toISOString(), reportId, key);
}

export function markDeliveryFailed(database, { key, error, now = new Date() }) {
  database.prepare(`
    UPDATE email_deliveries SET status = 'failed', completed_at = ?, error = ?
    WHERE delivery_key = ?
  `).run(now.toISOString(), String(error).slice(0, 1000), key);
}
