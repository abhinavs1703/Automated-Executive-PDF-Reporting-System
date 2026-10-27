# ExecuBrief: $0 cloud deployment with no card or verification hold

This is a **portfolio/demo deployment**, not a guaranteed always-on production service. The steps intentionally avoid payment cards, payment holds, paid upgrades, Oracle Cloud card verification, the paid Render Blueprint and external email/scheduler services.

## Free architecture

- **Render Free Web Service** runs Node.js/Express with no card/payment method in its free deployment tutorial. It sleeps after inactivity and has an ephemeral filesystem; the first visit after sleep can be slow. See [Render's first-deploy tutorial](https://render.com/docs/your-first-deploy) and [free service limits](https://render.com/docs/free).
- **Supabase Free** stores account/organisation metadata, sessions, import metadata, uploaded CSV source files and generated PDFs. Its current Free plan lists 500 MB database and 1 GB file storage, and projects can pause after a week of inactivity. See [Supabase pricing](https://supabase.com/pricing) and [free-project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).
- The public synthetic demo database and demo report PDFs live under `/tmp`. Their demo history can reset after a service sleeps/redeploys. Organisation accounts/imports/PDFs use Supabase and should persist while the Supabase project remains active.
- No card should be necessary for the documented free signup paths. If either provider requests payment details or a verification hold for your account/region, stop and do not enter them. Do not upgrade.

## 1. Publish the no-card cloud mode to the existing GitHub repository

The previously published commit may not include this newer cloud migration. Render can only deploy code that has actually been pushed, so merge this release into the existing `main` branch first. Do not create a second repository or force-push history.

1. Download `ExecuBrief-Supabase-Audited.zip` into your Downloads folder.
2. Open PowerShell. Confirm the publishing checkout is the authorised repo and has no uncommitted changes:

   ```powershell
   $Repo = "$HOME\ExecuBrief_Git_Publish"
   $Zip = "$HOME\Downloads\ExecuBrief-Supabase-Audited.zip"
   $Stage = "$HOME\ExecuBrief_Free_NoCard_Stage"
   $ExpectedRemote = "https://github.com/abhinavs1703/Automated-Executive-PDF-Reporting-System.git"

   if (!(Test-Path "$Repo\.git")) { throw "Git publish checkout not found." }
   if (!(Test-Path $Zip)) { throw "Download the release ZIP first." }
   if (Test-Path $Stage) { throw "Staging folder already exists. Choose another name." }
   $remote = (git -C $Repo remote get-url origin).Trim()
   if ($remote -ne $ExpectedRemote) { throw "Origin is not the authorised repository; stop and inspect it." }
   git -C $Repo status -sb
   if (@(git -C $Repo status --porcelain).Count -gt 0) { throw "Publishing checkout is not clean. Review it before merging." }
   ```

3. Extract to staging and verify the package root:

   ```powershell
   Expand-Archive -LiteralPath $Zip -DestinationPath $Stage
   if (!(Test-Path "$Stage\package.json")) { throw "package.json not found at archive root." }
   ```

4. Back up the current source checkout (excluding bulky dependencies and Git metadata) before copying the release files:

   ```powershell
   $Backup = "$HOME\ExecuBrief_Git_Publish_SourceBackup"
   if (Test-Path $Backup) { throw "Backup folder exists already; choose a new name." }
   robocopy $Repo $Backup /E /XD .git node_modules data demo-data custom-data reports
   ```

5. Merge the release source into the Git checkout, preserving `.env`, databases, generated PDFs and `node_modules` if any are present:

   ```powershell
   robocopy $Stage $Repo /E /XD .git node_modules data demo-data custom-data reports /XF .env *.sqlite *.sqlite3 *.db *.pdf *.log
   ```

6. In PowerShell, continue with `Set-Location $Repo`, `npm.cmd ci`, and `npm.cmd test`. Only proceed if installation succeeds and tests finish with no failures. Then inspect `git status --short`, run `git diff --check`, stage with `git add -A`, and ensure no `.env`, database, PDF or other private data is staged. Commit the cloud-mode change, run `git fetch origin`, inspect `git status -sb`, and push `main` only if it is a normal fast-forward. Never use `git push --force`.

The cloud deployment is an additive mode. Local Windows mode continues using SQLite and `npm start`; the cloud service uses `npm run start:cloud` only when the Supabase settings are supplied by Render.

Before deploying, ensure the newest release commit has these files:

- `src/cloud-app.js`
- `src/cloud-server.js`
- `src/cloud-store.js`
- `src/cloud-workspace.js`
- `supabase/migrations/0001_execubrief_cloud.sql`
- `render.yaml` configured with `plan: free` and `startCommand: npm run start:cloud`

Never commit `.env`, a Supabase service-role key, databases, real customer data, generated PDFs or `node_modules`. The `SUPABASE_SECRET_KEY` is a server secret; it must never appear in browser code or GitHub.

## 2. Create Supabase Free project

1. Open https://supabase.com/ and create/sign into an account. Select only the Free plan; do not add billing or upgrade.
2. Create a project with a strong database password and select a region near the Render service region if available.
3. Wait until the project finishes provisioning.
4. In the Supabase dashboard, open **SQL Editor** and create a new query.
5. Open this repository's `supabase/migrations/0001_execubrief_cloud.sql`, copy its entire content into the SQL Editor and run it once.
6. Verify that tables exist: `organizations`, `app_users`, `organization_memberships`, `auth_sessions`, `workspace_imports`, `custom_reports`. Verify that Storage has a private bucket named `execubrief-private`.
7. Open **Project Settings → API Keys** (or the project's API/Keys page in the current Supabase UI). Copy the Project URL and the **secret API key** that starts with `sb_secret_`. Do not use a publishable key (`sb_publishable_...`). Never share this secret or put it in GitHub. The adapter sends a modern `sb_secret_*` key only in the `apikey` header, as Supabase documents. For backwards compatibility only, an older `service_role` JWT can instead be placed in `SUPABASE_SERVICE_ROLE_KEY`; prefer the modern `SUPABASE_SECRET_KEY` variable.

If SQL reports an error, do not repeatedly run partial fragments. Save the error text (without secrets), correct the migration, then run the complete migration. This migration is designed to be re-runnable with `create table/index if not exists` and `create or replace function`; review the result before running again.

## 3. Configure Render Free

1. Open https://render.com/ and sign in without adding payment details. Render's free deployment guide states a payment method is not required for its Free instance workflow.
2. Connect GitHub and authorise the existing repository `abhinavs1703/Automated-Executive-PDF-Reporting-System`.
3. Choose **New → Blueprint** and select that repository/branch.
4. Review the root `render.yaml`. It must say `plan: free`, `startCommand: npm run start:cloud`, `healthCheckPath: /health`, and it must have **no `disk:` section**. Do not deploy the earlier paid Blueprint with `plan: 1c-2g` or a persistent disk.
5. When Render asks for the two values marked `sync: false`, set:
   - `SUPABASE_URL`: the Supabase Project URL.
   - `SUPABASE_SECRET_KEY`: the modern Supabase server-side secret key (`sb_secret_...`).
6. Keep `SUPABASE_STORAGE_BUCKET=execubrief-private`, `EMAIL_ENABLED=false`, `ENABLE_SCHEDULER=false`, and `PUPPETEER_NO_SANDBOX=true`. `API_AUTH_TOKEN` should be generated by Render as the Blueprint specifies.
7. Review the page carefully. Confirm the plan is **Free**, no add-on/paid service is being created, and the total shown is $0. If the screen requires a payment method or shows a nonzero service, stop without confirming.
8. Create/deploy the Blueprint only after the above review. Wait for the build/deploy to finish.

The service runs `npm ci` and `npm run start:cloud`. `npm start` remains the local SQLite mode; do not override it for Windows development.

## 4. Verify cloud setup before using accounts

Use the actual hostname assigned by Render; do not guess it.

1. Open `https://<actual-host>/health`; expected HTTP 200 and JSON `status: ok`.
2. Open `https://<actual-host>/ready`; expected HTTP 200 and JSON `status: ready`. If this returns 503, verify Supabase project status, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, the migration and the `execubrief-private` bucket. Never put the service key in frontend code.
3. Open the homepage, sign up with a test organisation, then sign out/in.
4. Open `/workspace`. Import only the synthetic `examples/enterprise-demo.csv` or `examples/custom-report-upload.csv`. It should preview columns/date coverage and import valid rows.
5. Verify analytics and date/category/region filters. Generate an organisation PDF; verify its preview and downloaded file opens and begins with a valid PDF signature.
6. Open `/custom-reports` and test single-file custom PDF generation too.
7. Create a second test organisation and confirm it cannot access the first organisation's imports/PDF endpoints.
8. Leave the service to sleep, reopen it, and verify that organisation accounts, imports and custom PDFs still exist. Allow for a cold start.
9. Visit Supabase after testing and monitor database/file-storage quota. The Free project has 500 MB database and 1 GB file storage limits. The app caps each organisation to 20 CSV imports/50,000 source rows and each uploaded CSV to 5 MB to reduce free-tier pressure, but the project-wide bucket limit is shared by every organisation.

## 5. Google sign-in (optional)

Email/password auth can be tested first. To enable Google:

1. Open https://console.cloud.google.com/ and create/select a project.
2. Configure OAuth consent and a Web application OAuth client.
3. Add the actual Render HTTPS origin to Authorized JavaScript origins.
4. Add `https://<actual-host>/auth/google/callback` to Authorized redirect URIs.
5. In Render's service **Environment** page, add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` with the actual callback URL. Keep the secret only server-side. Redeploy, then test a real login.

Google OAuth is optional and the project will show it as unavailable until those values are configured.

## 6. Important limitations and data safety

- Render Free sleeps after 15 minutes of no inbound traffic, so the next visit can take about a minute. It has no persistent local disk. `/tmp` demo history and demo PDFs may reset. Private organisation data is stored in Supabase.
- Supabase Free can pause projects after roughly one week of inactivity. If paused, resume it in Supabase's dashboard; the Render app may show storage/DB unavailable until then. Do not upgrade if a strict $0 bill is required.
- Supabase Free does not provide paid-plan automated backups / point-in-time recovery. Periodically export database data and securely download important PDFs/CSV files using authorised methods. Never commit these exports.
- Free hosting has limited CPU/RAM and concurrency. The cloud app limits PDF jobs to one at a time, one-off CSV uploads to 5 MB and reporting periods to 93 days. Large reports can still fail if Chromium reaches free-instance memory limits. Org CSVs are cached for up to five minutes in memory after rehydrating; cache is invalidated after imports and can reset on sleep/deploy.
- Free providers can change quotas/terms. Check their current plan page and stop if the checkout/deployment screen asks for payment.
- Do not enable Resend email or scheduled reporting for the public demo. They remain disabled.
- Do not claim this is always-on or enterprise production hosting. It is a $0 public portfolio demo with cold starts and free-tier limits.

## 7. GitHub post-deploy workflow

After a release change is tested locally, commit and push it to the same authorised repository. Render can auto-deploy new commits from its connected branch. After every change, repeat the health, sign-in, CSV-import and PDF-generation checks. Keep the original local `.env` out of Git.
