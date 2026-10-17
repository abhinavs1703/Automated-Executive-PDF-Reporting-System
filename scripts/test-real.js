// Cross-platform runner for the real-browser tests. A missing browser FAILS here
// (REQUIRE_REAL_PDF=true) instead of being skipped. Works from any directory.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['--test', 'test/real-pdf.test.js', 'test/renderer-lifecycle.test.js', 'test/report-layout.test.js', 'test/import-report.test.js'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, REQUIRE_REAL_PDF: 'true' },
});
process.exit(result.status ?? 1);
