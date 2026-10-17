import { closeDefaultDatabase, getDefaultDatabase, openDatabaseReadOnly } from '../src/db.js';
import { config } from '../src/config.js';
import { ImportDatabaseError, ImportFileError, formatImportSummary, importOrders, resolveImportPath } from '../src/order-import.js';

// Imports sales data from a CSV file. It NEVER seeds sample data, sends email or starts the scheduler.

const USAGE = `Import sales data from a CSV file.

Usage (run from the project folder):
  npm run import:check  -- <file.csv>      check the file only (dry run, nothing is written)
  npm run import:orders -- <file.csv>      validate and import it for real

  or directly:  node scripts/import-orders.js [--dry-run] <file.csv>

Options:
  --dry-run             validate only; the database is opened read-only
  --all-errors          list every problem (default: the first 25)
  --max-rows <n>        reject files with more than n data rows   (default ${config.importMaxRows})
  --max-file-mb <n>     reject files larger than n megabytes      (default ${config.importMaxFileBytes / 1024 / 1024})
  -h, --help            show this help

Required columns: order_id,line_item_id,customer,product,amount,created_at,category
Save your Excel sheet as "CSV UTF-8 (Comma delimited) (*.csv)" first.

Exit codes: 0 ok | 1 file rejected (nothing imported) | 2 bad command or unreadable file | 3 database failure (rolled back)`;

function parseArguments(argv) {
  const options = { dryRun: false, allErrors: false, files: [], maxRows: undefined, maxFileMb: undefined, help: false };
  const numeric = (name, raw) => {
    const value = Number(raw);
    if (raw === undefined || !Number.isInteger(value) || value < 1) throw new ImportFileError(`${name} needs a whole number of 1 or more (got "${raw ?? ''}").`, 'IMPORT_USAGE');
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].startsWith('--') ? argv[i].split(/=(.*)/s, 2) : [argv[i]];
    switch (flag) {
      case '--dry-run': options.dryRun = true; break;
      case '--all-errors': options.allErrors = true; break;
      case '-h': case '--help': options.help = true; break;
      case '--max-rows': options.maxRows = numeric('--max-rows', inline ?? argv[++i]); break;
      case '--max-file-mb': options.maxFileMb = numeric('--max-file-mb', inline ?? argv[++i]); break;
      default:
        if (argv[i].startsWith('-')) throw new ImportFileError(`Unknown option "${argv[i]}".`, 'IMPORT_USAGE');
        options.files.push(argv[i]);
    }
  }
  return options;
}

let database;
try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
  } else {
    if (options.files.length !== 1) {
      throw new ImportFileError(options.files.length === 0 ? 'No file was given.' : 'Import one file at a time.', 'IMPORT_USAGE');
    }
    const filePath = resolveImportPath(options.files[0]);
    // A dry run opens the database read-only (or not at all if it does not exist yet).
    database = options.dryRun ? openDatabaseReadOnly(config.databasePath) : getDefaultDatabase();
    console.log(`Database: ${config.databasePath}${database ? '' : '  (does not exist yet; a dry run does not create it)'}`);

    const result = importOrders({
      database,
      filePath,
      dryRun: options.dryRun,
      maxRows: options.maxRows ?? config.importMaxRows,
      maxBytes: options.maxFileMb ? options.maxFileMb * 1024 * 1024 : config.importMaxFileBytes,
    });
    console.log(formatImportSummary(result, { allErrors: options.allErrors }).join('\n'));
    if (result.status === 'rejected') process.exitCode = 1;
  }
} catch (error) {
  if (error instanceof ImportFileError) {
    console.error(`ERROR: ${error.message}`);
    if (error.code === 'IMPORT_USAGE') console.error(`\n${USAGE}`);
    process.exitCode = 2;
  } else if (error instanceof ImportDatabaseError) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 3;
  } else {
    console.error('Unexpected error:', error.message);
    process.exitCode = 3;
  }
} finally {
  try { database?.close(); } catch { /* already closed */ }
  closeDefaultDatabase();
}
