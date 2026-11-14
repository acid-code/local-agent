import { nextCron } from '@local-agent/shared';
import type { Engine } from './engine.js';
import type { Store } from './db.js';

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly store: Store, private readonly engine: Engine) {}

  start() {
    this.timer = setInterval(() => { void this.tick(); }, 20_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    const due = this.store.dueSchedules(new Date().toISOString());
    for (const schedule of due) {
      try {
        const session = schedule.sessionId
          ? this.store.getSession(schedule.sessionId)
          : this.store.createSession({ agentId: schedule.agentId, title: schedule.name });
        if (!session) throw new Error('Session missing.');
        if (!schedule.sessionId) this.store.updateSchedule(schedule.id, { sessionId: session.id });
        await this.engine.startTurn({ sessionId: session.id, agentId: schedule.agentId, content: schedule.prompt, background: true });
        const next = nextCron(schedule.cron, new Date()).toISOString();
        this.store.updateSchedule(schedule.id, { lastRunAt: new Date().toISOString(), nextRunAt: next, lastStatus: 'started' });
      } catch (error) {
        const next = safeNext(schedule.cron);
        this.store.updateSchedule(schedule.id, { lastRunAt: new Date().toISOString(), nextRunAt: next, lastStatus: error instanceof Error ? error.message : 'failed' });
      }
    }
  }
}

function safeNext(expr: string) {
  try { return nextCron(expr, new Date()).toISOString(); } catch { return new Date(Date.now() + 3600_000).toISOString(); }
}
