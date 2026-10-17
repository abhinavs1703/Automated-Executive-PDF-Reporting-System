import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { openAuthStore } from '../src/auth-store.js';
import { createDatabase } from '../src/db.js';
import { previewCustomCsv, mapCustomCsv } from '../src/custom-csv.js';
import { closeOrganizationWorkspace, getOrganizationAnalytics, insertWorkspaceImport, listWorkspaceImports, openOrganizationWorkspace } from '../src/organization-workspace.js';

const PASSWORD = 'safe-test-password-2026!';
const CSV = [
  'Order ID,Line Item ID,Order Date,Product,Category,Customer ID,Revenue,Cost,Gross Profit,Region,Sales Channel,Currency,Units',
  'A-100,L-100,2026-09-01,Cloud platform,Software,ACCT-1,1200,720,480,North America,Direct,USD,2',
  'A-100,L-101,2026-09-01,Support plan,Services,ACCT-1,300,150,150,North America,Partner,USD,1',
  'A-101,L-102,2026-09-05,Analytics licence,Software,ACCT-2,800,440,360,Europe,Direct,USD,4',
].join('\n');
function cookieFrom(response) {
  const header = response.headers.get('set-cookie') || '';
  const match = /(?:^|;\s*)execubrief_session=([^;]+)/.exec(header);
  assert.ok(match, 'registration should issue a session cookie');
  return `execubrief_session=${decodeURIComponent(match[1])}`;
}
function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
async function fetchJson(url, options = {}) {
  const response = await fetch(url, options); const data = await response.json().catch(() => ({})); return { response, data };
}
async function setup(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'execubrief-org-test-'));
  const authStore = openAuthStore(':memory:'); const demoDatabase = createDatabase(':memory:');
  const app = createApp({
    authStore, demoDatabase,
    customDataDir: path.join(tmp, 'custom-data'),
    demoReportsDir: path.join(tmp, 'demo-reports'),
    reportsDir: path.join(tmp, 'private-reports'),
    customGenerate: async ({ database, startDate, endDate, outputDir, analytics }) => {
      const report = analytics({ database, startDate, endDate }); const id = crypto.randomUUID();
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, `${id}.pdf`), Buffer.from('%PDF-1.7\nworkspace integration test'));
      return { id, status: 'completed', createdAt: new Date().toISOString(), reportPeriod: { startDate, endDate }, summary: report.summary, email: { status: 'not_requested' } };
    },
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); authStore.close(); demoDatabase.close(); await fs.rm(tmp, { recursive: true, force: true }); });
  return { origin, authStore };
}
async function register(origin, email, organizationName) {
  const { response, data } = await fetchJson(`${origin}/api/auth/register`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, name: 'Workspace User', organizationName }),
  });
  assert.equal(response.status, 200, JSON.stringify(data));
  return { cookie: cookieFrom(response), csrf: data.csrfToken, user: data.user };
}

test('organisation import database accumulates analytics, import health, and rejects exact file re-imports', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'execubrief-org-db-'));
  const organizationId = crypto.randomUUID(); let workspace;
  t.after(async () => { closeOrganizationWorkspace(workspace); await fs.rm(temp, { recursive: true, force: true }); });
  workspace = await openOrganizationWorkspace(temp, organizationId);
  const preview = previewCustomCsv(CSV); const mapped = mapCustomCsv(CSV, preview.suggestedMapping, { skipInvalidRows: true, skipDuplicateLineItems: true, uploadId: 'first' });
  const hash = crypto.createHash('sha256').update(CSV).digest('hex');
  const first = insertWorkspaceImport(workspace.database, { sourceFile: 'q3.csv', fileHash: hash, mapping: preview.suggestedMapping, mapped, currency: 'USD', csvText: CSV });
  assert.equal(first.rowsImported, 3); assert.equal(first.status, 'completed');
  const exactDuplicate = insertWorkspaceImport(workspace.database, { sourceFile: 'q3.csv', fileHash: hash, mapping: preview.suggestedMapping, mapped, currency: 'USD', csvText: CSV });
  assert.equal(exactDuplicate.duplicateFile, true); assert.equal(exactDuplicate.rowsImported, 0);
  const data = getOrganizationAnalytics({ database: workspace.database, organization: { id: organizationId, name: 'Northstar Group' } });
  assert.equal(data.hasData, true); assert.equal(data.organization.name, 'Northstar Group');
  assert.equal(data.availablePeriod.startDate, '2026-09-01'); assert.equal(data.availablePeriod.endDate, '2026-09-05');
  assert.equal(data.summary.totalRevenue, 2300); assert.equal(data.summary.totalOrders, 2);
  assert.equal(data.summary.grossProfit, 990); assert.equal(data.summary.grossMarginPercent, 43);
  assert.equal(data.regions.length, 2); assert.equal(data.importHealth.rowsImported, 3); assert.equal(data.importHealth.successfulFiles, 1);
  assert.ok(data.filterOptions.categories.includes('Software')); assert.ok(data.filterOptions.regions.includes('Europe'));
  const filtered = getOrganizationAnalytics({ database: workspace.database, organization: { id: organizationId, name: 'Northstar Group' },
    startDate: '2026-09-01', endDate: '2026-09-05', filters: { category: 'Software', region: 'Europe' } });
  assert.equal(filtered.summary.totalRevenue, 800); assert.equal(filtered.summary.totalOrders, 1);
  assert.deepEqual(filtered.filters, { category: 'Software', region: 'Europe' });
  assert.deepEqual(filtered.regions.map((item) => item.label), ['Europe']);
  assert.equal(listWorkspaceImports(workspace.database).length, 2);
  assert.throws(() => getOrganizationAnalytics({ database: workspace.database, startDate: '2026-08-01', endDate: '2026-09-05' }), /within the imported data range/i);
});

test('custom preview honors manual date mapping and returns an honest available date range', async (t) => {
  const { origin } = await setup(t); const user = await register(origin, 'preview-owner@example.com', 'Preview Company');
  const result = await fetchJson(`${origin}/api/custom/csv/preview`, {
    method: 'POST', headers: { Cookie: user.cookie, Origin: origin, 'X-CSRF-Token': user.csrf, 'Content-Type': 'text/csv', 'X-ExecuBrief-Preview-Mapping': encode({ ...previewCustomCsv(CSV).suggestedMapping, date: 'Order Date' }) }, body: CSV,
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.availablePeriod, { startDate: '2026-09-01', endDate: '2026-09-05' });
  assert.equal(result.data.validRowCount, 3); assert.equal(result.data.detectedCurrency, 'USD');
});

test('organisation API imports data, renders workspace analytics and a real PDF, and keeps organisations separate', async (t) => {
  const { origin } = await setup(t);
  const first = await register(origin, 'owner-a@example.com', 'Acme Enterprise');
  const preview = await fetchJson(`${origin}/api/custom/csv/preview`, { method: 'POST', headers: { Cookie: first.cookie, Origin: origin, 'X-CSRF-Token': first.csrf, 'Content-Type': 'text/csv' }, body: CSV });
  assert.equal(preview.response.status, 200);
  const options = { filename: 'enterprise-q3.csv', currency: 'USD', columns: preview.data.suggestedMapping };
  const imported = await fetchJson(`${origin}/api/organization/imports`, { method: 'POST', headers: { Cookie: first.cookie, Origin: origin, 'X-CSRF-Token': first.csrf, 'Content-Type': 'text/csv', 'X-ExecuBrief-Import-Options': encode(options) }, body: CSV });
  assert.equal(imported.response.status, 201, JSON.stringify(imported.data)); assert.equal(imported.data.rowsImported, 3);
  const secondCsv = [
    'Order ID,Line Item ID,Order Date,Product,Category,Customer ID,Revenue,Cost,Gross Profit,Region,Sales Channel,Currency,Units',
    'A-102,L-103,2026-09-05,Warehouse connector,Software,ACCT-3,500,200,300,Asia,Direct,USD,1',
  ].join('\n');
  const secondImported = await fetchJson(`${origin}/api/organization/imports`, { method: 'POST', headers: { Cookie: first.cookie, Origin: origin, 'X-CSRF-Token': first.csrf, 'Content-Type': 'text/csv', 'X-ExecuBrief-Import-Options': encode({ filename: 'september-adjustment.csv', currency: 'USD', columns: preview.data.suggestedMapping }) }, body: secondCsv });
  assert.equal(secondImported.response.status, 201, JSON.stringify(secondImported.data)); assert.equal(secondImported.data.rowsImported, 1);
  const analytics = await fetchJson(`${origin}/api/organization/analytics?startDate=2026-09-01&endDate=2026-09-05`, { headers: { Cookie: first.cookie } });
  assert.equal(analytics.response.status, 200, JSON.stringify(analytics.data)); assert.equal(analytics.data.summary.totalRevenue, 2800); assert.equal(analytics.data.summary.totalOrders, 3); assert.equal(analytics.data.organization.name, 'Acme Enterprise');
  assert.equal(analytics.data.importHealth.successfulFiles, 2); assert.equal(analytics.data.importHealth.rowsImported, 4);
  assert.ok(analytics.data.filterOptions.categories.includes('Software')); assert.ok(analytics.data.filterOptions.regions.includes('Europe'));
  const filteredAnalytics = await fetchJson(`${origin}/api/organization/analytics?startDate=2026-09-01&endDate=2026-09-05&category=Software&region=Europe`, { headers: { Cookie: first.cookie } });
  assert.equal(filteredAnalytics.response.status, 200, JSON.stringify(filteredAnalytics.data));
  assert.equal(filteredAnalytics.data.summary.totalRevenue, 800); assert.equal(filteredAnalytics.data.summary.totalOrders, 1);
  const unsafeFilter = await fetchJson(`${origin}/api/organization/analytics?category=${'x'.repeat(151)}`, { headers: { Cookie: first.cookie } });
  assert.equal(unsafeFilter.response.status, 400);
  const importHistory = await fetchJson(`${origin}/api/organization/imports`, { headers: { Cookie: first.cookie } });
  assert.equal(importHistory.response.status, 200); assert.equal(importHistory.data.imports.length, 2);
  const generated = await fetchJson(`${origin}/api/organization/reports`, { method: 'POST', headers: { Cookie: first.cookie, Origin: origin, 'X-CSRF-Token': first.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Acme Monthly Brief', currency: 'USD', startDate: '2026-09-01', endDate: '2026-09-05' }) });
  assert.equal(generated.response.status, 201, JSON.stringify(generated.data));
  assert.equal(generated.data.summary.totalRevenue, 2800);
  const filteredGenerated = await fetchJson(`${origin}/api/organization/reports`, { method: 'POST', headers: { Cookie: first.cookie, Origin: origin, 'X-CSRF-Token': first.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Acme Europe Software Brief', currency: 'USD', startDate: '2026-09-01', endDate: '2026-09-05', category: 'Software', region: 'Europe' }) });
  assert.equal(filteredGenerated.response.status, 201, JSON.stringify(filteredGenerated.data));
  assert.equal(filteredGenerated.data.summary.totalRevenue, 800, 'the generated PDF summary should use the selected dimensions');
  const pdf = await fetch(`${origin}${generated.data.file}`, { headers: { Cookie: first.cookie } }); assert.equal(pdf.status, 200); assert.match(pdf.headers.get('content-type') || '', /application\/pdf/); assert.match(Buffer.from(await pdf.arrayBuffer()).toString('utf8'), /^%PDF-/);
  const second = await register(origin, 'owner-b@example.com', 'Contoso Separate');
  const otherAnalytics = await fetchJson(`${origin}/api/organization/analytics`, { headers: { Cookie: second.cookie } });
  assert.equal(otherAnalytics.response.status, 200); assert.equal(otherAnalytics.data.hasData, false); assert.equal(otherAnalytics.data.importHealth.rowsImported, 0);
  const otherHistory = await fetchJson(`${origin}/api/organization/imports`, { headers: { Cookie: second.cookie } }); assert.equal(otherHistory.data.imports.length, 0);
  const foreignPdf = await fetch(`${origin}${generated.data.file}`, { headers: { Cookie: second.cookie } }); assert.equal(foreignPdf.status, 404);
});
