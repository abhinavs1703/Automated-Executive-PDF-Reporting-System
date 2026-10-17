import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { getReportData } from '../src/analytics.js';
import { importOrders } from '../src/order-import.js';
import { SAMPLE_CSV } from './support/import-helpers.js';

/*
 * Metric definitions for line-item data:
 *   orders = DISTINCT order_id | revenue = SUM(amount) | AOV = revenue / distinct orders
 *   product orders = distinct orders containing the product | category revenue = SUM(amount)
 * The expected numbers for the sample file were computed independently (exact decimal
 * arithmetic outside this code base), not by running the code under test.
 */

const PERIOD = { startDate: '2026-09-28', endDate: '2026-10-04' };

function line(database, { order, item, date, product = 'Widget', category = 'General', amount, customer = 'Customer' }) {
  database.prepare('INSERT INTO orders (order_id, line_item_id, customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(order, item, customer, product, amount, `${date}T12:00:00.000Z`, category);
}

test('sample file: totals use distinct orders, not rows (12 orders from 18 line items)', () => {
  const database = createDatabase(':memory:');
  try {
    assert.equal(importOrders({ database, filePath: SAMPLE_CSV, now: new Date('2026-10-11T00:00:00Z') }).counts.imported, 18);
    const { summary, previousSummary } = getReportData({ database, ...PERIOD });
    assert.equal(summary.totalOrders, 12, 'distinct order_id values (a row count would give 18)');
    assert.equal(summary.totalRevenue, 2570.21, 'sum of the 18 line-item amounts');
    assert.equal(summary.averageOrderValue, 214.18, '2570.21 / 12 (a per-row average would give 142.79)');
    assert.deepEqual({ orders: previousSummary.totalOrders, revenue: previousSummary.totalRevenue }, { orders: 0, revenue: 0 });
    assert.equal(summary.revenueChangePercent, null, 'no baseline, so no percentage');
    assert.equal(summary.ordersChangePercent, null);
  } finally { database.close(); }
});

test('sample file: daily order counts are distinct orders per day', () => {
  const database = createDatabase(':memory:');
  try {
    importOrders({ database, filePath: SAMPLE_CSV });
    const { dailyTrend } = getReportData({ database, ...PERIOD });
    assert.deepEqual(dailyTrend.map((d) => [d.date, d.totalOrders, d.revenue]), [
      ['2026-09-28', 2, 496.89], ['2026-09-29', 2, 383.44], ['2026-09-30', 2, 658], ['2026-10-01', 2, 267.4],
      ['2026-10-02', 1, 129.99], ['2026-10-03', 2, 143.99], ['2026-10-04', 1, 490.5],
    ]);
    assert.equal(dailyTrend.reduce((n, d) => n + d.totalOrders, 0), 12, 'single-date orders: the daily counts add up to the total');
  } finally { database.close(); }
});

test('sample file: product revenue sums line items; product order counts are distinct orders', () => {
  const database = createDatabase(':memory:');
  try {
    importOrders({ database, filePath: SAMPLE_CSV });
    const { topProducts, categoryRevenue } = getReportData({ database, ...PERIOD });
    assert.deepEqual(topProducts.map((p) => [p.product, p.totalOrders, p.revenue, p.averageOrderValue]), [
      ['Ultra-wide Monitor', 3, 1387, 462.33],
      ['Noise-Cancelling Headphones', 2, 408, 204],
      ['USB-C Multi-Port Dock', 2, 273, 136.5], // 3 rows, but one order contains it twice => 2 distinct orders
      ['Mechanical Keyboard', 2, 249.49, 124.75], // 249.49 / 2 = 124.745: exact tie, rounded half-up like the SQL ROUND() it replaced
      ['Wireless Mouse', 3, 119.97, 39.99],
      ['Ergonomic Desk Mat', 3, 95.35, 31.78],
      ['Café Carry Case "Pro"', 1, 24.5, 24.5],
      ['USB-C Cable, 2 m', 1, 12.9, 12.9],
    ]);
    assert.deepEqual(categoryRevenue.map((c) => [c.category, c.revenue]), [
      ['Displays', 1387], ['Audio', 408], ['Accessories', 406.86], ['Connectivity', 273], ['Workspace', 95.35],
    ]);
  } finally { database.close(); }
});

test('the same product twice in one order counts as ONE order for that product', () => {
  const database = createDatabase(':memory:');
  try {
    line(database, { order: 'A', item: 'A1', date: '2026-09-28', product: 'Dock', category: 'Conn', amount: 90 });
    line(database, { order: 'A', item: 'A2', date: '2026-09-28', product: 'Dock', category: 'Conn', amount: 90 });
    line(database, { order: 'B', item: 'B1', date: '2026-09-29', product: 'Dock', category: 'Conn', amount: 95 });
    const { topProducts, summary } = getReportData({ database, ...PERIOD });
    assert.deepEqual(topProducts.map((p) => [p.totalOrders, p.revenue, p.averageOrderValue]), [[2, 275, 137.5]]);
    assert.deepEqual([summary.totalOrders, summary.totalRevenue, summary.averageOrderValue], [2, 275, 137.5]);
  } finally { database.close(); }
});

test('an order whose lines fall on two dates counts once in the period total and once on each day', () => {
  const database = createDatabase(':memory:');
  try {
    line(database, { order: 'SPLIT', item: 'S1', date: '2026-09-29', amount: 10 });
    line(database, { order: 'SPLIT', item: 'S2', date: '2026-09-30', amount: 20 });
    const { summary, dailyTrend } = getReportData({ database, ...PERIOD });
    assert.equal(summary.totalOrders, 1);
    assert.equal(summary.totalRevenue, 30);
    assert.deepEqual(dailyTrend.filter((d) => d.totalOrders > 0).map((d) => [d.date, d.totalOrders, d.revenue]), [['2026-09-29', 1, 10], ['2026-09-30', 1, 20]]);
  } finally { database.close(); }
});

test('previous-period comparison uses the same definitions', () => {
  const database = createDatabase(':memory:');
  try {
    // Previous week 2026-09-21..27: 2 orders (3 lines), revenue 200 -> AOV 100
    line(database, { order: 'P1', item: 'P1a', date: '2026-09-22', amount: 100 });
    line(database, { order: 'P1', item: 'P1b', date: '2026-09-22', amount: 50 });
    line(database, { order: 'P2', item: 'P2a', date: '2026-09-25', amount: 50 });
    // Current week: 1 order (3 lines), revenue 600
    line(database, { order: 'C1', item: 'C1a', date: '2026-09-28', amount: 300 });
    line(database, { order: 'C1', item: 'C1b', date: '2026-09-28', amount: 200 });
    line(database, { order: 'C1', item: 'C1c', date: '2026-09-28', amount: 100 });
    const { summary, previousSummary } = getReportData({ database, ...PERIOD });
    assert.deepEqual([previousSummary.totalOrders, previousSummary.totalRevenue, previousSummary.averageOrderValue], [2, 200, 100]);
    assert.equal(previousSummary.startDate, '2026-09-21');
    assert.deepEqual([summary.totalOrders, summary.totalRevenue, summary.averageOrderValue], [1, 600, 600]);
    assert.equal(summary.revenueChangePercent, 200);
    assert.equal(summary.ordersChangePercent, -50);
  } finally { database.close(); }
});

test('legacy rows (no order ID) each count as their own order, alongside imported multi-line orders', () => {
  const database = createDatabase(':memory:');
  try {
    const insert = database.prepare('INSERT INTO orders (customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?)');
    insert.run('Old A', 'Thing', 10, '2026-09-28T09:00:00.000Z', 'Misc');
    insert.run('Old B', 'Thing', 10, '2026-09-28T09:00:00.000Z', 'Misc'); // identical data, still a separate order
    line(database, { order: 'NEW-1', item: 'N1', date: '2026-09-28', amount: 30 });
    line(database, { order: 'NEW-1', item: 'N2', date: '2026-09-28', amount: 30 });
    const { summary } = getReportData({ database, ...PERIOD });
    assert.deepEqual([summary.totalOrders, summary.totalRevenue, summary.averageOrderValue], [3, 80, 26.67]);
  } finally { database.close(); }
});

test('money is exact to the cent and an empty period has zero orders and zero average', () => {
  const database = createDatabase(':memory:');
  try {
    assert.deepEqual(getReportData({ database, ...PERIOD }).summary, { totalOrders: 0, totalRevenue: 0, averageOrderValue: 0, revenueChangePercent: 0, ordersChangePercent: 0 });
    for (let i = 0; i < 10; i += 1) line(database, { order: `O${i}`, item: `L${i}`, date: '2026-09-28', amount: 0.1 });
    line(database, { order: 'O0', item: 'L-extra', date: '2026-09-28', amount: 0.2 });
    const { summary } = getReportData({ database, ...PERIOD });
    assert.equal(summary.totalRevenue, 1.2, '10 x 0.10 + 0.20 must not show float noise like 1.2000000000000002');
    assert.equal(summary.totalOrders, 10);
    assert.equal(summary.averageOrderValue, 0.12);
  } finally { database.close(); }
});
