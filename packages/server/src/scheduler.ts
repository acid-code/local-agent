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
        const linked = schedule.sessionId ? this.store.getSession(schedule.sessionId) : null;
        // A deleted chat gets a fresh one rather than a reply nobody sees.
        const session = linked && !linked.archived ? linked : this.store.createSession({ agentId: schedule.agentId, title: schedule.name });
        if (!session) throw new Error('Session missing.');
        if (session.id !== schedule.sessionId) this.store.updateSchedule(schedule.id, { sessionId: session.id });
        // The chat is mid-reply: try again in a minute instead of skipping this run.
        if (this.engine.sessionBusy(session.id)) {
          this.store.updateSchedule(schedule.id, { nextRunAt: new Date(Date.now() + 60_000).toISOString(), lastStatus: 'Waiting for the chat to finish its reply.' });
          continue;
        }
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
