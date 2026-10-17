import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parseCreatedAt, validateOrderCsv } from '../src/order-validation.js';

const HEADER = 'order_id,line_item_id,customer,product,amount,created_at,category';
const GOOD = 'ORD-1,L-1,Avery,Keyboard,49.99,2026-09-28T10:00:00Z,Accessories';
const csv = (...lines) => `${lines.join('\n')}\n`;
const NOW = new Date('2026-10-11T12:00:00Z');
const validate = (text, options = {}) => validateOrderCsv(text, { now: NOW, ...options });
const errorFor = (result, row, column) => result.errors.find((e) => e.row === row && (column === undefined || e.column === column));

test('a valid file produces normalised rows and clean statistics', () => {
  const result = validate(csv(HEADER, GOOD, 'ORD-1,L-2,Avery,Mouse,10,2026-09-28,Accessories'));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.stats, { recordsRead: 2, blankRowsSkipped: 0, validRows: 2, rejectedRows: 0 });
  assert.deepEqual(result.rows[0], {
    row: 2, orderId: 'ORD-1', lineItemId: 'L-1', customer: 'Avery', product: 'Keyboard', amount: 49.99,
    createdAt: '2026-09-28T10:00:00.000Z', category: 'Accessories',
  });
  assert.equal(result.rows[1].createdAt, '2026-09-28T00:00:00.000Z', 'a bare date means midnight UTC');
  assert.equal(result.rows[1].amount, 10);
});

test('required headers: every missing column is named, with what was found', () => {
  const result = validate(csv('order_id,customer,product,amount,created_at', 'ORD-1,Avery,Keyboard,1,2026-09-28'));
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, null);
  assert.match(result.errors[0].message, /Missing required column\(s\): line_item_id, category/);
  assert.match(result.errors[0].message, /found: order_id, customer, product, amount, created_at/);
});

test('headers are matched case-insensitively, trimmed, in any order; extra columns only warn', () => {
  const result = validate(csv(' Created_At ,Order ID,line-item-id,Customer,Product,Amount,Category,Notes', '2026-09-28,ORD-1,L-1,Avery,Keyboard,5,Accessories,ignored'));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].orderId, 'ORD-1');
  assert.equal(result.rows[0].lineItemId, 'L-1');
  assert.match(result.warnings[0].message, /Ignoring column\(s\).*Notes/);
});

test('semicolon-separated files (some Excel locales) get a specific instruction', () => {
  const result = validate(csv('order_id;line_item_id;customer;product;amount;created_at;category', 'ORD-1;L-1;A;B;1;2026-09-28;C'));
  assert.match(result.errors[0].message, /not comma-separated/);
  assert.match(result.errors[0].message, /CSV UTF-8/);
});

test('empty file, header-only file and duplicate headers', () => {
  assert.match(validate('').errors[0].message, /empty|header/);
  assert.match(validate(csv(HEADER)).errors[0].message, /no data rows/);
  assert.match(validate(csv(`${HEADER},amount`, `${GOOD},1`)).errors[0].message, /"amount" appears more than once/);
});

test('invalid and negative monetary amounts are rejected with actionable messages and row numbers', () => {
  const cases = [
    ['abc', /not a valid number/],
    ['', /required but the cell is empty/],
    ['-5', /negative; amounts must be 0 or greater/],
    ['-0.01', /negative/],
    ['$5.00', /currency symbol/],
    ['USD 5', /currency symbol/],
    ['"1,299.00"', /thousands separator; remove the comma \(write 1299\.00\)/],
    ['"12,50"', /comma as the decimal separator; use a dot instead \(write 12\.50\)/],
    ['12.345', /more than 2 decimal places; round it to cents/],
    ['1e3', /not a valid number/],
    ['NaN', /not a valid number/],
    ['Infinity', /not a valid number/],
    ['5 %', /not a valid number/],
    ['2000000000', /larger than the allowed maximum/],
  ];
  for (const [amount, pattern] of cases) {
    const result = validate(csv(HEADER, GOOD, `ORD-2,L-2,Avery,Mouse,${amount},2026-09-28,Accessories`));
    const error = errorFor(result, 3, 'amount');
    assert.ok(error, `amount ${JSON.stringify(amount)} should be rejected`);
    assert.match(error.message, pattern, `amount ${JSON.stringify(amount)}`);
    assert.equal(result.rows.length, 1, 'the valid row 2 is still reported as valid');
    assert.equal(result.stats.rejectedRows, 1);
  }
});

test('accepted amount formats', () => {
  for (const [text, value] of [['0', 0], ['12', 12], ['49.99', 49.99], ['.5', 0.5], ['5.', 5], [' 7.10 ', 7.1], ['1000000000', 1_000_000_000]]) {
    assert.deepEqual(parseAmount(text), { value }, text);
  }
});

test('invalid dates are rejected with advice and row numbers', () => {
  const cases = [
    ['9/28/2026', /not a valid ISO date; use YYYY-MM-DD/],
    ['28.09.2026', /not a valid ISO date/],
    ['2026-02-30', /not a real calendar date/],
    ['2026-13-01', /not a real calendar date/],
    ['2026-09-31', /not a real calendar date/],
    ['2025-02-29', /not a real calendar date/],
    ['2026-09-28T25:00:00Z', /invalid time/],
    ['2026-09-28T10:61:00Z', /invalid time/],
    ['2026-09-28T10:00:00+25:00', /invalid time zone offset/],
    ['yesterday', /not a valid ISO date/],
    ['1999-12-31', /outside the supported range 2000-2100/],
    ['', /required but the cell is empty/],
  ];
  for (const [date, pattern] of cases) {
    const result = validate(csv(HEADER, `ORD-1,L-1,Avery,Keyboard,5,${date},Accessories`));
    const error = errorFor(result, 2, 'created_at');
    assert.ok(error, `date ${JSON.stringify(date)} should be rejected`);
    assert.match(error.message, pattern, `date ${JSON.stringify(date)}`);
  }
});

test('accepted date formats are normalised to UTC', () => {
  const cases = [
    ['2026-09-28', '2026-09-28T00:00:00.000Z'],
    ['2026-09-28T14:30:00Z', '2026-09-28T14:30:00.000Z'],
    ['2026-09-28T14:30Z', '2026-09-28T14:30:00.000Z'],
    ['2026-09-28 14:30:15', '2026-09-28T14:30:15.000Z'],
    ['2026-09-28T14:30:00', '2026-09-28T14:30:00.000Z'],
    ['2026-09-28T14:30:00.123456Z', '2026-09-28T14:30:00.123Z'],
    ['2026-09-28T14:30:00+05:30', '2026-09-28T09:00:00.000Z'],
    ['2026-09-28T00:30:00+02:00', '2026-09-27T22:30:00.000Z'],
    ['2026-09-28T23:30:00-0500', '2026-09-29T04:30:00.000Z'],
    ['2028-02-29', '2028-02-29T00:00:00.000Z'],
  ];
  for (const [input, expected] of cases) assert.deepEqual(parseCreatedAt(input), { value: expected }, input);
});

test('duplicate line_item_id inside the file: every repeat is rejected and points at the first use', () => {
  const result = validate(csv(HEADER, GOOD, 'ORD-2,L-2,B,Mouse,5,2026-09-28,Accessories', 'ORD-3,L-1,C,Dock,9,2026-09-29,Connectivity', 'ORD-4,L-2,D,Mat,3,2026-09-29,Workspace'));
  const first = errorFor(result, 4, 'line_item_id');
  const second = errorFor(result, 5, 'line_item_id');
  assert.match(first.message, /Duplicate line_item_id "L-1".*row 2/);
  assert.match(second.message, /Duplicate line_item_id "L-2".*row 3/);
  assert.equal(result.stats.rejectedRows, 2);
  assert.deepEqual(result.rows.map((r) => r.lineItemId), ['L-1', 'L-2'], 'only the first occurrences remain valid');
});

test('line_item_id comparison is exact (case-sensitive), like the database index', () => {
  const result = validate(csv(HEADER, GOOD, 'ORD-2,l-1,B,Mouse,5,2026-09-28,Accessories'));
  assert.deepEqual(result.errors, []);
});

test('the reserved LEGACY- ID prefix is refused for order and line-item IDs', () => {
  const result = validate(csv(HEADER, 'LEGACY-5,L-1,A,B,1,2026-09-28,C', 'ORD-2,legacy-7,A,B,1,2026-09-28,C'));
  assert.match(errorFor(result, 2, 'order_id').message, /reserved/);
  assert.match(errorFor(result, 3, 'line_item_id').message, /reserved/);
});

test('required text fields, length limits and control characters', () => {
  const result = validate(csv(HEADER, 'ORD-1,L-1,,Keyboard,5,2026-09-28,Accessories', `ORD-2,L-2,A,${'x'.repeat(201)},5,2026-09-28,Accessories`, 'ORD-3,L-3,A,Mouse,5,2026-09-28,'));
  assert.match(errorFor(result, 2, 'customer').message, /customer is required but the cell is empty/);
  assert.match(errorFor(result, 3, 'product').message, /201 characters long; the maximum is 200/);
  assert.match(errorFor(result, 4, 'category').message, /category is required/);
  const control = validate(csv(HEADER, 'ORD-1,L-1,"line\nbreak",Keyboard,5,2026-09-28,Accessories'));
  assert.match(errorFor(control, 2, 'customer').message, /line break or control character/);
});

test('wrong number of columns: explains the likely cause', () => {
  const result = validate(csv(HEADER, GOOD, 'ORD-2,L-2,Avery,Cable, 2 m,12.90,2026-09-28,Accessories', 'ORD-3,L-3,Avery,Mouse'));
  assert.match(errorFor(result, 3).message, /Expected 7 columns but found 8.*wrapped in double quotes/);
  assert.match(errorFor(result, 4).message, /Expected 7 columns but found 4/);
});

test('quoted product and customer names with commas, quotes and UTF-8 are imported intact', () => {
  const result = validate(csv(HEADER, 'ORD-1,L-1,"Müller, Zoë & Söhne","USB-C Cable, 2 m",12.90,2026-09-28,Accessories', 'ORD-1,L-2,"Müller, Zoë & Söhne","Café ""Pro"" Case 東京",24.50,2026-09-28,Accessories'));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].customer, 'Müller, Zoë & Söhne');
  assert.equal(result.rows[0].product, 'USB-C Cable, 2 m');
  assert.equal(result.rows[1].product, 'Café "Pro" Case 東京');
});

test('blank lines are ignored but row numbers still match the spreadsheet', () => {
  const result = validate(`${HEADER}\r\n${GOOD}\r\n\r\n,,,,,,\r\nORD-9,L-9,A,B,not-a-number,2026-09-28,C\r\n`);
  assert.equal(result.stats.blankRowsSkipped, 2);
  assert.equal(result.stats.recordsRead, 2);
  assert.ok(errorFor(result, 5, 'amount'), 'the bad row is reported as row 5 (as Excel would number it)');
});

test('one bad row with several problems lists them all but counts as one rejected row', () => {
  const result = validate(csv(HEADER, ',L-1,,Keyboard,-5,13/45/2026,'));
  assert.equal(result.errors.length, 5);
  assert.equal(result.stats.rejectedRows, 1);
  assert.equal(result.rows.length, 0);
});

test('a malformed CSV structure is a single clear error, not a cascade', () => {
  const result = validate(csv(HEADER, GOOD, 'ORD-2,L-2,"Unclosed,Mouse,5,2026-09-28,Accessories'));
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, 3);
  assert.match(result.errors[0].message, /never closed/);
});

test('row limit', () => {
  const lines = Array.from({ length: 6 }, (_, i) => `ORD-${i},L-${i},A,B,1,2026-09-28,C`);
  const result = validate(csv(HEADER, ...lines), { maxRows: 5 });
  assert.match(result.errors[0].message, /6 data rows, which is more than the allowed maximum of 5/);
  assert.equal(validate(csv(HEADER, ...lines), { maxRows: 6 }).errors.length, 0);
});

test('warnings (never blockers): future dates and orders whose lines disagree', () => {
  const result = validate(csv(HEADER, 'ORD-1,L-1,Avery,A,1,2026-12-25,C', 'ORD-2,L-2,Avery,A,1,2026-09-28,C', 'ORD-2,L-3,Jordan,A,1,2026-09-28,C', 'ORD-2,L-4,Jordan,A,1,2026-09-29,C'));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 4);
  const messages = result.warnings.map((w) => `${w.row}: ${w.message}`).join('\n');
  assert.match(messages, /2: .*in the future/);
  assert.match(messages, /4: order_id "ORD-2" has a different customer than row 3/);
  assert.match(messages, /5: order_id "ORD-2" has a different (customer|date)/);
});
