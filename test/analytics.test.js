import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { getPreviousWeekRange, getReportData, validateDateRange } from '../src/analytics.js';

function insertOrder(database, { customer = 'Test Customer', product = 'Keyboard', category = 'Accessories', amount, date }) {
  database.prepare('INSERT INTO orders (customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?)')
    .run(customer, product, amount, `${date}T12:00:00.000Z`, category);
}

test('previous-week range returns the last completed Monday through Sunday', () => {
  assert.deepEqual(getPreviousWeekRange(new Date('2026-10-10T10:00:00.000Z')), {
    startDate: '2026-09-28',
    endDate: '2026-10-04',
  });
});

test('SQL metrics and JSON data include current and previous periods', () => {
  const database = createDatabase(':memory:');
  try {
    insertOrder(database, { amount: 100, date: '2026-09-28', product: 'Keyboard' });
    insertOrder(database, { amount: 200, date: '2026-09-30', product: 'Monitor', category: 'Displays' });
    insertOrder(database, { amount: 50, date: '2026-09-22', product: 'Mouse' });
    const report = getReportData({ database, startDate: '2026-09-28', endDate: '2026-10-04' });

    assert.equal(report.summary.totalOrders, 2);
    assert.equal(report.summary.totalRevenue, 300);
    assert.equal(report.summary.averageOrderValue, 150);
    assert.equal(report.previousSummary.totalRevenue, 50);
    assert.equal(report.summary.revenueChangePercent, 500);
    assert.equal(report.dailyTrend.length, 7);
    assert.equal(report.dailyTrend[0].date, '2026-09-28');
    assert.equal(report.dailyTrend[0].revenue, 100);
    assert.equal(report.topProducts[0].product, 'Monitor');
    assert.equal(report.categoryRevenue.length, 2);
    assert.equal(report.metadata.reportStart, '2026-09-28');
  } finally {
    database.close();
  }
});

test('report date ranges are validated', () => {
  assert.throws(() => validateDateRange('2026-10-07', '2026-10-01'), /cannot be after/);
  assert.throws(() => validateDateRange('not-a-date', '2026-10-01'), /YYYY-MM-DD/);
  assert.throws(() => validateDateRange('2026-02-30', '2026-03-01'), /YYYY-MM-DD/);
  assert.throws(() => validateDateRange('2026-01-01', '2026-05-01'), /cannot exceed 93 days/);
});


test('category and region filters consistently scope summary, comparisons, daily rows and product mix', () => {
  const database = createDatabase(':memory:');
  try {
    database.prepare('INSERT INTO orders (order_id, line_item_id, customer, product, amount, created_at, category, region) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('SO-1', 'SO-1-L1', 'Europe Customer', 'Analytics licence', 800, '2026-09-05T12:00:00.000Z', 'Software', 'Europe');
    database.prepare('INSERT INTO orders (order_id, line_item_id, customer, product, amount, created_at, category, region) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('SO-2', 'SO-2-L1', 'US Customer', 'Cloud platform', 1200, '2026-09-05T12:00:00.000Z', 'Software', 'North America');
    database.prepare('INSERT INTO orders (order_id, line_item_id, customer, product, amount, created_at, category, region) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('SV-1', 'SV-1-L1', 'Europe Customer', 'Support plan', 300, '2026-09-05T12:00:00.000Z', 'Services', 'Europe');
    database.prepare('INSERT INTO orders (order_id, line_item_id, customer, product, amount, created_at, category, region) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('SO-OLD', 'SO-OLD-L1', 'Europe Customer', 'Legacy licence', 400, '2026-08-29T12:00:00.000Z', 'Software', 'Europe');

    const report = getReportData({ database, startDate: '2026-09-01', endDate: '2026-09-07', filters: { category: 'Software', region: 'Europe' } });
    assert.equal(report.summary.totalRevenue, 800);
    assert.equal(report.summary.totalOrders, 1);
    assert.equal(report.previousSummary.totalRevenue, 400);
    assert.equal(report.summary.revenueChangePercent, 100);
    assert.equal(report.dailyTrend.reduce((sum, item) => sum + item.revenue, 0), 800);
    assert.deepEqual(report.topProducts.map((item) => item.product), ['Analytics licence']);
    assert.deepEqual(report.categoryRevenue.map((item) => item.category), ['Software']);
    assert.deepEqual(report.metadata.filters, { category: 'Software', region: 'Europe' });
    assert.throws(() => getReportData({ database, startDate: '2026-09-01', endDate: '2026-09-07', filters: { category: 'x'.repeat(151) } }), /at most 150 characters/i);
  } finally { database.close(); }
});
