# ExecuBrief — No-card cloud release status

Updated: 2026-10-17

## Changes included in this archive

- Added a cloud runtime entry point while preserving local SQLite mode (`npm start`). The cloud release uses `npm run start:cloud`.
- Added `src/cloud-store.js` to access Supabase PostgREST and private Storage with a server-side Supabase secret key.
- Added `src/cloud-workspace.js` to reconstruct organisation analytics from private CSV objects into in-memory SQLite, with a small TTL/LRU cache, 20-import/50,000-row caps and cache invalidation after successful imports.
- Added `src/cloud-app.js` and `src/cloud-server.js` for account/session/CSRF routes, optional Google OAuth, CSV preview/import, organisation analytics, custom PDF generation/history and private PDF downloads.
- Added `supabase/migrations/0001_execubrief_cloud.sql` for private organisation/auth/import/report tables, service-role-only RPC functions and the private `execubrief-private` bucket.
- Replaced the paid Render Blueprint configuration with a free Node service, `/health`, cloud start command, no persistent-disk section and server-side Supabase env placeholders.
- Added `docs/FREE_DEPLOYMENT_NO_CARD.md` and updated README, setup and deployment docs to explain the strict $0 path and its limits.
- Strengthened ambiguous-write cleanup so an uncertain remote timeout does not destroy a file that may already have a durable metadata record.
- Fixed PDF temp-directory creation for a fresh/ephemeral Render instance before calling `mkdtemp`.
- `/ready` now checks both PostgREST database access and the configured private Storage bucket.
- Updated Supabase secret-key requests to use modern `sb_secret_*` values on `apikey` only, retaining an opt-in legacy `service_role` JWT fallback.

## Actual checks completed for this cloud change

- `node --check` passed for `src/cloud-app.js`, `src/cloud-store.js`, `src/cloud-workspace.js` and `src/cloud-server.js`; a broader syntax pass over the project also passed before the latest docs edits.
- `node --test test/cloud-store.test.js test/cloud-deployment-contract.test.js`: **10 passed, 0 failed**.
- The test suite checks the source/deployment contract and store helper with fake HTTP responses; it does not substitute for a live Supabase or Render integration test.

## Blockers / limitations

- `npm ci` could not finish in this build environment because registry access timed out; the generated `node_modules` tree is incomplete and excluded from the package. A full test suite was **not** run against this exact cloud release. The focused tests use Node built-ins and mocks only.
- The Supabase SQL migration has not been applied to a real project. Cloud register/login, RPC permissions, private bucket setup, CSV round-trips and PDF storage need a real no-card acceptance run.
- Render has not been deployed; there is no verified public URL. Google OAuth and live browser navigation remain unverified.
- Free-tier limits: Render sleeps after inactivity and has ephemeral local storage; Supabase Free is limited to 500 MB database and 1 GB file storage and can pause after about a week inactive. Public synthetic-demo cache/history may reset. This is a portfolio demo, not guaranteed always-on production hosting.
- No provider account, external service, payment method or paid resource was created by this work.

## Next exact actions

1. Extract/merge the release source into the authorised GitHub checkout without `.env`, databases, PDFs or `node_modules`.
2. Run `npm ci` and `npm test` on Node 24.21.0 with network access; fix any failures.
3. Create a Supabase Free project only if it does not ask for payment, run the migration SQL, and verify tables/bucket.
4. Connect the repository to Render New → Blueprint. Confirm the service is **Free**, `npm run start:cloud`, `/health`, and no `disk:`. Stop if payment details or a nonzero service is required.
5. Enter only the Supabase Project URL and Supabase secret key into Render's server environment settings. Never commit or paste the service key.
6. Complete and record the entire cloud acceptance checklist in `docs/FREE_DEPLOYMENT_NO_CARD.md` before sharing the URL.
