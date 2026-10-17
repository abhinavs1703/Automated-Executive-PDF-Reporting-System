import { parseCsv, CsvParseError } from './csv.js';

const FIELD_ALIASES = {
  date: ['date', 'orderdate', 'createdat', 'createddate', 'timestamp', 'transactiondate', 'saledate', 'invoicedate'],
  amount: ['amount', 'revenue', 'total', 'lineamount', 'linetotal', 'sales', 'totalamount', 'orderamount', 'netamount'],
  product: ['product', 'productname', 'item', 'itemname', 'description', 'sku'],
  customer: ['customer', 'customername', 'buyer', 'client', 'accountname', 'customerid', 'accountid'],
  orderId: ['orderid', 'transactionid', 'invoiceid', 'ordernumber', 'order'],
  category: ['category', 'productcategory', 'department', 'productgroup'],
  lineItemId: ['lineitemid', 'lineid', 'itemid', 'rowid', 'detailid'],
  region: ['region', 'salesregion', 'territory', 'market'],
  country: ['country', 'countrycode', 'nation'],
  businessUnit: ['businessunit', 'division', 'businessline'],
  salesChannel: ['saleschannel', 'channel', 'orderchannel'],
  customerSegment: ['customersegment', 'segment', 'accountsegment'],
  quantity: ['quantity', 'qty', 'units', 'unitcount', 'numberofunits'],
  unitPrice: ['unitprice', 'priceperunit', 'price'],
  discountPercent: ['discountpercent', 'discountpct', 'discountpercentage'],
  cost: ['cost', 'linecost', 'totalcost', 'costamount'],
  grossProfit: ['grossprofit', 'profit', 'lineprofit'],
  grossMarginPercent: ['grossmargin', 'grossmarginpercent', 'marginpercent', 'marginpct'],
  currency: ['currency', 'currencycode', 'sourcecurrency', 'isocurrency'],
  salesRep: ['salesrep', 'salesperson', 'owner'],
  paymentStatus: ['paymentstatus', 'paymentstate'],
  fulfillmentStatus: ['fulfillmentstatus', 'fulfilmentstatus', 'deliverystatus'],
  sourceSystem: ['sourcesystem', 'source', 'system'],
};

export class CustomCsvError extends Error {
  constructor(message, row = null) {
    super(message);
    this.name = 'CustomCsvError';
    this.row = row;
    this.code = 'INVALID_CSV';
  }
}

function normalizedHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getRecords(text, maxRows) {
  if (typeof text !== 'string' || !text.trim()) throw new CustomCsvError('Choose a CSV file that contains a header and at least one data row.');
  let parsed;
  try { parsed = parseCsv(text); } catch (error) {
    if (error instanceof CsvParseError) throw new CustomCsvError(error.message, error.row);
    throw error;
  }
  const nonblank = parsed.records.filter((record) => !record.blank);
  if (nonblank.length < 2) throw new CustomCsvError('The CSV must contain a header row and at least one non-empty data row.');
  const headerRecord = nonblank[0];
  const headers = headerRecord.fields.map((field) => field.trim().replace(/^\uFEFF/, ''));
  if (headers.length > 100) throw new CustomCsvError('The CSV has too many columns. The maximum is 100.');
  if (headers.some((header) => !header)) throw new CustomCsvError('Every column needs a header name.');
  const headerKeys = headers.map(normalizedHeader);
  if (new Set(headerKeys).size !== headerKeys.length) throw new CustomCsvError('Column headers must be unique (ignoring spaces and punctuation).');
  const rows = nonblank.slice(1);
  if (rows.length > maxRows) throw new CustomCsvError(`The CSV contains ${rows.length.toLocaleString()} rows; the limit is ${maxRows.toLocaleString()}.`);
  for (const row of rows) {
    if (row.fields.length !== headers.length) {
      throw new CustomCsvError(`Row ${row.row} has ${row.fields.length} columns; the header has ${headers.length}. Check for missing values or unquoted commas.`, row.row);
    }
  }
  return { headers, rows };
}

function suggestMapping(headers) {
  const result = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const index = headers.findIndex((header) => aliases.includes(normalizedHeader(header)));
    result[field] = index >= 0 ? headers[index] : '';
  }
  return result;
}

export function previewCustomCsv(text, { maxRows = 50_000 } = {}) {
  const { headers, rows } = getRecords(text, maxRows);
  return {
    headers,
    sampleRows: rows.slice(0, 5).map((row) => row.fields.map((value) => value.slice(0, 180))),
    rowCount: rows.length,
    suggestedMapping: suggestMapping(headers),
  };
}

function parseDate(value, rowNumber) {
  const text = String(value ?? '').trim();
  if (!text) throw new CustomCsvError(`Row ${rowNumber}: the date value is empty.`, rowNumber);
  let date;
  if (/^\d{4}-\d{2}-\d{2}(?:$|[T\s])/.test(text)) {
    const short = text.slice(0, 10);
    date = new Date(`${short}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== short) {
      throw new CustomCsvError(`Row ${rowNumber}: invalid date "${text.slice(0, 40)}". Use YYYY-MM-DD or a recognizable date.`, rowNumber);
    }
    return short;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new CustomCsvError(`Row ${rowNumber}: invalid date "${text.slice(0, 40)}". Use YYYY-MM-DD or a recognizable date.`, rowNumber);
  date = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

function parseNumeric(value, rowNumber, field, { min = -1_000_000_000_000, max = 1_000_000_000_000 } = {}) {
  const original = String(value ?? '').trim();
  if (!original) return null;
  const numericText = original.replace(/,/g, '').replace(/[^0-9.+-]/g, '');
  if (!numericText || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(numericText)) {
    throw new CustomCsvError(`Row ${rowNumber}: invalid ${field} value "${original.slice(0, 40)}". Use a number such as 1250.50.`, rowNumber);
  }
  const number = Number(numericText);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new CustomCsvError(`Row ${rowNumber}: ${field} must be between ${min.toLocaleString()} and ${max.toLocaleString()}.`, rowNumber);
  }
  return number;
}

function parseAmount(value, rowNumber) {
  const original = String(value ?? '').trim();
  if (!original) throw new CustomCsvError(`Row ${rowNumber}: the amount value is empty.`, rowNumber);
  const amount = parseNumeric(original, rowNumber, 'amount', { min: 0 });
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function optionalText(fields, index, max, label, rowNumber, fallback = null) {
  if (index < 0 || !String(fields[index] ?? '').trim()) return fallback;
  const value = String(fields[index]).trim();
  if (value.length > max) throw new CustomCsvError(`Row ${rowNumber}: ${label} must be ${max} characters or fewer.`, rowNumber);
  return value;
}

function mappedIndex(headers, column, field, required) {
  if (column === undefined || column === null || column === '') {
    if (required) throw new CustomCsvError(`Choose the CSV column for ${field}.`);
    return -1;
  }
  if (typeof column !== 'string' || !headers.includes(column)) throw new CustomCsvError(`The selected ${field} column is not present in the uploaded CSV.`);
  return headers.indexOf(column);
}

/**
 * Map a CSV to normalized line items. Strict mode (the default) preserves the original
 * custom-PDF contract. Organisation imports can opt to skip invalid rows and duplicate
 * line-item IDs while retaining row-level diagnostics for the import ledger.
 */
export function mapCustomCsv(text, mapping, {
  maxRows = 50_000,
  uploadId = 'upload',
  skipInvalidRows = false,
  skipDuplicateLineItems = false,
} = {}) {
  const { headers, rows } = getRecords(text, maxRows);
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new CustomCsvError('Choose the columns before generating a report.');
  const indexes = {};
  for (const [field, label, required] of [
    ['date', 'date', true], ['amount', 'amount / line total', true], ['product', 'product', true],
    ['customer', 'customer', false], ['orderId', 'order ID', false], ['category', 'category', false],
    ['lineItemId', 'line item ID', false], ['region', 'region', false], ['country', 'country', false],
    ['businessUnit', 'business unit', false], ['salesChannel', 'sales channel', false],
    ['customerSegment', 'customer segment', false], ['quantity', 'quantity', false], ['unitPrice', 'unit price', false],
    ['discountPercent', 'discount percentage', false], ['cost', 'cost', false], ['grossProfit', 'gross profit', false],
    ['grossMarginPercent', 'gross margin percentage', false], ['currency', 'currency', false], ['salesRep', 'sales representative', false],
    ['paymentStatus', 'payment status', false], ['fulfillmentStatus', 'fulfilment status', false], ['sourceSystem', 'source system', false],
  ]) indexes[field] = mappedIndex(headers, mapping[field], label, required);

  const lineIds = new Set();
  const orders = [];
  const duplicateRows = [];
  const invalidRows = [];
  for (const record of rows) {
    try {
      const fields = record.fields;
      const product = optionalText(fields, indexes.product, 200, 'product', record.row, '');
      if (!product) throw new CustomCsvError(`Row ${record.row}: product cannot be empty.`, record.row);
      const customer = optionalText(fields, indexes.customer, 200, 'customer', record.row, 'Not provided');
      const category = optionalText(fields, indexes.category, 100, 'category', record.row, product);
      const orderId = optionalText(fields, indexes.orderId, 200, 'order ID', record.row, `CSV-${String(record.row).padStart(6, '0')}`);
      const lineItemId = optionalText(fields, indexes.lineItemId, 200, 'line item ID', record.row, `${uploadId}-${String(record.row).padStart(6, '0')}`);
      const currency = optionalText(fields, indexes.currency, 3, 'currency', record.row, null)?.toUpperCase() || null;
      if (currency && !/^[A-Z]{3}$/.test(currency)) throw new CustomCsvError(`Row ${record.row}: currency must be a three-letter code such as USD or INR.`, record.row);
      const quantity = indexes.quantity < 0 ? null : parseNumeric(fields[indexes.quantity], record.row, 'quantity', { min: 0, max: 1_000_000_000 });
      const unitPrice = indexes.unitPrice < 0 ? null : parseNumeric(fields[indexes.unitPrice], record.row, 'unit price', { min: 0 });
      const discountPercent = indexes.discountPercent < 0 ? null : parseNumeric(fields[indexes.discountPercent], record.row, 'discount percentage', { min: 0, max: 100 });
      const amount = parseAmount(fields[indexes.amount], record.row);
      const cost = indexes.cost < 0 ? null : parseNumeric(fields[indexes.cost], record.row, 'cost');
      const suppliedGrossProfit = indexes.grossProfit < 0 ? null : parseNumeric(fields[indexes.grossProfit], record.row, 'gross profit');
      const grossProfit = suppliedGrossProfit ?? (cost !== null ? Math.round((amount - cost + Number.EPSILON) * 100) / 100 : null);
      const suppliedGrossMarginPercent = indexes.grossMarginPercent < 0 ? null : parseNumeric(fields[indexes.grossMarginPercent], record.row, 'gross margin percentage', { min: -1000, max: 1000 });
      const grossMarginPercent = suppliedGrossMarginPercent ?? (grossProfit !== null && amount !== 0 ? Number((grossProfit / amount * 100).toFixed(2)) : null);
      const createdAt = parseDate(fields[indexes.date], record.row);
      if (lineIds.has(lineItemId)) {
        if (skipDuplicateLineItems) {
          duplicateRows.push({ row: record.row, reason: `Duplicate line item ID "${lineItemId.slice(0, 60)}" within this file.` });
          continue;
        }
        throw new CustomCsvError(`Row ${record.row}: duplicate line item ID "${lineItemId.slice(0, 60)}". Line item IDs must be unique.`, record.row);
      }
      lineIds.add(lineItemId);

      orders.push({
        orderId, lineItemId, customer, product, amount,
        createdAt, category,
        region: optionalText(fields, indexes.region, 100, 'region', record.row),
        country: optionalText(fields, indexes.country, 100, 'country', record.row),
        businessUnit: optionalText(fields, indexes.businessUnit, 120, 'business unit', record.row),
        salesChannel: optionalText(fields, indexes.salesChannel, 100, 'sales channel', record.row),
        customerSegment: optionalText(fields, indexes.customerSegment, 100, 'customer segment', record.row),
        quantity, unitPrice, discountPercent, cost, grossProfit, grossMarginPercent, currency,
        salesRep: optionalText(fields, indexes.salesRep, 150, 'sales representative', record.row),
        paymentStatus: optionalText(fields, indexes.paymentStatus, 80, 'payment status', record.row),
        fulfillmentStatus: optionalText(fields, indexes.fulfillmentStatus, 80, 'fulfilment status', record.row),
        sourceSystem: optionalText(fields, indexes.sourceSystem, 120, 'source system', record.row),
        sourceRow: record.row,
      });
    } catch (error) {
      if (skipInvalidRows && error instanceof CustomCsvError) {
        invalidRows.push({ row: record.row, reason: error.message });
        continue;
      }
      throw error;
    }
  }
  const dates = orders.map((order) => order.createdAt).sort();
  return {
    headers, orders, rowCount: orders.length, rowsReceived: rows.length,
    duplicateRows, invalidRows,
    minDate: dates[0] || null, maxDate: dates.at(-1) || null,
    hasLineItemId: indexes.lineItemId >= 0,
    hasCurrencyColumn: indexes.currency >= 0,
    hasCustomer: indexes.customer >= 0,
    hasGrossProfit: indexes.grossProfit >= 0 || indexes.cost >= 0,
  };
}
