import { closeDefaultDatabase, openDatabaseReadOnly } from '../src/db.js';
import { config } from '../src/config.js';
import { formatMoney } from '../src/format.js';
import { getOrdersOverview } from '../src/orders-overview.js';
import { getReportData, ReportPeriodError } from '../src/analytics.js';

// Read-only: shows what is stored so you can verify an import. Changes nothing.
const USAGE = `Show what is stored in the orders database (read-only).

Usage:
  npm run orders:summary
  npm run orders:summary -- --start 2026-09-28 --end 2026-10-04   (also show that report period)
  npm run orders:summary -- --limit 25                            (show 25 recent line items)`;

const args = process.argv.slice(2);
const value = (name) => {
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

let database;
try {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
  } else {
    const start = value('start');
    const end = value('end');
    const limit = value('limit') === undefined ? 10 : Number(value('limit'));
    if (Boolean(start) !== Boolean(end)) throw new ReportPeriodError('Give both --start and --end, or neither.');
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) throw new Error('--limit must be a whole number from 0 to 1000.');

    database = openDatabaseReadOnly(config.databasePath);
    console.log(`Database: ${config.databasePath}`);
    if (!database) {
      console.log('\nThere is no database yet. Import a CSV (npm run import:orders -- <file.csv>) or create sample data (npm run seed).');
    } else {
      const overview = getOrdersOverview(database, { latest: limit });
      const money = (amount) => formatMoney(amount, config.reportCurrency);
      console.log('\nAll stored data');
      console.log(`  Line items:        ${overview.lineItems}`);
      console.log(`  Distinct orders:   ${overview.orders}`);
      console.log(`  Revenue:           ${money(overview.revenue)}`);
      console.log(`  Dates:             ${overview.firstDate ?? '-'} to ${overview.lastDate ?? '-'}`);
      if (!overview.migrated) console.log('  Note: this database is from an older version and will be upgraded automatically the next time you import or start the app.');
      else if (overview.legacyLineItems > 0) console.log(`  Of which ${overview.legacyLineItems} line item(s) have no real order ID (LEGACY-...; sample or old data, each counted as its own order).`);

      if (overview.batches.length > 0) {
        console.log('\nCSV imports (newest first)');
        for (const b of overview.batches) {
          console.log(`  #${b.id}  ${b.importedAt.slice(0, 16).replace('T', ' ')} UTC  ${b.sourceFile}  ${b.rowsImported} rows, ${b.orders} orders (skipped ${b.rowsSkipped}, file ${b.fingerprint})`);
        }
      } else {
        console.log('\nCSV imports: none yet');
      }

      if (overview.recent.length > 0) {
        console.log(`\nMost recent ${overview.recent.length} line item(s)`);
        for (const r of overview.recent) {
          console.log(`  ${r.date}  ${String(r.orderId).padEnd(14)} ${String(r.lineItemId).padEnd(16)} ${money(r.amount).padStart(14)}  ${r.product} (${r.category}) - ${r.customer}`);
        }
      }

      if (start && end) {
        if (!overview.migrated) {
          console.log('\nReport period: skipped (database must be upgraded first; run an import once).');
        } else {
          const report = getReportData({ database, startDate: start, endDate: end });
          const s = report.summary;
          console.log(`\nReport period ${start} to ${end} (same numbers the PDF shows)`);
          console.log(`  Total orders:        ${s.totalOrders}  (distinct order IDs)`);
          console.log(`  Total revenue:       ${money(s.totalRevenue)}`);
          console.log(`  Average order value: ${money(s.averageOrderValue)}`);
        }
      }
    }
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
} finally {
  try { database?.close(); } catch { /* already closed */ }
  closeDefaultDatabase();
}
