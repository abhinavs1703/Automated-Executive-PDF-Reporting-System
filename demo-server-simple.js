/** @deprecated The synthetic dashboard is now served by the root Express app. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from './src/server.js';

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedFile && pathToFileURL(invokedFile).href === import.meta.url) {
  console.warn('[ExecuBrief] demo-server-simple.js is deprecated; prefer `npm start`.');
  try {
    startServer();
  } catch (error) {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
