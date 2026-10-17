# ExecuBrief — Final Release Candidate Status

Updated: 2026-10-17

## Completed in this release candidate

- Rechecked and consolidated the Phase 1 auth/organisation foundation and Phase 2 custom CSV/PDF workflow.
- Fixed the browser test's required organisation field, correct post-registration route and report-history UUID selector (`.report-created` instead of the title element).
- Public top bar: right-aligned sign-in/account actions; signed-in account menu shows identity, organisation, workspace and sign-out.
- Public Overview: 7/30/90-day presets, product search/category/sort, report search/status filters, responsive styling and reduced-motion-aware transitions.
- Organisation workspace: 7/30/90-day periods, validated date picker, category/region server-side filters applied consistently to overview analytics and generated workspace PDFs, import history search/status filters and import health.
- More conservative `.gitignore` rules covering `.env`, local SQLite stores and sidecars, generated PDFs, runtime storage, dependencies and local editor artifacts.
- Render Blueprint stores all SQLite databases, organisation imports, and generated report paths under the explicit persistent `/var/data` mount; false environment values are serialized as strings.
- Added `docs/FINAL_RELEASE_GUIDE.md` with test steps, local acceptance criteria, GitHub safety workflow, Render persistence/cost notes, Google OAuth setup and a LinkedIn post draft.

## Tests actually run

- Individual file runs cover the 31 `test/*.test.js` files: **225 passed, 0 failed, 1 skipped**.
- The skipped test is the interactive browser flow in this isolated sandbox, where Chrome was blocked from navigating to the loopback application. Actual Puppeteer rendering and PDF-layout tests passed with `/usr/bin/chromium` and `PUPPETEER_NO_SANDBOX=true`.
- JavaScript syntax checks pass for application, scripts, frontend, tests and legacy compatibility scripts.
- The `npm audit` command was attempted but could not reach the registry (`EAI_AGAIN registry.npmjs.org`). Dependency advisory status remains unverified.
- The aggregate suite can stall during browser process teardown in this sandbox. Individual test files were run and their summaries aggregated rather than misrepresenting the outer wrapper timeout as a successful single invocation.

## Not done / still needs human-account access

- No GitHub commit or push: this build workspace is not a Git checkout, GitHub CLI is unavailable, and the connector's repository actions are not exposed in this session. Do not infer success from the release ZIP.
- No Render service or paid resources created.
- No actual Google OAuth round trip with user credentials.
- No LinkedIn post published; the release guide contains a template and instructs to substitute only verified links.
- No independent security penetration test or production data backup/restore exercise.

Follow `docs/FINAL_RELEASE_GUIDE.md` for the local, GitHub, and deploy workflows.
