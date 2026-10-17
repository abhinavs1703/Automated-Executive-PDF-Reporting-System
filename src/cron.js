import cron from 'node-cron';
import { config } from './config.js';
import { generateReport } from './report-service.js';

/**
 * Runs the scheduled report with an overlap guard: if the previous run is still
 * in progress when the next tick fires, the tick is skipped (and logged).
 */
export function createScheduledRunner({ generate = generateReport, sendEmail = false, logger = console } = {}) {
  let running = false;
  return {
    isRunning: () => running,
    async run() {
      if (running) {
        logger.warn('[Scheduler] Previous report run is still in progress; skipping this tick to avoid overlap.');
        return { skipped: true };
      }
      running = true;
      try {
        logger.log(`[Scheduler] Starting weekly report. Email enabled: ${sendEmail}`);
        const result = await generate({ sendEmail });
        logger.log(`[Scheduler] Report ${result.id} completed; email status: ${result.email.status}`);
        if (result.email.status === 'failed') logger.error(`[Scheduler] Email delivery failed: ${result.email.error}`);
        return { skipped: false, result };
      } catch (error) {
        logger.error(`[Scheduler] Report generation failed (${error.stage ?? 'unknown stage'}): ${error.message}`);
        return { skipped: false, error };
      } finally {
        running = false;
      }
    },
  };
}

/**
 * Start the weekly job. Options default to the environment configuration but can
 * be overridden (used by tests). Returns null when the scheduler is disabled.
 */
export function initScheduledReports({
  generate = generateReport,
  enabled = config.enableScheduler,
  schedule = config.reportCronSchedule,
  timezone = config.reportTimezone,
  sendEmail = config.emailEnabled,
  logger = console,
} = {}) {
  if (!enabled) {
    logger.log('[Scheduler] Disabled. Set ENABLE_SCHEDULER=true to enable weekly automation.');
    return null;
  }
  if (!cron.validate(schedule)) throw new Error(`Invalid REPORT_CRON_SCHEDULE: ${schedule}`);

  const runner = createScheduledRunner({ generate, sendEmail, logger });
  // noOverlap is node-cron's own guard; the runner's flag is the one we test and log.
  const task = cron.schedule(schedule, () => runner.run(), { timezone, noOverlap: true });
  logger.log(`[Scheduler] Enabled with "${schedule}" in ${timezone}.`);
  return { task, runner, stop: async () => { await task.destroy(); } };
}
