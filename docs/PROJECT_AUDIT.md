# ExecuBrief — final ZIP audit (Supabase cloud-mode release)

Audit date: 2026-10-27. This report distinguishes source-level checks from runtime and hosted verification.

## Scope inspected

The uploaded `Executive pdf Report.zip` contained the full application source, the Node test suite, Supabase SQL migration, Render Blueprint, setup and deployment docs, and synthetic example CSVs. The ZIP did not contain a real `.env`, Git history, `node_modules`, local SQLite databases, or generated PDF reports. The 1.8 MB `examples/enterprise-demo.csv` is synthetic demo data.

## Confirmed corrections in this reviewed copy

- Supabase cloud mode remains additive: local Windows mode continues using `npm start` / SQLite, while cloud mode starts with `npm run start:cloud` and uses Supabase PostgREST + private Storage for organisation records, imported CSVs and PDF objects.
- Fixed Supabase Storage upload metadata: uploads now send `cache-control: max-age=0` rather than `no-store`, matching Supabase's raw upload API expectation for `max-age=<seconds>`.
- Added a regression test that asserts storage upload content type, upsert header, cache-control metadata, server-side API key header and raw byte body.
- Tightened `SECURITY DEFINER` SQL functions to explicitly use `search_path = pg_catalog, public`.
- Corrected misleading API-token comments: `API_AUTH_TOKEN` protects the private/admin `/reports` endpoints; it does not blanket-protect the public demo or the separate session-backed organization routes.
- Removed known trailing whitespace and the extra README end-of-file blank line.
- Added `.gitattributes` to keep text files LF-normalized across Windows/Linux/CI and reduce avoidable line-ending noise.
- Render Blueprint remains `plan: free`, uses `npm run start:cloud`, checks `/health`, has no persistent disk, and keeps email/scheduler disabled by default.

## Verification performed in this environment

- JavaScript syntax check: every `.js` file outside `node_modules` passed `node --check`.
- Focused dependency-independent tests: **55 passed, 0 failed** across cloud store/deployment contract, CSV parsing/mapping, currency formatting, order validation and Google token verification.
- One expanded test command included `test/analytics.test.js`, but that test file could not load because `dotenv` was absent in the incomplete installation; it did not fail on an assertion.
- Archive structure and secret/data exclusions were inspected before packaging.

## Verification blocked / not claimed

- `npm ci` did not finish in this build environment because DNS lookup for `registry.npmjs.org` failed (`EAI_AGAIN`). The resulting `node_modules` was incomplete. Therefore, the complete `npm test` suite and `npm audit` were **not** completed on this uploaded source.
- The Supabase migration/API/storage round-trip and Render deployment were not exercised against live provider resources in this sandbox. The user must run the complete test suite on Node 24.21.0 with working npm registry access, then validate the hosted flows.
- Google OAuth needs the user's own OAuth client setup and a real callback test.
- No independent penetration test or formal production-readiness assessment was performed. Treat this as a portfolio/demo release pending the acceptance checklist, not a guarantee of a foolproof production service.

## Release acceptance checklist

1. Extract into a clean folder and run `npm ci` on Node 24.21.0.
2. Run `npm test`; review every failure and skipped test.
3. Apply `supabase/migrations/0001_execubrief_cloud.sql` to the intended Supabase project; verify all six tables and the private `execubrief-private` bucket.
4. Configure `SUPABASE_URL` and `SUPABASE_SECRET_KEY` only in the host's server-side environment; never commit a real secret.
5. Deploy only the free Blueprint and stop if a payment card, verification hold, paid plan, or paid add-on is required.
6. Verify `/health`, `/ready`, registration/login, CSV preview/import, analytics filters, real PDF generation, preview/download, and cross-organisation isolation on the actual public host.
7. Verify persistence after a cold start and document free-tier limitations before posting the URL publicly.
