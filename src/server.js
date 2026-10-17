import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createApp } from './app.js';
import { config } from './config.js';
import { closeDefaultDatabase, getDefaultDatabase } from './db.js';
import { closeDemoDatabase, createDemoDatabase } from './demo-db.js';
import { closeAuthStore } from './auth-store.js';
import { assertSafeBinding } from './auth.js';
import { recoverStaleReports } from './report-service.js';
import { initScheduledReports } from './cron.js';

export { createApp };

/** Start exactly one HTTP listener. Importing this module never opens a socket. */
export function startServer({ app = createApp(), enableScheduler = true } = {}) {
  assertSafeBinding(config);
  if (process.env.SENDGRID_API_KEY) {
    console.warn('[Migration] SENDGRID_API_KEY is no longer used; remove it from your environment.');
  }
  const { database: demoDatabase } = createDemoDatabase();
  const recoveredPrivate = recoverStaleReports({ database: getDefaultDatabase() });
  const recoveredDemo = recoverStaleReports({ database: demoDatabase });
  if (recoveredPrivate > 0) console.warn(`[Startup] Marked ${recoveredPrivate} interrupted private report(s) as failed.`);
  if (recoveredDemo > 0) console.warn(`[Startup] Marked ${recoveredDemo} interrupted demo report(s) as failed.`);

  const server = app.listen(config.port, config.host, () => {
    console.log(`ExecuBrief listening on http://${config.host}:${config.port}`);
    if (!config.apiAuthToken) console.warn('[Security] API_AUTH_TOKEN is unset; private APIs are reachable only on loopback in development.');
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use.`);
    else console.error('Server failed to start.');
  });

  const scheduler = enableScheduler ? initScheduledReports() : null;
  let closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      let schedulerError;
      try { await scheduler?.stop(); } catch (error) { schedulerError = error; }
      await new Promise((resolve, reject) => {
        server.close((error) => {
          closeDefaultDatabase();
          closeDemoDatabase();
          closeAuthStore();
          if (error) reject(error);
          else resolve();
        });
      });
      if (schedulerError) throw schedulerError;
    })();
    return closePromise;
  };

  const onSignal = (signal) => {
    console.log(`[Server] Received ${signal}; shutting down.`);
    close().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return { app, server, scheduler, close };
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedFile && pathToFileURL(invokedFile).href === import.meta.url) {
  try {
    startServer();
  } catch (error) {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
