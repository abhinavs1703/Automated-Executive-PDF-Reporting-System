import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db.js';
import { createApp } from '../../src/server.js';

export const FAKE_PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1200, 'x'), Buffer.from('\n%%EOF')]);

export function seededDatabase() {
  const database = createDatabase(':memory:');
  const insert = database.prepare('INSERT INTO orders (customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?)');
  insert.run('A Customer', 'Keyboard', 100, '2026-09-28T10:00:00.000Z', 'Accessories');
  insert.run('B Customer', 'Monitor', 400, '2026-09-30T10:00:00.000Z', 'Displays');
  insert.run('C Customer', 'Mouse', 50, '2026-09-22T10:00:00.000Z', 'Accessories');
  return database;
}

export const tempDir = (prefix = 'exec-report-test-') => fs.mkdtemp(path.join(os.tmpdir(), prefix));

/** A PDF renderer test double: writes a tiny valid-looking PDF. Never use as proof of real rendering. */
export const fakePdfRenderer = async (_data, outputPath) => { await fs.writeFile(outputPath, FAKE_PDF); return outputPath; };

/**
 * A Resend SDK test double. It reproduces the real SDK contract: `emails.send()` RESOLVES with
 * `{ data, error }` (it does not throw for API errors such as an unverified domain).
 *
 *   fakeResendClient()                               -> accepts every send, returns { data: { id }, error: null }
 *   fakeResendClient({ error: { ... } })             -> API-level failure: { data: null, error }
 *   fakeResendClient({ throws: new Error('...') })   -> network/SDK exception
 *   fakeResendClient({ response: { ... } })          -> any custom response
 *
 * `sent` records only the payloads Resend accepted; `attempts` records every call.
 */
export function fakeResendClient(initial = {}) {
  let behaviour = { ...initial };
  const sent = [];
  const attempts = [];
  let counter = 0;
  return {
    sent,
    attempts,
    /** Change how subsequent sends behave, e.g. behave({ error: null }) to recover after a failure. */
    behave(next) { behaviour = { ...next }; },
    emails: {
      async send(payload) {
        attempts.push(payload);
        if (behaviour.throws) throw behaviour.throws;
        if ('response' in behaviour) return behaviour.response;
        if (behaviour.error) return { data: null, error: behaviour.error, headers: null };
        sent.push(payload);
        counter += 1;
        return { data: { id: `test-email-id-${counter}` }, error: null, headers: {} };
      },
    },
  };
}

/** Typical Resend API failures, shaped like the SDK's ErrorResponse. */
export const RESEND_ERRORS = {
  unverifiedDomain: { name: 'validation_error', statusCode: 403, message: 'You can only send testing emails to your own email address (owner@example.com). To send emails to other recipients, please verify a domain at resend.com/domains.' },
  invalidKey: { name: 'invalid_api_key', statusCode: 403, message: 'API key is invalid' },
  rateLimited: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests. You can only make 2 requests per second.' },
  server: { name: 'application_error', statusCode: 500, message: 'Internal server error.' },
};

export async function startTestServer(options = {}) {
  const app = createApp(options);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, close: () => new Promise((resolve) => server.close(resolve)) };
}

export const postJson = (url, body, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
