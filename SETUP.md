# ExecuBrief Dashboard — local setup

ExecuBrief serves one browser dashboard and the existing reporting API from the same Express process. The browser demo reads synthetic records from its own SQLite database and writes demo PDFs to a separate directory. It does not send email or invoke the scheduler.

## Requirements

- Node.js 24.x (the code uses the built-in `node:sqlite` module)
- npm
- Chrome/Chromium for PDF rendering. `npm ci` installs the Puppeteer-managed browser; see [Browser setup in README](README.md#browser-setup) if the browser install was skipped.

## Start on Windows PowerShell

Run these commands one at a time from the project root (the folder with `package.json`):

```powershell
node --version
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
node scripts/init-demo.js
npm test
npm start
```

Open `http://127.0.0.1:3000/`. Stop the server with `Ctrl+C`.

`init-demo.js` initializes only `DEMO_DATABASE_PATH` and `DEMO_REPORTS_DIR`. It is idempotent, does not seed or reset `DATABASE_PATH`, does not clear any existing reports, and refuses an existing demo database that lacks the synthetic-data marker. If you already have a `.env`, this guide does not overwrite it; confirm its paths before startup.

For local default settings, the private reporting database is `data/report.db` with output in `reports/`. The public demo database is `demo-data/demo-report.db` with output in `demo-data/reports/`. Keep these separate. Relative paths are resolved from the project root. Email and the scheduler are disabled by default.

## Dashboard workflow

- Overview KPI figures, trends, daily summaries, and product rankings are calculated from the selected date range through SQL analytics.
- Choose a start and end date, then generate a report. Valid periods are limited to 93 days.
- A successful result corresponds to a report record and a PDF produced by Puppeteer, not a placeholder response.
- Recent reports offer an embedded PDF preview and a separate PDF download.
- Browser demo routes (`/api/analytics`, `/api/reports`, `/api/reports/generate`) use only synthetic demo storage and force email off.
- Private/admin routes (`/reports`, `/reports/:id`, `/reports/:id/file`) use the private reporting storage and require the bearer token when configured. Production and non-loopback binding require `API_AUTH_TOKEN`.

## Useful commands

```powershell
npm run demo:init  # Same safe, repeatable demo initialization
npm test           # Full sequential test suite
npm run report     # Existing CLI report generator (private database)
```

Do not use the private seed command as a shortcut for demo initialization. Do not put real credentials into frontend files or a committed file. `.env` is ignored by Git; `.env.example` contains placeholders only.

## Troubleshooting

**Node version error:** install Node.js 24.x, then reopen PowerShell and verify `node --version`.

**Port already in use:** set a different `PORT` in `.env`, then browse to that port.

**Puppeteer cannot launch Chrome:** run `npx puppeteer browsers install chrome` or configure `PUPPETEER_EXECUTABLE_PATH` to an installed Chrome/Chromium. `PUPPETEER_NO_SANDBOX=true` is intended for isolated container environments, not ordinary Windows use.

**Demo database refused:** the configured existing demo database does not have the ExecuBrief synthetic marker, or the demo/private storage paths overlap. Do not delete the file blindly; point `DEMO_DATABASE_PATH` at a new, dedicated demo path after inspecting your configuration.

See [docs/CUSTOM_REPORTING_AND_AUTH.md](docs/CUSTOM_REPORTING_AND_AUTH.md) for the additive private CSV-to-PDF workspace, email/password sign-in, optional Google OAuth setup, storage isolation, and phased implementation notes. See [README.md](README.md) for CLI reporting, CSV import, email, API contracts, and existing tests, and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for hosted deployment preparation.
