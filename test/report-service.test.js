import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../src/db.js';
import { generateReport } from '../src/report-service.js';

function setupDatabase() {
  const database = createDatabase(':memory:');
  database.prepare('INSERT INTO orders (customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?)')
    .run('Test Customer', 'Keyboard', 99.99, '2026-09-29T12:00:00.000Z', 'Accessories');
  return database;
}

test('report service tracks a completed PDF and successful email separately', async () => {
  const database = setupDatabase();
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'executive-report-service-'));
  try {
    const result = await generateReport({
      database,
      startDate: '2026-09-28',
      endDate: '2026-10-04',
      sendEmail: true,
      outputDir,
      pdfRenderer: async (_reportData, outputPath) => { await fs.writeFile(outputPath, '%PDF-1.4 mock'); return outputPath; },
      emailSender: async () => ({ accepted: true, statusCode: 202 }),
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.email.status, 'sent');
    const row = database.prepare('SELECT status, email_status FROM reports WHERE id = ?').get(result.id);
    assert.equal(row.status, 'completed');
    assert.equal(row.email_status, 'sent');
  } finally {
    database.close();
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('report service does not attempt email when PDF rendering fails', async () => {
  const database = setupDatabase();
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'executive-report-failure-'));
  let emailCalls = 0;
  try {
    await assert.rejects(generateReport({
      database,
      startDate: '2026-09-28',
      endDate: '2026-10-04',
      sendEmail: true,
      outputDir,
      pdfRenderer: async () => { throw new Error('browser rendering failed'); },
      emailSender: async () => { emailCalls += 1; return { accepted: true }; },
    }), /browser rendering failed/);
    assert.equal(emailCalls, 0);
    const row = database.prepare('SELECT status, email_status, error FROM reports ORDER BY created_at DESC LIMIT 1').get();
    assert.equal(row.status, 'failed');
    assert.equal(row.email_status, 'not_sent');
    assert.match(row.error, /browser rendering failed/);
  } finally {
    database.close();
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
