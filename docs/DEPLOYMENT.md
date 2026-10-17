# Free cloud deployment (no card, no paid resources)

ExecuBrief contains two separate runtime modes:

- **Local Windows mode** uses the original SQLite architecture and runs with `npm start`.
- **Free cloud mode** runs with `npm run start:cloud`. Organisation accounts, import metadata, original CSVs and generated PDFs are stored in Supabase Free. A short-lived in-memory SQLite database is rebuilt from an organisation's stored CSV files for analytics and PDF generation.

This design is intended for a **$0 portfolio/demo deployment**, not an always-on or high-availability production service. Render Free sleeps after 15 minutes of inactivity and has an ephemeral local filesystem; Supabase Free projects may pause after a week of inactivity. No card, verification hold or paid upgrade should be required for the documented route. If any service asks for card details or shows nonzero charges, stop without confirming.

## Required deployment files

- `src/cloud-app.js`, `src/cloud-server.js`, `src/cloud-store.js`, `src/cloud-workspace.js`
- `supabase/migrations/0001_execubrief_cloud.sql`
- `render.yaml` using `plan: free`, `startCommand: npm run start:cloud`, `/health`, and no persistent-disk section
- `.env.example` (placeholders only; never publish `.env`)

## Deployment procedure

Follow [`FREE_DEPLOYMENT_NO_CARD.md`](FREE_DEPLOYMENT_NO_CARD.md) in order. It covers Supabase schema/bucket setup, Render Free Blueprint settings, server-only secrets, health/readiness verification, import/PDF acceptance checks and free-tier limitations.

## Limits to understand

- Supabase Free currently lists 500 MB database and 1 GB file storage; low-activity projects can pause after a week. Monitor quotas and make authorised backups.
- Render Free sleeps after inactivity and has no persistent local disk. Only account/workspace source files and PDFs stored in Supabase persist; `/tmp` synthetic-demo cache/history can reset.
- The cloud mode limits uploaded CSVs to 5 MB, source rows to 50,000 per organisation, imports to 20 per organisation and active PDF generation to one at a time. Those are demo guardrails, not enterprise-scale capacity claims.
- PDF generation on a free 512 MB web instance can still fail for large reports due to browser memory/CPU limits. Test the actual deployment before sharing it.
- Email and scheduler remain disabled. Google OAuth is optional and needs a real client configuration and redirect test.

Do not deploy an earlier Blueprint that uses `plan: 1c-2g` or a persistent disk. Do not claim the app is live until its actual public hostname and the complete CSV-to-PDF workflow have been verified externally.
