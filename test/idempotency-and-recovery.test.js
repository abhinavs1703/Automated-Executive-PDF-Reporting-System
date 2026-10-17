import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDatabase } from '../src/db.js';
import { generateReport, recoverStaleReports } from '../src/report-service.js';
import { claimDelivery, computeDeliveryKey } from '../src/email-ledger.js';
import { fakePdfRenderer, seededDatabase, tempDir } from './support/helpers.js';

const PERIOD = { startDate: '2026-09-28', endDate: '2026-10-04' };
const RECIPIENTS = ['exec@example.com'];

function harness(overrides = {}) {
  const database = seededDatabase();
  const calls = [];
  const emailSender = overrides.emailSender ?? (async ({ to }) => { calls.push(to); return { accepted: true, statusCode: 202 }; });
  const run = async (extra = {}) => generateReport({
    database, outputDir: overrides.outputDir, pdfRenderer: fakePdfRenderer, recipients: RECIPIENTS, emailSender, sendEmail: true, ...PERIOD, ...extra,
  });
  return { database, calls, run };
}

test('sequential duplicate requests send exactly one email; the second is skipped_duplicate', async () => {
  const outputDir = await tempDir();
  const { database, calls, run } = harness({ outputDir });
  try {
    const first = await run();
    const second = await run();
    assert.equal(first.email.status, 'sent');
    assert.equal(second.email.status, 'skipped_duplicate');
    assert.equal(second.email.reason, 'already_sent');
    assert.equal(calls.length, 1);
    const row = database.prepare('SELECT email_status FROM reports WHERE id = ?').get(second.id);
    assert.equal(row.email_status, 'skipped_duplicate');
  } finally { database.close(); await fs.rm(outputDir, { recursive: true, force: true }); }
});

test('concurrent duplicate requests (slow email provider) still send exactly one email', async () => {
  const outputDir = await tempDir();
  let sends = 0;
  const slowSender = async () => { sends += 1; await new Promise((r) => setTimeout(r, 80)); return { accepted: true }; };
  const { database, run } = harness({ outputDir, emailSender: slowSender });
  try {
    const results = await Promise.all([run(), run(), run()]);
    assert.equal(sends, 1);
    const statuses = results.map((r) => r.email.status).sort();
    assert.deepEqual(statuses, ['sent', 'skipped_duplicate', 'skipped_duplicate']);
    for (const skipped of results.filter((r) => r.email.status === 'skipped_duplicate')) {
      assert.ok(['in_progress', 'already_sent'].includes(skipped.email.reason), `unexpected reason ${skipped.email.reason}`);
    }
  } finally { database.close(); await fs.rm(outputDir, { recursive: true, force: true }); }
});

test('a failed send can be retried; a different period or recipient list is a different delivery', async () => {
  const outputDir = await tempDir();
  let failNext = true;
  const flaky = async () => { if (failNext) { failNext = false; throw new Error('Resend 503'); } return { accepted: true }; };
  const { database, run } = harness({ outputDir, emailSender: flaky });
  try {
    const first = await run();
    assert.equal(first.email.status, 'failed');
    assert.match(first.email.error, /503/);
    const retry = await run();
    assert.equal(retry.email.status, 'sent', 'a failed delivery must not block a legitimate retry');
    assert.equal(retry.email.attempt, 2);
    assert.equal((await run()).email.status, 'skipped_duplicate');

    assert.equal((await run({ startDate: '2026-09-21', endDate: '2026-09-27' })).email.status, 'sent');
    assert.equal((await run({ recipients: ['other@example.com'] })).email.status, 'sent');
  } finally { database.close(); await fs.rm(outputDir, { recursive: true, force: true }); }
});

test('ledger: stale "sending" claims are reclaimable, fresh ones are not; resend overrides sent', () => {
  const database = createDatabase(':memory:');
  try {
    const key = computeDeliveryKey({ ...PERIOD, recipients: RECIPIENTS });
    const t0 = new Date('2026-10-10T10:00:00Z');
    assert.equal(claimDelivery(database, { key, reportId: 'r1', now: t0, staleMs: 60_000 }).claimed, true);
    const fresh = claimDelivery(database, { key, reportId: 'r2', now: new Date(t0.getTime() + 30_000), staleMs: 60_000 });
    assert.deepEqual([fresh.claimed, fresh.reason, fresh.originalReportId], [false, 'in_progress', 'r1']);
    const stale = claimDelivery(database, { key, reportId: 'r3', now: new Date(t0.getTime() + 61_000), staleMs: 60_000 });
    assert.deepEqual([stale.claimed, stale.attempt], [true, 2]);

    database.prepare("UPDATE email_deliveries SET status = 'sent' WHERE delivery_key = ?").run(key);
    assert.equal(claimDelivery(database, { key, reportId: 'r4', now: t0, staleMs: 60_000 }).reason, 'already_sent');
    assert.equal(claimDelivery(database, { key, reportId: 'r4', now: t0, staleMs: 60_000, resend: true }).claimed, true);
  } finally { database.close(); }
});

test('delivery keys ignore recipient order and case, and differ by period', () => {
  const a = computeDeliveryKey({ ...PERIOD, recipients: ['B@x.com', 'a@x.com'] });
  const b = computeDeliveryKey({ ...PERIOD, recipients: ['a@x.com', 'b@x.com'] });
  assert.equal(a, b);
  assert.notEqual(a, computeDeliveryKey({ startDate: '2026-09-21', endDate: '2026-09-27', recipients: ['a@x.com', 'b@x.com'] }));
});

test('analytics failure -> report is failed (stage analytics), no email attempted, no PDF left behind', async () => {
  const outputDir = await tempDir();
  const calls = [];
  const database = seededDatabase();
  try {
    await assert.rejects(
      generateReport({
        database, outputDir, sendEmail: true, recipients: RECIPIENTS, ...PERIOD,
        analytics: () => { throw new Error('SQL exploded'); },
        pdfRenderer: fakePdfRenderer,
        emailSender: async () => { calls.push(1); },
      }),
      (error) => { assert.equal(error.stage, 'analytics'); assert.ok(error.reportId); return true; },
    );
    const row = database.prepare('SELECT * FROM reports').get();
    assert.equal(row.status, 'failed');
    assert.equal(row.error_stage, 'analytics');
    assert.match(row.error, /SQL exploded/);
    assert.equal(row.email_status, 'not_sent');
    assert.equal(calls.length, 0);
  } finally { database.close(); await fs.rm(outputDir, { recursive: true, force: true }); }
});

test('render failure removes a partial PDF and leaves the report failed with stage render', async () => {
  const outputDir = await tempDir();
  const database = seededDatabase();
  try {
    await assert.rejects(generateReport({
      database, outputDir, ...PERIOD,
      pdfRenderer: async (_d, out) => { await fs.writeFile(out, 'partial'); throw new Error('Chrome crashed mid-render'); },
    }));
    const row = database.prepare('SELECT * FROM reports').get();
    assert.equal(row.status, 'failed');
    assert.equal(row.error_stage, 'render');
    assert.deepEqual(await fs.readdir(outputDir), [], 'partial PDF is deleted');
  } finally { database.close(); await fs.rm(outputDir, { recursive: true, force: true }); }
});

test('recoverStaleReports moves old pending reports to failed and leaves recent/finished ones alone', () => {
  const database = createDatabase(':memory:');
  try {
    const insert = database.prepare("INSERT INTO reports (id, path, file_url, status, created_at, email_status) VALUES (?, '', '', ?, ?, ?)");
    const now = new Date('2026-10-10T12:00:00Z');
    insert.run('old-pending', 'pending', '2026-10-10T10:00:00.000Z', 'pending');
    insert.run('recent-pending', 'pending', '2026-10-10T11:59:00.000Z', 'pending');
    insert.run('old-done', 'completed', '2026-10-09T10:00:00.000Z', 'sent');
    const recovered = recoverStaleReports({ database, olderThanMs: 15 * 60 * 1000, now });
    assert.equal(recovered, 1);
    const get = (id) => database.prepare('SELECT status, error_stage, error, email_status FROM reports WHERE id = ?').get(id);
    assert.deepEqual({ ...get('old-pending') }, { status: 'failed', error_stage: 'interrupted', error: get('old-pending').error, email_status: 'not_sent' });
    assert.match(get('old-pending').error, /interrupted/);
    assert.equal(get('recent-pending').status, 'pending');
    assert.equal(get('old-done').status, 'completed');
    assert.equal(recoverStaleReports({ database, olderThanMs: 15 * 60 * 1000, now }), 0, 'idempotent');
  } finally { database.close(); }
});

test('invalid periods are rejected before any record is created', async () => {
  const database = seededDatabase();
  try {
    await assert.rejects(generateReport({ database, startDate: '2026-10-04', endDate: '2026-09-28' }), (e) => e.code === 'INVALID_PERIOD');
    await assert.rejects(generateReport({ database, startDate: '2026-10-04' }), (e) => e.code === 'INVALID_PERIOD');
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 0);
  } finally { database.close(); }
});
