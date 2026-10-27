import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseCloudStore, CloudStoreError } from '../src/cloud-store.js';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('cloud store keeps the service-role key server-side and uses it for REST requests', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse([{ id: 'example-id' }]));
  const store = new SupabaseCloudStore({ url: 'https://example.supabase.co', serviceRoleKey: 'server-only-secret', fetchImpl });
  const rows = await store.select('organizations', { select: 'id', limit: '1' });
  assert.deepEqual(rows, [{ id: 'example-id' }]);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].options.headers.apikey, 'server-only-secret');
  assert.equal(fetchImpl.calls[0].options.headers.Authorization, 'Bearer server-only-secret');
  assert.match(fetchImpl.calls[0].url, /rest\/v1\/organizations/);
});

test('modern sb_secret keys are sent on apikey and never treated as Bearer JWTs', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse([{ id: 'example-id' }]));
  const store = new SupabaseCloudStore({ url: 'https://example.supabase.co', serviceRoleKey: 'sb_secret_example_secret_key', fetchImpl });
  const rows = await store.select('organizations', { select: 'id', limit: '1' });
  assert.deepEqual(rows, [{ id: 'example-id' }]);
  assert.equal(fetchImpl.calls[0].options.headers.apikey, 'sb_secret_example_secret_key');
  assert.equal(Object.hasOwn(fetchImpl.calls[0].options.headers, 'Authorization'), false);
});

test('readiness verifies both the database API and configured private storage bucket', async () => {
  const fetchImpl = fakeFetch(async (url) => jsonResponse(url.includes('/storage/v1/bucket/execubrief-private') ? { id: 'execubrief-private', public: false } : []));
  const store = new SupabaseCloudStore({ url: 'https://example.supabase.co', serviceRoleKey: 'sb_secret_example_secret_key', fetchImpl });
  assert.equal(await store.checkReadiness(), true);
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[0].url, /rest\/v1\/organizations/);
  assert.match(fetchImpl.calls[1].url, /storage\/v1\/bucket\/execubrief-private/);
  assert.equal(fetchImpl.calls.every((call) => call.options.headers.apikey === 'sb_secret_example_secret_key'), true);
});

test('storage upload uses Supabase-compatible cache-control metadata and keeps bytes raw', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse({ Key: 'execubrief-private/org/csv/file.csv' }, 200));
  const store = new SupabaseCloudStore({ url: 'https://example.supabase.co', serviceRoleKey: 'sb_secret_example_secret_key', fetchImpl });
  const bytes = new Uint8Array([97, 44, 98, 10, 49, 44, 50]);
  await store.uploadObject('org/csv/file.csv', bytes, 'text/csv');
  const call = fetchImpl.calls[0];
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['Content-Type'], 'text/csv');
  assert.equal(call.options.headers['x-upsert'], 'true');
  assert.equal(call.options.headers['cache-control'], 'max-age=0');
  assert.equal(call.options.headers.apikey, 'sb_secret_example_secret_key');
  assert.equal(Object.hasOwn(call.options.headers, 'Authorization'), false);
  assert.deepEqual(call.options.body, bytes);
  assert.match(call.url, /storage\/v1\/object\/execubrief-private\/org\/csv\/file.csv/);
});

test('cloud store rejects unsafe object paths before making a network request', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse({ ok: true }));
  const store = new SupabaseCloudStore({ url: 'https://example.supabase.co', serviceRoleKey: 'server-only-secret', fetchImpl });
  await assert.rejects(() => store.downloadObject('../another-org/private.pdf'), (error) => error instanceof CloudStoreError && error.code === 'INVALID_STORAGE_PATH');
  assert.equal(fetchImpl.calls.length, 0);
});

test('cloud store does not echo the service-role key or raw remote response on upstream failure', async () => {
  const fetchImpl = fakeFetch(async () => new Response(JSON.stringify({ code: '42501', message: 'permission denied' }), { status: 403 }));
  const store = new SupabaseCloudStore({ url: 'https://example.supabase.co', serviceRoleKey: 'server-only-secret', fetchImpl });
  await assert.rejects(() => store.select('organizations'), (error) => {
    assert.ok(error instanceof CloudStoreError);
    assert.equal(error.status, 503);
    assert.equal(error.message.includes('server-only-secret'), false);
    assert.equal(error.message.includes('permission denied'), false);
    return true;
  });
});

test('cloud store refuses a production Supabase URL that is not HTTPS', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => new SupabaseCloudStore({ url: 'http://example.supabase.co', serviceRoleKey: 'server-only-secret' }),
      (error) => error instanceof CloudStoreError && error.code === 'CLOUD_CONFIG_INVALID');
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
});
