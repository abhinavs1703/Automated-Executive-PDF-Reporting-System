# ExecuBrief — private organisation reporting

## Current scope

The public Overview preserves the original navy/teal visual identity and continues to use synthetic demo data; it now includes right-aligned account controls, quick date ranges, and product/report filters. Signup now collects an organisation name and creates an organisation with the first member as owner. Sessions carry the organisation context, and the custom report library, report records, PDFs and per-job SQLite data are stored under that organisation's ID. Data from different organisations is not intentionally shared.

## Phase 1 — authentication and tenant foundation

The prior `Internal server error` during signup/sign-in was caused by `src/auth-store.js` referencing `config` without importing it during file-backed auth database initialization. This is fixed in the Phase 1 source. Registration and login should return meaningful validation/authentication errors rather than the generic server error. Authentication continues to use server-side salted `scrypt` password hashing, opaque HTTP-only session cookies, CSRF checks for state-changing requests, same-origin checks and rate limiting.

The auth database adds `organizations` and `organization_memberships` and adds organisation references to sessions/custom reports through additive migrations. Existing users are assigned personal workspaces and old report records are backfilled; these steps do not intentionally delete old account/report rows.

## Phase 2 — organisation analytics/data hub (implemented; Windows acceptance remains required)

- Upload CSV files one by one into the active organisation's dataset.
- Validate rows/columns/dates, show available date coverage, and track import history, added rows, skipped duplicates, invalid rows and data freshness.
- Aggregate accepted rows across imports for the organisation dashboard.
- Use imported data for KPIs, trends, comparisons, rankings and evidence-based business signals.
- Category and region filters are applied server-side to the dashboard analytics and organisation report-generation data.
- Retain public synthetic Overview routes and isolate private organisation data, report metadata and generated files.
- Run multi-organisation access tests, full HTTP/report tests and Windows visual workflow checks before public release.

## Google sign-in

The server-side OAuth flow remains optional and cannot be verified against Google without the user's own OAuth client ID/secret and an exact callback URL. Add credentials only to `.env`; never to browser code or source control. For localhost use `http://127.0.0.1:3000/auth/google/callback` in both the Google Cloud authorized redirect URI list and `GOOGLE_REDIRECT_URI`. Use the hosted HTTPS callback URL for deployment.

## Local verification (Windows PowerShell)

```powershell
node --version
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run demo:init
npm.cmd test
npm.cmd start
```

Use Node.js 24.21.0 (or the project-declared Node 24+ version). Open `http://127.0.0.1:3000/`; use `/signup` to register an organisation, then `/login` for subsequent visits. The organisation dashboard is at `/workspace`; the one-file Custom PDFs screen remains at `/custom-reports`. Keep `.env`, databases, reports and `custom-data` out of source control.

For the complete final acceptance, GitHub safety, Render persistence/cost and LinkedIn checklist, see [FINAL_RELEASE_GUIDE.md](FINAL_RELEASE_GUIDE.md).
