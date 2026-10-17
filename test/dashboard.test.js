import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDatabase } from '../src/db.js';
import { generateReport } from '../src/report-service.js';
import { FAKE_PDF, fakePdfRenderer, postJson, startTestServer, tempDir } from './support/helpers.js';

const PERIOD = { startDate: '2026-09-28', endDate: '2026-10-04' };
const PRIVATE_TOKEN = 'test-private-token-value-24';

function insertOrder(database, orderId, lineId, customer, amount, createdAt) {
  database.prepare(`
    INSERT INTO orders (order_id, line_item_id, customer, product, amount, created_at, category)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(orderId, lineId, customer, 'Synthetic Demo Product', amount, createdAt, 'Demo Category');
}

async function setup({ demoGenerate: injectedDemoGenerate } = {}) {
  const privateDatabase = createDatabase(':memory:');
  const demoDatabase = createDatabase(':memory:');
  insertOrder(privateDatabase, 'PRIVATE-1', 'PRIVATE-L1', 'Private customer', 9000, '2026-10-01T10:00:00.000Z');
  insertOrder(demoDatabase, 'DEMO-1', 'DEMO-L1', 'Demo Customer 01', 125, '2026-10-01T10:00:00.000Z');
  const privateReportsDir = await tempDir('execubrief-private-reports-');
  const demoReportsDir = await tempDir('execubrief-demo-reports-');
  const demoCalls = [];
  let emailCalls = 0;
  const privateGenerate = (options) => generateReport({ ...options, pdfRenderer: fakePdfRenderer });
  const demoGenerate = injectedDemoGenerate ?? ((options) => {
    demoCalls.push({ sendEmail: options.sendEmail, resendEmail: options.resendEmail, outputDir: options.outputDir });
    return generateReport({
      ...options,
      pdfRenderer: fakePdfRenderer,
      emailSender: async () => { emailCalls += 1; return { accepted: true }; },
    });
  });
  const server = await startTestServer({
    database: privateDatabase,
    reportsDir: privateReportsDir,
    authToken: PRIVATE_TOKEN,
    generate: privateGenerate,
    demoDatabase,
    demoReportsDir,
    demoGenerate,
  });
  return {
    ...server,
    privateDatabase,
    demoDatabase,
    privateReportsDir,
    demoReportsDir,
    demoCalls,
    emailCount: () => emailCalls,
    cleanup: async () => {
      await server.close();
      privateDatabase.close();
      demoDatabase.close();
      await fs.rm(privateReportsDir, { recursive: true, force: true });
      await fs.rm(demoReportsDir, { recursive: true, force: true });
    },
  };
}

test('dashboard is served as HTML and its analytics use only the synthetic demo database', async () => {
  const ctx = await setup();
  try {
    const homepage = await fetch(`${ctx.baseUrl}/`);
    assert.equal(homepage.status, 200);
    assert.match(homepage.headers.get('content-type'), /text\/html/);
    const html = await homepage.text();
    assert.match(html, /ExecuBrief/);
    assert.match(html, /Synthetic demo data/);
    assert.match(html, /class="topbar-actions"/, 'account actions should sit in a dedicated right-side header region');
    assert.match(html, /id="topbar-account"/, 'signed-in account details are loaded into the header');
    assert.match(html, /id="product-search"/, 'top products should support search');
    assert.match(html, /id="product-category-filter"/, 'top products should support category filtering');
    assert.match(html, /id="reports-search"/, 'report history should support text search');
    assert.match(html, /id="reports-status-filter"/, 'report history should support status filtering');
    assert.doesNotMatch(html, /125430\.50|112350\.25/);

    const config = await (await fetch(`${ctx.baseUrl}/api/config`)).json();
    assert.deepEqual(config, { companyName: 'ExecuBrief', reportCurrency: 'USD', theme: 'corporate', demo: true });
    const response = await fetch(`${ctx.baseUrl}/api/analytics?startDate=${PERIOD.startDate}&endDate=${PERIOD.endDate}`);
    assert.equal(response.status, 200);
    const analytics = await response.json();
    assert.equal(analytics.summary.totalOrders, 1);
    assert.equal(analytics.summary.totalRevenue, 125);
    assert.notEqual(analytics.summary.totalRevenue, 9000);

    const unauthorized = await fetch(`${ctx.baseUrl}/reports`);
    assert.equal(unauthorized.status, 401, 'private report APIs require a bearer token when configured');
    const privateReports = await fetch(`${ctx.baseUrl}/reports`, { headers: { authorization: `Bearer ${PRIVATE_TOKEN}` } });
    assert.equal(privateReports.status, 200);
    assert.deepEqual(await privateReports.json(), { reports: [] });
  } finally { await ctx.cleanup(); }
});

test('public report generation ignores email flags, creates a real report record, and previews/downloads its PDF', async () => {
  const ctx = await setup();
  try {
    const response = await postJson(`${ctx.baseUrl}/api/reports/generate`, {
      ...PERIOD,
      sendEmail: true,
      resendEmail: true,
      apiAuthToken: 'this-must-not-be-used',
    }, { 'Idempotency-Key': 'synthetic-demo-report-001' });
    assert.equal(response.status, 201);
    const report = await response.json();
    assert.equal(report.status, 'completed');
    assert.equal(report.summary.totalRevenue, 125);
    assert.equal(report.summary.totalOrders, 1);
    assert.deepEqual(report.email, { status: 'not_requested' });
    assert.equal(report.file, `/api/reports/${report.id}/file`);
    assert.equal(report.download, `/api/reports/${report.id}/download`);
    assert.equal(ctx.demoCalls.length, 1);
    assert.equal(ctx.demoCalls[0].sendEmail, false);
    assert.equal(ctx.demoCalls[0].resendEmail, false);
    assert.equal(path.resolve(ctx.demoCalls[0].outputDir), path.resolve(ctx.demoReportsDir));
    assert.equal(ctx.emailCount(), 0);

    const [privateFiles, demoFiles] = await Promise.all([
      fs.readdir(ctx.privateReportsDir),
      fs.readdir(ctx.demoReportsDir),
    ]);
    assert.deepEqual(privateFiles, [], 'public report generation must not create files in the private directory');
    assert.deepEqual(demoFiles, [`${report.id}.pdf`]);
    assert.deepEqual(await fs.readFile(path.join(ctx.demoReportsDir, `${report.id}.pdf`)), FAKE_PDF);

    const history = await (await fetch(`${ctx.baseUrl}/api/reports`)).json();
    assert.equal(history.reports.length, 1);
    assert.equal(history.reports[0].id, report.id);
    assert.equal(history.reports[0].summary.totalRevenue, 125);
    assert.equal(history.reports[0].file, report.file);
    assert.equal(history.reports[0].download, report.download);

    const status = await fetch(`${ctx.baseUrl}/api/reports/${report.id}`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).status, 'completed');

    const preview = await fetch(`${ctx.baseUrl}${report.file}`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('content-type'), /application\/pdf/);
    assert.match(preview.headers.get('content-disposition'), /inline/);
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), FAKE_PDF);

    const download = await fetch(`${ctx.baseUrl}${report.download}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-type'), /application\/pdf/);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), FAKE_PDF);

    const replay = await postJson(`${ctx.baseUrl}/api/reports/generate`, { ...PERIOD, sendEmail: true }, { 'Idempotency-Key': 'synthetic-demo-report-001' });
    assert.equal(replay.status, 200);
    const replayedReport = await replay.json();
    assert.equal(replayedReport.id, report.id);
    assert.equal(replayedReport.idempotentReplay, true);
    assert.equal(ctx.demoCalls.length, 1, 'an idempotent replay must not generate a second PDF');
    assert.equal(ctx.emailCount(), 0);
  } finally { await ctx.cleanup(); }
});

test('dashboard rejects malformed or oversized reporting periods before generation', async () => {
  const ctx = await setup();
  try {
    const invalidCases = [
      [{ startDate: '2026-02-30', endDate: '2026-03-02' }, /valid dates/],
      [{ startDate: '2026-10-04', endDate: '2026-09-28' }, /cannot be after/],
      [{ startDate: '2026-01-01', endDate: '2026-12-31' }, /93 days/],
      [{ startDate: '2026-09-28' }, /both startDate and endDate/],
    ];
    for (const [body, message] of invalidCases) {
      const response = await postJson(`${ctx.baseUrl}/api/reports/generate`, body);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, message);
    }
    assert.equal(ctx.demoCalls.length, 0);
    const malformed = await postJson(`${ctx.baseUrl}/api/reports/generate`, '{bad json');
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /Malformed JSON/);
  } finally { await ctx.cleanup(); }
});

test('public PDF retrieval rejects missing, malformed, and non-demo report identifiers', async () => {
  const ctx = await setup();
  try {
    assert.equal((await fetch(`${ctx.baseUrl}/api/reports/not-a-uuid/file`)).status, 404);
    assert.equal((await fetch(`${ctx.baseUrl}/api/reports/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/file`)).status, 404);
  } finally { await ctx.cleanup(); }
});


test('public demo report generation is rate limited per client', async () => {
  const ctx = await setup();
  try {
    const successes = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await postJson(`${ctx.baseUrl}/api/reports/generate`, PERIOD);
      successes.push(response.status);
      assert.equal(response.status, 201);
    }
    const limited = await postJson(`${ctx.baseUrl}/api/reports/generate`, PERIOD);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(ctx.demoCalls.length, 5);
  } finally { await ctx.cleanup(); }
});

test('public demo PDF concurrency is capped at two active jobs', async () => {
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = await setup({
    demoGenerate: async (options) => {
      started += 1;
      await gate;
      return generateReport({ ...options, pdfRenderer: fakePdfRenderer });
    },
  });
  try {
    const first = postJson(`${ctx.baseUrl}/api/reports/generate`, PERIOD);
    const second = postJson(`${ctx.baseUrl}/api/reports/generate`, PERIOD);
    for (let i = 0; i < 100 && started < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(started, 2, 'two jobs should occupy the renderer slots');
    const third = await postJson(`${ctx.baseUrl}/api/reports/generate`, PERIOD);
    assert.equal(third.status, 503);
    assert.equal(third.headers.get('retry-after'), '5');
    release();
    assert.equal((await first).status, 201);
    assert.equal((await second).status, 201);
  } finally {
    release();
    await ctx.cleanup();
  }
});
