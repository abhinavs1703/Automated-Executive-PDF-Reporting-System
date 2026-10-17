import test from 'node:test';
import assert from 'node:assert/strict';
import { previewCustomCsv, mapCustomCsv, CustomCsvError } from '../src/custom-csv.js';

const CSV = `Order ID,Order Date,Product,Category,Customer,Revenue\nA-100,2026-09-01,Keyboard,Accessories,Ada,129.99\nA-100,2026-09-01,Mouse,Accessories,Ada,"49.50"\nA-101,2026-09-03,Monitor,Displays,Lin,"1,200.00"\n`;

test('custom CSV preview recognizes common sales headers and returns sample rows', () => {
  const result = previewCustomCsv(CSV);
  assert.equal(result.rowCount, 3);
  assert.deepEqual(result.suggestedMapping, {
    date: 'Order Date', amount: 'Revenue', product: 'Product', customer: 'Customer',
    orderId: 'Order ID', category: 'Category', lineItemId: '', region: '', country: '',
    businessUnit: '', salesChannel: '', customerSegment: '', quantity: '', unitPrice: '',
    discountPercent: '', cost: '', grossProfit: '', grossMarginPercent: '', currency: '',
    salesRep: '', paymentStatus: '', fulfillmentStatus: '', sourceSystem: '',
  });
  assert.equal(result.sampleRows[2][5], '1,200.00');
});

test('custom CSV mapping extracts line items, groups order IDs, and normalizes currency amounts', () => {
  const preview = previewCustomCsv(CSV);
  const result = mapCustomCsv(CSV, preview.suggestedMapping, { uploadId: 'test-upload' });
  assert.equal(result.rowCount, 3);
  assert.equal(result.minDate, '2026-09-01');
  assert.equal(result.maxDate, '2026-09-03');
  assert.equal(result.orders[0].orderId, 'A-100');
  assert.equal(result.orders[1].orderId, 'A-100');
  assert.equal(result.orders[2].amount, 1200);
  assert.equal(result.orders[0].lineItemId, 'test-upload-000002');
});

test('custom CSV validation rejects duplicate headers, invalid dates, invalid amounts and repeated line item IDs', () => {
  assert.throws(() => previewCustomCsv('Date,date,Product,Amount\n2026-01-01,2026-01-01,Widget,1'), CustomCsvError);
  const preview = previewCustomCsv('Date,Product,Amount,Line Item ID\nnot-a-date,Widget,1,L1');
  assert.throws(() => mapCustomCsv('Date,Product,Amount,Line Item ID\nnot-a-date,Widget,1,L1', preview.suggestedMapping), /invalid date/i);
  assert.throws(() => mapCustomCsv('Date,Product,Amount\n2026-01-01,Widget,unknown', { date: 'Date', product: 'Product', amount: 'Amount' }), /invalid amount/i);
  assert.throws(() => mapCustomCsv('Date,Product,Amount,Line Item ID\n2026-01-01,Widget,1,L1\n2026-01-02,Mouse,2,L1', { date: 'Date', product: 'Product', amount: 'Amount', lineItemId: 'Line Item ID' }), /duplicate line item ID/i);
});

test('custom CSV validation enforces row shape and required column mappings', () => {
  assert.throws(() => previewCustomCsv('Date,Product,Amount\n2026-01-01,Widget'), /columns/i);
  assert.throws(() => mapCustomCsv('Date,Product,Amount\n2026-01-01,Widget,1', { date: 'Date', product: '', amount: 'Amount' }), /Choose the CSV column for product/i);
});


test('custom CSV analytics fields derive gross profit and margin from amount less cost when needed', () => {
  const csv = 'Date,Product,Amount,Cost\n2026-02-01,Platform,200,125\n';
  const preview = previewCustomCsv(csv);
  const result = mapCustomCsv(csv, preview.suggestedMapping);
  assert.equal(result.orders[0].grossProfit, 75);
  assert.equal(result.orders[0].grossMarginPercent, 37.5);
});
