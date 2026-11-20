// Один исполнитель расписаний. Время — UTC, как в cron-триггерах Cloudflare.
export function dueCrons(date) {
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const day = date.getUTCDate();
  const weekday = date.getUTCDay(); // 0 = Sunday, 1 = Monday
  const due = [];
  if (minute % 15 === 0) due.push('*/15 * * * *');
  if (hour === 3 && minute === 0) due.push('0 3 * * *');
  if (weekday === 1 && hour === 7 && minute === 0) due.push('0 7 * * 1');
  if (day === 1 && hour === 6 && minute === 0) due.push('0 6 1 * *');
  return due;
}

const minuteKey = (cron, date) => cron + '@' + date.toISOString().slice(0, 16);

export function startScheduler({scheduled, env, logger = console, intervalMs = 15000}) {
  const seen = new Map();
  let stopped = false;
  let running = false;

  const prune = (now) => {
    const cutoff = now.getTime() - 10 * 60 * 1000;
    for (const [key, at] of seen) if (at < cutoff) seen.delete(key);
  };

  async function tick() {
    if (stopped || running) return;
    running = true;
    const now = new Date();
    try {
      for (const cron of dueCrons(now)) {
        const key = minuteKey(cron, now);
        if (seen.has(key)) continue;
        seen.set(key, now.getTime());
        const pending = new Set();
        const ctx = {
          waitUntil(promise) {
            const task = Promise.resolve(promise).catch((error) => {
              logger.error?.('scheduler-task-failed', cron, error?.code || error?.name || 'Error');
            });
            pending.add(task);
            task.finally(() => pending.delete(task));
          },
        };
        try {
          await scheduled({cron, scheduledTime: now.getTime()}, env, ctx);
          await Promise.all([...pending]);
          logger.log?.('scheduler-ran', cron);
        } catch (error) {
          logger.error?.('scheduler-failed', cron, error?.code || error?.name || 'Error');
        }
      }
      prune(now);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    tick().catch((error) => logger.error?.('scheduler-tick-failed', error?.code || error?.name || 'Error'));
  }, intervalMs);
  timer.unref?.();
  tick().catch((error) => logger.error?.('scheduler-tick-failed', error?.code || error?.name || 'Error'));

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tickOnce: tick,
  };
}
