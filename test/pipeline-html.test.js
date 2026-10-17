import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHtmlReport } from '../src/renderer.js';
import { getReportData } from '../src/analytics.js';
import { createDatabase } from '../src/db.js';

// These tests cover SQL -> JSON -> Handlebars HTML -> Chart.js wiring WITHOUT a browser.
// They are not evidence of PDF rendering; see real-pdf.test.js for that.

function database() {
  const db = createDatabase(':memory:');
  const insert = db.prepare('INSERT INTO orders (customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?)');
  insert.run('Zed', '<img src=x onerror=alert(1)>', 120.5, '2026-09-29T09:00:00.000Z', 'Gadgets & <b>Things</b>');
  insert.run('Yan', 'Monitor', 400, '2026-10-01T09:00:00.000Z', 'Displays');
  insert.run('Xia', 'Monitor', 100, '2026-09-24T09:00:00.000Z', 'Displays');
  return db;
}

test('JSON report data is rendered into HTML with chart data derived from SQL results', async () => {
  const db = database();
  try {
    const data = getReportData({ database: db, startDate: '2026-09-28', endDate: '2026-10-04' });
    const html = await buildHtmlReport(data);

    // The embedded chart payload equals the SQL-derived JSON (no hard-coded values).
    const match = /const data = (\{.*?\});\n/s.exec(html);
    assert.ok(match, 'chart data JSON is embedded in the page');
    const chart = JSON.parse(match[1]);
    assert.deepEqual(chart.dailyLabels, data.dailyTrend.map((d) => d.date));
    assert.deepEqual(chart.dailyRevenue, data.dailyTrend.map((d) => d.revenue));
    assert.deepEqual(chart.productLabels, data.topProducts.map((p) => p.product));
    assert.equal(chart.dailyRevenue.reduce((a, b) => a + b, 0), 520.5);
    assert.equal(chart.dailyLabels.length, 7);

    for (const id of ['dailyRevenueChart', 'dailyOrdersChart', 'productRevenueChart', 'categoryRevenueChart']) {
      assert.ok(html.includes(`id="${id}"`), `${id} canvas present`);
      assert.ok(html.includes(`getElementById('${id}')`), `${id} is initialised by Chart.js`);
    }
    assert.ok(html.includes('__REPORT_CHARTS_READY'), 'readiness flag is set after charts initialise');
    assert.ok(html.includes('__REPORT_CHARTS_ERROR'), 'chart failures are surfaced');
  } finally { db.close(); }
});

test('the page is self-contained (no external scripts, styles, images or fonts) and escapes database text', async () => {
  const db = database();
  try {
    const html = await buildHtmlReport(getReportData({ database: db, startDate: '2026-09-28', endDate: '2026-10-04' }));
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /<link[^>]+href=/i);
    assert.doesNotMatch(html, /<img[^>]+src=["']?https?:/i);
    assert.doesNotMatch(html, /@import/i);
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'raw HTML from the database must not appear');
    assert.ok(html.includes('&lt;img src&#x3D;x onerror&#x3D;alert(1)&gt;'), 'escaped form is present');
    assert.ok(html.includes('Gadgets &amp; &lt;b&gt;Things&lt;/b&gt;'));
    // JSON embedded in <script> cannot terminate the script block.
    const embedded = /const data = (\{.*?\});\n/s.exec(html)[1];
    assert.ok(!embedded.includes('<') && !embedded.includes('>'));
  } finally { db.close(); }
});

test('an empty period still renders a valid page with an empty-state message', async () => {
  const db = createDatabase(':memory:');
  try {
    const html = await buildHtmlReport(getReportData({ database: db, startDate: '2026-09-28', endDate: '2026-10-04' }));
    assert.ok(html.includes('No orders were recorded'));
    assert.ok(html.includes('Period change: 0%'), 'zero vs zero is a 0% change, not N/A');
  } finally { db.close(); }
});

// ---- Presentation formatting (currency and percentage changes) -------------------------

function formattingDatabase() {
  const db = createDatabase(':memory:');
  const insert = db.prepare('INSERT INTO orders (customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?)');
  insert.run('A', 'Premium Monitor', 2200, '2026-09-29T09:00:00.000Z', 'Displays');
  insert.run('B', 'Desk Mat', 33.9, '2026-09-30T09:00:00.000Z', 'Workspace');
  insert.run('C', 'Cable', 32.4, '2026-10-01T09:00:00.000Z', 'Workspace');
  insert.run('D', 'Old Order', 3000, '2026-09-22T09:00:00.000Z', 'Displays'); // previous period -> negative change
  return db;
}

test('all monetary values are rendered with thousands separators and exactly two decimals', async () => {
  const db = formattingDatabase();
  try {
    const data = getReportData({ database: db, startDate: '2026-09-28', endDate: '2026-10-04' });
    assert.equal(data.summary.totalRevenue, 2266.3, 'sanity: the analytics value is the raw, unformatted number');
    const html = await buildHtmlReport(data);
    const body = html.slice(html.indexOf('<body>'), html.indexOf('<script>'));

    assert.ok(body.includes('USD 2,266.30'), 'total revenue');
    assert.ok(body.includes('USD 33.90'), 'one-decimal amounts get two decimals');
    assert.ok(body.includes('USD 2,200.00'), 'whole amounts get two decimals');
    // No amount anywhere may have 0, 1 or 3+ decimals, or lack thousands separators.
    const amounts = body.match(/USD [\d,]+(\.\d*)?/g);
    assert.ok(amounts.length >= 10, `found ${amounts.length} monetary values`);
    for (const amount of amounts) {
      assert.match(amount, /^USD \d{1,3}(,\d{3})*\.\d{2}$/, `badly formatted amount: ${amount}`);
    }
    assert.doesNotMatch(body, /NaN|undefined|\[object/);
  } finally { db.close(); }
});

test('the configured currency is preserved in every formatted amount', async () => {
  const db = formattingDatabase();
  try {
    const data = getReportData({ database: db, startDate: '2026-09-28', endDate: '2026-10-04' });
    const html = await buildHtmlReport({ ...data, metadata: { ...data.metadata, currency: 'EUR' } });
    const body = html.slice(html.indexOf('<body>'), html.indexOf('<script>'));
    assert.ok(body.includes('EUR 2,266.30'));
    assert.doesNotMatch(body, /USD/);
  } finally { db.close(); }
});

test('negative and positive period changes are signed and styled; the caption text stays contiguous', async () => {
  const db = formattingDatabase();
  try {
    const down = await buildHtmlReport(getReportData({ database: db, startDate: '2026-09-28', endDate: '2026-10-04' }));
    assert.match(down, /<span class="delta-negative">Period change: -24\.5%<\/span>/, 'revenue fell from 3,000 to 2,266.30');
    assert.match(down, /<span class="delta-positive">Period change: \+200%<\/span>/, 'orders rose from 1 to 3');

    const empty = createDatabase(':memory:');
    const none = await buildHtmlReport(getReportData({ database: empty, startDate: '2026-09-28', endDate: '2026-10-04' }));
    assert.match(none, /Period change: 0%/);
    empty.close();
  } finally { db.close(); }
});

test('the product and daily tables keep column headings and are structured to stay together', async () => {
  const db = formattingDatabase();
  try {
    const html = await buildHtmlReport(getReportData({ database: db, startDate: '2026-09-28', endDate: '2026-10-04' }));
    assert.match(html, /<section class="keep-together">\s*<h2>Top products<\/h2>[\s\S]*?<thead>[\s\S]*?<\/thead>/);
    assert.match(html, /<section class="keep-together">\s*<h2>Daily summary<\/h2>/, '7-day tables are kept together');
    assert.match(html, /thead \{ display: table-header-group; \}/, 'headings repeat on every page');
    assert.match(html, /tr \{ break-inside: avoid;/, 'rows are never split mid-row');
    assert.match(html, /h2 \{ break-after: avoid;/, 'titles never stay behind alone');

    const long = await buildHtmlReport(getReportData({ database: db, startDate: '2026-09-01', endDate: '2026-10-04' }));
    assert.match(long, /<section class="allow-split">\s*<h2>Daily summary<\/h2>/, 'long periods may span pages');
  } finally { db.close(); }
});
