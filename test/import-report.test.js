import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateReport } from '../src/report-service.js';
import { importOrders } from '../src/order-import.js';
import { inspectPdf } from './support/pdf-inspect.js';
import { probeBrowser, requireRealPdf } from './support/browser.js';
import { postJson, startTestServer } from './support/helpers.js';
import { SAMPLE_CSV, root, runScript, workspace } from './support/import-helpers.js';

/*
 * REAL-BROWSER end-to-end tests: CSV -> validation -> SQLite -> analytics -> HTML/Chart.js -> PDF.
 * Skipped (= unverified) without a browser; REQUIRE_REAL_PDF=true turns that into a failure.
 * Nothing here sends email.
 */
const browser = await probeBrowser();
const skip = browser.available ? false : (requireRealPdf ? false : `UNVERIFIED - ${browser.reason}`);

const PERIOD = ['--start', '2026-09-28', '--end', '2026-10-04'];

/** The report numbers for the sample file, computed independently (exact decimal arithmetic). */
function assertSampleReportText(pdf) {
  const text = pdf.text.replace(/\s+/g, ' ');
  assert.match(text, /2026-09-28 – 2026-10-04/);
  assert.match(text, /Total revenue USD 2,570\.21/i);
  assert.match(text, /Total orders 12/i, 'distinct orders, not the 18 line items');
  assert.doesNotMatch(text, /Total orders 18/i);
  assert.match(text, /Average order value USD 214\.18/i);
  assert.match(text, /Ultra-wide Monitor Displays 3 USD 462\.33 USD 1,387\.00/);
  assert.match(text, /USB-C Multi-Port Dock Connectivity 2 USD 136\.50 USD 273\.00/, 'two distinct orders although three rows');
  assert.match(text, /Café Carry Case "Pro" Accessories 1 USD 24\.50 USD 24\.50/, 'UTF-8 and quotes survive CSV -> database -> PDF');
  assert.match(text, /USB-C Cable, 2 m Accessories 1 USD 12\.90 USD 12\.90/);
  assert.match(text, /2026-09-28 2 USD 496\.89/);
  assert.match(text, /2026-10-02 1 USD 129\.99/);
  assert.match(text, /2026-10-04 1 USD 490\.50/);
  assert.ok(pdf.imageCount >= 4, `expected the four charts, found ${pdf.imageCount} images`);
  for (const image of pdf.imageDetails.filter((i) => i.width >= 300 && i.height >= 200).slice(0, 4)) {
    assert.ok(image.opaqueRatio > 0.02, 'charts are drawn from the imported data (not blank)');
  }
}

test('CLI: import the sample file, then `npm run report -- --start --end` produces a correct PDF', { skip }, async () => {
  const ws = workspace();
  try {
    const reports = path.join(ws.dir, 'reports');
    const env = { DATABASE_PATH: ws.dbPath, REPORTS_DIR: reports };
    const imported = runScript('import-orders.js', [SAMPLE_CSV], { env });
    assert.equal(imported.code, 0, imported.output);

    const generated = runScript('generate-report.js', PERIOD, { env });
    assert.equal(generated.code, 0, generated.output);
    assert.match(generated.stdout, /Period: 2026-09-28 to 2026-10-04/);
    assert.match(generated.stdout, /"totalOrders":12,"totalRevenue":2570\.21,"averageOrderValue":214\.18/);
    assert.match(generated.stdout, /Email: not_requested/, 'no email unless explicitly requested');

    const pdfs = fs.readdirSync(reports).filter((name) => name.endsWith('.pdf'));
    assert.equal(pdfs.length, 1);
    assertSampleReportText(await inspectPdf(path.join(reports, pdfs[0])));
  } finally { ws.cleanup(); }
});

test('API: POST /reports on the imported data returns the same numbers and a downloadable PDF', { skip }, async () => {
  const ws = workspace();
  const database = ws.openDb();
  const reportsDir = path.join(ws.dir, 'reports');
  let server;
  try {
    assert.equal(importOrders({ database, filePath: SAMPLE_CSV }).counts.imported, 18);
    // The real pipeline (real renderer); only the HTTP server is local. No email requested.
    server = await startTestServer({ database, reportsDir, generate: (options) => generateReport({ ...options }) });
    const response = await postJson(`${server.baseUrl}/reports`, { startDate: '2026-09-28', endDate: '2026-10-04' });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.deepEqual(
      { orders: body.summary.totalOrders, revenue: body.summary.totalRevenue, aov: body.summary.averageOrderValue },
      { orders: 12, revenue: 2570.21, aov: 214.18 },
    );
    assert.deepEqual(body.email, { status: 'not_requested' });

    const pdfResponse = await fetch(`${server.baseUrl}${body.file}`);
    assert.equal(pdfResponse.status, 200);
    const file = path.join(ws.dir, 'downloaded.pdf');
    fs.writeFileSync(file, Buffer.from(await pdfResponse.arrayBuffer()));
    assertSampleReportText(await inspectPdf(file));
  } finally {
    await server?.close();
    database.close();
    ws.cleanup();
  }
});

test('importing more data later is reflected in the next report; duplicates do not inflate it', { skip }, async () => {
  const ws = workspace();
  const database = ws.openDb();
  try {
    importOrders({ database, filePath: SAMPLE_CSV });
    importOrders({ database, filePath: SAMPLE_CSV }); // re-import: must change nothing
    const extra = ws.writeCsv('extra.csv', 'order_id,line_item_id,customer,product,amount,created_at,category\nORD-3001,L-3001-1,CUST-3001,Ultra-wide Monitor,500.00,2026-10-04T18:00:00Z,Displays\nORD-3001,L-3001-2,CUST-3001,Ergonomic Desk Mat,30.00,2026-10-04T18:00:00Z,Workspace\n');
    assert.equal(importOrders({ database, filePath: extra }).counts.imported, 2);

    const report = await generateReport({ database, outputDir: ws.dir, startDate: '2026-09-28', endDate: '2026-10-04' });
    assert.equal(report.summary.totalOrders, 13, '12 + 1 new order (with 2 lines)');
    assert.equal(report.summary.totalRevenue, 3100.21);
    const pdf = await inspectPdf(report.pdfPath);
    assert.match(pdf.text.replace(/\s+/g, ' '), /Total revenue USD 3,100\.21/i);
  } finally { database.close(); ws.cleanup(); }
});
