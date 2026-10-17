import { generateReport } from '../src/report-service.js';
import { closeDefaultDatabase } from '../src/db.js';

// Usage: npm run report [-- --start YYYY-MM-DD --end YYYY-MM-DD] [-- --email]
// Without --start/--end the previous complete Monday-Sunday week is used.
const args = process.argv.slice(2);
const ALLOWED = new Set(['--email', '--start', '--end']);

function readOption(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a date, for example ${name} 2026-09-28`);
  return next;
}

try {
  for (const arg of args) {
    const flag = arg.split('=')[0];
    if (arg.startsWith('--') && !ALLOWED.has(flag)) throw new Error(`Unknown option "${arg}". Supported options: --start, --end, --email.`);
  }
  const sendEmail = args.includes('--email');
  const startDate = readOption('--start');
  const endDate = readOption('--end');
  const report = await generateReport({ sendEmail, startDate, endDate });
  console.log(`Report generated: ${report.pdfPath}`);
  console.log(`Period: ${report.reportPeriod.startDate} to ${report.reportPeriod.endDate}`);
  console.log(`Summary: ${JSON.stringify(report.summary)}`);
  console.log(`Email: ${report.email.status}${report.email.error ? ` (${report.email.error})` : ''}`);
  if (report.email.status === 'failed') process.exitCode = 2;
} catch (error) {
  console.error('Report generation failed:', error.message);
  process.exitCode = 1;
} finally {
  closeDefaultDatabase();
}
