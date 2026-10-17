import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createCloudApp } from '../src/cloud-app.js';

function makeFakeStore() {
  return {
    async select(table) { assert.equal(table, 'organizations'); return []; },
  };
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('cloud app serves health/readiness and preserves protected workspace redirects', async () => {
  const local = express();
  local.get('/', (_req, res) => res.status(200).send('demo overview'));
  const app = createCloudApp({ store: makeFakeStore(), localApp: local, tempRoot: '/tmp/execubrief-cloud-test' });
  await withServer(app, async (origin) => {
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', mode: 'cloud-free' });

    const ready = await fetch(`${origin}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: 'ready' });

    const workspace = await fetch(`${origin}/workspace`, { redirect: 'manual' });
    assert.equal(workspace.status, 303);
    assert.equal(workspace.headers.get('location'), '/login?next=%2Fworkspace');

    const overview = await fetch(origin);
    assert.equal(overview.status, 200);
    assert.equal(await overview.text(), 'demo overview');
    assert.match(overview.headers.get('content-security-policy') || '', /default-src 'self'/);
  });
});
