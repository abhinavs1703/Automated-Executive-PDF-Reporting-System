# ExecuBrief — Final Release, Verification, GitHub and Hosting Guide

This guide is for the release candidate in this archive. It is deliberately conservative: a ZIP is not the same thing as a verified deployment, and the app should not be described as production-ready until the real deployment checks in this document have passed.

## 1. What is in this release candidate

- Existing public synthetic-data Overview at `/`, retaining the navy/teal brand and existing core page composition.
- Right-aligned top-bar account controls: sign-in/create-account while signed out; account name/organisation, workspace links and sign-out while signed in.
- Public overview period picker with 7/30/90-day presets; product search/category/sort; report-history search/status filters.
- Email/password account flow, organisation workspaces, secure session/CSRF/origin checks and optional server-side Google OAuth.
- Organisation CSV import history, row/date-range preview, deduplication/validation, cumulative imports, 7/30/90 date presets, category and region analytics filters, business signals and organisation-level report generation.
- One-file Custom PDFs flow, report history, real Puppeteer PDF output, inline preview and download.
- Express health route, separated synthetic demo storage, private reporting routes, rate limiting and concurrency controls.
- Windows-friendly npm scripts, Node test suite, GitHub Actions workflow and native Node.js Render Blueprint.

The demo dataset in `examples/enterprise-demo.csv` is synthetic. Do not use it as evidence of real commercial performance.

## 2. Requirements and safe working folder

- Windows: use Node.js **24.21.0** (the package declares Node `>=24.0.0`), npm, Git and a working Chrome for Testing/Chrome/Chromium installation for real PDF generation.
- Create one project directory, for example `C:\Users\<you>\OneDrive\Desktop\Recent projects\Exec_pdf_report`.
- Extract this archive so `package.json` sits directly inside that directory alongside `src`, `dashboard`, `scripts`, `test`, `templates`, `docs`, and `examples`. Avoid a nested `project\project\package.json` layout.
- Keep the real `.env` out of the ZIP/Git. Copy `.env.example` to `.env` only if a `.env` does not already exist; do not overwrite a working `.env`.
- Do not place `.env` in `src` or `dashboard`.

## 3. Windows install and test workflow

Open PowerShell in the project root and verify the location before doing anything:

```powershell
Get-Location
Test-Path .\package.json
Test-Path .\package-lock.json
node --version
npm --version
```

Both path checks should be `True`; Node should be v24.x. If PowerShell blocks `npm.ps1`, use `npm.cmd` instead of changing the machine-wide execution policy.

Install pinned dependencies:

```powershell
npm.cmd ci
```

If Puppeteer did not acquire a browser during installation, install Chrome explicitly:

```powershell
npx.cmd puppeteer browsers install chrome
```

Ensure `.env` exists, without replacing an existing file:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

Before initializing, review the *path settings only* in `.env` (`DATABASE_PATH`, `REPORTS_DIR`, `AUTH_DATABASE_PATH`, `CUSTOM_DATA_DIR`, `DEMO_DATABASE_PATH`, `DEMO_REPORTS_DIR`). Do not paste secrets into chat. Relative data paths are resolved against the project root, regardless of the PowerShell current directory. Keep the private, auth, custom workspace, and demo paths separate.

Initialize **only** synthetic demo storage, then run tests:

```powershell
npm.cmd run demo:init
npm.cmd test
```

`demo:init` is designed to be repeatable and must not seed/reset the private database. The test script runs sequentially because the PDF tests start browser processes. Review the TAP totals and every skipped test; a skipped test is not a pass. The browser journey (`test/custom-browser-flow.test.js`) should run on a normal local machine with a working browser; if it is skipped, check the reason.

Start the service:

```powershell
npm.cmd start
```

Open `http://127.0.0.1:3000/`; keep the terminal open. Stop it with `Ctrl+C`. Health should return `200` at `http://127.0.0.1:3000/health`.

## 4. Acceptance checklist (must be completed on the target PC)

1. `GET /` returns the public HTML page and the title `ExecuBrief — Executive Reporting`.
2. `/health` returns HTTP 200.
3. Signed out, the right side of the top bar shows Sign in/Create account. Register a **test** organisation with a unique test email; after signup it should open `/workspace`.
4. Return to `/`; right-side account menu should show the signed-in user/organisation and link to the workspace and Custom PDFs. Sign out and verify the menu reverts.
5. Import `examples/enterprise-demo.csv` into that test organisation. Confirm the preview dates, accepted/invalid/duplicate row counts, and workspace currency before confirming import.
6. Check that dashboard metrics, line/category/region visuals and Business Signals respond to the chosen period/category/region filters.
7. Import the same file again; verify duplicates are not counted twice and import history explains the outcome.
8. Generate a workspace PDF and a one-file Custom PDF. Confirm completed status, history, preview content type `application/pdf`, downloaded file starts with `%PDF-`, and PDF figures reconcile with the selected filters/period.
9. Create a second test organisation and verify it cannot see the first organisation's analytics, imports or reports.
10. Confirm public `/` analytics use synthetic demo storage and a public request cannot enable email/scheduling.
11. Test invalid dates, reversed dates, ranges longer than 93 days, invalid CSV mappings, missing PDF files and unauthenticated workspace/API requests.
12. Restart the app; local account/workspace/report data should remain present (provided the configured storage paths are unchanged).

Do not use real business/customer data for the public demo until access control, backup, privacy and deployment have been reviewed for your actual requirements.

## 5. Configuration and secrets

- `API_AUTH_TOKEN` must be a long random value in production and remains server-side. Never put it in front-end code or a commit.
- Google sign-in is optional. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` server-side. Add the exact HTTPS callback `https://<actual-host>/auth/google/callback` and the actual host origin in Google Cloud Console. Test the full OAuth callback; having the code alone does not mean Google sign-in is live.
- Resend email and schedule execution remain disabled in the Render template. Only turn these on after setting and testing the verified sender, recipients, API key, timezone and scheduling policy.
- Do not publish `.env`, local SQLite databases, generated PDF reports, logs, `node_modules`, or real imports. `.gitignore` excludes these. Check `git status --ignored` and use a secret scanner before pushing.

## 6. GitHub release workflow

Authorised repository from the project requirements:

`https://github.com/abhinavs1703/Automated-Executive-PDF-Reporting-System.git`

Before using Git:

```powershell
git --version
git ls-remote https://github.com/abhinavs1703/Automated-Executive-PDF-Reporting-System.git
```

If `git ls-remote` returns refs, the remote already has history. Do **not** force-push or replace history. Clone the repository to a separate review folder and merge the release into it, resolve conflicts, run `npm ci` and `npm test`, then commit/push a reviewed branch or pull request. If it has no refs and you have write permission, you may create an initial commit on `main` after reviewing `git status --short`, confirming `.env`/DB/PDFs are absent, running tests and `npm audit` with working network. Never commit `.env`.

If GitHub CLI/authentication is unavailable, connect GitHub in your client or authenticate Git locally; do not paste tokens into chat. Verify the commit SHA and remote after pushing. The supplied ZIP itself is not a Git repository and contains no original history.

## 7. Render native Node.js deployment

The included `render.yaml` is deployment preparation; it does not create a service by itself. Do not select **Apply/Create** until you have approved the current monthly cost shown by Render.

1. Push the reviewed source (without secrets/DBs/report files) to the authorised GitHub repository.
2. In Render, choose **New → Blueprint** and connect only that repository. Review `render.yaml`, runtime, build command (`npm ci`), start command (`npm start`), health path (`/health`) and the persistent disk before applying.
3. The blueprint mounts persistent storage at `/var/data` and points these paths into it: private DB/reports, auth database, organisation custom-data root, demo database and demo reports. Do not change these back to ephemeral project-relative paths in production.
4. The blueprint generates `API_AUTH_TOKEN`, disables email and scheduling, and sets `PUPPETEER_NO_SANDBOX=true` for headless container rendering. Validate that Puppeteer/Chrome starts on the actual selected image. Do not assume a successful local Windows render proves the Render browser runtime works.
5. Once Render creates the actual hostname, configure Google OAuth callback/origins and other secrets in Render's environment settings, not in source files.
6. Verify the actual public homepage, `/health`, account registration/login, CSV import, analytics filters, PDF generation, preview/download, authentication, a second organisation's isolation, and persistence across a controlled restart/redeploy. Inspect logs for secrets/path disclosure.
7. Test backup/restore of persistent data before using real records. One SQLite-backed instance and its persistent disk are a simple demo deployment, not a high-availability multi-instance architecture.

The current Blueprint selects a `1c-2g` paid service and a 1 GB disk. Render's published compute table currently lists `1c-2g` at approximately **US$25/month**, and persistent disks at **US$0.25/GB/month**. With a 1 GB disk, the approximate compute+disk total is **US$25.25/month**, before workspace-plan fees, outbound bandwidth beyond included usage, taxes, or other charges. Verify the complete current price in Render immediately before creating resources. Free instances spin down and do not provide persistent disks suitable for preserving SQLite/PDF data. Do not activate paid hosting without explicit budget approval.

## 8. LinkedIn portfolio post

Only add the real GitHub repository link after the push is verified, and only add a public website link after the public deployment has passed the deployment acceptance checklist. Never use `localhost` as a portfolio link or invent a Render hostname. LinkedIn publishing remains a manual user action in this workflow.

Suggested post text (replace the two placeholders after verification):

> I’ve been building ExecuBrief, an executive reporting app that turns sales CSVs into organisation-specific analytics dashboards and PDF briefs.
>
> Key capabilities include organisation workspaces, cumulative CSV imports with duplicate validation, date/category/region filters, revenue and order trends, data-derived business signals, PDF preview/download, and an Express/SQLite/Puppeteer reporting pipeline.
>
> I focused on data isolation, input validation, report-generation failure handling and repeatable tests as well as the interface.
>
> Source: <verified GitHub repository URL>
> Live demo: <verified public URL>
>
> The demonstration dataset is synthetic.

## 9. Important release caveats

A test suite cannot prove a system is “foolproof.” Before real-world use, complete all local acceptance items above, `npm audit --audit-level=moderate` with network access, the deployment checks, backups/restore, Google OAuth end-to-end verification if enabled, and a manual security review. Public registration currently creates a workspace; if the app will store real business data, decide whether email verification, password reset, account recovery, retention/deletion controls and a privacy policy are needed before public launch.
