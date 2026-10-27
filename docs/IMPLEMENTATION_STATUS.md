# ExecuBrief — no-card cloud release status

Updated: 2026-10-27

## Changes included in this archive

- Preserves local Windows SQLite operation (`npm start`) and adds the separate cloud entry point (`npm run start:cloud`).
- Uses `src/cloud-store.js` for Supabase PostgREST and private Storage requests with a server-side secret key.
- Uses `src/cloud-workspace.js` to reconstruct organisation analytics from private CSV objects into a short-lived in-memory SQLite database, with bounded cache/import limits.
- Uses `src/cloud-app.js` and `src/cloud-server.js` for session/CSRF routes, optional Google OAuth, CSV preview/import, organisation analytics, custom PDF generation/history and private PDF downloads.
- Provides `supabase/migrations/0001_execubrief_cloud.sql` for private tables, RLS, server-role-only RPC functions, and the `execubrief-private` bucket.
- Render Blueprint is the no-card/free profile: `plan: free`, `npm run start:cloud`, `/health`, no persistent disk, Supabase connection placeholders, and email/scheduler disabled.
- Fixed Supabase Storage upload cache-control metadata, hardened SQL function search paths, corrected API-token documentation, cleaned whitespace, and added cross-platform LF attributes.

## Actual checks completed

- All JavaScript source/test files passed `node --check`.
- Focused dependency-independent suite: **55 passed, 0 failed**. Covered cloud store/deployment contract, Supabase key/header behavior, storage readiness/upload headers, safe object paths, redacted errors, HTTPS config, CSV parsing and mapping, currency formatting, order validation and Google token verification.
- `test/cloud-store.test.js` plus `test/cloud-deployment-contract.test.js`: **11 passed, 0 failed** after the new storage-header regression test.

## Blockers / limitations

- `npm ci` could not finish because this environment failed DNS resolution for `registry.npmjs.org` (`EAI_AGAIN`). The incomplete `node_modules` created during that attempt is excluded from the package. The full test suite and `npm audit` were not completed against this exact source here.
- The Supabase migration and data/API/storage flow need to be verified with the user's live project. Render has not been deployed; there is no verified public URL.
- Google OAuth requires a real OAuth client and live callback verification.
- Free Render sleeps after inactivity and has an ephemeral filesystem; private organisation data is designed to persist through Supabase. Supabase Free has quotas and may pause inactive projects. This is a free portfolio/demo setup, not guaranteed always-on production hosting.

## Next actions

1. Extract into a clean staging folder and run `npm ci` on Node 24.21.0 with working registry access.
2. Run the full `npm test` suite and `npm audit --audit-level=moderate`; resolve failures/advisories instead of suppressing them.
3. Apply the migration to Supabase and verify the six application tables and private storage bucket.
4. Configure only server-side `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the free hosting service.
5. Deploy only if the provider's final screen confirms $0 and does not request a card, hold, paid disk, or paid add-on.
6. Complete the cloud acceptance tests before sharing a public URL.
