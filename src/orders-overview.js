/**
 * Read-only overview of what is in the orders table, using the SAME definitions as the
 * report (orders = distinct order_id, revenue = sum of line-item amounts).
 * Works on a read-only handle and on databases that predate order IDs.
 */
export function getOrdersOverview(database, { latest = 10 } = {}) {
  const columns = database.prepare('PRAGMA table_info(orders)').all().map((column) => column.name);
  const migrated = columns.includes('order_id') && columns.includes('line_item_id');
  const orderKey = migrated ? "COALESCE(order_id, 'LEGACY-' || id)" : "'LEGACY-' || id";

  const totals = database.prepare(`
    SELECT COUNT(*) AS line_items,
           COUNT(DISTINCT ${orderKey}) AS orders,
           COALESCE(SUM(amount), 0) AS revenue,
           MIN(DATE(created_at)) AS first_date,
           MAX(DATE(created_at)) AS last_date
    FROM orders
  `).get();

  const hasBatches = migrated && database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'import_batches'").get() !== undefined;
  const batches = hasBatches
    ? database.prepare(`
        SELECT b.id, b.source_file AS sourceFile, b.imported_at AS importedAt, b.rows_imported AS rowsImported,
               b.rows_skipped AS rowsSkipped, SUBSTR(b.file_sha256, 1, 12) AS fingerprint,
               (SELECT COUNT(DISTINCT order_id) FROM orders WHERE import_batch_id = b.id) AS orders
        FROM import_batches b ORDER BY b.id DESC LIMIT 10
      `).all()
    : [];
  const legacy = migrated ? database.prepare("SELECT COUNT(*) AS n FROM orders WHERE line_item_id LIKE 'LEGACY-%'").get().n : totals.line_items;
  const recent = database.prepare(`
    SELECT ${migrated ? 'order_id' : "'LEGACY-' || id"} AS orderId, ${migrated ? 'line_item_id' : "'LEGACY-' || id"} AS lineItemId,
           customer, product, category, amount, DATE(created_at) AS date
    FROM orders ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(latest);

  return {
    migrated,
    lineItems: Number(totals.line_items),
    orders: Number(totals.orders),
    revenue: Math.round(Number(totals.revenue) * 100) / 100,
    firstDate: totals.first_date ?? null,
    lastDate: totals.last_date ?? null,
    legacyLineItems: Number(legacy),
    batches,
    recent,
  };
}
