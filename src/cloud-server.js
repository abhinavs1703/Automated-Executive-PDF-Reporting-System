import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCloudApp } from './cloud-app.js';
import { config } from './config.js';
import { assertSafeBinding } from './auth.js';
import { createDemoDatabase, closeDemoDatabase } from './demo-db.js';
import { getDefaultDatabase, closeDefaultDatabase } from './db.js';
import { recoverStaleReports } from './report-service.js';
import { closeAuthStore } from './auth-store.js';
import { clearWorkspaceDatabaseCache } from './cloud-workspace.js';

export function startCloudServer({ app = createCloudApp() } = {}) {
  assertSafeBinding(config);
  const closeWorkspaceCache = () => clearWorkspaceDatabaseCache();
  // Only synthetic demo data is initialized locally. All private org imports and report
  // PDFs go to Supabase; /tmp demo history can reset when a free service wakes or redeploys.
  const { database: demoDatabase } = createDemoDatabase();
  recoverStaleReports({ database: getDefaultDatabase() });
  recoverStaleReports({ database: demoDatabase });
  const server = app.listen(config.port, config.host, () => {
    console.log(`ExecuBrief free cloud mode listening on ${config.host}:${config.port}`);
    console.log('Private account/workspace data: Supabase. Public demo cache: ephemeral local storage.');
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use.`);
    else console.error('Cloud server failed to start.');
  });
  let closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = new Promise((resolve, reject) => server.close((error) => {
      closeWorkspaceCache(); closeDefaultDatabase(); closeDemoDatabase(); closeAuthStore();
      if (error) reject(error); else resolve();
    }));
    return closePromise;
  };
  const onSignal = () => close().catch(() => { process.exitCode = 1; });
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  return { app, server, close };
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedFile && pathToFileURL(invokedFile).href === import.meta.url) {
  try { startCloudServer(); }
  catch (error) {
    console.error(`Cloud startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
