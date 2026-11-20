import { nextCron } from '@local-agent/shared';
import type { Engine } from './engine.js';
import type { Store } from './db.js';

/** Heartbeat / watchdog schedules run on the fast local model and stay quiet when the reply is HEARTBEAT_OK. */
export function isHeartbeatSchedule(name: string, prompt: string): boolean {
  return /\[(heartbeat|watchdog)\]/i.test(`${name} ${prompt}`) || /^heartbeat:/i.test(prompt.trim());
}

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
        const heartbeat = isHeartbeatSchedule(schedule.name, schedule.prompt);
        const fastModel = heartbeat ? this.engine.autonomy.pickHelperModel('fast') : undefined;
        const prompt = heartbeat
          ? `${schedule.prompt}\n\n[Watchdog rule: If everything looks healthy and nothing needs the owner's attention, reply ONLY with "HEARTBEAT_OK". Otherwise write a concise alert.]`
          : schedule.prompt;
        const beforeCount = this.store.listMessages(session.id).length;
        await this.engine.startTurn({
          sessionId: session.id,
          agentId: schedule.agentId,
          content: prompt,
          modelId: fastModel?.id,
          background: true,
          onDone: heartbeat ? (finishedRun) => {
            const msgs = this.store.listMessages(session.id).slice(beforeCount);
            const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
            if (lastAssistant && /^\s*(HEARTBEAT_OK|NO_ALERT)\b/i.test(lastAssistant.content.trim())) {
              // Quietly drop the watchdog prompt & HEARTBEAT_OK reply so the chat and phone notifications stay noise-free.
              for (const m of msgs) this.store.db.prepare('DELETE FROM messages WHERE id = ?').run(m.id);
              this.store.updateSchedule(schedule.id, { lastStatus: `ok (quiet · ${finishedRun.modelId || 'fast'})` });
            }
          } : undefined,
        });
        const next = nextCron(schedule.cron, new Date()).toISOString();
        this.store.updateSchedule(schedule.id, { lastRunAt: new Date().toISOString(), nextRunAt: next, lastStatus: heartbeat ? 'watchdog started' : 'started' });
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
