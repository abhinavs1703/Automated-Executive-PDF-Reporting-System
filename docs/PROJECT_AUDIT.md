# ExecuBrief — Final Release Audit

Audit snapshot: 2026-10-17. This document describes the release candidate in this source tree; it is not a claim of an externally deployed or independently penetration-tested production service.

## Verified implementation

- One Express app factory and one deliberate server entry point; importing the app does not bind a listener.
- Synthetic public dashboard storage is separated from private/admin storage and organisation workspaces.
- Public dashboard has period presets, analytics, product search/category/sort controls, and report-history query/status filters.
- Top navigation places Sign in/Create account at the right when signed out and an account menu with user/organisation details, workspace links, Custom PDFs and sign-out when signed in. The organisation workspace header also right-aligns user and sign-out actions.
- Account signup/login use a separate auth store, password hashing and session/CSRF/origin protections. Google OAuth code validates state/nonce and verifies provider identity server-side; a real Google client and live callback are still required before it is available publicly.
- The private organisation dashboard supports date quick ranges, exact dates, category/region filters, cumulative CSV imports, duplicate/invalid-row accounting, import history search/status filters, data-derived business signals, and organisation-scoped report generation.
- CSV imports have file/row limits, strict column/date validation, duplicate checks, consistent-currency enforcement and separate organisation storage.
- Report generation uses the actual report service and Puppeteer PDF renderer. Report history, status, preview and download are protected by the authenticated organisation boundary; file resolution is containment-checked.
- Scheduler and email are disabled in the deployment Blueprint. Public synthetic demo routes do not enable email or scheduler operations.
- `render.yaml` configures the authentication database, private data, organisation custom-data, demo database and report output paths under the persistent `/var/data` mount.
- `.gitignore` now excludes credentials, databases and SQLite sidecars, runtime directories, generated PDFs, logs, dependencies and local editor artifacts while retaining `.env.example`, source and synthetic example CSVs.

## Automated checks completed in the sandbox

The 31 test files were executed individually to avoid a combined Node/Puppeteer teardown hang in this container. Results aggregated from each completed file:

- **225 passed**
- **0 failed**
- **1 skipped**: browser end-to-end navigation was skipped because this sandbox blocks navigation to its own loopback HTTP server (`ERR_BLOCKED_BY_ADMINISTRATOR`).
- Real custom PDF generation, real PDF layout, renderer lifecycle, report pipeline, scheduled execution with email test doubles, auth, import, multi-organisation isolation, filter calculations and API tests passed in the individual file runs.
- All project JavaScript was syntax-checked after the release changes.
- A 5,000-row synthetic enterprise CSV had previously passed the preview/import/analytics/PDF integration smoke path; this is synthetic demo verification, not evidence of real business accuracy.

## Checks that could not be completed here

- `npm audit --audit-level=moderate` could not reach `registry.npmjs.org` (`EAI_AGAIN`), so advisory status is **unknown**, not clean.
- This container uses Node 22.16.0 although the package requires Node 24+. The end-to-end acceptance must be rerun on Node 24.21.0 in Windows/CI.
- The monolithic `npm test` process does not consistently exit after browser-heavy tests in this sandbox; each of the 31 test files completed when executed in isolation. The user's Windows run should use the package script sequentially and capture its final summary.
- Live Google OAuth, GitHub push, Render deployment, external URL verification, backup/restore testing, and LinkedIn publication have not occurred.
- No independent security penetration test has been performed. Public registration, account recovery, user deletion/retention, privacy terms and operational backup policies should be reviewed before handling real customer/company data.

## Release blockers before claiming public launch

1. Run `npm ci` and `npm test` on Node 24.21.0 in a clean Windows environment or GitHub Actions, with every skipped test explained.
2. Run `npm audit --audit-level=moderate` with registry access and update vulnerable dependencies only with regression testing.
3. Verify account signup/login/logout, header alignment, all filters, custom CSV preview, actual PDFs, and cross-organisation isolation in a real browser.
4. Review `.env` locally and configure production-only secrets via the hosting provider. Do not copy `.env` into the ZIP/repository.
5. Inspect the canonical GitHub remote/branch and its history before committing. Never force-push or replace unexpected history.
6. Create paid hosting only after explicit budget approval. Verify the actual deployed homepage, `/health`, PDF generation/preview/download, secure auth, persistent files after restart/redeploy, and external access before sharing a public link.
