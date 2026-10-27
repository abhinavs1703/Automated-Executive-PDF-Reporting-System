# Test fixes and verification

> **Scope note:** the aggregate numbers below are historical results for the local SQLite-mode release before the $0 Supabase cloud runtime was added. For current cloud-mode verification and blockers, see [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md). They must not be interpreted as an end-to-end result for a live Supabase/Render deployment.

## What was fixed

1. `test/custom-browser-flow.test.js` expected the obsolete text `rows validated`. The CSV preview correctly displays a count plus the available date range, such as `5 valid rows detected across 2026-09-01 to 2026-09-04`. The assertion now checks for the current count-bearing status message instead of an obsolete phrase.
2. The scheduled PDF integration test could hide a real generation/email error and report only `scheduler never produced a report` after 30 seconds. The test now propagates errors from the report generation callback so future failures are diagnosable.
3. `npm test` now uses `--test-concurrency=1`. PDF tests launch real Chromium processes; running many browser-heavy files simultaneously can create resource contention, causing flaky scheduled-rendering timeouts. Sequential execution improves repeatability without disabling or weakening assertions.

## Historical local-mode verification and current cloud audit

The prior local-mode release had historical per-file test results recorded as **226 total, 225 passed, 0 failed, 1 skipped** in its earlier packaging environment. Those results are historical and do not certify the current cloud-mode source or a live Supabase/Render deployment.

For the latest uploaded ZIP audit (2026-10-27), all JavaScript files passed `node --check`. The focused dependency-independent suite passed **55/55**. A full `npm ci` could not complete because the audit environment could not resolve `registry.npmjs.org` (`EAI_AGAIN`), leaving `node_modules` incomplete; consequently the full current test suite and `npm audit` were not completed here.

The Chromium environment variables used by an earlier Linux packaging sandbox are specific to that environment and should not be copied into Windows PowerShell. On Windows, let Puppeteer use its installed browser unless your local setup explicitly requires an executable path.

## Recommended Windows verification

From the extracted project root, run commands individually:

```powershell
node --version
npm.cmd ci
npm.cmd test
```

Use Node.js 24.x as required by `package.json`. A complete successful Windows browser run should exercise the Overview, account signup, CSV preview, and real custom PDF workflow; this exact interactive browser journey remains to be confirmed on the user's machine.
