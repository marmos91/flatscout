import cron, { type ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';
import type { LoadedPlugin } from './loader.js';

export interface ScheduleHandle {
  stop(): void;
}

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
