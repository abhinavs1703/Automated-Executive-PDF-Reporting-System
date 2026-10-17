# ExecuBrief — Project audit for the $0 cloud release candidate

Audit snapshot: 2026-10-17. This audit distinguishes code checks from external deployment verification. The no-card cloud mode is prepared, but the Supabase migration, live account flows and Render deployment still require real provider accounts and acceptance tests.

## Existing product and architecture

- Local Windows mode remains Express + SQLite, using `npm start`.
- Free cloud mode is an additive runtime selected with `npm run start:cloud`; it uses a server-side Supabase REST/Storage adapter and a Supabase SQL migration for account, organisation, session, import and report metadata.
- The public landing/Overview and synthetic demo remain served by the existing Express application. The private workspace uses cloud-specific handlers; browser clients never receive the Supabase secret key.
- Account registration/password hashing, session and CSRF protection, Google OAuth state/nonce and ID-token validation are reused. Google sign-in still needs a real OAuth client and live callback test.
- Private CSVs and generated PDFs use a private Supabase Storage bucket. Analytics databases are reconstructed from organisation CSV objects into a small, short-lived in-memory SQLite cache to avoid downloading all CSVs for each filter request.
- PDF generation calls the existing Puppeteer/reporting pipeline. Cloud mode limits concurrent PDF rendering to one at a time and applies free-tier file/row/import caps.

## Safety and isolation decisions

- The Supabase secret key is server-only, configured in the hosting environment, and absent from `.env.example` as a value.
- The migration enables RLS on app tables, revokes public/anon/authenticated access and grants access to the service role only. The file bucket is private.
- CSV object paths and report IDs are validated; report metadata/file access is scoped to the active organisation.
- An ambiguous database insert timeout no longer blindly deletes a Supabase object that may already be referenced by committed import/report metadata. Cache entries are invalidated after successful imports and released safely.
- Scheduler and email are disabled in the free Blueprint; public demo reporting does not trigger email or scheduler work.
- `.gitignore` excludes `.env`, node_modules, local database/WAL files, PDFs, logs and runtime data.

## What is verified in this sandbox

- All source JavaScript files were syntax-checked after adding the cloud mode.
- `test/cloud-store.test.js` and `test/cloud-deployment-contract.test.js`: **10 passed, 0 failed**, including modern Supabase secret-key header semantics, storage readiness and the PDF temp-directory cold-start regression. The checks cover the server-only Supabase key usage, safe storage paths, redacted remote errors, HTTPS enforcement in production, free/no-disk Render configuration, migration-table/RLS presence and clean secret placeholders.
- The earlier local-mode release had 225 pass, 0 fail and 1 skip aggregated from individual file runs. That historical result is not a full test result for the new cloud mode.

## Not verified yet (do not treat as production-ready)

- The current environment could not complete `npm ci` from the package registry; the local `node_modules` created during the attempt was incomplete. Therefore the full test suite has **not** been rerun on this latest cloud-mode source in this sandbox.
- The migration has not been applied to a live Supabase project; registration, session RPC, CSV object storage, report object storage and real API responses have not been end-to-end tested against Supabase.
- The Render service has not been created, and no public health/page/PDF endpoints exist to externally verify yet.
- The actual deploy host's Puppeteer/Chromium resource use has not been measured. Free Render resources may be too constrained for unusually large reports.
- Dependency advisory status is unknown until `npm audit --audit-level=moderate` can access the registry.
- Google OAuth, backup/restore and inactivity resume behaviour still require provider-account verification.
- No independent penetration test or legal/privacy review has been performed. Use only synthetic data in a public demo.

## Release acceptance requirements

1. Apply `supabase/migrations/0001_execubrief_cloud.sql` once in Supabase SQL Editor and verify all six app tables and private bucket.
2. On Node 24.21.0, run `npm ci` then `npm test` in a clean copy; fix failures rather than skipping/weakening tests.
3. Deploy only the checked-in `plan: free` Blueprint and verify Render asks for no card/hold or paid resources; stop if it asks.
4. Test homepage, `/health`, `/ready`, registration/login/logout, CSV preview/import, analytics filters, real PDF generation, preview/download and two-organisation isolation.
5. Test a cold start and Supabase resume after pause; export synthetic test data and perform a restore exercise before any real data is considered.
6. Publish a LinkedIn link only after the actual public URL is live and externally verified.
