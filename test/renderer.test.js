import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHtmlReport } from '../src/renderer.js';

const sampleReport = {
  metadata: {
    companyName: 'Example Co',
    generatedAt: '2026-10-10T10:00:00.000Z',
    reportStart: '2026-09-28',
    reportEnd: '2026-10-04',
    periodLabel: '2026-09-28 to 2026-10-04',
    currency: 'USD',
  },
  summary: { totalOrders: 2, totalRevenue: 300, averageOrderValue: 150, revenueChangePercent: 20, ordersChangePercent: null },
  previousSummary: { totalOrders: 1, totalRevenue: 250, averageOrderValue: 250, startDate: '2026-09-21', endDate: '2026-09-27' },
  dailyTrend: [{ date: '2026-09-28', totalOrders: 2, revenue: 300 }],
  topProducts: [{ product: '<script>alert(1)</script>', category: 'Accessories', totalOrders: 2, revenue: 300, averageOrderValue: 150 }],
  categoryRevenue: [{ category: 'Accessories', revenue: 300 }],
};

test('Handlebars builds an executive HTML report and escapes database text', async () => {
  const html = await buildHtmlReport(sampleReport, { chartJsBundle: '/* chart bundle test fixture */' });
  assert.match(html, /Weekly Executive Business Report/);
  assert.match(html, /Example Co/);
  assert.match(html, /dailyRevenueChart/);
  assert.match(html, /window\.__REPORT_CHARTS_READY = true/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<td><script>alert\(1\)<\/script><\/td>/);
});
