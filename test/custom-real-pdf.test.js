import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { openAuthStore } from '../src/auth-store.js';
import { createDatabase } from '../src/db.js';
import { config } from '../src/config.js';
import puppeteer from 'puppeteer';

const CSV = `Order ID,Order Date,Product,Category,Customer,Revenue\nA-100,2026-09-01,Keyboard,Accessories,Ada,129.99\nA-100,2026-09-01,Mouse,Accessories,Ada,49.50\nA-101,2026-09-03,Monitor,Displays,Lin,1200.00\n`;
const PASSWORD = 'a-secure-test-password-for-real-pdf';
const chromeExists = async () => {
  const candidates = [config.chromeExecutablePath, puppeteer.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
  for (const candidate of candidates) {
    try { await fs.access(candidate); return true; } catch { /* Try next available location. */ }
  }
  return false;
};
const hasChrome = await chromeExists();

function cookieFrom(response) {
  const match = /(?:^|;\s*)execubrief_session=([^;]+)/.exec(response.headers.get('set-cookie') || '');
  assert.ok(match, 'registration should issue a session cookie');
  return `execubrief_session=${decodeURIComponent(match[1])}`;
}

function encodedOptions(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

 test('custom CSV route uses the real report engine to produce a valid PDF', { skip: !hasChrome && 'UNVERIFIED - no Chrome/Chromium executable is available' }, async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'execubrief-custom-pdf-'));
  const authStore = openAuthStore(':memory:');
  const demoDatabase = createDatabase(':memory:');
  const app = createApp({
    authStore,
    demoDatabase,
    customDataDir: path.join(tempDir, 'custom-data'),
    demoReportsDir: path.join(tempDir, 'demo-reports'),
    reportsDir: path.join(tempDir, 'private-reports'),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    authStore.close();
    demoDatabase.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const registered = await fetch(`${origin}/api/auth/register`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'real-pdf@example.com', password: PASSWORD, name: 'Real PDF Test' }),
  });
  assert.equal(registered.status, 200);
  const cookie = cookieFrom(registered);
  const me = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } }).then((response) => response.json());
  const previewResponse = await fetch(`${origin}/api/custom/csv/preview`, {
    method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': me.csrfToken, 'Content-Type': 'text/csv' }, body: CSV,
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  const options = {
    filename: 'real-render-test.csv', title: 'Real Custom PDF Test', currency: 'USD',
    columns: preview.suggestedMapping, startDate: '2026-09-01', endDate: '2026-09-03',
  };
  const generated = await fetch(`${origin}/api/custom/reports`, {
    method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': me.csrfToken,
      'Content-Type': 'text/csv', 'X-ExecuBrief-Options': encodedOptions(options) }, body: CSV,
  });
  const generatedData = await generated.json();
  assert.equal(generated.status, 201, JSON.stringify(generatedData));
  assert.equal(generatedData.status, 'completed');
  assert.equal(generatedData.title, 'Real Custom PDF Test');
  assert.equal(generatedData.summary.totalOrders, 2);
  assert.equal(generatedData.summary.totalRevenue, 1379.49);
  const pdfResponse = await fetch(`${origin}${generatedData.file}`, { headers: { Cookie: cookie } });
  assert.equal(pdfResponse.status, 200);
  const pdf = Buffer.from(await pdfResponse.arrayBuffer());
  assert.ok(pdf.length > 1000, `expected a rendered PDF larger than 1 KB, received ${pdf.length} bytes`);
  assert.match(pdf.subarray(0, 8).toString('ascii'), /^%PDF-/);
});
