import cron, { type ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';
import type { LoadedPlugin } from './loader.js';

export interface ScheduleHandle {
  stop(): void;
}

/**
 * Schedules each source for periodic execution under node-cron.
 *
 * Reads the cron expression from each source's config `schedule` field
 * (defaulting to `*\/5 * * * *`); invalid expressions are logged and skipped.
 * Returns a handle whose `stop()` halts every scheduled task. The orchestrator
 * is responsible for actually running the source via the provided `runOne`
 * callback — this function only handles scheduling and error logging.
 */
export function scheduleSources(
  sources: LoadedPlugin<'source'>[],
  logger: Logger,
  runOne: (s: LoadedPlugin<'source'>) => Promise<void>,
): ScheduleHandle {
  const tasks: ScheduledTask[] = [];
  for (const s of sources) {
    const sched = (s.config as { schedule?: string } | undefined)?.schedule ?? '*/5 * * * *';
    if (!cron.validate(sched)) {
      logger.error({ source: s.name, schedule: sched }, 'invalid cron expression');
      continue;
    }
    const task = cron.schedule(sched, async () => {
      try {
        await runOne(s);
      } catch (err) {
        logger.error({ source: s.name, err }, 'scheduled run failed');
      }
    });
    task.start();
    tasks.push(task);
    logger.info({ source: s.name, schedule: sched }, 'scheduled');
  }
  return {
    stop() {
      for (const t of tasks) t.stop();
    },
  };
}
