import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, projectRoot } from './config.js';
import { formatMoney } from './format.js';
import { REQUIRED_COLUMNS, validateOrderCsv } from './order-validation.js';

/*
 * CSV order import.
 *
 * Duplicate policy (never silent, never destructive):
 *  - A line_item_id repeated INSIDE the file is an error on every repeat.
 *  - A line_item_id that already exists in the database with IDENTICAL data is skipped and
 *    counted ("already imported"), so re-running the same file is harmless.
 *  - A line_item_id that exists with DIFFERENT data is a conflict error. Existing rows are
 *    never overwritten or deleted by an import.
 *  - Any error rejects the whole file: nothing is written (all-or-nothing). Real imports run
 *    in one transaction, so a failure part-way cannot leave a half-imported batch.
 *
 * This module never sends email, never seeds sample data and never starts the scheduler.
 */

/** Problems with the file itself (missing, wrong type, too large, wrong encoding). */
export class ImportFileError extends Error {
  constructor(message, code = 'IMPORT_FILE') {
    super(message);
    this.name = 'ImportFileError';
    this.code = code;
  }
}

/** The database refused the import; the transaction was rolled back. */
export class ImportDatabaseError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'ImportDatabaseError';
  }
}

const EXCEL_HINT = 'In Excel use File > Save As > "CSV UTF-8 (Comma delimited) (*.csv)".';

/**
 * Turn the path typed by the user into a real file path.
 * Relative paths are tried against the folder the command was typed in (npm exposes that as
 * INIT_CWD) and then against the repository root, so `examples/sample-orders.csv` works from
 * anywhere. Only existing regular .csv files are accepted.
 */
export function resolveImportPath(input, { cwd = process.env.INIT_CWD || process.cwd(), root = projectRoot } = {}) {
  if (typeof input !== 'string' || input.trim() === '') throw new ImportFileError('No file was given. Pass the path of a .csv file.', 'IMPORT_USAGE');
  if (input.includes('\0')) throw new ImportFileError('The file path contains an invalid character.', 'IMPORT_USAGE');

  const cleaned = input.trim();
  const candidates = path.isAbsolute(cleaned) ? [cleaned] : [...new Set([path.resolve(cwd, cleaned), path.resolve(root, cleaned)])];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new ImportFileError(`File not found: ${cleaned}\nLooked in:\n${candidates.map((c) => `  ${c}`).join('\n')}\nCheck the spelling, or give the full path (for example C:\\Users\\you\\Documents\\orders.csv).`, 'IMPORT_NOT_FOUND');
  }
  const real = fs.realpathSync(found);
  if (!fs.statSync(real).isFile()) throw new ImportFileError(`${found} is a folder, not a file. Give the path of the .csv file itself.`, 'IMPORT_NOT_FILE');
  for (const candidate of [found, real]) {
    if (path.extname(candidate).toLowerCase() !== '.csv') {
      throw new ImportFileError(`Only .csv files can be imported (got "${path.basename(candidate)}"). ${EXCEL_HINT}`, 'IMPORT_EXTENSION');
    }
  }
  return real;
}

/** Read an import file with size and encoding checks. Returns { text, bytes, sha256 }. */
export function readImportFile(filePath, { maxBytes = config.importMaxFileBytes } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    throw new ImportFileError(`Cannot read ${filePath}: ${error.code === 'ENOENT' ? 'the file does not exist' : error.message}`, 'IMPORT_NOT_FOUND');
  }
  if (!stat.isFile()) throw new ImportFileError(`${filePath} is not a regular file.`, 'IMPORT_NOT_FILE');
  if (path.extname(fs.realpathSync(filePath)).toLowerCase() !== '.csv') {
    throw new ImportFileError(`Only .csv files can be imported. ${EXCEL_HINT}`, 'IMPORT_EXTENSION');
  }
  if (stat.size === 0) throw new ImportFileError('The file is empty (0 bytes).', 'IMPORT_EMPTY');
  if (stat.size > maxBytes) {
    throw new ImportFileError(`The file is ${(stat.size / 1024 / 1024).toFixed(1)} MB, which is larger than the allowed ${(maxBytes / 1024 / 1024).toFixed(1)} MB. Split it into smaller files, or raise IMPORT_MAX_FILE_MB.`, 'IMPORT_TOO_LARGE');
  }

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    if (['EBUSY', 'EPERM', 'EACCES', 'EMFILE'].includes(error.code)) {
      throw new ImportFileError(`The file cannot be read (${error.code}). If it is open in Excel or another program, close it (or save a copy) and try again; otherwise check that you have permission to read it.`, 'IMPORT_LOCKED');
    }
    throw new ImportFileError(`The file could not be read: ${error.message}`, 'IMPORT_UNREADABLE');
  }
  if (buffer.length > maxBytes) throw new ImportFileError('The file grew while it was being read and is now over the size limit.', 'IMPORT_TOO_LARGE');
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    throw new ImportFileError(`This is an Excel workbook (.xlsx), not a CSV file, even though it is named .csv. ${EXCEL_HINT}`, 'IMPORT_ENCODING');
  }
  if ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff) || buffer.includes(0)) {
    throw new ImportFileError(`The file is UTF-16 or binary, not UTF-8 text. ${EXCEL_HINT}`, 'IMPORT_ENCODING');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new ImportFileError(`The file is not valid UTF-8 (accented or special characters would be corrupted). Do not choose plain "CSV (Comma delimited)", which uses a legacy encoding. ${EXCEL_HINT}`, 'IMPORT_ENCODING');
  }
  return { text, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

// ---------------------------------------------------------------------------- database comparison

function hasImportColumns(database) {
  if (!database) return false;
  try {
    const columns = database.prepare('PRAGMA table_info(orders)').all().map((column) => column.name);
    return columns.includes('line_item_id') && columns.includes('order_id');
  } catch {
    return false;
  }
}

function existingLineItems(database, ids) {
  const found = new Map();
  if (!hasImportColumns(database)) return found; // an un-migrated database has no importable IDs to collide with
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = database.prepare(
      `SELECT line_item_id, order_id, customer, product, amount, created_at, category FROM orders WHERE line_item_id IN (${placeholders})`,
    ).all(...chunk);
    for (const row of rows) found.set(row.line_item_id, row);
  }
  return found;
}

function differences(existing, row) {
  const changed = [];
  if (existing.order_id !== row.orderId) changed.push('order_id');
  if (existing.customer !== row.customer) changed.push('customer');
  if (existing.product !== row.product) changed.push('product');
  if ((existing.category ?? '') !== row.category) changed.push('category');
  if (Math.abs(Number(existing.amount) - row.amount) > 0.005) changed.push('amount');
  if (Date.parse(existing.created_at) !== Date.parse(row.createdAt)) changed.push('created_at');
  return changed;
}

/** Split valid rows into new rows, identical duplicates (skipped) and conflicts (errors). */
export function planImport(database, rows) {
  const existing = existingLineItems(database, rows.map((row) => row.lineItemId));
  const plan = { newRows: [], duplicates: [], conflicts: [] };
  for (const row of rows) {
    const match = existing.get(row.lineItemId);
    if (!match) { plan.newRows.push(row); continue; }
    const changed = differences(match, row);
    if (changed.length === 0) {
      plan.duplicates.push({ row: row.row, lineItemId: row.lineItemId });
    } else {
      plan.conflicts.push({
        row: row.row,
        column: 'line_item_id',
        message: `line_item_id "${row.lineItemId}" already exists in the database with different data (different ${changed.join(', ')}). Existing records are never overwritten. If this is a new line, give it a new unique line_item_id; if the saved record is wrong, correct it deliberately instead of re-importing.`,
      });
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------- import

const sumCents = (rows) => rows.reduce((total, row) => total + Math.round(row.amount * 100), 0) / 100;
const byRowThenColumn = (a, b) => (a.row ?? 0) - (b.row ?? 0) || String(a.column).localeCompare(String(b.column));

/**
 * Validate (and, unless dryRun, import) an orders CSV file.
 *
 * `database` may be null for a dry run against a database that does not exist yet.
 * Never throws for bad DATA (that is reported in the result); throws ImportFileError for
 * file-level problems and ImportDatabaseError if the database refuses the import (after
 * rolling the whole batch back).
 */
export function importOrders({
  database,
  filePath,
  dryRun = false,
  maxRows = config.importMaxRows,
  maxBytes = config.importMaxFileBytes,
  now = new Date(),
} = {}) {
  const file = readImportFile(filePath, { maxBytes });
  const validation = validateOrderCsv(file.text, { maxRows, now });
  const warnings = [...validation.warnings];

  const result = {
    dryRun,
    file: { path: filePath, name: path.basename(filePath), bytes: file.bytes, sha256: file.sha256 },
    counts: {
      recordsRead: validation.stats.recordsRead,
      blankRowsSkipped: validation.stats.blankRowsSkipped,
      validRows: validation.rows.length,
      rejectedRows: 0,
      newRows: 0,
      duplicatesSkipped: 0,
      imported: 0,
    },
    ordersInFile: new Set(validation.rows.map((row) => row.orderId)).size,
    newOrders: 0,
    newRevenue: 0,
    period: null,
    errors: [...validation.errors],
    warnings,
    batchId: null,
    status: 'rejected',
  };

  const finalize = (plan) => {
    result.counts.newRows = plan.newRows.length;
    result.counts.duplicatesSkipped = plan.duplicates.length;
    result.newOrders = new Set(plan.newRows.map((row) => row.orderId)).size;
    result.newRevenue = sumCents(plan.newRows);
    if (plan.newRows.length > 0) {
      const days = plan.newRows.map((row) => row.createdAt.slice(0, 10)).sort();
      result.period = { start: days[0], end: days[days.length - 1] };
    }
    if (plan.duplicates.length > 0) {
      warnings.push({ row: null, message: `${plan.duplicates.length} row(s) are already in the database with identical data and were skipped (not imported again).` });
    }
  };
  // Counts are derived from the final error list, so every code path reports the same way.
  const closeOut = () => {
    result.errors.sort(byRowThenColumn);
    const rejected = new Set(result.errors.filter((e) => e.row !== null).map((e) => e.row));
    result.counts.rejectedRows = rejected.size;
    result.counts.validRows = validation.rows.filter((row) => !rejected.has(row.row)).length;
  };

  // Look for a previous import of this exact file (informational only).
  if (hasImportBatches(database)) {
    const previous = database.prepare('SELECT id, imported_at FROM import_batches WHERE file_sha256 = ? ORDER BY id DESC LIMIT 1').get(file.sha256);
    if (previous) warnings.push({ row: null, message: `This exact file was already imported on ${previous.imported_at.slice(0, 10)} (import batch #${previous.id}). Rows that are already stored are skipped, never duplicated.` });
  }

  // Read-only comparison with the database, so conflicts are reported together with other problems.
  const preview = planImport(database, validation.rows);
  result.errors.push(...preview.conflicts);

  if (result.errors.length > 0) {
    finalize(preview);
    result.counts.newRows = 0; // nothing will be imported from a rejected file
    closeOut();
    return result;
  }

  if (dryRun) {
    finalize(preview);
    result.status = preview.newRows.length > 0 ? 'dry-run-ok' : 'nothing-new';
    closeOut();
    return result;
  }

  // Real import: one transaction. The comparison is repeated INSIDE the write lock so that
  // another process cannot slip a duplicate in between the check and the insert.
  database.exec('BEGIN IMMEDIATE');
  try {
    const plan = planImport(database, validation.rows);
    if (plan.conflicts.length > 0) {
      database.exec('ROLLBACK');
      result.errors.push(...plan.conflicts);
      finalize(plan);
      result.counts.newRows = 0;
      closeOut();
      return result;
    }
    finalize(plan);
    if (plan.newRows.length === 0) {
      database.exec('ROLLBACK');
      result.status = 'nothing-new';
      closeOut();
      return result;
    }
    const batch = database.prepare(
      'INSERT INTO import_batches (source_file, file_sha256, rows_imported, rows_skipped, imported_at) VALUES (?, ?, ?, ?, ?)',
    ).run(result.file.name, file.sha256, plan.newRows.length, plan.duplicates.length, new Date().toISOString());
    const batchId = Number(batch.lastInsertRowid);
    const insert = database.prepare(
      'INSERT INTO orders (order_id, line_item_id, customer, product, amount, created_at, category, import_batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const row of plan.newRows) {
      insert.run(row.orderId, row.lineItemId, row.customer, row.product, row.amount, row.createdAt, row.category, batchId);
    }
    database.exec('COMMIT');
    result.batchId = batchId;
    result.counts.imported = plan.newRows.length;
    result.status = 'imported';
    closeOut();
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* the transaction was already closed by SQLite */ }
    throw new ImportDatabaseError(`The database rejected the import and every change was rolled back (nothing was imported): ${error.message}`, { cause: error });
  }
}

function hasImportBatches(database) {
  if (!database) return false;
  try {
    return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'import_batches'").get() !== undefined;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------- presentation

/** Human-readable summary lines for the command line. */
export function formatImportSummary(result, { currency = config.reportCurrency, allErrors = false, maxListed = 25, commandHint = 'npm run import:orders --' } = {}) {
  const { counts } = result;
  const lines = [];
  const pad = (label, value, note = '') => lines.push(`  ${label.padEnd(26)}${String(value).padStart(7)}${note ? `   ${note}` : ''}`);

  lines.push(`File:  ${result.file.path}  (${(result.file.bytes / 1024).toFixed(1)} KB)`);
  lines.push(`Mode:  ${result.dryRun ? 'DRY RUN - nothing is written to the database' : 'IMPORT'}`);
  lines.push('');
  pad('Data rows read', counts.recordsRead, counts.blankRowsSkipped ? `(${counts.blankRowsSkipped} blank row(s) ignored)` : '');
  pad('Valid rows', counts.validRows);
  pad('Rejected rows', counts.rejectedRows);
  pad('Already in database', counts.duplicatesSkipped, 'identical, skipped');
  if (result.status === 'imported') pad('Newly imported rows', counts.imported, `${result.newOrders} order(s), ${formatMoney(result.newRevenue, currency)}`);
  else if (result.status === 'dry-run-ok') pad('Would import', counts.newRows, `${result.newOrders} order(s), ${formatMoney(result.newRevenue, currency)}`);
  else pad('Imported rows', 0);
  lines.push(`  ${'Orders in file'.padEnd(26)}${String(result.ordersInFile).padStart(7)}   (distinct order_id values, valid rows)`);

  const listProblems = (title, items, format) => {
    if (items.length === 0) return;
    lines.push('', `${title} (${items.length}):`);
    const shown = allErrors ? items : items.slice(0, maxListed);
    for (const item of shown) lines.push(format(item));
    if (shown.length < items.length) lines.push(`  ... and ${items.length - shown.length} more. Add --all-errors to list everything.`);
  };
  listProblems('PROBLEMS', result.errors, (e) => `  ${e.row === null ? 'File ' : `Row ${String(e.row).padEnd(5)}`} ${e.column ? `[${e.column}] ` : ''}${e.message}`);
  listProblems('WARNINGS', result.warnings, (w) => `  ${w.row === null ? 'File ' : `Row ${String(w.row).padEnd(5)}`} ${w.message}`);

  lines.push('');
  switch (result.status) {
    case 'rejected':
      lines.push('RESULT: REJECTED. Nothing was imported. Fix the problems above in your spreadsheet, save as CSV UTF-8 again and re-run.');
      break;
    case 'dry-run-ok':
      lines.push('RESULT: the file is valid. Nothing was written (dry run).', `To import it for real:  ${commandHint} "${result.file.path}"`);
      break;
    case 'nothing-new':
      lines.push('RESULT: nothing new to import; every row is already in the database. The database was not changed.');
      break;
    case 'imported':
      lines.push(`RESULT: imported ${counts.imported} line item(s) in one transaction (import batch #${result.batchId}).`);
      if (result.period) {
        lines.push('', 'Next steps:', '  npm run orders:summary', `  npm run report -- --start ${result.period.start} --end ${result.period.end}`);
      }
      break;
    default:
      break;
  }
  return lines;
}

export { REQUIRED_COLUMNS };
