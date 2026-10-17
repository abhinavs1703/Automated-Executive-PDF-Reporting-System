import { getDefaultDatabase, closeDefaultDatabase } from '../src/db.js';

const db = getDefaultDatabase();

const products = [
  { product: 'Mechanical Keyboard', category: 'Accessories', base: 129.99 },
  { product: 'Ultra-wide Monitor', category: 'Displays', base: 499.00 },
  { product: 'Wireless Mouse', category: 'Accessories', base: 49.99 },
  { product: 'USB-C Multi-Port Dock', category: 'Connectivity', base: 89.50 },
  { product: 'Noise-Cancelling Headphones', category: 'Audio', base: 219.00 },
  { product: 'Ergonomic Desk Mat', category: 'Workspace', base: 34.95 },
];
const customers = ['Avery Johnson', 'Jordan Lee', 'Morgan Patel', 'Taylor Brown', 'Casey Williams', 'Riley Chen', 'Jamie Garcia', 'Cameron Singh', 'Drew Martin', 'Alex Morgan'];
const insert = db.prepare('INSERT INTO orders (order_id, line_item_id, customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?, ?, ?)');
const LINES_PER_ORDER = [1, 2, 1, 3]; // repeating pattern so some orders have several line items
const TOTAL_LINE_ITEMS = 240;
const pad = (number, width) => String(number).padStart(width, '0');

try {
  // Safety: this script DELETES every row in `orders`. Refuse if real imported data would be lost.
  const imported = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE import_batch_id IS NOT NULL').get().n;
  if (imported > 0 && !process.argv.includes('--force')) {
    console.error(`Refusing to seed: the database contains ${imported} imported line item(s) from CSV files, and seeding would delete them.`);
    console.error('Sample data is only for trying the project out. To use a separate database, set DATABASE_PATH in .env.');
    console.error('If you really want to erase everything and start over, run:  node scripts/seed.js --force');
    process.exitCode = 1;
  } else {
    db.exec('BEGIN');
    db.exec('DELETE FROM orders');
    const now = Date.now();
    let lineItem = 0;
    let orderIndex = 0;
    while (lineItem < TOTAL_LINE_ITEMS) {
      const orderNumber = orderIndex + 1;
      const daysAgo = (orderIndex * 11) % 120;
      const timestamp = new Date(now - daysAgo * 24 * 60 * 60 * 1000 - (orderIndex % 24) * 60 * 60 * 1000).toISOString();
      const lines = Math.min(LINES_PER_ORDER[orderIndex % LINES_PER_ORDER.length], TOTAL_LINE_ITEMS - lineItem);
      for (let line = 1; line <= lines; line += 1) {
        const product = products[(lineItem * 7 + 2) % products.length];
        const priceAdjustment = 0.8 + ((lineItem * 13) % 41) / 100;
        const amount = Number((product.base * priceAdjustment).toFixed(2));
        insert.run(`SEED-O-${pad(orderNumber, 4)}`, `SEED-L-${pad(orderNumber, 4)}-${line}`, customers[orderIndex % customers.length], product.product, amount, timestamp, product.category);
        lineItem += 1;
      }
      orderIndex += 1;
    }
    db.exec('COMMIT');
    console.log(`Seeded ${TOTAL_LINE_ITEMS} deterministic sample line items in ${orderIndex} orders across the last 120 days.`);
  }
} catch (error) {
  try { db.exec('ROLLBACK'); } catch { /* no transaction was open */ }
  console.error('Failed to seed sample data:', error.message);
  process.exitCode = 1;
} finally {
  closeDefaultDatabase();
}
