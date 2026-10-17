import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledRunner, initScheduledReports } from '../src/cron.js';

const silent = () => ({ log() {}, warn() {}, error() {}, messages: [] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const okResult = { id: 'r1', email: { status: 'not_requested' } };

test('overlap guard: a tick fired while a run is in progress is skipped, and the next run works afterwards', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runner = createScheduledRunner({ logger: silent(), generate: async () => { calls += 1; await gate; return okResult; } });

  const first = runner.run();
  assert.equal(runner.isRunning(), true);
  const overlapping = await runner.run();
  assert.deepEqual(overlapping, { skipped: true });
  assert.equal(calls, 1);

  release();
  assert.equal((await first).skipped, false);
  assert.equal(runner.isRunning(), false);
  await runner.run();
  assert.equal(calls, 2);
});

test('overlap guard releases the lock when generation throws', async () => {
  const runner = createScheduledRunner({ logger: silent(), generate: async () => { throw Object.assign(new Error('boom'), { stage: 'render' }); } });
  const outcome = await runner.run();
  assert.equal(outcome.error.message, 'boom');
  assert.equal(runner.isRunning(), false);
});

test('scheduler passes the configured sendEmail flag to the report service', async () => {
  const seen = [];
  const runner = createScheduledRunner({ sendEmail: true, logger: silent(), generate: async (opts) => { seen.push(opts); return okResult; } });
  await runner.run();
  assert.deepEqual(seen, [{ sendEmail: true }]);
});

test('scheduler is disabled by default and validates its cron expression', () => {
  assert.equal(initScheduledReports({ enabled: false, logger: silent() }), null);
  assert.throws(() => initScheduledReports({ enabled: true, schedule: 'not a cron', logger: silent() }), /Invalid REPORT_CRON_SCHEDULE/);
});

test('real cron scheduling: the job fires on schedule and slow runs never overlap', async () => {
  let started = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const scheduler = initScheduledReports({
    enabled: true,
    schedule: '* * * * * *', // every second (node-cron v4 seconds field)
    timezone: 'UTC',
    sendEmail: false,
    logger: silent(),
    generate: async () => {
      started += 1; concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(1600); // longer than the tick interval
      concurrent -= 1;
      return okResult;
    },
  });
  try {
    await sleep(3600);
  } finally {
    await scheduler.stop();
  }
  await sleep(1800); // let the in-flight run finish
  assert.ok(started >= 1, 'the cron job fired at least once');
  assert.equal(maxConcurrent, 1, 'runs never overlapped');
  assert.ok(started <= 3, `ticks during a running job were skipped (started=${started})`);
});
