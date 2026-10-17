import { getDefaultDatabase } from './db.js';
import { config } from './config.js';
import { DAY_MS, addDays, getPreviousWeekRange } from './dates.js';

/** Thrown for invalid reporting periods; the API maps it to HTTP 400. */
export class ReportPeriodError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReportPeriodError';
    this.code = 'INVALID_PERIOD';
  }
}

export { getPreviousWeekRange }; // moved to dates.js; re-exported for existing importers

function validateDateRange(startDate, endDate) {
  const valid = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!valid(startDate) || !valid(endDate)) {
    throw new ReportPeriodError('startDate and endDate must be valid dates in YYYY-MM-DD format.');
  }
  if (startDate > endDate) throw new ReportPeriodError('startDate cannot be after endDate.');
  const length = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY_MS + 1;
  if (length > 93) throw new ReportPeriodError('A report period cannot exceed 93 days.');
}

function number(value) {
  return Number(value ?? 0);
}

/**
 * Metric definitions. The `orders` table holds LINE ITEMS: one order (order_id) can have
 * several rows, so
 *   - an "order" is a distinct order_id (never a row count);
 *   - revenue is the sum of line-item amounts;
 *   - average order value is revenue / distinct orders;
 *   - product/category revenue sum their own line items, and a product's order count is the
 *     number of distinct orders that contain it.
 * Rows without an order_id (databases created before CSV import existed) count as one order
 * each; the migration normally gives them LEGACY-<id> IDs, COALESCE is a safety net.
 */
const ORDER_KEY = "COALESCE(order_id, 'LEGACY-' || id)";

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const perOrder = (revenue, orders) => (orders > 0 ? round2(revenue / orders) : 0);

/** Build a safely parameterised optional filter for organisation analytics. */
export function buildAnalyticsFilter(filters = {}) {
  const normalized = {};
  for (const key of ['category', 'region']) {
    const raw = filters?.[key];
    if (raw === undefined || raw === null || raw === '') { normalized[key] = ''; continue; }
    if (typeof raw !== 'string' || raw.trim().length > 150) {
      throw new ReportPeriodError(`${key} filter must be a string of at most 150 characters.`);
    }
    normalized[key] = raw.trim();
  }
  const clauses = [];
  const params = [];
  if (normalized.category) {
    clauses.push("COALESCE(NULLIF(TRIM(category), ''), product) = ?");
    params.push(normalized.category);
  }
  if (normalized.region) {
    clauses.push('TRIM(region) = ?');
    params.push(normalized.region);
  }
  return { category: normalized.category, region: normalized.region, sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

function querySummary(database, startDate, endDate, filterSpec) {
  const row = database.prepare(`
    SELECT
      COUNT(DISTINCT ${ORDER_KEY}) AS total_orders,
      COALESCE(SUM(amount), 0) AS raw_revenue
    FROM orders
    WHERE DATE(created_at) BETWEEN ? AND ?${filterSpec.sql}
  `).get(startDate, endDate, ...filterSpec.params);

  const totalOrders = number(row.total_orders);
  const rawRevenue = number(row.raw_revenue);
  return {
    totalOrders,
    totalRevenue: round2(rawRevenue),
    averageOrderValue: perOrder(rawRevenue, totalOrders),
  };
}

function percentChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null;
  return Number((((current - previous) / Math.abs(previous)) * 100).toFixed(1));
}

export function getReportData({ database = getDefaultDatabase(), startDate, endDate, now = new Date(), filters = {} } = {}) {
  const defaultRange = getPreviousWeekRange(now);
  const periodStart = startDate || defaultRange.startDate;
  const periodEnd = endDate || defaultRange.endDate;
  validateDateRange(periodStart, periodEnd);
  const filterSpec = buildAnalyticsFilter(filters);

  const periodDays = (Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${periodStart}T00:00:00Z`)) / DAY_MS + 1;
  const previousStart = addDays(periodStart, -periodDays);
  const previousEnd = addDays(periodStart, -1);
  const summary = querySummary(database, periodStart, periodEnd, filterSpec);
  const previousSummary = querySummary(database, previousStart, previousEnd, filterSpec);

  const dailyRows = database.prepare(`
    SELECT DATE(created_at) AS day,
           COUNT(DISTINCT ${ORDER_KEY}) AS total_orders,
           COALESCE(ROUND(SUM(amount), 2), 0) AS revenue
    FROM orders
    WHERE DATE(created_at) BETWEEN ? AND ?${filterSpec.sql}
    GROUP BY DATE(created_at)
    ORDER BY day ASC
  `).all(periodStart, periodEnd, ...filterSpec.params);
  const dailyMap = new Map(dailyRows.map((row) => [row.day, row]));
  const dailyTrend = [];
  for (let offset = 0; offset < periodDays; offset += 1) {
    const day = addDays(periodStart, offset);
    const row = dailyMap.get(day);
    dailyTrend.push({ date: day, totalOrders: number(row?.total_orders), revenue: number(row?.revenue) });
  }

  const topProducts = database.prepare(`
    SELECT product,
           COALESCE(category, product) AS category,
           COUNT(DISTINCT ${ORDER_KEY}) AS total_orders,
           COALESCE(SUM(amount), 0) AS raw_revenue
    FROM orders
    WHERE DATE(created_at) BETWEEN ? AND ?${filterSpec.sql}
    GROUP BY product, COALESCE(category, product)
    ORDER BY ROUND(SUM(amount), 2) DESC, product ASC
    LIMIT 8
  `).all(periodStart, periodEnd, ...filterSpec.params).map((row) => ({
    product: row.product,
    category: row.category,
    totalOrders: number(row.total_orders),
    revenue: round2(number(row.raw_revenue)),
    // Revenue per distinct order that contains this product.
    averageOrderValue: perOrder(number(row.raw_revenue), number(row.total_orders)),
  }));

  const categoryRevenue = database.prepare(`
    SELECT COALESCE(NULLIF(TRIM(category), ''), product) AS category,
           COALESCE(ROUND(SUM(amount), 2), 0) AS revenue
    FROM orders
    WHERE DATE(created_at) BETWEEN ? AND ?${filterSpec.sql}
    GROUP BY COALESCE(NULLIF(TRIM(category), ''), product)
    ORDER BY revenue DESC, category ASC
    LIMIT 8
  `).all(periodStart, periodEnd, ...filterSpec.params).map((row) => ({ category: row.category, revenue: number(row.revenue) }));

  return {
    metadata: {
      companyName: config.companyName,
      generatedAt: new Date().toISOString(),
      reportStart: periodStart,
      reportEnd: periodEnd,
      periodLabel: `${periodStart} to ${periodEnd}`,
      currency: config.reportCurrency,
      filters: { category: filterSpec.category || null, region: filterSpec.region || null },
    },
    summary: {
      ...summary,
      revenueChangePercent: percentChange(summary.totalRevenue, previousSummary.totalRevenue),
      ordersChangePercent: percentChange(summary.totalOrders, previousSummary.totalOrders),
    },
    previousSummary: {
      ...previousSummary,
      startDate: previousStart,
      endDate: previousEnd,
    },
    dailyTrend,
    topProducts,
    categoryRevenue,
  };
}

export { validateDateRange };
