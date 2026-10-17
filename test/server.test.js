import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateReport } from '../src/report-service.js';
import { assertSafeBinding } from '../src/auth.js';
import { FAKE_PDF, fakePdfRenderer, fakeResendClient, RESEND_ERRORS, postJson, seededDatabase, startTestServer, tempDir } from './support/helpers.js';
import { sendReportEmail } from '../src/email.js';

const PERIOD = { startDate: '2026-09-28', endDate: '2026-10-04' };

const TEST_API_KEY = 're_test_key_not_a_real_secret';

/** Build an app whose pipeline uses test doubles for the PDF renderer and Resend. */
async function setup({ renderer = fakePdfRenderer, resend = fakeResendClient(), authToken = '', apiKey = TEST_API_KEY } = {}) {
  const database = seededDatabase();
  const reportsDir = await tempDir();
  const recipients = ['exec@example.com'];
  const generate = (opts) => generateReport({
    ...opts,
    recipients,
    pdfRenderer: renderer,
    emailSender: (args) => sendReportEmail({ ...args, apiKey, from: 'reports@example.com', client: resend }),
  });
  const server = await startTestServer({ database, generate, authToken, reportsDir });
  return { database, reportsDir, resend, ...server, cleanup: async () => { await server.close(); await fs.rm(reportsDir, { recursive: true, force: true }); database.close(); } };
}

test('GET /health is 200 and GET /reports starts empty', async () => {
  const ctx = await setup();
  try {
    const health = await fetch(`${ctx.baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const list = await (await fetch(`${ctx.baseUrl}/reports`)).json();
    assert.deepEqual(list.reports, []);
  } finally { await ctx.cleanup(); }
});

test('POST /reports with a valid period returns 201, then status/list/download work', async () => {
  const ctx = await setup();
  try {
    const res = await postJson(`${ctx.baseUrl}/reports`, PERIOD);
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.status, 'completed');
    assert.equal(created.summary.totalOrders, 2);
    assert.equal(created.summary.totalRevenue, 500);
    assert.deepEqual(created.email, { status: 'not_requested' });
    assert.equal(created.file, `/reports/${created.id}/file`);

    const status = await (await fetch(`${ctx.baseUrl}/reports/${created.id}`)).json();
    assert.equal(status.status, 'completed');
    assert.equal(status.emailStatus, 'not_requested');
    assert.equal(status.startDate, PERIOD.startDate);

    const list = await (await fetch(`${ctx.baseUrl}/reports`)).json();
    assert.equal(list.reports.length, 1);

    const file = await fetch(`${ctx.baseUrl}${created.file}`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-type'), /application\/pdf/);
    assert.equal(file.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), FAKE_PDF);
  } finally { await ctx.cleanup(); }
});

test('POST /reports with an empty body uses the default previous-week period', async () => {
  const ctx = await setup();
  try {
    const res = await postJson(`${ctx.baseUrl}/reports`, {});
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.match(body.reportPeriod.startDate, /^\d{4}-\d{2}-\d{2}$/);
    const days = (Date.parse(body.reportPeriod.endDate) - Date.parse(body.reportPeriod.startDate)) / 86400000 + 1;
    assert.equal(days, 7);
    assert.equal(new Date(`${body.reportPeriod.startDate}T00:00:00Z`).getUTCDay(), 1, 'starts on a Monday');
  } finally { await ctx.cleanup(); }
});

test('POST /reports rejects invalid input with 400 and creates no report records', async () => {
  const ctx = await setup();
  try {
    const cases = [
      [{ sendEmail: 'yes' }, /sendEmail/],
      [{ resendEmail: 1 }, /resendEmail/],
      [{ startDate: 20260928, endDate: '2026-10-04' }, /strings/],
      [{ startDate: '2026-09-28' }, /both startDate and endDate/],
      [{ startDate: '2026-10-04', endDate: '2026-09-28' }, /cannot be after/],
      [{ startDate: '2026-02-30', endDate: '2026-03-02' }, /valid dates/],
      [{ startDate: 'yesterday', endDate: 'today' }, /valid dates/],
      [{ startDate: '2026-01-01', endDate: '2026-12-31' }, /93 days/],
      [{ idempotencyKey: 'has spaces!' }, /Idempotency-Key/],
    ];
    for (const [body, pattern] of cases) {
      const res = await postJson(`${ctx.baseUrl}/reports`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await res.json()).error, pattern, JSON.stringify(body));
    }
    const malformed = await postJson(`${ctx.baseUrl}/reports`, '{not json');
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /Malformed JSON/);

    const tooLarge = await postJson(`${ctx.baseUrl}/reports`, { padding: 'x'.repeat(40_000) });
    assert.equal(tooLarge.status, 413);

    const list = await (await fetch(`${ctx.baseUrl}/reports`)).json();
    assert.equal(list.reports.length, 0, 'validation failures must not leave database records');
  } finally { await ctx.cleanup(); }
});

test('a rendering failure returns 500 with the report id, and the record ends as failed (not pending)', async () => {
  const ctx = await setup({ renderer: async () => { throw new Error('Chrome exploded'); } });
  try {
    const res = await postJson(`${ctx.baseUrl}/reports`, { ...PERIOD, sendEmail: true });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'Report generation failed.');
    assert.equal(body.stage, 'render');
    assert.ok(body.reportId);
    assert.ok(!JSON.stringify(body).includes('Chrome exploded'), 'internal error text is not leaked in the response');

    const status = await (await fetch(`${ctx.baseUrl}/reports/${body.reportId}`)).json();
    assert.equal(status.status, 'failed');
    assert.equal(status.errorStage, 'render');
    assert.match(status.error, /Chrome exploded/);
    assert.equal(status.emailStatus, 'not_sent');
    assert.equal(ctx.resend.sent.length, 0, 'email is never attempted after a render failure');

    const download = await fetch(`${ctx.baseUrl}/reports/${body.reportId}/file`);
    assert.equal(download.status, 409);
  } finally { await ctx.cleanup(); }
});

test('an email failure returns 502 while the PDF report itself is completed and downloadable', async () => {
  const ctx = await setup({ resend: fakeResendClient({ error: RESEND_ERRORS.unverifiedDomain }) });
  try {
    const res = await postJson(`${ctx.baseUrl}/reports`, { ...PERIOD, sendEmail: true });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.status, 'completed');
    assert.equal(body.email.status, 'failed');
    const status = await (await fetch(`${ctx.baseUrl}/reports/${body.id}`)).json();
    assert.equal(status.status, 'completed');
    assert.equal(status.emailStatus, 'failed');
    assert.match(status.emailError, /Resend rejected the email \(HTTP 403, validation_error\)/);
    assert.match(body.email.error, /own email address/, 'the API surfaces Resend\'s reason');
    assert.equal((await fetch(`${ctx.baseUrl}/reports/${body.id}/file`)).status, 200);
  } finally { await ctx.cleanup(); }
});

test('duplicate email requests are suppressed (HTTP level), with explicit resend and idempotency keys', async () => {
  const ctx = await setup();
  try {
    const first = await (await postJson(`${ctx.baseUrl}/reports`, { ...PERIOD, sendEmail: true })).json();
    assert.equal(first.email.status, 'sent');
    assert.equal(ctx.resend.sent.length, 1);

    const retry = await postJson(`${ctx.baseUrl}/reports`, { ...PERIOD, sendEmail: true });
    assert.equal(retry.status, 201);
    const retryBody = await retry.json();
    assert.equal(retryBody.email.status, 'skipped_duplicate');
    assert.equal(retryBody.email.reason, 'already_sent');
    assert.equal(retryBody.email.originalReportId, first.id);
    assert.equal(ctx.resend.sent.length, 1, 'retry must not send a second email');

    const forced = await (await postJson(`${ctx.baseUrl}/reports`, { ...PERIOD, sendEmail: true, resendEmail: true })).json();
    assert.equal(forced.email.status, 'sent');
    assert.equal(ctx.resend.sent.length, 2, 'explicit resendEmail overrides the guard');

    const keyed1 = await (await postJson(`${ctx.baseUrl}/reports`, { ...PERIOD, sendEmail: true }, { 'Idempotency-Key': 'weekly-2026-w40' })).json();
    const keyed2 = await (await postJson(`${ctx.baseUrl}/reports`, { startDate: '2026-09-21', endDate: '2026-09-27', sendEmail: true }, { 'Idempotency-Key': 'weekly-2026-w40' })).json();
    assert.equal(keyed1.email.status, 'sent');
    assert.equal(keyed2.email.status, 'skipped_duplicate', 'same Idempotency-Key suppresses the send even for a different body');
    assert.equal(ctx.resend.sent.length, 3);
  } finally { await ctx.cleanup(); }
});

test('API email status: a successful send reports sent, with the Resend id and attachment details', async () => {
  const ctx = await setup();
  try {
    const res = await postJson(`${ctx.baseUrl}/reports`, { ...PERIOD, sendEmail: true });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, 'completed');
    assert.deepEqual(body.email, {
      status: 'sent',
      attempt: 1,
      accepted: true,
      statusCode: null,
      recipientCount: 1,
      filename: 'executive-report-2026-09-28-to-2026-10-04.pdf',
      id: 'test-email-id-1',
    });
    const status = await (await fetch(`${ctx.baseUrl}/reports/${body.id}`)).json();
    assert.equal(status.emailStatus, 'sent');
    assert.equal(status.emailError, null);
    assert.equal(ctx.resend.sent[0].attachments[0].filename, 'executive-report-2026-09-28-to-2026-10-04.pdf');
  } finally { await ctx.cleanup(); }
});

test('API email status: each Resend failure is a 502 with a failed email, a completed report, and a retry that then succeeds', async () => {
  for (const [label, error] of Object.entries(RESEND_ERRORS)) {
    const resend = fakeResendClient({ error });
    const ctx = await setup({ resend });
    try {
      const res = await postJson(`${ctx.baseUrl}/reports`, { ...PERIOD, sendEmail: true });
      assert.equal(res.status, 502, label);
      const text = await res.text();
      const body = JSON.parse(text);
      assert.equal(body.status, 'completed', `${label}: the PDF report is still completed`);
      assert.equal(body.email.status, 'failed', label);
      assert.match(body.email.error, new RegExp(`HTTP ${error.statusCode}, ${error.name}`), label);
      assert.ok(!text.includes(TEST_API_KEY), `${label}: the API key is not in the response`);

      const status = await (await fetch(`${ctx.baseUrl}/reports/${body.id}`)).json();
      assert.equal(status.status, 'completed');
      assert.equal(status.emailStatus, 'failed');
      assert.ok(status.emailError.includes(error.message));
      assert.equal((await fetch(`${ctx.baseUrl}/reports/${body.id}/file`)).status, 200, `${label}: PDF still downloadable`);
      assert.equal(ctx.database.prepare('SELECT status FROM email_deliveries').get().status, 'failed', `${label}: not recorded as sent`);

      // Resend recovers: the same request now sends (a failed delivery is retryable)...
      resend.behave({});
      const retry = await postJson(`${ctx.baseUrl}/reports`, { ...PERIOD, sendEmail: true });
      assert.equal(retry.status, 201, label);
      assert.equal((await retry.json()).email.status, 'sent', label);
      // ...and a further identical request is suppressed.
      const again = await (await postJson(`${ctx.baseUrl}/reports`, { ...PERIOD, sendEmail: true })).json();
      assert.equal(again.email.status, 'skipped_duplicate', label);
      assert.equal(resend.sent.length, 1, `${label}: exactly one email was delivered overall`);
    } finally { await ctx.cleanup(); }
  }
});

test('API email status: a network exception is a 502 failed email, not a 500, and the report stays completed', async () => {
  const ctx = await setup({ resend: fakeResendClient({ throws: new Error('connect ECONNRESET') }) });
  try {
    const res = await postJson(`${ctx.baseUrl}/reports`, { ...PERIOD, sendEmail: true });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.status, 'completed');
    assert.match(body.email.error, /Resend request failed: connect ECONNRESET/);
  } finally { await ctx.cleanup(); }
});

test('API email status: missing Resend configuration is a 502 failed email that names RESEND_API_KEY; Resend is never called', async () => {
  const ctx = await setup({ apiKey: '' });
  try {
    const res = await postJson(`${ctx.baseUrl}/reports`, { ...PERIOD, sendEmail: true });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.status, 'completed');
    assert.equal(body.email.status, 'failed');
    assert.match(body.email.error, /RESEND_API_KEY/);
    assert.equal(ctx.resend.attempts.length, 0);
    const status = await (await fetch(`${ctx.baseUrl}/reports/${body.id}`)).json();
    assert.equal(status.emailStatus, 'failed');
    assert.match(status.emailError, /RESEND_API_KEY/);
  } finally { await ctx.cleanup(); }
});

test('API: requests that do not ask for email never touch Resend', async () => {
  const ctx = await setup();
  try {
    for (const body of [PERIOD, { ...PERIOD, sendEmail: false }]) {
      const res = await postJson(`${ctx.baseUrl}/reports`, body);
      assert.equal(res.status, 201);
      assert.deepEqual((await res.json()).email, { status: 'not_requested' });
    }
    assert.equal(ctx.resend.attempts.length, 0);
  } finally { await ctx.cleanup(); }
});

test('GET /reports/:id and /file return 404 for unknown or malformed ids, 409 while pending', async () => {
  const ctx = await setup();
  try {
    const unknown = crypto.randomUUID();
    assert.equal((await fetch(`${ctx.baseUrl}/reports/${unknown}`)).status, 404);
    assert.equal((await fetch(`${ctx.baseUrl}/reports/${unknown}/file`)).status, 404);
    assert.equal((await fetch(`${ctx.baseUrl}/reports/not-a-uuid`)).status, 404);
    assert.equal((await fetch(`${ctx.baseUrl}/reports/..%2F..%2Fetc%2Fpasswd/file`)).status, 404);
    assert.equal((await fetch(`${ctx.baseUrl}/nope`)).status, 404);

    const pendingId = crypto.randomUUID();
    ctx.database.prepare("INSERT INTO reports (id, path, file_url, status, created_at) VALUES (?, '', '', 'pending', ?)").run(pendingId, new Date().toISOString());
    const pending = await fetch(`${ctx.baseUrl}/reports/${pendingId}/file`);
    assert.equal(pending.status, 409);
    assert.equal((await pending.json()).status, 'pending');
  } finally { await ctx.cleanup(); }
});

test('download refuses paths outside the reports directory and reports files missing from disk', async () => {
  const ctx = await setup();
  try {
    const outsideId = crypto.randomUUID();
    const outsidePath = path.join(await tempDir('outside-'), 'secret.pdf');
    await fs.writeFile(outsidePath, FAKE_PDF);
    ctx.database.prepare("INSERT INTO reports (id, path, file_url, status, created_at) VALUES (?, ?, '', 'completed', ?)").run(outsideId, outsidePath, new Date().toISOString());
    assert.equal((await fetch(`${ctx.baseUrl}/reports/${outsideId}/file`)).status, 500);

    const missingId = crypto.randomUUID();
    ctx.database.prepare("INSERT INTO reports (id, path, file_url, status, created_at) VALUES (?, ?, '', 'completed', ?)").run(missingId, path.join(ctx.reportsDir, 'gone.pdf'), new Date().toISOString());
    assert.equal((await fetch(`${ctx.baseUrl}/reports/${missingId}/file`)).status, 404);
  } finally { await ctx.cleanup(); }
});

test('API_AUTH_TOKEN protects private report APIs while the synthetic dashboard remains public', async () => {
  const token = 'test-token-0123456789abcdef';
  const ctx = await setup({ authToken: token });
  try {
    assert.equal((await fetch(`${ctx.baseUrl}/health`)).status, 200);
    const created = await postJson(`${ctx.baseUrl}/reports`, PERIOD, { authorization: `Bearer ${token}` });
    assert.equal(created.status, 201);
    const { id } = await created.json();

    const homepage = await fetch(`${ctx.baseUrl}/`);
    assert.equal(homepage.status, 200);
    assert.match(homepage.headers.get('content-type'), /text\/html/);
    const publicConfig = await (await fetch(`${ctx.baseUrl}/api/config`)).json();
    assert.equal(publicConfig.demo, true);

    const protectedCalls = [
      () => fetch(`${ctx.baseUrl}/reports`),
      () => postJson(`${ctx.baseUrl}/reports`, PERIOD),
      () => fetch(`${ctx.baseUrl}/reports/${id}`),
      () => fetch(`${ctx.baseUrl}/reports/${id}/file`),
    ];
    for (const call of protectedCalls) {
      const res = await call();
      assert.equal(res.status, 401);
      assert.match(res.headers.get('www-authenticate'), /Bearer/);
    }
    const wrong = await fetch(`${ctx.baseUrl}/reports`, { headers: { authorization: 'Bearer wrong-token-wrong-token' } });
    assert.equal(wrong.status, 401);
    const right = await fetch(`${ctx.baseUrl}/reports/${id}/file`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(right.status, 200);
    assert.equal((await ctx.database.prepare('SELECT COUNT(*) AS n FROM reports').get()).n, 1, 'unauthenticated POST created nothing');
  } finally { await ctx.cleanup(); }
});

test('startup safety: refuses unprotected non-loopback or production configurations', () => {
  const ok = { host: '127.0.0.1', apiAuthToken: '', nodeEnv: 'development' };
  assert.doesNotThrow(() => assertSafeBinding(ok));
  assert.throws(() => assertSafeBinding({ ...ok, host: '0.0.0.0' }), /without API_AUTH_TOKEN/);
  assert.throws(() => assertSafeBinding({ ...ok, nodeEnv: 'production' }), /required when NODE_ENV=production/);
  assert.throws(() => assertSafeBinding({ ...ok, apiAuthToken: 'short' }), /too short/);
  assert.doesNotThrow(() => assertSafeBinding({ host: '0.0.0.0', apiAuthToken: 'a-long-enough-token-1234', nodeEnv: 'production' }));
});
