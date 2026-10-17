#!/usr/bin/env node
import { createDemoDatabase, closeDemoDatabase } from '../src/demo-db.js';

try {
  const { database } = createDemoDatabase();
  const counts = database.prepare(`
    SELECT COUNT(DISTINCT order_id) AS orders, COUNT(*) AS lineItems FROM orders
  `).get();
  console.log('ExecuBrief synthetic demo storage is initialized.');
  console.log(`Synthetic orders: ${counts.orders}; line items: ${counts.lineItems}.`);
  console.log('This command never resets the private database or overwrites dashboard source files.');
} catch (error) {
  console.error(`Demo initialization failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  closeDemoDatabase();
}
