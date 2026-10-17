/**
 * Legacy compatibility launcher. The dashboard now runs inside the single root
 * Express application; this file intentionally contains no routes or listener of
 * its own. Prefer `npm start` from the project root.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../src/server.js';

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedFile && pathToFileURL(invokedFile).href === import.meta.url) {
  console.warn('[ExecuBrief] dashboard/server.js is deprecated; prefer `npm start`.');
  try {
    startServer();
  } catch (error) {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
