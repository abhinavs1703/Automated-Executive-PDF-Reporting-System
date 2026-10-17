# Automated Executive PDF Reporting System

A modular Node.js backend that turns weekly business data into an executive PDF report and can email it through [Resend](https://resend.com).

**Pipeline:** SQL → JSON → Handlebars HTML + Chart.js → Puppeteer PDF → Resend email with PDF attachment → (optional) weekly schedule

## Relationship to the upstream repository

Inspired by [`Mohamed-Ahmed007062/PDF-report-generator`](https://github.com/Mohamed-Ahmed007062/PDF-report-generator) (cloned and compared at commit `c460ddf`).
**This package is a standalone re-implementation, not a modification of the upstream repo, and nothing has been pushed to it.**
Upstream uses Playwright, an in-code HTML template, an in-process job queue (`POST /reports/async`, 202 responses) and same-day report reuse with a `force` flag. This project uses Puppeteer, a separate Handlebars template, Chart.js, Resend, and the email-idempotency design below. Upstream features **not** ported here: the async queue endpoint, same-day report reuse, the full order-detail table, the Postman collection and the `ai-version/` folder. To land this work in the upstream repository you need push access (or a fork) and a decision on whether to replace or merge those modules.

## Requirements

- Node.js **24+** (uses `node:sqlite`). The current repair session used Node 22.16.0, below the package requirement; run the documented install and tests on Node 24.21.0 before relying on the Windows setup.
- npm and Git.
- A Chrome/Chromium browser for PDF rendering (see [Browser setup](#browser-setup)).
- A Resend account and API key, only for live email (see [Email with Resend](#email-with-resend)).

## Quick start

```bash
git clone <your-repository-url>
cd executive-pdf-report
npm ci                               # installs from package-lock.json and installs Puppeteer's browser
# PowerShell: if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm run demo:init                    # safe synthetic demo database only
npm test                             # full test suite
npm start                            # http://127.0.0.1:3000
```

Generate a report from the command line (writes a PDF to `reports/`):

```bash
npm run report              # previous complete Mon–Sun week, no email
npm run report -- --start 2026-10-05 --end 2026-10-11   # a specific period (both dates, YYYY-MM-DD)
npm run report -- --email   # also send via Resend (needs RESEND_API_KEY, EMAIL_FROM, EMAIL_TO)
```

**Have your own sales data in Excel?** Skip the sample seed and follow [Importing your own sales data](#importing-your-own-sales-data-csv--excel).

## Interactive ExecuBrief dashboard

The root page (`/`) is a responsive browser dashboard served by the same Express process as the reporting API. Its KPIs, date-trend charts, daily summary, product ranking, report history, PDF preview and download all use server responses. Demo endpoints (`/api/analytics`, `/api/reports`, `/api/reports/generate`) access only synthetic demo storage at `demo-data/demo-report.db` and `demo-data/reports/`; demo generation cannot send email or run the scheduler. Demo setup is safe to repeat:

```powershell
node scripts/init-demo.js
npm start
```

Open `http://127.0.0.1:3000/`. Private/admin APIs remain at `/reports` and use `API_AUTH_TOKEN` when configured. Production always requires that token. Do not expose private API routes publicly without production authentication. See [SETUP.md](SETUP.md) for the dashboard workflow, [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for hosting preparation, [docs/CUSTOM_REPORTING_AND_AUTH.md](docs/CUSTOM_REPORTING_AND_AUTH.md) for CSV/auth setup, and [docs/FINAL_RELEASE_GUIDE.md](docs/FINAL_RELEASE_GUIDE.md) for final acceptance testing, safe GitHub publication, Render persistence/costs and the LinkedIn checklist.

All commands work from any directory when given the path (`node /path/to/repo/scripts/seed.js`); paths are anchored to the repository, not the working directory, and relative `DATABASE_PATH`/`REPORTS_DIR` values are resolved from the repository root.

## Private organisation analytics (Phase 2)

After creating an account at `/signup`, open `/workspace` for the organisation-specific **Executive Pulse** dashboard. The workspace supports cumulative, one-file-at-a-time CSV imports, detected date coverage, period filters, revenue/order/AOV/customer metrics, conditional profit analytics, category/region charts, data-derived Business Signals, import history and PDF generation from all imported rows for the selected period. `/custom-reports` remains available for a one-off upload and customized PDF.

The public `/` Overview retains the original navy/teal brand and familiar layout, with improved responsive top-bar account controls, quick date presets, product filters, report search/status controls, and reduced-motion-aware transitions. Private uploaded data lives in a marked, per-organisation SQLite workspace under `CUSTOM_DATA_DIR` and is not read by public demo endpoints. Uploads must map Date, Amount/Revenue and Product. The default limits are 5 MB / 50,000 rows and PDFs are limited to 93 days. A workspace uses a single currency; currency mismatches are rejected (no FX conversion is performed). Review [docs/PHASE2-SETUP.md](docs/PHASE2-SETUP.md) for the Windows merge/acceptance steps and [docs/PROJECT_AUDIT.md](docs/PROJECT_AUDIT.md) for the verified changes and limitations.

## Browser setup

Puppeteer needs a Chrome/Chromium. Pick one:

| Situation | What to do |
|---|---|
| Normal machine | `npm install` downloads Chrome for Testing automatically. If it was skipped: `npx puppeteer browsers install chrome` |
| Use an existing browser | Set `PUPPETEER_EXECUTABLE_PATH=/path/to/chrome` in `.env` |
| Windows | Nothing extra is normally needed; `npm install` downloads Chrome for Testing (`PUPPETEER_NO_SANDBOX` is not needed) |
| Docker / CI / running as root | Also set `PUPPETEER_NO_SANDBOX=true` (disables Chrome's sandbox; only do this in an isolated container) |
| Linux missing shared libraries | Install Chrome's dependencies, e.g. on Debian/Ubuntu `sudo npx puppeteer browsers install chrome --install-deps` or the distro's `chromium` package |

If the browser cannot start, report generation fails with an actionable message and the report record is marked `failed` (stage `render`).

## Configuration (`.env`)

See [`.env.example`](.env.example) for every variable with comments. Highlights:

| Variable | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Bind address. Non-loopback requires `API_AUTH_TOKEN` |
| `API_AUTH_TOKEN` | empty | Bearer token for all endpoints except `/health` (≥16 chars). **Required** when `NODE_ENV=production` or `HOST` is not loopback |
| `DATABASE_PATH`, `REPORTS_DIR` | `data/report.db`, `reports` | Private reporting data; relative to repo root |
| `DEMO_DATABASE_PATH`, `DEMO_REPORTS_DIR` | `demo-data/demo-report.db`, `demo-data/reports` | Synthetic public demo storage, strictly separate from private paths |
| `PUPPETEER_EXECUTABLE_PATH`, `PUPPETEER_NO_SANDBOX`, `PDF_CHART_TIMEOUT_MS` | empty, `false`, `15000` | Browser control |
| `ENABLE_SCHEDULER`, `REPORT_CRON_SCHEDULE`, `REPORT_TIMEZONE` | `false`, `0 8 * * 1`, `UTC` | Weekly schedule (off by default) |
| `EMAIL_ENABLED` | `false` | Whether **scheduled** runs send email; manual requests use `sendEmail` |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TO` | empty | Resend credentials and addresses; `EMAIL_TO` may hold several comma-separated recipients (max 50) |
| `EMAIL_CLAIM_TIMEOUT_MS` | `600000` | When an abandoned "sending" claim may be retried |
| `IMPORT_MAX_FILE_MB`, `IMPORT_MAX_ROWS` | `5`, `50000` | Largest CSV file (MB) and most data rows per import |
| `STALE_REPORT_AFTER_MS` | `900000` | Startup cleanup threshold for stuck `pending` reports |

Secrets live only in `.env` (git-ignored). `.env.example` contains placeholders only.

## API

Private `/reports` endpoints require `Authorization: Bearer <API_AUTH_TOKEN>` when a token is configured (and always in production). The public `/api/*` dashboard endpoints expose synthetic demo data only and do not expose private reports.

| Method & path | Description |
|---|---|
| `GET /health` | Liveness probe, always open |
| `GET /` | Interactive dashboard HTML |
| `GET /api/config` | Public display options only |
| `GET /api/analytics?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` | SQL analytics from the synthetic demo database |
| `GET /api/reports` | Recent reports from the synthetic demo database |
| `POST /api/reports/generate` | Generate a real PDF from synthetic data; email is always disabled |
| `GET /api/reports/:id` | Demo report status |
| `GET /api/reports/:id/file` | Inline PDF preview from demo storage |
| `GET /api/reports/:id/download` | PDF download from demo storage |
| `POST /reports` | Generate a private report. Body (all optional): `startDate`, `endDate` (`YYYY-MM-DD`, both or neither, ≤93 days), `sendEmail` (bool), `resendEmail` (bool), `idempotencyKey` (or header `Idempotency-Key`) |
| `GET /reports` | Latest 50 reports |
| `GET /reports/:id` | Status: `status`, `emailStatus`, `error`, `errorStage`, `emailError`, period |
| `GET /reports/:id/file` | Download the PDF (`409` unless completed) |

Status codes: `201` created · `400` invalid input · `401` missing/invalid token · `404` unknown report/file · `409` not ready · `413` body too large · `500` generation failed (body includes `reportId` and `stage`) · `502` PDF created but email delivery failed.

```bash
curl -X POST http://127.0.0.1:3000/reports \
  -H "Authorization: Bearer $API_AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"startDate":"2026-09-28","endDate":"2026-10-04","sendEmail":true}'
```

### Statuses

- **Report `status`:** `pending` → `completed` | `failed`. A failure records `errorStage` (`analytics`, `render`, `finalize`, or `interrupted`) and `error`. Reports left `pending` by a crash are marked `failed/interrupted` at the next startup.
- **`emailStatus`:** `not_requested`, `pending`, `sent`, `failed`, `not_sent` (report failed before email), `skipped_duplicate`.
- Email is never attempted unless the PDF was generated successfully. An email failure never changes the report to failed, and is never shown as sent.

### Email idempotency

Each delivery has a key: by default `reporting period + recipient list`, or your own `Idempotency-Key`. Before calling Resend the service atomically claims the key in the `email_deliveries` table.

- Same key already `sent` → skipped (`skipped_duplicate`, `reason: already_sent`, `originalReportId`).
- Same key currently `sending` → skipped (`reason: in_progress`).
- Previous attempt `failed` → a retry is allowed.
- `resendEmail: true` deliberately overrides a previous send.
- A "sending" claim older than `EMAIL_CLAIM_TIMEOUT_MS` can be re-claimed.

Limitation: if the process dies after Resend accepts a message but before the ledger is updated, a later retry after the claim timeout may send again (at-least-once in that narrow window).

### Scheduler

`ENABLE_SCHEDULER=true` runs the weekly job in `REPORT_TIMEZONE`. Overlap is prevented (node-cron `noOverlap` plus an application-level lock; skipped ticks are logged). Scheduled emails go out only when `EMAIL_ENABLED=true` and are protected by the idempotency ledger, so a restart cannot re-send the same week.

## Report presentation

- **Money** is always `<CURRENCY> 1,234.50`: thousands separators and exactly two decimals (`en-US` formatting, independent of the server's locale), using the configured `REPORT_CURRENCY`. Negative amounts render as `-USD 5.00`; missing values render as `N/A`. Formatting is display-only (`src/format.js`); the SQL analytics values are untouched.
- **Period changes** render as `+12.5%`, `-23.1%` or `0%`; positive changes are teal and negative changes red. `N/A` is shown when the previous period's baseline is zero.
- **Layout:** page 1 is the header, KPI cards and the four charts. The *Top products* and *Daily summary* sections follow as unbreakable blocks (title, column headings and all rows stay together; they move to the next page as a unit if they do not fit). Daily summaries longer than 14 days (long custom periods) may span pages, with column headings repeated and rows never split.

## Importing your own sales data (CSV / Excel)

You can load your own sales from a spreadsheet, check it, store it in SQLite and generate the PDF from it. **The import never sends email, never starts the scheduler and never runs the sample seed.** Email stays a separate, manual step.

The workflow is always the same four steps:

1. **Export** your sheet as *CSV UTF-8*.
2. **Check** it with a dry run (nothing is written).
3. **Import** it for real.
4. **Verify** the stored data, then **generate the report**.

All commands are run in Windows PowerShell **from the project folder** (the folder that contains `package.json`):

```powershell
cd C:\path\to\executive-pdf-report
```

### 1. The CSV format

The first row must contain these column names (any order, upper or lower case is fine):

```
order_id,line_item_id,customer,product,amount,created_at,category
```

| Column | Meaning | Rules |
|---|---|---|
| `order_id` | The whole order. **Several rows may share one `order_id`** (an order with several products). | Required, up to 100 characters. Must not start with `LEGACY-` (reserved). |
| `line_item_id` | One product line of an order. Used to detect duplicates. | Required, **unique** across the file *and* the database, up to 100 characters. Compared exactly (`L-1` and `l-1` are different). Must not start with `LEGACY-`. |
| `customer` | Customer name or anonymised ID. | Required, up to 200 characters. |
| `product` | Product name. | Required, up to 200 characters. |
| `amount` | Revenue of this **line item**. | A plain number, 0 or more, at most 2 decimals (`49.99`, `12`, `0`). No currency symbols, no thousands separators, no negatives. |
| `created_at` | When the order was placed. | An ISO date `2026-10-05` or timestamp `2026-10-05T14:30:00Z` (a timezone offset such as `+02:00` is allowed). A timestamp with no timezone is treated as UTC; a date alone means midnight UTC. |
| `category` | Product category. | Required, up to 100 characters. |

Example (the second order has two product lines):

```csv
order_id,line_item_id,customer,product,amount,created_at,category
ORD-1001,L-1001-1,CUST-0001,Wireless Mouse,34.99,2026-10-05T09:15:00Z,Accessories
ORD-1002,L-1002-1,CUST-0002,Ultra-wide Monitor,449.00,2026-10-05,Displays
ORD-1002,L-1002-2,CUST-0002,"USB-C Cable, 2 m",12.90,2026-10-05,Accessories
```

Normal CSV rules apply: a value containing a comma or a line break must be wrapped in double quotes (`"USB-C Cable, 2 m"`), and a quote inside a quoted value is written twice (`"27"" monitor"`). UTF-8 text (accents, other alphabets), Windows line endings, a UTF-8 byte-order mark and blank lines are all fine. Extra columns are ignored with a warning. Please use anonymised customer IDs rather than real personal data.

### 2. Exporting from Excel

1. Make sure each money cell is a plain number (no `$`, no thousands separators; format the column as *Number* with 2 decimals).
2. Make the date column a text-like ISO date: select the column, **Format Cells → Custom**, type `yyyy-mm-dd`.
3. **File → Save As → Browse**, and choose the file type **CSV UTF-8 (Comma delimited) (\*.csv)**.
   *Do not* choose plain "CSV (Comma delimited)" (it uses a legacy encoding that corrupts accents) or "Unicode Text".
4. If Excel warns that only the active sheet will be saved, choose **Keep Format / OK**; a CSV holds one sheet.
5. Close the file in Excel before importing, so you import the version you saved (an open file can also be locked by Excel; the importer then asks you to close it).

Some regions make Excel use semicolons as separators; the importer detects this and tells you to re-save as *CSV UTF-8 (Comma delimited)*.

### 3. Try it with the sample file

`examples/sample-orders.csv` contains synthetic orders (no real customers) for the **previous complete Monday-Sunday week**: 12 orders in 18 line items, with several multi-product orders. It currently covers **2026-10-05 to 2026-10-11**. Run `npm run sample:csv` at any time to regenerate it for the *latest* previous week (the IDs contain the week, so samples from different weeks never clash). Then:

```powershell
npm run import:check -- examples\sample-orders.csv     # dry run: nothing is written
npm run import:orders -- examples\sample-orders.csv    # the real import
npm run orders:summary                                  # what is stored now
npm run report -- --start 2026-10-05 --end 2026-10-11   # PDF from the imported data
```

(`npm run import:orders` prints the exact `report` command with the right dates for your file.) Importing the same file a second time is harmless: it reports `Already in database 18` and changes nothing.

If you only want to try the project with made-up data and have **not** imported anything, `npm run seed` still works. It refuses to run once real data has been imported (see [Avoiding duplicates and data loss](#avoiding-duplicates-and-data-loss)).

### 4. Dry run, then the real import

```powershell
# 1) Dry run: validates the file, compares it with the database, writes nothing
npm run import:check -- "C:\Users\you\Documents\sales-october.csv"

# 2) If it says "RESULT: the file is valid", import it for real
npm run import:orders -- "C:\Users\you\Documents\sales-october.csv"
```

* Put the path in double quotes if it contains spaces. Relative paths work too: they are looked up from the folder you typed the command in, then from the project folder.
* Only existing `.csv` files are accepted (never `.env`, `.xlsx`, folders, …).
* The dry run opens the database **read-only**: it cannot change anything, and it does not even create `data\report.db` if it does not exist yet.
* The same thing without npm: `node scripts\import-orders.js --dry-run file.csv`. Extra options: `--all-errors` (list every problem instead of the first 25), `--max-rows <n>`, `--max-file-mb <n>`, `--help`.

What you will see:

```
  Data rows read                 18
  Valid rows                     18
  Rejected rows                   0
  Already in database             0   identical, skipped
  Newly imported rows            18   12 order(s), USD 2,570.21
  Orders in file                 12   (distinct order_id values, valid rows)

RESULT: imported 18 line item(s) in one transaction (import batch #1).
```

A file with mistakes is **rejected as a whole** (exit code 1) and tells you the row, column and fix:

```
PROBLEMS (3):
  Row 3     [amount] amount "-5" is negative; amounts must be 0 or greater.
  Row 5     [created_at] created_at "9/30/2026" is not a valid ISO date; use YYYY-MM-DD ...
  Row 6     [line_item_id] Duplicate line_item_id "L-1": it was already used in row 2. ...
RESULT: REJECTED. Nothing was imported. ...
```

Row numbers are the spreadsheet row numbers: the header is row 1, the first data row is row 2.

Exit codes: `0` success (including "nothing new") · `1` the file was rejected, nothing imported · `2` bad command or unreadable file · `3` database failure (the transaction was rolled back).

### 5. Verify the imported records and generate the report

```powershell
npm run orders:summary                                              # totals, import history, latest rows
npm run orders:summary -- --start 2026-10-05 --end 2026-10-11       # the same numbers the PDF will show
npm run report -- --start 2026-10-05 --end 2026-10-11               # writes the PDF into reports\
```

`orders:summary` is read-only. Compare its *line items*, *distinct orders* and *revenue* with your spreadsheet (row count, number of unique `order_id` values, sum of `amount`).

To generate the PDF through the API instead (`npm start` first; add an `Authorization` header if you set `API_AUTH_TOKEN`):

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/reports -ContentType 'application/json' `
  -Body '{"startDate":"2026-10-05","endDate":"2026-10-11"}'
```

Without `--start/--end` (or `startDate/endDate`) the report covers the previous complete week, so data from older weeks needs explicit dates. **Emailing a report is separate and manual**: add `--email` / `"sendEmail": true` only when you want it (see [Email with Resend](#email-with-resend)).

### How the numbers are calculated

Each CSV row is a **line item**. In the report:

* **Total orders** = number of *distinct* `order_id` values (not rows).
* **Total revenue** = sum of the line-item `amount`s.
* **Average order value** = total revenue ÷ total orders.
* **Orders by day** = distinct `order_id` values per day.
* **Revenue by product / category** = sum of that product's / category's line items.
* **Orders per product** = distinct orders containing that product (a product listed twice in one order counts once); its **Avg. order** = its revenue ÷ those orders.
* The **previous-period comparison** uses exactly the same definitions.

If the lines of one order carry different dates, the importer warns you (the order would be counted on each of those days).

### Avoiding duplicates and data loss

The import never silently creates duplicate sales and never overwrites existing data:

| Situation | What happens |
|---|---|
| `line_item_id` repeated **inside the file** | Every repeat is an error; the file is rejected. |
| `line_item_id` already in the database with **identical** data | Skipped and counted (`Already in database`). Re-running a file is safe. |
| `line_item_id` already in the database with **different** data | A *conflict*: the file is rejected and the stored row is untouched. Give genuinely new lines a new ID. |
| **Any** rejected row | The **whole file** is rejected; nothing is imported (all-or-nothing). |
| Failure while writing | One database transaction: it is rolled back completely, so a half-imported batch cannot exist. |

Good habits:

* **Always dry-run first** (`npm run import:check`).
* **Back up before importing** (copy the database; it is one file):
  `Copy-Item data\report.db data\report.backup.db`
* **Keep experiments separate**: set `DATABASE_PATH=data/test.db` in `.env` to use a different database.
* **`npm run seed` deletes every order.** Because of that it now refuses to run when imported data exists, unless you add `--force` (`node scripts\seed.js --force`), which erases everything on purpose.
* There is no "undo" command: to undo an import, restore your backup. Each import is recorded (file name, fingerprint, row counts) and visible in `npm run orders:summary`.

Limits (override in `.env`, or per run): files up to **5 MB** (`IMPORT_MAX_FILE_MB`) and **50,000 data rows** (`IMPORT_MAX_ROWS`).

Existing databases are upgraded automatically the first time they are opened by the new version (nothing to run). Old rows without an order ID receive a deterministic ID `LEGACY-<id>`, so every old row stays its own order and old reports do not change.

### Import troubleshooting

| Message | What to do |
|---|---|
| `The file cannot be read (EBUSY ...)` | The CSV is open in Excel or another program. Close it (or save a copy) and run the command again. |
| `File not found: ...` | Check the spelling; use the full path in quotes, or run the command from the project folder. |
| `Only .csv files can be imported` | Save as *CSV UTF-8 (Comma delimited) (\*.csv)* from Excel; do not rename an `.xlsx`. |
| `This is an Excel workbook (.xlsx), not a CSV file` | The file was only renamed. Open it in Excel and use **Save As → CSV UTF-8**. |
| `The file is not valid UTF-8` / `UTF-16` | You saved plain "CSV" or "Unicode Text". Re-save as **CSV UTF-8**. |
| `The header row is not comma-separated` | Your Excel uses semicolons. Re-save as **CSV UTF-8 (Comma delimited)**. |
| `Missing required column(s): ...` | Fix the first row so it contains all seven column names. |
| `Expected 7 columns but found 8` | A value contains a comma but is not in quotes (`"USB-C Cable, 2 m"`). |
| `a quote character appears inside an unquoted field` | Wrap the value in quotes and write inner quotes twice. |
| `amount ... contains a thousands separator` / `currency symbol` | Use plain numbers: `1299.00`, not `"1,299.00"` or `$1299`. |
| `amount ... has more than 2 decimal places` | Round to cents in your sheet. |
| `created_at ... is not a valid ISO date` | Format the column as `yyyy-mm-dd` before saving. |
| `Duplicate line_item_id "...": it was already used in row N` | Give every line a unique `line_item_id`. |
| `... already exists in the database with different data` | The same ID is stored with other values. Use a new ID for a new line; never reuse IDs. |
| `Refusing to seed: the database contains N imported line item(s)` | Intentional protection. Use another `DATABASE_PATH` for sample data, or `--force` to erase everything. |
| `The file has N data rows, which is more than the allowed maximum` | Split the file, or raise `IMPORT_MAX_ROWS`. |
| The report is empty after importing | The report covers the previous complete week by default. Use `--start`/`--end` with your data's dates. |

## Email with Resend

Email is **off by default** (`EMAIL_ENABLED=false`, `ENABLE_SCHEDULER=false`). Nothing is sent unless you ask for it (`sendEmail: true` on the API, `--email` on the CLI) or enable the scheduler **and** `EMAIL_ENABLED=true`.

| Variable | Purpose |
|---|---|
| `RESEND_API_KEY` | Resend API key (`re_...`). Read only from the environment; never logged, returned by the API, or stored in the database. |
| `EMAIL_FROM` | Sender: `reports@yourdomain.com` or `Reports <reports@yourdomain.com>`. Must be on a verified domain (or `onboarding@resend.dev` for testing). |
| `EMAIL_TO` | One recipient or several, comma-separated (Resend allows at most 50). |
| `EMAIL_ENABLED` | Scheduled runs email only when `true`. |
| `EMAIL_CLAIM_TIMEOUT_MS` | Unchanged: when an abandoned "sending" claim may be retried. |

`SENDGRID_API_KEY` is no longer used. If it is still set, the server logs a one-line warning at startup.

**What is sent:** one email per report with the PDF attached as `executive-report-<start>-to-<end>.pdf` (`application/pdf`, base64 on the wire) and a short text summary using the same currency formatting as the PDF.

**Failures are never reported as success.** The Resend SDK *returns* API errors (`{ data: null, error }`) instead of throwing them, so the code checks for them explicitly: any error, any exception, and any response without an email id is a failed delivery. The report itself stays `completed`, `emailStatus` becomes `failed` with `emailError` explaining why, the HTTP response is `502`, and the delivery ledger records `failed` so the same request can be retried. Only a response carrying a Resend email id counts as `sent`.

Email result (`email` in the `POST /reports` response): `{ status: "sent", attempt, accepted: true, statusCode: null, recipientCount, filename, id }`. `id` is the Resend email id, handy for finding the message in the Resend dashboard; `statusCode` is `null` because the SDK does not expose the HTTP status of a successful send. Other statuses are unchanged: `failed` (with `error`), `skipped_duplicate`, `not_requested`, `not_sent`.

### Domain verification (required to send to anyone but yourself)

Until you verify a domain, Resend only lets you send **from `onboarding@resend.dev`** and only **to the email address of your own Resend account**. Any other recipient is rejected with HTTP 403 `validation_error` ("You can only send testing emails to your own email address"), and this project reports that as a failed email.

To send from your own address or to other people:

1. Resend dashboard → **Domains** → **Add Domain** (Resend suggests a subdomain such as `notifications.example.com` to keep your sender reputation separate from your company email).
2. Add the DNS records Resend displays (SPF/DKIM and so on) at your DNS provider, then click **Verify**. DNS changes can take a while to propagate.
3. When the domain shows **Verified**, set `EMAIL_FROM` to an address on that domain (for example `reports@notifications.example.com`) and put the real recipients in `EMAIL_TO`.

### Manual test: send one report to yourself (Windows PowerShell)

This sends one real email to **your own** Resend account address using `onboarding@resend.dev`. It needs no domain.

1. Create a Resend account. Note the email address you signed up with. Under **API Keys**, create a key (sending access is enough) and copy it; Resend shows it only once.
2. In the project folder, create `.env` if you do not have one, then edit it (never commit it):
   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```
   Set exactly these values, leaving everything else (including `EMAIL_ENABLED=false` and `ENABLE_SCHEDULER=false`) as it is:
   ```
   RESEND_API_KEY=re_paste_your_key_here
   EMAIL_FROM=onboarding@resend.dev
   EMAIL_TO=the-address-you-signed-up-to-Resend-with@example.com
   ```
3. Prepare data and check the PDF without email first:
   ```powershell
   npm install
   npm run seed
   npm run report
   ```
4. Send the report:
   ```powershell
   npm run report -- --email
   ```
   Expected output ends with `Email: sent` (exit code 0). `Email: failed (...)` (exit code 2) prints Resend's reason; see Troubleshooting.
5. Check your inbox (and spam) for *Weekly Executive Business Report* with the attached `executive-report-<start>-to-<end>.pdf`, and open the attachment. The message also appears under **Emails** in the Resend dashboard.
6. Run step 4 again. `Email: skipped_duplicate` is **expected**: the same period to the same recipients is deliberately sent only once. To send again on purpose, start the server (`npm start`) and call:
   ```powershell
   Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/reports -ContentType 'application/json' -Body '{"sendEmail":true,"resendEmail":true}'
   ```
   (add `-Headers @{ Authorization = "Bearer $env:API_AUTH_TOKEN" }` if you configured `API_AUTH_TOKEN`).
7. When finished, delete `RESEND_API_KEY` from `.env`, or revoke the key in the Resend dashboard.

## How charts get into the PDF (rendering lifecycle)

Chart.js is responsive and redraws asynchronously whenever its container changes size, so a PDF taken "some time after the charts were created" can catch them cleared, resized, or drawn for a different layout. `renderPdf()` therefore makes the hand-off deterministic:

1. Print media is emulated and the viewport is set to the print column width (A4 minus the 12 mm `@page` side margins) **before** any chart exists, so charts are drawn at the size they are printed at.
2. It waits for web fonts and for the page's own chart script.
3. In one synchronous browser task it re-draws all four charts at the final layout, verifies each (sized to its container, not blank, not clipped on the left edge) and snapshots each canvas to a 2x PNG. The live charts are then destroyed and replaced by static images, so nothing can resize or redraw before printing. Up to three attempts are made.
4. Only then is `page.pdf()` called.

If a chart script throws, a chart is blank or unsized, or the page reports an error, the render **fails with diagnostics** (per-chart status plus browser console/page errors) and no PDF is written. It never silently produces a PDF with missing charts. Long product names are wrapped so axis labels are neither clipped nor auto-skipped.

## Security and deployment

- The API can generate reports and download PDFs containing business data. **Do not expose it to the internet without protection.** The server refuses to start on a non-loopback `HOST`, or with `NODE_ENV=production`, unless `API_AUTH_TOKEN` is set.
- The bearer token is a single shared secret compared in constant time. It is suitable for service-to-service use behind HTTPS; it is **not** per-user auth, has no rate limiting and no audit log. Put the service behind a TLS-terminating reverse proxy (and add rate limiting / network allow-listing there) for anything beyond local use.
- Plain HTTP carries the token in clear text; always use HTTPS outside localhost.
- Database-sourced text is HTML-escaped by Handlebars; JSON embedded in the page is escaped against `</script>` breakouts. The headless browser blocks all non-`data:` requests, so rendering never depends on, or leaks to, the internet.
- Download paths are validated to stay inside `REPORTS_DIR`; report IDs must be UUIDs.
- Never commit `.env`, databases or generated PDFs (all git-ignored). Test files use obviously fake placeholder keys such as `SG.test-key`.

## Tests

```bash
npm test             # everything; real-browser tests are SKIPPED (not passed) if no browser exists
npm run test:real    # only the real-browser tests (real-pdf, renderer-lifecycle, report-layout, import-report); FAILS if no browser can launch
npm run audit        # npm audit (moderate and above)
```

| File | Covers |
|---|---|
| `analytics.test.js` | Period math, SQL metrics, date validation |
| `pipeline-html.test.js` | SQL→JSON→HTML wiring, chart data derived from SQL, no external assets, escaping (no browser) |
| `renderer.test.js` | Handlebars output, escaping |
| `csv.test.js`, `order-validation.test.js` | CSV parser (quotes, CRLF, BOM, multi-line cells, malformed input) and every validation rule with row-numbered messages |
| `order-import.test.js` | Import engine: valid imports, duplicate policy (in file / identical / conflicting), dry run leaves the database file byte-identical, transaction rollback via a real SQLite failure, file and path safety |
| `order-analytics.test.js`, `order-migration.test.js` | Distinct-order revenue / AOV / daily / product / category / previous-period definitions (independently computed expectations) and the old-schema migration, plus the seed script's data-loss guard |
| `import-cli.test.js`, `sample-data.test.js` | The `import:*`, `orders:summary`, `report --start/--end` and `sample:csv` commands in real child processes; the importer cannot reach email, the scheduler or the seed; the committed example file |
| `import-report.test.js` | **Real Chrome**: sample CSV -> database -> PDF through the CLI and the API; the PDF shows the independently computed totals |
| `email.test.js` | Resend: configuration errors, payload and PDF attachment (filename, content type, byte-exact base64), API errors and exceptions (never reported as sent), key redaction, the **real Resend SDK against a stubbed `fetch`** (exact HTTP request), and service-level retry / duplicate / failed-email behavior |
| `email-config.test.js` | Email and scheduler off by default, env variables, `.env.example` placeholders only, no SendGrid remnants, no credentials committed |
| `report-service.test.js`, `idempotency-and-recovery.test.js` | Status tracking, failure stages, stale recovery, email idempotency incl. concurrency |
| `server.test.js` | All HTTP endpoints: success, validation, failure, auth, status codes |
| `scheduler.test.js` | Overlap guard and a real cron tick |
| `paths.test.js` | Runs from a different working directory (uses `pathToFileURL()` so it works on Windows); seeding |
| `real-pdf.test.js` | **Real Chrome**: PDF parsed with pdf.js (text, A4, page numbers, ≥4 chart images that are non-blank and correctly proportioned), full pipeline with a Resend test double, scheduled run |
| `format.test.js` | Currency and percentage formatting rules, incl. a 5,000-value round-trip proving formatting never changes an amount |
| `report-layout.test.js` | **Real Chrome**: money formatting as it appears in the PDF, Top products never split across pages (1/3/6/8 products), page-1/page-2 composition, repeating headings on long periods, large amounts fit the KPI cards |
| `renderer-lifecycle.test.js` | **Real Chrome**: charts re-drawn at the print layout, frozen charts stay static, chart failures and blank charts fail loudly with diagnostics, no clipped/skipped axis labels, empty period, consistency across repeated renders |

Mocked-renderer tests prove orchestration only. **Only `real-pdf.test.js`, `renderer-lifecycle.test.js`, `report-layout.test.js` and `import-report.test.js` are evidence of real PDF rendering**, and they report `skipped` when no browser is available.

CI (`.github/workflows/ci.yml`) installs Chrome, runs the suite with `REQUIRE_REAL_PDF=true` and runs `npm audit`.

## Known limitations

- CSV import reads `.csv` files only (save Excel sheets as *CSV UTF-8*); there is no direct `.xlsx` reader and no "undo import" command (restore a backup instead).
- Timestamps without a timezone are treated as UTC, and weeks are computed in UTC.
- A line item is identified only by `line_item_id`; two different files that reuse an ID for different data conflict by design.

- Live Resend delivery has not been tested from this repository's development environment; the attachment, wire format and failure paths are verified with a test double and with the real SDK against a stubbed `fetch`. Follow the manual test below to confirm delivery with your account.
- Real rendering was verified using system Chromium in this sandbox. The default Puppeteer-managed browser installation still needs confirmation on the target machine because the clean npm install attempt timed out.
- Requires Node 24 per `engines`. This audit environment used Linux with Node 22.16.0, below the declared requirement; re-run setup and tests on Node 24.21.0 and Windows before treating that environment as verified.
- Single-process SQLite; weeks are computed in UTC.
- Idempotency edge case described above (crash after Resend accepts the message).
- Authentication is a shared bearer token only.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Could not start a Chrome/Chromium browser…` | See [Browser setup](#browser-setup) |
| `No usable sandbox` / launch fails in Docker | `PUPPETEER_NO_SANDBOX=true` |
| `Startup failed: Refusing to listen…` | Set `API_AUTH_TOKEN` or use `HOST=127.0.0.1` |
| `401 Authentication required` | Send `Authorization: Bearer <token>` |
| `502` with `email.status: failed` | The PDF exists; read `email.error` (see the Resend rows below), fix it and repeat the same request: a failed delivery is retryable |
| `email.error` says *Resend is not configured* | Set `RESEND_API_KEY` and `EMAIL_FROM` in `.env` |
| `403 validation_error` … *You can only send testing emails to your own email address* | You are sending from `onboarding@resend.dev` to someone other than your Resend account email. Send to your own address, or verify a domain (below) |
| `403 invalid_api_key` / `401 missing_api_key` | The key is wrong, revoked or not loaded; create a new one at resend.com/api-keys |
| `429 rate_limit_exceeded` | Resend rate-limited the request; wait and repeat the request |
| `Startup` warning about `SENDGRID_API_KEY` | Leftover variable from the old provider; delete it from `.env` |
| `Charts did not finish rendering…` | Raise `PDF_CHART_TIMEOUT_MS`; check the message for page errors |
| Report stuck in `pending` | Restart the server; stale ones are marked `failed/interrupted` |

## Free cloud portfolio deployment (no payment card)

ExecuBrief has an **optional cloud mode** for a zero-cost portfolio deployment: Render Free runs Node.js while Supabase Free stores organisation accounts, CSV imports and PDFs. Apply `supabase/migrations/0001_execubrief_cloud.sql` in the Supabase SQL Editor and configure `SUPABASE_URL` and `SUPABASE_SECRET_KEY` as Render server-side environment variables. The service starts with `npm run start:cloud`; local Windows development continues using `npm start` and SQLite.

Read [docs/FREE_DEPLOYMENT_NO_CARD.md](docs/FREE_DEPLOYMENT_NO_CARD.md) before deploying. The cloud adapter rehydrates organisation CSVs into a short-lived in-memory SQLite database and caches it briefly to reduce free-tier egress; the cache resets on sleep/redeploy. Free services sleep, Supabase Free may pause after a week of inactivity, public demo report history may reset, and free tiers are not guaranteed always-on production services. Never commit `.env` or expose the Supabase service-role secret. Do not deploy the earlier paid Blueprint; the checked-in `render.yaml` must have `plan: free` and no persistent-disk stanza.
