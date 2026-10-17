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

const CSV = `Order ID,Order Date,Product,Category,Customer,Revenue\nA-100,2026-09-01,Keyboard,Accessories,Ada,129.99\nA-100,2026-09-01,Mouse,Accessories,Ada,49.50\nA-101,2026-09-03,Monitor,Displays,Lin,1200.00\n`;
const PASSWORD = 'a-secure-test-password-for-app';

function parseCookie(setCookie) {
  const match = /(?:^|;\s*)execubrief_session=([^;]+)/.exec(setCookie || '');
  assert.ok(match, 'session cookie should be issued');
  return `execubrief_session=${decodeURIComponent(match[1])}`;
}

function encodeOptions(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function startTestApp(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'execubrief-workspace-'));
  const authStore = openAuthStore(':memory:');
  const demoDatabase = createDatabase(':memory:');
  const app = createApp({
    authStore,
    demoDatabase,
    customDataDir: path.join(tempDir, 'custom-data'),
    demoReportsDir: path.join(tempDir, 'demo-reports'),
    reportsDir: path.join(tempDir, 'private-reports'),
    customGenerate: async ({ database, startDate, endDate, outputDir, analytics }) => {
      const reportData = analytics({ database, startDate, endDate });
      const id = crypto.randomUUID();
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, `${id}.pdf`), Buffer.from('%PDF-1.7\nSynthetic test PDF bytes'));
      return { id, status: 'completed', createdAt: new Date().toISOString(), reportPeriod: { startDate, endDate }, summary: reportData.summary, email: { status: 'not_requested' } };
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    authStore.close();
    demoDatabase.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  return { origin, authStore };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

test('custom reporting pages require authentication and preserve the public dashboard', async (t) => {
  const { origin } = await startTestApp(t);
  const home = await fetch(`${origin}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Executive overview/);
  const workspace = await fetch(`${origin}/custom-reports`, { redirect: 'manual' });
  assert.equal(workspace.status, 303);
  assert.equal(workspace.headers.get('location'), '/login?next=%2Fcustom-reports');
  const organisationWorkspace = await fetch(`${origin}/workspace`, { redirect: 'manual' });
  assert.equal(organisationWorkspace.status, 303);
  assert.equal(organisationWorkspace.headers.get('location'), '/login?next=%2Fworkspace');
  const preview = await fetchJson(`${origin}/api/custom/csv/preview`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: CSV });
  assert.equal(preview.response.status, 401);
});

test('account registration, CSV preview, custom PDF generation, history and download are user-scoped', async (t) => {
  const { origin, authStore } = await startTestApp(t);
  const registration = await fetchJson(`${origin}/api/auth/register`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', password: PASSWORD, name: 'Workspace Owner', organizationName: 'Northwind Analytics' }),
  });
  assert.equal(registration.response.status, 200);
  assert.equal(registration.data.user.email, 'owner@example.com');
  assert.equal(registration.data.user.organization.name, 'Northwind Analytics');
  assert.equal(registration.data.user.organization.role, 'owner');
  const cookie = parseCookie(registration.response.headers.get('set-cookie'));
  const organisationPage = await fetch(`${origin}/workspace`, { headers: { Cookie: cookie } });
  assert.equal(organisationPage.status, 200);
  assert.match(organisationPage.headers.get('content-type') || '', /text\/html/);
  assert.match(await organisationPage.text(), /Executive Pulse/);
  const workspaceScript = await fetch(`${origin}/organization-dashboard.js`);
  assert.equal(workspaceScript.status, 200);
  assert.match(workspaceScript.headers.get('content-type') || '', /javascript/);
  const workspaceStyles = await fetch(`${origin}/workspace.css`);
  assert.equal(workspaceStyles.status, 200);
  assert.match(await workspaceStyles.text(), /org-kpi-grid/);

  const validLogin = await fetchJson(`${origin}/api/auth/login`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', password: PASSWORD }),
  });
  assert.equal(validLogin.response.status, 200, JSON.stringify(validLogin.data));
  assert.equal(validLogin.data.user.organization.id, registration.data.user.organization.id);

  const unknownLogin = await fetchJson(`${origin}/api/auth/login`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'random-user-not-registered@example.com', password: PASSWORD }),
  });
  assert.equal(unknownLogin.response.status, 401);
  assert.match(unknownLogin.data.error, /Email or password is incorrect/);
  assert.doesNotMatch(JSON.stringify(unknownLogin.data), /Internal server error/);

  let me = await fetchJson(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.response.status, 200);
  assert.equal(me.data.user.organization.id, registration.data.user.organization.id);
  assert.ok(me.data.csrfToken);

  const preview = await fetchJson(`${origin}/api/custom/csv/preview`, {
    method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': me.data.csrfToken, 'Content-Type': 'text/csv' }, body: CSV,
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.data.rowCount, 3);
  assert.equal(preview.data.suggestedMapping.date, 'Order Date');
  assert.equal(preview.data.suggestedPeriod.startDate, '2026-09-01');

  const options = {
    filename: 'quarterly-sales.csv', title: 'Northwind Custom Brief', currency: 'INR',
    columns: preview.data.suggestedMapping, startDate: '2026-09-01', endDate: '2026-09-03',
  };
  const created = await fetchJson(`${origin}/api/custom/reports`, {
    method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': me.data.csrfToken, 'Content-Type': 'text/csv', 'X-ExecuBrief-Options': encodeOptions(options) }, body: CSV,
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.title, 'Northwind Custom Brief');
  assert.equal(created.data.currency, 'INR');
  assert.equal(created.data.summary.totalOrders, 2);
  assert.equal(created.data.summary.totalRevenue, 1379.49);
  assert.ok(created.data.file.endsWith('/file'));

  const history = await fetchJson(`${origin}/api/custom/reports`, { headers: { Cookie: cookie } });
  assert.equal(history.response.status, 200);
  assert.equal(history.data.reports.length, 1);
  assert.equal(history.data.reports[0].sourceFile, 'quarterly-sales.csv');
  const pdf = await fetch(`${origin}${created.data.file}`, { headers: { Cookie: cookie } });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /application\/pdf/);
  assert.match(pdf.headers.get('content-disposition'), /inline/);
  assert.match(Buffer.from(await pdf.arrayBuffer()).toString('utf8'), /^%PDF-/);

  const download = await fetch(`${origin}${created.data.download}`, { headers: { Cookie: cookie } });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment/);

  const other = await authStore.register({ email: 'other@example.com', password: PASSWORD, name: 'Other User', organizationName: 'Other Organisation' });
  const otherSession = authStore.createSession(other.id);
  const foreignPdf = await fetch(`${origin}${created.data.file}`, { headers: { Cookie: `execubrief_session=${otherSession.rawToken}` } });
  assert.equal(foreignPdf.status, 404);
});

test('custom CSV mutations require a same-origin CSRF token and invalid CSV is rejected before report generation', async (t) => {
  const { origin } = await startTestApp(t);
  const registration = await fetchJson(`${origin}/api/auth/register`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'csrf@example.com', password: PASSWORD, name: 'CSRF Test' }),
  });
  const cookie = parseCookie(registration.response.headers.get('set-cookie'));
  const noCsrf = await fetchJson(`${origin}/api/custom/csv/preview`, {
    method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'text/csv' }, body: CSV,
  });
  assert.equal(noCsrf.response.status, 403);
  const badCsrf = await fetchJson(`${origin}/api/custom/csv/preview`, {
    method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.example', 'X-CSRF-Token': registration.data.csrfToken, 'Content-Type': 'text/csv' }, body: CSV,
  });
  assert.equal(badCsrf.response.status, 403);
  const me = await fetchJson(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
  const invalidCsv = await fetchJson(`${origin}/api/custom/csv/preview`, {
    method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': me.data.csrfToken, 'Content-Type': 'text/csv' }, body: 'Date,Product,Amount\n2026-01-01,Widget',
  });
  assert.equal(invalidCsv.response.status, 400);
});
