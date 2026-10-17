import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EmailDeliveryError, sendReportEmail } from '../src/email.js';
import { generateReport } from '../src/report-service.js';
import { fakePdfRenderer, fakeResendClient, RESEND_ERRORS, seededDatabase, tempDir } from './support/helpers.js';

/*
 * Resend email tests. Nothing here talks to the network or to Resend:
 *  - most tests inject a Resend test double (`fakeResendClient`);
 *  - the "real SDK" tests run the genuine `resend` package against a stubbed global `fetch`,
 *    which proves the exact HTTP request it would send without sending anything.
 * Every key below is an obvious fake.
 */
const FAKE_KEY = 're_test_key_not_a_real_secret';
const FROM = 'reports@example.com';
const TO = ['reader@example.com'];

const reportData = {
  metadata: { reportStart: '2026-09-28', reportEnd: '2026-10-04', periodLabel: '2026-09-28 to 2026-10-04', currency: 'USD' },
  summary: { totalRevenue: 2266.3, totalOrders: 14, averageOrderValue: 161.88 },
};
// Deliberately binary (non-UTF-8 bytes, CR/LF, NUL) so an encoding mistake would corrupt it.
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0, 255, 128, 10, 13, 200, 1, 2, 3, 250]), Buffer.alloc(300, 7), Buffer.from('\n%%EOF')]);

async function withPdf(run, bytes = PDF_BYTES) {
  const dir = await tempDir('resend-email-test-');
  const pdfPath = path.join(dir, 'report.pdf');
  await fs.writeFile(pdfPath, bytes);
  try { return await run(pdfPath); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

const send = (overrides, pdfPath = 'unused.pdf') => sendReportEmail({ pdfPath, reportData, apiKey: FAKE_KEY, from: FROM, to: TO, ...overrides });

// ---------------------------------------------------------------- configuration errors

test('missing or invalid configuration is reported clearly and nothing is sent or constructed', async () => {
  const cases = [
    ['missing API key', { apiKey: '' }, /RESEND_API_KEY/],
    ['undefined API key', { apiKey: undefined, createClient: undefined }, /RESEND_API_KEY/],
    ['missing sender', { from: '' }, /EMAIL_FROM/],
    ['no recipients', { to: [] }, /EMAIL_TO/],
    ['recipients not an array', { to: undefined }, /EMAIL_TO/],
    ['invalid sender', { from: 'not-an-address' }, /Invalid email address configuration: not-an-address/],
    ['invalid recipient', { to: ['ok@example.com', 'broken@'] }, /Invalid email address configuration: broken@/],
    ['header-injection attempt in recipient', { to: ['a@example.com\r\nBcc: evil@example.com'] }, /Invalid email address configuration/],
    ['header-injection attempt in sender', { from: 'a@example.com\r\nBcc: evil@example.com' }, /Invalid email address configuration/],
    ['too many recipients', { to: Array.from({ length: 51 }, (_, i) => `user${i}@example.com`) }, /at most 50 recipients/],
  ];
  for (const [label, overrides, pattern] of cases) {
    const resend = fakeResendClient();
    const created = [];
    await assert.rejects(
      send({ client: resend, createClient: (key) => { created.push(key); return resend; }, ...overrides }),
      pattern,
      label,
    );
    assert.equal(resend.attempts.length, 0, `${label}: no send attempted`);
    assert.equal(created.length, 0, `${label}: no Resend client constructed`);
  }
});

test('missing configuration never reaches the Resend SDK (importing and calling without a key is safe)', async () => {
  // The real `new Resend()` throws "Missing API key"; our validation must fail first, with our own message.
  await assert.rejects(send({ apiKey: '' }), (error) => {
    assert.match(error.message, /Resend is not configured: set RESEND_API_KEY/);
    assert.doesNotMatch(error.message, /Missing API key/);
    return true;
  });
});

test('display-name sender format is accepted', async () => {
  await withPdf(async (pdfPath) => {
    const resend = fakeResendClient();
    await send({ client: resend, from: 'Executive Reports <reports@example.com>' }, pdfPath);
    assert.equal(resend.sent[0].from, 'Executive Reports <reports@example.com>');
    await assert.rejects(send({ client: resend, from: 'Executive Reports <not-valid>' }, pdfPath), /Invalid email address configuration/);
  });
});

// ---------------------------------------------------------------- successful submission

test('a successful send returns the existing result contract (plus the Resend email id)', async () => {
  await withPdf(async (pdfPath) => {
    const resend = fakeResendClient();
    const result = await send({ client: resend }, pdfPath);
    assert.deepEqual(result, {
      accepted: true,
      statusCode: null,
      recipientCount: 1,
      filename: 'executive-report-2026-09-28-to-2026-10-04.pdf',
      id: 'test-email-id-1',
    });
    assert.equal(resend.attempts.length, 1);
  });
});

test('payload: sender, single recipient as a string, subject, and a text body with consistently formatted money', async () => {
  await withPdf(async (pdfPath) => {
    const resend = fakeResendClient();
    await send({ client: resend }, pdfPath);
    const payload = resend.sent[0];
    assert.equal(payload.from, FROM);
    assert.equal(payload.to, 'reader@example.com');
    assert.equal(payload.subject, 'Weekly Executive Business Report: 2026-09-28 to 2026-10-04');
    assert.match(payload.text, /executive business report for 2026-09-28 to 2026-10-04/);
    assert.match(payload.text, /Revenue: USD 2,266\.30/);
    assert.match(payload.text, /Orders: 14/);
    assert.match(payload.text, /Average order value: USD 161\.88/);
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(FAKE_KEY), 'the API key is never part of the message');
  });
});

test('PDF attachment: exact filename, PDF content type, and byte-for-byte base64 content', async () => {
  await withPdf(async (pdfPath) => {
    const resend = fakeResendClient();
    await send({ client: resend }, pdfPath);
    const { attachments } = resend.sent[0];
    assert.equal(attachments.length, 1);
    const [attachment] = attachments;
    assert.equal(attachment.filename, 'executive-report-2026-09-28-to-2026-10-04.pdf');
    assert.equal(attachment.contentType, 'application/pdf');
    assert.equal(typeof attachment.content, 'string', 'base64 text, not a Buffer (which JSON-serialises badly)');
    assert.match(attachment.content, /^[A-Za-z0-9+/]+=*$/);
    assert.deepEqual(Buffer.from(attachment.content, 'base64'), PDF_BYTES, 'decoded attachment equals the generated PDF exactly');
  });
});

test('multiple recipients are preserved in order; display count matches', async () => {
  await withPdf(async (pdfPath) => {
    const resend = fakeResendClient();
    const to = ['first@example.com', 'second@example.com', 'third@example.org'];
    const result = await send({ client: resend, to }, pdfPath);
    assert.deepEqual(resend.sent[0].to, to);
    assert.equal(result.recipientCount, 3);
  });
});

test('50 recipients (the Resend maximum) is accepted', async () => {
  await withPdf(async (pdfPath) => {
    const resend = fakeResendClient();
    const to = Array.from({ length: 50 }, (_, i) => `user${i}@example.com`);
    assert.equal((await send({ client: resend, to }, pdfPath)).recipientCount, 50);
  });
});

test('without an injected client, the Resend client is created once, from the configured key', async () => {
  await withPdf(async (pdfPath) => {
    const resend = fakeResendClient();
    const keys = [];
    await send({ createClient: (key) => { keys.push(key); return resend; } }, pdfPath);
    assert.deepEqual(keys, [FAKE_KEY]);
    assert.equal(resend.sent.length, 1);
  });
});

// ---------------------------------------------------------------- attachment validation

test('the attachment is validated before anything is sent', async () => {
  const resend = fakeResendClient();
  await assert.rejects(send({ client: resend, pdfPath: undefined }, undefined), /pdfPath is required/);
  await assert.rejects(send({ client: resend }, path.join(await tempDir(), 'missing.pdf')), /ENOENT/);
  await withPdf(async (pdfPath) => {
    await assert.rejects(send({ client: resend }, pdfPath), /not a valid PDF/);
  }, Buffer.from('this is not a pdf'));
  await withPdf(async (pdfPath) => {
    await assert.rejects(send({ client: resend }, pdfPath), /not a valid PDF/);
  }, Buffer.from('%PD'));
  await withPdf(async (pdfPath) => {
    await assert.rejects(send({ client: resend, reportData: { metadata: {}, summary: {} } }, pdfPath), /missing reporting-period metadata/);
  });
  assert.equal(resend.attempts.length, 0);
});

// ---------------------------------------------------------------- Resend API errors

test('Resend API errors (returned, not thrown) reject: the email is never reported as accepted', async () => {
  await withPdf(async (pdfPath) => {
    for (const [label, error] of Object.entries(RESEND_ERRORS)) {
      const resend = fakeResendClient({ error });
      let result;
      await assert.rejects(
        (async () => { result = await send({ client: resend }, pdfPath); })(),
        (thrown) => {
          assert.ok(thrown instanceof EmailDeliveryError, `${label}: EmailDeliveryError`);
          assert.equal(thrown.code, error.name);
          assert.equal(thrown.statusCode, error.statusCode);
          assert.match(thrown.message, new RegExp(`HTTP ${error.statusCode}, ${error.name}`));
          assert.ok(thrown.message.includes(error.message), `${label}: Resend's reason is preserved`);
          return true;
        },
      );
      assert.equal(result, undefined, `${label}: no success result`);
      assert.equal(resend.attempts.length, 1);
      assert.equal(resend.sent.length, 0, `${label}: nothing was accepted`);
    }
  });
});

test('network or SDK exceptions reject with EmailDeliveryError', async () => {
  await withPdf(async (pdfPath) => {
    const resend = fakeResendClient({ throws: new Error('getaddrinfo ENOTFOUND api.resend.com') });
    await assert.rejects(send({ client: resend }, pdfPath), (thrown) => {
      assert.ok(thrown instanceof EmailDeliveryError);
      assert.match(thrown.message, /Resend request failed: getaddrinfo ENOTFOUND/);
      return true;
    });
  });
});

test('an unconfirmed response (no error but no email id) is not treated as success', async () => {
  await withPdf(async (pdfPath) => {
    for (const response of [undefined, null, {}, { data: null, error: null }, { data: {}, error: null }, { data: { id: '' }, error: null }]) {
      const resend = fakeResendClient({ response });
      await assert.rejects(send({ client: resend }, pdfPath), /no email id/, JSON.stringify(response));
    }
  });
});

test('the API key never appears in errors, even if the provider echoes it back', async () => {
  await withPdf(async (pdfPath) => {
    const echoing = fakeResendClient({ error: { name: 'invalid_api_key', statusCode: 401, message: `API key ${FAKE_KEY} is invalid` } });
    await assert.rejects(send({ client: echoing }, pdfPath), (thrown) => {
      assert.ok(!thrown.message.includes(FAKE_KEY));
      assert.match(thrown.message, /\[redacted\]/);
      return true;
    });
    const throwing = fakeResendClient({ throws: new Error(`socket hang up using ${FAKE_KEY}`) });
    await assert.rejects(send({ client: throwing }, pdfPath), (thrown) => {
      assert.ok(!thrown.message.includes(FAKE_KEY));
      return true;
    });
  });
});

// ---------------------------------------------------------------- the REAL Resend SDK against a stubbed fetch

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Replace global fetch for one test; asserts afterwards that only api.resend.com was ever contacted. */
function stubFetch(t, handler) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  t.mock.method(console, 'error', () => {}); // the SDK logs API errors outside production
  t.after(() => {
    for (const call of calls) assert.equal(call.url, 'https://api.resend.com/emails', 'only the Resend send endpoint is ever contacted');
  });
  return calls;
}

test('real Resend SDK: the exact HTTP request for a report email (no network used)', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, { id: 'a1b2c3d4-0000-4000-8000-000000000001' }));
  await withPdf(async (pdfPath) => {
    // No `client` injected: this runs the genuine `resend` package.
    const result = await send({ to: ['one@example.com', 'two@example.com'], from: 'Reports <reports@example.com>' }, pdfPath);
    assert.equal(result.accepted, true);
    assert.equal(result.id, 'a1b2c3d4-0000-4000-8000-000000000001');
    assert.equal(result.recipientCount, 2);

    assert.equal(calls.length, 1);
    const { init } = calls[0];
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${FAKE_KEY}`);
    assert.match(new Headers(init.headers).get('content-type'), /application\/json/);

    const body = JSON.parse(init.body);
    assert.equal(body.from, 'Reports <reports@example.com>');
    assert.deepEqual(body.to, ['one@example.com', 'two@example.com']);
    assert.equal(body.subject, 'Weekly Executive Business Report: 2026-09-28 to 2026-10-04');
    assert.match(body.text, /Revenue: USD 2,266\.30/);
    assert.equal(body.attachments.length, 1);
    const [attachment] = body.attachments;
    assert.equal(attachment.filename, 'executive-report-2026-09-28-to-2026-10-04.pdf');
    assert.equal(attachment.content_type, 'application/pdf', 'the SDK maps contentType to content_type on the wire');
    assert.equal(typeof attachment.content, 'string');
    assert.deepEqual(Buffer.from(attachment.content, 'base64'), PDF_BYTES, 'base64 on the wire decodes to the exact PDF');
    assert.ok(!('path' in attachment && attachment.path), 'content is inline, not a remote path');
  });
});

test('real Resend SDK: a 403 (unverified domain) response is a failed delivery, not a success', async (t) => {
  stubFetch(t, () => jsonResponse(403, { statusCode: 403, name: 'validation_error', message: RESEND_ERRORS.unverifiedDomain.message }));
  await withPdf(async (pdfPath) => {
    await assert.rejects(send({ from: 'onboarding@resend.dev', to: ['someone.else@example.com'] }, pdfPath), (thrown) => {
      assert.ok(thrown instanceof EmailDeliveryError);
      assert.equal(thrown.statusCode, 403);
      assert.equal(thrown.code, 'validation_error');
      assert.match(thrown.message, /can only send testing emails to your own email address/);
      return true;
    });
  });
});

test('real Resend SDK: invalid key (401/403), rate limit (429) and server errors (500) all reject', async (t) => {
  let next;
  stubFetch(t, () => next());
  await withPdf(async (pdfPath) => {
    const scenarios = [
      [() => jsonResponse(401, { statusCode: 401, name: 'missing_api_key', message: 'Missing API key' }), 401],
      [() => jsonResponse(403, { statusCode: 403, name: 'invalid_api_key', message: 'API key is invalid' }), 403],
      [() => jsonResponse(429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' }), 429],
      [() => jsonResponse(500, { statusCode: 500, name: 'internal_server_error', message: 'Something went wrong' }), 500],
      [() => new Response('<html>Bad gateway</html>', { status: 502 }), 502],
    ];
    for (const [make, status] of scenarios) {
      next = make;
      await assert.rejects(send({}, pdfPath), (thrown) => {
        assert.ok(thrown instanceof EmailDeliveryError);
        assert.equal(thrown.statusCode, status);
        return true;
      }, `HTTP ${status}`);
    }
  });
});

test('real Resend SDK: a network failure rejects and no success is reported', async (t) => {
  stubFetch(t, () => { throw new TypeError('fetch failed'); });
  await withPdf(async (pdfPath) => {
    await assert.rejects(send({}, pdfPath), (thrown) => {
      assert.ok(thrown instanceof EmailDeliveryError);
      assert.match(thrown.message, /Resend/);
      return true;
    });
  });
});

// ---------------------------------------------------------------- through the report service

async function serviceHarness(clientOptions, extra = {}) {
  const database = seededDatabase();
  const outputDir = await tempDir('resend-service-test-');
  const resend = fakeResendClient(clientOptions);
  const run = (overrides = {}) => generateReport({
    database, outputDir, pdfRenderer: fakePdfRenderer, sendEmail: true, recipients: TO,
    startDate: '2026-09-28', endDate: '2026-10-04',
    emailSender: (args) => sendReportEmail({ ...args, apiKey: FAKE_KEY, from: FROM, client: resend, ...extra }),
    ...overrides,
  });
  const cleanup = async () => { database.close(); await fs.rm(outputDir, { recursive: true, force: true }); };
  return { database, resend, run, cleanup };
}

test('service: a Resend API error leaves the report COMPLETED and the email FAILED (never "sent")', async () => {
  const { database, resend, run, cleanup } = await serviceHarness({ error: RESEND_ERRORS.unverifiedDomain });
  try {
    const result = await run();
    assert.equal(result.status, 'completed');
    assert.equal(result.email.status, 'failed');
    assert.match(result.email.error, /Resend rejected the email \(HTTP 403, validation_error\)/);

    const report = database.prepare('SELECT status, email_status, email_error, error FROM reports WHERE id = ?').get(result.id);
    assert.equal(report.status, 'completed');
    assert.equal(report.email_status, 'failed');
    assert.match(report.email_error, /own email address/);
    assert.equal(report.error, null, 'a delivery failure is not a generation failure');

    const ledger = database.prepare('SELECT status, error FROM email_deliveries').get();
    assert.equal(ledger.status, 'failed', 'the ledger must not record a send that Resend rejected');
    assert.match(ledger.error, /Resend rejected/);
    assert.equal(resend.sent.length, 0);
  } finally { await cleanup(); }
});

test('service: after a Resend failure a retry sends exactly once, and later duplicates are suppressed', async () => {
  const { database, resend, run, cleanup } = await serviceHarness({ error: RESEND_ERRORS.rateLimited });
  try {
    const failed = await run();
    assert.equal(failed.email.status, 'failed');

    resend.behave({}); // Resend recovers
    const retried = await run();
    assert.equal(retried.email.status, 'sent');
    assert.equal(retried.email.attempt, 2, 'second attempt for the same delivery');
    assert.ok(retried.email.id, 'the Resend email id is returned');
    assert.equal(database.prepare('SELECT status FROM email_deliveries').get().status, 'sent');

    const duplicate = await run();
    assert.equal(duplicate.email.status, 'skipped_duplicate');
    assert.equal(duplicate.email.reason, 'already_sent');
    assert.equal(duplicate.email.originalReportId, retried.id);

    assert.equal(resend.attempts.length, 2, 'Resend was called only for the failed attempt and the successful retry');
    assert.equal(resend.sent.length, 1);
  } finally { await cleanup(); }
});

test('service: thrown network errors behave like API errors (completed report, failed email, retryable)', async () => {
  const { database, resend, run, cleanup } = await serviceHarness({ throws: new Error('connect ETIMEDOUT') });
  try {
    const failed = await run();
    assert.equal(failed.status, 'completed');
    assert.equal(failed.email.status, 'failed');
    assert.match(failed.email.error, /Resend request failed: connect ETIMEDOUT/);
    assert.equal(database.prepare('SELECT email_status FROM reports WHERE id = ?').get(failed.id).email_status, 'failed');

    resend.behave({});
    assert.equal((await run()).email.status, 'sent');
  } finally { await cleanup(); }
});

test('service: missing Resend configuration fails the email, never the report, and Resend is never called', async () => {
  const { database, resend, run, cleanup } = await serviceHarness({}, { apiKey: '' });
  try {
    const result = await run();
    assert.equal(result.status, 'completed');
    assert.equal(result.email.status, 'failed');
    assert.match(result.email.error, /RESEND_API_KEY/);
    assert.equal(resend.attempts.length, 0);
    assert.equal(database.prepare('SELECT status FROM reports WHERE id = ?').get(result.id).status, 'completed');
  } finally { await cleanup(); }
});

test('service: concurrent duplicate requests call Resend exactly once', async () => {
  const { resend, run, cleanup } = await serviceHarness({});
  const original = resend.emails.send.bind(resend.emails);
  resend.emails.send = async (payload) => { await new Promise((resolve) => setTimeout(resolve, 80)); return original(payload); };
  try {
    const results = await Promise.all([run(), run(), run()]);
    assert.equal(resend.attempts.length, 1);
    assert.deepEqual(results.map((r) => r.email.status).sort(), ['sent', 'skipped_duplicate', 'skipped_duplicate']);
  } finally { await cleanup(); }
});

test('service: no email is attempted unless requested (sendEmail defaults to false)', async () => {
  const { resend, run, cleanup } = await serviceHarness({});
  try {
    const result = await run({ sendEmail: false });
    assert.deepEqual(result.email, { status: 'not_requested' });
    assert.equal(resend.attempts.length, 0);
  } finally { await cleanup(); }
});
