import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../src/config.js';
import { buildSampleOrdersCsv, sampleWeekFor } from '../src/sample-data.js';

// Writes synthetic sample orders for the previous complete Monday-Sunday week (or --start).
// It only WRITES A CSV FILE: it never touches the database, never imports, never emails.
const USAGE = `Create a sample orders CSV for the previous complete week.

Usage:
  npm run sample:csv                                  refresh examples/sample-orders.csv
  npm run sample:csv -- --out my-sample.csv           write another file
  npm run sample:csv -- --start 2026-10-05            use a specific week start instead
  --force                                             overwrite an existing --out file`;

const args = process.argv.slice(2);
const option = (name) => {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value.`);
  return next;
};

try {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
  } else {
    for (const arg of args) {
      if (arg.startsWith('--') && !['--out', '--start', '--force'].includes(arg.split('=')[0])) throw new Error(`Unknown option "${arg}".`);
    }
    const defaultOutput = path.join(projectRoot, 'examples', 'sample-orders.csv');
    const requested = option('--out');
    const output = requested ? path.resolve(process.env.INIT_CWD || process.cwd(), requested) : defaultOutput;
    if (path.extname(output).toLowerCase() !== '.csv') throw new Error('The output file must end in .csv');
    if (!fs.existsSync(path.dirname(output))) throw new Error(`The folder ${path.dirname(output)} does not exist.`);
    if (fs.existsSync(output) && output !== defaultOutput && !args.includes('--force')) {
      throw new Error(`${output} already exists. Choose another name, or add --force to overwrite it.`);
    }
    const start = option('--start') ?? sampleWeekFor().startDate;
    const csv = buildSampleOrdersCsv(start);
    fs.writeFileSync(output, csv);
    const end = new Date(`${start}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 6);
    const endDate = end.toISOString().slice(0, 10);
    console.log(`Wrote ${output}`);
    console.log(`Sample orders for ${start} to ${endDate} (12 orders, 18 line items). Nothing was imported.`);
    console.log('\nNext:');
    console.log(`  npm run import:check -- "${output}"`);
    console.log(`  npm run import:orders -- "${output}"`);
    console.log(`  npm run report -- --start ${start} --end ${endDate}`);
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
