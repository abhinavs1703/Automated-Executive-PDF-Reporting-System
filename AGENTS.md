# ExecuBrief — Agent Instructions

These instructions apply to AI coding agents working anywhere in this repository, including Google Antigravity.

## Project purpose

ExecuBrief is an executive reporting application. It supports organisation workspaces, CSV-based data ingestion and validation, business analytics, dashboard views, and PDF report generation. Preserve the existing application and improve it incrementally; do not replace it with a new scaffold.

## Read before changing code

Before making changes, inspect the relevant implementation and tests, and consult:
- `README.md`
- `SETUP.md`
- `FINAL_AUDIT_SUMMARY.md`
- Relevant files under `docs/`

Do not assume documentation proves a live integration works. Distinguish implementation, automated-test coverage, and real deployment verification.

## Architecture and run modes

- The project requires Node.js 24 or later (see `package.json` and `.node-version`).
- Local development uses `npm start` and `src/server.js`, with the SQLite-backed local application.
- Cloud mode uses `npm run start:cloud` and `src/cloud-server.js`, with the Supabase-backed cloud application.
- Keep local SQLite and cloud/Supabase paths intentionally separate. Do not silently merge, replace, or change their storage semantics.
- Review both the local and cloud implementation when changing shared behavior, authentication, organisation boundaries, CSV processing, or report generation.
- The dashboard client lives under `dashboard/public/`; report templates live under `templates/`; Supabase migrations live under `supabase/migrations/`.

## Non-negotiable safety and data rules

- Preserve strict organisation-level data isolation. Never expose one organisation's users, imports, analytics, or reports to another organisation.
- Never commit, print, or expose values from `.env`, API keys, OAuth secrets, Supabase secret keys, tokens, private databases, or generated business reports.
- Use `.env.example` for documented placeholders only. Do not create real credentials or invent values.
- Do not weaken authentication, authorisation, upload validation, path validation, or storage access controls to make a test pass.
- Do not run destructive database reset, seed-with-force, migration rollback, or data deletion commands unless the user explicitly approves the exact operation.
- Treat uploaded CSV content and report data as untrusted input. Preserve validation and output escaping.

## Development workflow

1. Start by checking the current Git branch and working-tree status. Do not overwrite or discard user changes.
2. Before a multi-file change, provide a short implementation plan and identify the affected modules and tests.
3. Prefer small, integrated changes over broad rewrites or isolated patches.
4. Preserve the existing dashboard structure, visual identity, navigation, and working interactions unless the user explicitly requests a design change.
5. Do not add dependencies or change major versions unless there is a clear need; explain the impact first.
6. Do not commit, push, merge, force-push, or modify the `main` branch unless the user explicitly asks for that Git operation. Work on a feature branch by default.
7. Review the resulting diff for unintended changes before reporting completion.

## Verification

Check the installed Node version before running project commands. Use the repository's existing scripts:
- `npm ci` — install the locked dependencies.
- `npm test` — full automated test suite.
- `npm run test:real` — real-browser/PDF verification; a real browser is required.
- `npm run audit` — dependency security audit.
- `npm start` — start local SQLite mode.
- `npm run start:cloud` — start Supabase cloud mode when the required cloud environment is configured.

For changes to CSV ingestion, authentication, organisation access, analytics, dashboard behavior, or PDF rendering, run the relevant focused tests and the broadest practical regression checks. Do not describe skipped tests as passed. Do not claim live Supabase, OAuth, email, or hosting verification unless it was actually exercised against the configured service.

## Completion report

When finishing a task, report:
- What changed and why.
- Files and modules affected.
- Commands and tests run, with pass/fail/skip status.
- Any remaining risks or steps that require the user's credentials or local environment.

Keep explanations beginner-friendly and give Windows PowerShell commands when local setup instructions are needed.
