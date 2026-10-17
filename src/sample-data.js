import { getPreviousWeekRange } from './dates.js';

/**
 * Synthetic sample orders (no real customers) for trying the CSV import.
 * 12 orders / 18 line items over seven days; some orders have several lines, one product
 * appears twice inside a single order, and names include a comma, quotes and UTF-8 text.
 * IDs contain the week's start date, so samples for different weeks never collide, while
 * generating the same week twice gives identical rows (re-importing is then a harmless no-op).
 */
const TEMPLATE = [
  { day: 0, time: '09:15:00', customer: 'CUST-1001', lines: [['Ultra-wide Monitor', '449.00', 'Displays'], ['USB-C Cable, 2 m', '12.90', 'Accessories']] },
  { day: 0, time: '13:40:00', customer: 'CUST-1002', lines: [['Wireless Mouse', '34.99', 'Accessories']] },
  { day: 1, time: '10:05:00', customer: 'Zoë Example', lines: [['Mechanical Keyboard', '119.50', 'Accessories'], ['Ergonomic Desk Mat', '29.95', 'Workspace'], ['Wireless Mouse', '34.99', 'Accessories']] },
  { day: 1, time: '16:20:00', customer: 'CUST-1004', lines: [['Noise-Cancelling Headphones', '199.00', 'Audio']] },
  { day: 2, time: '08:30:00', customer: 'Müller Demo GmbH', lines: [['USB-C Multi-Port Dock', '89.50', 'Connectivity'], ['USB-C Multi-Port Dock', '89.50', 'Connectivity']] },
  { day: 2, time: '14:45:00', customer: 'CUST-1006', lines: [['Ultra-wide Monitor', '479.00', 'Displays']] },
  { day: 3, time: '11:10:00', customer: 'CUST-1007', lines: [['Ergonomic Desk Mat', '33.90', 'Workspace']] },
  { day: 3, time: '17:55:00', customer: 'CUST-1008', lines: [['Noise-Cancelling Headphones', '209.00', 'Audio'], ['Café Carry Case "Pro"', '24.50', 'Accessories']] },
  { day: 4, time: '09:00:00', customer: 'CUST-1009', lines: [['Mechanical Keyboard', '129.99', 'Accessories']] },
  { day: 5, time: '12:30:00', customer: 'CUST-1010', lines: [['Wireless Mouse', '49.99', 'Accessories']] },
  { day: 5, time: '15:15:00', customer: 'CUST-1011', lines: [['USB-C Multi-Port Dock', '94.00', 'Connectivity']] },
  { day: 6, time: '10:45:00', customer: 'CUST-1012', lines: [['Ultra-wide Monitor', '459.00', 'Displays'], ['Ergonomic Desk Mat', '31.50', 'Workspace']] },
];

export const SAMPLE_HEADER = 'order_id,line_item_id,customer,product,amount,created_at,category';

const csvCell = (value) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** CSV text (LF line endings) for the seven days starting at `startDate` (YYYY-MM-DD). */
export function buildSampleOrdersCsv(startDate) {
  // Round-trip check: Date.parse() quietly rolls 2026-02-30 over to March, so compare the result.
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(startDate)
    && new Date(`${startDate}T00:00:00.000Z`).toISOString().slice(0, 10) === startDate;
  if (!valid) throw new Error('startDate must be a valid date in YYYY-MM-DD format.');
  const compact = startDate.replaceAll('-', '');
  const lines = [SAMPLE_HEADER];
  TEMPLATE.forEach((order, index) => {
    const orderId = `ORD-${compact}-${String(index + 1).padStart(2, '0')}`;
    const createdAt = `${addDays(startDate, order.day)}T${order.time}Z`;
    order.lines.forEach(([product, amount, category], lineIndex) => {
      const lineId = `L-${compact}-${String(index + 1).padStart(2, '0')}-${lineIndex + 1}`;
      lines.push([orderId, lineId, order.customer, product, amount, createdAt, category].map(csvCell).join(','));
    });
  });
  return `${lines.join('\n')}\n`;
}

/** The previous complete Monday-Sunday week (UTC) relative to `now`, as the report uses by default. */
export function sampleWeekFor(now = new Date()) {
  return getPreviousWeekRange(now);
}
