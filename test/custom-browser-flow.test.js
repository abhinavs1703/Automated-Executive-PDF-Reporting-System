import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import puppeteer from 'puppeteer';
import { createApp } from '../src/app.js';
import { openAuthStore } from '../src/auth-store.js';
import { createDatabase } from '../src/db.js';
import { browserLaunchOptions } from '../src/renderer.js';
import { probeBrowser } from './support/browser.js';

const PASSWORD = 'browser-flow-test-password-at-least-12';
const CSV_PATH = path.resolve('examples/custom-report-upload.csv');
const browserStatus = await probeBrowser();

test('browser flow: existing overview -> account sign-up -> CSV preview -> real custom PDF', { skip: browserStatus.available ? false : `UNVERIFIED - ${browserStatus.reason}` }, async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'execubrief-browser-flow-'));
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
  let browser;
  t.after(async () => {
    if (browser) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    authStore.close();
    demoDatabase.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  browser = await puppeteer.launch(browserLaunchOptions());
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await page.goto(origin, { waitUntil: 'networkidle0' });
  } catch (error) {
    if (String(error?.message).includes('ERR_BLOCKED_BY_ADMINISTRATOR')) {
      t.skip('UNVERIFIED - browser sandbox blocks navigation to the local app');
      return;
    }
    throw error;
  }
  assert.equal(await page.title(), 'ExecuBrief — Executive Reporting');
  assert.equal(await page.$eval('#page-title', (el) => el.textContent.trim()), 'Executive overview');
  assert.ok(await page.$('a[href="/custom-reports"]'), 'the additive Custom PDFs link should be present');
  assert.ok(await page.$('a[href="/login"]'), 'sign-in should be available when signed out');
  assert.ok(await page.$('#product-search'), 'product search filter should be present');
  assert.ok(await page.$('#reports-status-filter'), 'report status filter should be present');
  assert.ok(await page.$('#kpi-revenue'), 'the original overview KPI should remain in place');

  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('a[href="/login"]')]);
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#auth-switch a[href="/signup"]')]);
  // Organisation name is a required field in the registration form. Leaving it
  // empty makes the browser block submission before the submit handler can run.
  await page.type('#register-organisation', 'Browser Flow Test Organization');
  await page.type('#register-name', 'Browser Flow Test');
  await page.type('#register-email', `browser-flow-${Date.now()}@example.com`);
  await page.type('#register-password', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.click('#register-form button[type="submit"]'),
  ]);
  assert.equal(
    new URL(page.url()).pathname,
    '/workspace',
    'successful registration should open the organisation workspace',
  );

  // Verify the signed-in account details appear at the right of the public header.
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#topbar-account .account-menu');
  assert.match(await page.$eval('.account-menu-copy strong', (el) => el.textContent), /Browser Flow Test/);
  assert.equal(await page.$eval('.account-menu-copy small', (el) => el.textContent), 'Browser Flow Test Organization');

  // Continue to the separate Custom PDFs screen before exercising CSV preview/PDF generation.
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.click('a[href="/custom-reports"]'),
  ]);
  await page.waitForSelector('#preview-csv');
  assert.equal(new URL(page.url()).pathname, '/custom-reports');

  await page.$eval('#csv-file', (el) => { el.dataset.testReady = 'true'; });
  await page.$('#csv-file').then((input) => input.uploadFile(CSV_PATH));
  await page.click('#preview-csv');
  await page.waitForFunction(() => !document.querySelector('#csv-preview-area').classList.contains('hidden'));
  assert.match(await page.$eval('#upload-status', (el) => el.textContent), /\b\d+ valid rows detected\b/i);
  assert.equal(await page.$eval('#csv-row-count', (el) => el.textContent), '5 rows');

  const customReportResponse = page.waitForResponse((response) => response.url().endsWith('/api/custom/reports') && response.request().method() === 'POST');
  await page.click('#generate-custom-report');
  const response = await customReportResponse;
  const payload = await response.json();
  assert.equal(response.status(), 201, JSON.stringify(payload));
  assert.equal(payload.status, 'completed');
  assert.equal(payload.title, 'Custom Executive Brief');
  assert.ok(payload.summary.totalRevenue > 0);
  await page.waitForFunction(() => !document.querySelector('#custom-pdf-preview').classList.contains('hidden'));
  assert.match(await page.$eval('#generation-status', (el) => el.textContent), /generated successfully/i);
  assert.equal(await page.$eval('#custom-reports-list .report-created', (el) => el.textContent), payload.id, 'history should show the full report ID');

  const pdfCheck = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'same-origin' });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, type: response.headers.get('content-type'), size: bytes.length, header: new TextDecoder().decode(bytes.slice(0, 5)) };
  }, payload.file);
  assert.equal(pdfCheck.status, 200);
  assert.match(pdfCheck.type, /application\/pdf/);
  assert.ok(pdfCheck.size > 1000);
  assert.equal(pdfCheck.header, '%PDF-');
  assert.deepEqual(pageErrors, [], 'browser pages should not raise uncaught JavaScript errors');
});
