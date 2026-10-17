import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderPdf } from '../src/renderer.js';
import { getReportData } from '../src/analytics.js';
import { createDatabase } from '../src/db.js';
import { generateReport } from '../src/report-service.js';
import { sendReportEmail } from '../src/email.js';
import { initScheduledReports } from '../src/cron.js';
import { inspectPdf } from './support/pdf-inspect.js';
import { probeBrowser, requireRealPdf } from './support/browser.js';
import { fakeResendClient, postJson, startTestServer, tempDir } from './support/helpers.js';

/*
 * REAL RENDERING TESTS: no mocked renderer. These launch an actual Chrome/Chromium
 * through Puppeteer. If none is available they are SKIPPED (shown as "skipped" in
 * the test output, which means UNVERIFIED, not passed). Set REQUIRE_REAL_PDF=true
 * (as CI does) to make a missing browser a hard failure instead.
 */
const browser = await probeBrowser();
const skip = browser.available ? false : (requireRealPdf ? false : `UNVERIFIED - ${browser.reason}`);


/**
 * The four embedded chart images must be real charts, not blank or distorted:
 *  - each has visible (non-transparent) content, and
 *  - each has the proportions of its print-layout container (about 323 x 205 CSS px,
 *    aspect ~1.58). The previous renderer drew charts at the 1280 px screen layout
 *    (aspect ~2.98) and squeezed them into the narrow print column.
 */
function assertReadableCharts(pdf) {
  const charts = pdf.imageDetails.filter((image) => image.width >= 300 && image.height >= 200);
  assert.ok(charts.length >= 4, `expected at least 4 chart-sized images, found ${charts.length}`);
  for (const [index, image] of charts.slice(0, 4).entries()) {
    assert.ok(image.opaqueRatio > 0.02, `chart image ${index + 1} looks blank (${(image.opaqueRatio * 100).toFixed(2)}% visible pixels)`);
    const aspect = image.width / image.height;
    assert.ok(aspect > 1.3 && aspect < 1.9, `chart image ${index + 1} has distorted proportions: ${image.width}x${image.height} (aspect ${aspect.toFixed(2)})`);
  }
}

function realDatabase() {
  const database = createDatabase(':memory:');
  const insert = database.prepare('INSERT INTO orders (customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?)');
  insert.run('Ada', 'Ultra-wide Monitor', 499, '2026-09-28T09:00:00.000Z', 'Displays');
  insert.run('Bo', 'Mechanical Keyboard', 129.99, '2026-09-29T09:00:00.000Z', 'Accessories');
  insert.run('Cy', 'Wireless Mouse', 49.99, '2026-10-01T09:00:00.000Z', 'Accessories');
  insert.run('Di', '<script>alert(1)</script> Gadget', 80, '2026-10-02T09:00:00.000Z', 'Gadgets');
  insert.run('Ed', 'Mechanical Keyboard', 120, '2026-09-22T09:00:00.000Z', 'Accessories'); // previous period
  return database;
}

test('a Chrome/Chromium browser is available for real PDF rendering', { skip }, () => {
  assert.equal(browser.available, true, browser.reason);
});

test('real renderer produces a parseable A4 PDF with report text, tables, page numbers and chart images', { skip }, async () => {
  const database = realDatabase();
  const dir = await tempDir();
  try {
    const data = getReportData({ database, startDate: '2026-09-28', endDate: '2026-10-04' });
    const pdfPath = await renderPdf(data, path.join(dir, 'report.pdf'));

    const stat = await fs.stat(pdfPath);
    assert.ok(stat.size > 10_000, `PDF is substantial (${stat.size} bytes)`);
    assert.equal((await fs.readFile(pdfPath)).subarray(0, 5).toString(), '%PDF-');

    const pdf = await inspectPdf(pdfPath);
    assert.ok(pdf.pageCount >= 1);
    assert.ok(Math.abs(pdf.pages[0].width - 595) < 3 && Math.abs(pdf.pages[0].height - 842) < 3, 'A4 page size');

    const text = pdf.text.replace(/\s+/g, ' ');
    assert.match(text, /Weekly Executive Business Report/);
    assert.match(text, /2026-09-28 – 2026-10-04/);
    assert.match(text, new RegExp(`USD ${data.summary.totalRevenue}`));
    assert.match(text, new RegExp(`Total orders ${data.summary.totalOrders}`, 'i'));
    assert.match(text, /Ultra-wide Monitor/);
    assert.match(text, /Mechanical Keyboard/);
    assert.ok(text.includes('<script>alert(1)</script> Gadget'), 'database text is shown literally (escaped), not executed');
    assert.match(text, new RegExp(`1 / ${pdf.pageCount}`), 'page numbering footer');

    // The four Chart.js canvases are embedded as raster images on the first page.
    assert.ok(pdf.pages[0].images >= 4, `expected >=4 chart images on page 1, got ${pdf.pages[0].images} (images per page: ${pdf.pages.map((p) => p.images).join(', ')})`);

    assertReadableCharts(pdf);
  } finally { database.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('real renderer succeeds with every non-data: network request blocked (no CDN dependency)', { skip }, async () => {
  const database = realDatabase();
  const dir = await tempDir();
  try {
    // The renderer aborts every non-data: request, so a successful render proves
    // the page needs no CDN or other external resource.
    const data = getReportData({ database, startDate: '2026-09-28', endDate: '2026-10-04' });
    const pdfPath = await renderPdf(data, path.join(dir, 'offline.pdf'));
    const offline = await inspectPdf(pdfPath);
    assert.ok(offline.pages[0].images >= 4, `expected >=4 chart images on page 1, got ${offline.pages[0].images} (images per page: ${offline.pages.map((p) => p.images).join(', ')})`);
    assertReadableCharts(offline);
  } finally { database.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('FULL PIPELINE: SQL -> JSON -> HTML -> Chart.js -> real PDF -> Resend attachment (test double) -> HTTP download', { skip }, async () => {
  const database = realDatabase();
  const reportsDir = await tempDir();
  const resend = fakeResendClient();
  const generate = (opts) => generateReport({
    ...opts,
    recipients: ['exec@example.com'],
    emailSender: (args) => sendReportEmail({ ...args, apiKey: 're_test_key_not_a_real_secret', from: 'reports@example.com', client: resend }),
  });
  const server = await startTestServer({ database, generate, reportsDir });
  try {
    const res = await postJson(`${server.baseUrl}/reports`, { startDate: '2026-09-28', endDate: '2026-10-04', sendEmail: true });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.email.status, 'sent');
    assert.equal(created.summary.totalOrders, 4);

    // The Resend double received exactly one message whose attachment IS the generated PDF.
    assert.equal(resend.sent.length, 1);
    const attachment = resend.sent[0].attachments[0];
    assert.equal(attachment.contentType, 'application/pdf');
    assert.match(attachment.filename, /executive-report-2026-09-28-to-2026-10-04\.pdf/);
    const attached = Buffer.from(attachment.content, 'base64');

    const downloaded = Buffer.from(await (await fetch(`${server.baseUrl}${created.file}`)).arrayBuffer());
    assert.deepEqual(attached, downloaded, 'emailed bytes equal downloaded bytes');
    const onDisk = path.join(reportsDir, `${created.id}.pdf`);
    assert.deepEqual(attached, await fs.readFile(onDisk));

    const pdf = await inspectPdf(onDisk);
    assert.match(pdf.text, /Weekly Executive Business Report/);
    assert.ok(pdf.imageCount >= 4, `expected >=4 chart images in the PDF, got ${pdf.imageCount} (images per page: ${pdf.pages.map((p) => p.images).join(', ')})`);
    assertReadableCharts(pdf);

    const row = database.prepare('SELECT status, email_status FROM reports WHERE id = ?').get(created.id);
    assert.deepEqual({ ...row }, { status: 'completed', email_status: 'sent' });

    // Duplicate request: no second email, still a valid report.
    const dup = await (await postJson(`${server.baseUrl}/reports`, { startDate: '2026-09-28', endDate: '2026-10-04', sendEmail: true })).json();
    assert.equal(dup.email.status, 'skipped_duplicate');
    assert.equal(resend.sent.length, 1);
  } finally { await server.close(); database.close(); await fs.rm(reportsDir, { recursive: true, force: true }); }
});

test('SCHEDULED EXECUTION: a cron tick runs the real pipeline and emails the PDF via the test double', { skip }, async () => {
  const database = realDatabase();
  const reportsDir = await tempDir();
  const resend = fakeResendClient();
  let finished;
  let failed;
  const done = new Promise((resolve, reject) => { finished = resolve; failed = reject; });
  const scheduler = initScheduledReports({
    enabled: true, schedule: '* * * * * *', timezone: 'UTC', sendEmail: true,
    logger: { log() {}, warn() {}, error() {} },
    generate: async (opts) => {
      try {
        const result = await generateReport({
          ...opts, database, outputDir: reportsDir, startDate: '2026-09-28', endDate: '2026-10-04', recipients: ['exec@example.com'],
          emailSender: (args) => sendReportEmail({ ...args, apiKey: 're_test_key_not_a_real_secret', from: 'reports@example.com', client: resend }),
        });
        finished(result);
        return result;
      } catch (error) {
        failed(error);
        throw error;
      }
    },
  });
  let timeoutHandle;
  try {
    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('scheduler never produced a report')), 30_000);
    });
    const result = await Promise.race([done, timeout]);
    await scheduler.stop();
    assert.equal(result.status, 'completed');
    assert.equal(result.email.status, 'sent');
    assert.equal(resend.sent.length, 1);
    const scheduled = await inspectPdf(result.pdfPath);
    assert.ok(scheduled.imageCount >= 4, `expected >=4 chart images in the PDF, got ${scheduled.imageCount} (images per page: ${scheduled.pages.map((p) => p.images).join(', ')})`);
    assertReadableCharts(scheduled);
  } finally {
    clearTimeout(timeoutHandle);
    await scheduler.stop();
    await new Promise((r) => setTimeout(r, 300));
    database.close();
    await fs.rm(reportsDir, { recursive: true, force: true });
  }
});
