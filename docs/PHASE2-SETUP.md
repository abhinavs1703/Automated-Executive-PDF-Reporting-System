# ExecuBrief Phase 2 — Windows Setup and Acceptance

## What Phase 2 adds

The root URL `/` remains the existing public synthetic-data Overview. After signing in, open `/workspace` for the organisation-specific Executive Pulse dashboard. Use `/custom-reports` for an individual CSV-to-PDF report. Existing Overview markup/styles/scripts were not modified in Phase 2.

The organisation workspace supports one CSV at a time; each successful import adds validated rows to the organisation's cumulative SQLite data. Import history tracks successful, partial, duplicate and failed attempts. Charts and KPIs are recalculated for the selected dates. Organisation reports use all imported rows in the workspace for the selected date window.

CSV expectations: UTF-8 CSV; date, amount/revenue, and product are required mappings; 5 MB / 50,000 rows by default. An optional currency column is detected. One organisation workspace uses one reporting currency; ExecuBrief does not convert currencies. For reports, choose dates in the detected source range, up to 93 days per PDF. Custom one-off reports auto-suggest the latest 93 days when the CSV spans a longer period.

## Safely merge the source archive

1. Stop ExecuBrief with `Ctrl+C` in its server terminal.
2. Download `execubrief-phase2-complete.zip` to your Downloads folder.
3. Extract it into a new staging directory, not over the running project.
4. Back up the project source. Keep the real `.env`, `.git`, database files, generated PDFs and report folders.
5. Merge the staged source into the project, excluding local state. Example PowerShell commands (run one by one):

```powershell
$Project = "$HOME\OneDrive\Desktop\LinkedIn_Projects"
$Stage = "$HOME\OneDrive\Desktop\ExecuBrief_Phase2_Staging"
$Backup = "$HOME\OneDrive\Desktop\LinkedIn_Projects_Backup_Phase2"

if (Test-Path $Backup) { throw "Backup path already exists. Choose a new backup name." }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
Expand-Archive -LiteralPath "$HOME\Downloads\execubrief-phase2-complete.zip" -DestinationPath $Stage -Force
robocopy $Project $Backup /E /XD node_modules
robocopy $Stage $Project /E /XD node_modules .git data demo-data custom-data reports /XF .env *.sqlite *.db *.pdf
```

`robocopy` exit codes 0–7 indicate that the file copy completed without a fatal error; 8 or higher indicates a copy failure. If any command fails, stop and review it before continuing. These copy commands do not delete destination files.

## Install and run

Use Node.js 24.21.0 or another compatible Node 24+ release. Open PowerShell in the project directory and execute commands separately:

```powershell
Set-Location "$HOME\OneDrive\Desktop\LinkedIn_Projects"
node --version
npm.cmd ci
npm.cmd test
npm.cmd start
```

If Puppeteer reports that Chrome/Chromium is missing, install its managed browser:

```powershell
npx.cmd puppeteer browsers install chrome
```

Restart `npm.cmd start` afterward. The Linux-only setting used in this sandbox (`PUPPETEER_NO_SANDBOX=true`) is not generally needed on a regular Windows desktop and should not be copied blindly into production.

Open these pages while the server is running:

- `http://127.0.0.1:3000/` — public synthetic Overview with its original visual identity plus date presets, filters and right-aligned account actions
- `http://127.0.0.1:3000/signup` — create an account and organisation
- `http://127.0.0.1:3000/workspace` — cumulative organisation analytics/imports/reports
- `http://127.0.0.1:3000/custom-reports` — one-file custom PDF workflow

## Acceptance checklist

- Register an account with an organisation name and sign out/in again.
- On `/custom-reports`, preview the enterprise sample CSV. Confirm date coverage is `2025-10-01`–`2026-09-30`, USD is detected, and the latest 93-day range is suggested. Generate and download the PDF.
- On `/workspace`, import the sample CSV. Confirm 5,000 rows are recorded and the dashboard's date coverage matches the imported rows.
- Import a second CSV with unique line item IDs and confirm analytics are cumulative and import history shows both files.
- Try importing a CSV in a different currency to an already-established workspace. The UI should clearly block it; the server should reject it even if called directly.
- Generate an organisation report; preview and download its PDF.
- Register another organisation and confirm it has no access to the first organisation's data, import history or report files.
- Confirm that a malformed CSV provides actionable feedback rather than leaving a disabled button with no explanation.
- Run the tests and retain the output. The tool environment's one interactive browser test was skipped because its browser sandbox blocked local navigation; check it on Windows.

## Google sign-in

Google sign-in is optional. Add the Google OAuth client ID and secret to `.env` and register the callback for the chosen base URL, e.g. `http://127.0.0.1:3000/auth/google/callback` for local testing. Keep secrets server-side. The implementation's route/token-verification tests are automated, but a full live Google authorization round-trip still requires your actual client credentials.

## Notes before publishing

Do not upload `.env`, auth/workspace SQLite databases, imported private CSV data, generated PDFs, or `node_modules`. No commit/push or public hosting was done as part of Phase 2. Verify a clean install and tests on Windows first; review hosting cost/persistence and approve any paid infrastructure before provisioning.
