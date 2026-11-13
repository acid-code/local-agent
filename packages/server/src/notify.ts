import fs from 'node:fs';
import path from 'node:path';
import type { Bus } from './bus.js';
import type { Engine } from './engine.js';
import type { Store } from './db.js';

interface PushSub { endpoint: string; keys: { p256dh: string; auth: string } }

export class Notifier {
  private offset = 0;
  private timer: NodeJS.Timeout | null = null;
  private seen = new Map<string, number>();

  constructor(private readonly store: Store, private readonly bus: Bus, private readonly engine: Engine, private readonly dataDir: string, private readonly fetchImpl: typeof fetch) {}

  start() {
    this.bus.subscribeAll((event) => { void this.onEvent(event); });
    this.timer = setInterval(() => { void this.pollTelegram(); }, 4000);
    void this.pollTelegram();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private token() { return process.env.TELEGRAM_BOT_TOKEN || ''; }
  private chat() { return process.env.TELEGRAM_CHAT_ID || ''; }

  private async onEvent(event: { type: string; runId?: string; approval?: { id: string; toolName?: string; reason?: string }; message?: string; exhausted?: boolean }) {
    if (event.type === 'approval' && event.approval) {
      await this.push(`Approval needed: ${event.approval.toolName || 'action'}\n${event.approval.reason || ''}`, [
        [{ text: 'Approve', callback_data: `ok:${event.approval.id}` }, { text: 'Deny', callback_data: `no:${event.approval.id}` }],
      ]);
    } else if (event.type === 'error' && event.message) {
      await this.pushOnce(`fail:${event.runId}`, `Run failed: ${event.message}`);
    } else if (event.type === 'quota' && event.exhausted) {
      await this.pushOnce(`quota:${new Date().toISOString().slice(0, 10)}`, 'Gemini quota is used up. New turns stay on the local model.');
    } else if (event.type === 'watch') {
      await this.pushOnce(`watch:${event.message}`, String(event.message));
    }
  }

  async push(text: string, keyboard?: { text: string; callback_data: string }[][]) {
    await this.telegram(text, keyboard);
    await this.webPush(text);
    this.store.addLog('info', `Notice: ${text.slice(0, 180)}`);
  }

  private async pushOnce(key: string, text: string) {
    const last = this.seen.get(key) ?? 0;
    if (Date.now() - last < 30 * 60_000) return;
    this.seen.set(key, Date.now());
    await this.push(text);
  }

  private async telegram(text: string, keyboard?: { text: string; callback_data: string }[][]) {
    if (!this.token() || !this.chat()) return;
    await this.fetchImpl(`https://api.telegram.org/bot${this.token()}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chat(),
        text: text.slice(0, 3500),
        reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
      }),
    }).catch(() => undefined);
  }

  private async pollTelegram() {
    if (!this.token()) return;
    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token()}/getUpdates?timeout=0&offset=${this.offset}`);
      if (!response.ok) return;
      const body = await response.json() as { result?: { update_id: number; callback_query?: { id: string; data?: string } }[] };
      for (const update of body.result ?? []) {
        this.offset = update.update_id + 1;
        const data = update.callback_query?.data || '';
        const [action, id] = data.split(':');
        if (update.callback_query && id && (action === 'ok' || action === 'no')) {
          try { this.engine.decideApproval(id, action === 'ok' ? 'approved' : 'denied'); } catch { /* already resolved */ }
          await this.fetchImpl(`https://api.telegram.org/bot${this.token()}/answerCallbackQuery`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ callback_query_id: update.callback_query.id, text: action === 'ok' ? 'Approved' : 'Denied' }),
          }).catch(() => undefined);
        }
      }
    } catch { /* telegram is optional */ }
  }

  private async webPush(text: string) {
    const subs = this.subscriptions();
    if (!subs.length) return;
    let webpush: { setVapidDetails: (subject: string, pub: string, priv: string) => void; sendNotification: (sub: PushSub, payload: string) => Promise<unknown> };
    try {
      webpush = (await import('web-push')).default as typeof webpush;
    } catch {
      return;
    }
    const vapid = this.vapid(webpush as unknown as { generateVAPIDKeys?: () => { publicKey: string; privateKey: string } });
    if (!vapid) return;
    webpush.setVapidDetails('mailto:owner@local-agent.local', vapid.publicKey, vapid.privateKey);
    await Promise.all(subs.map((sub) => webpush.sendNotification(sub, JSON.stringify({ title: 'local-agent', body: text.slice(0, 180) })).catch(() => undefined)));
  }

  publicKey(): string | null {
    const file = path.join(this.dataDir, 'vapid.json');
    if (!fs.existsSync(file)) return null;
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { publicKey: string }).publicKey;
  }

  private vapid(webpush: { generateVAPIDKeys?: () => { publicKey: string; privateKey: string } }) {
    const file = path.join(this.dataDir, 'vapid.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as { publicKey: string; privateKey: string };
    if (!webpush.generateVAPIDKeys) return null;
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
    return keys;
  }

  addSubscription(sub: PushSub) {
    const all = this.subscriptions().filter((item) => item.endpoint !== sub.endpoint);
    all.push(sub);
    fs.writeFileSync(path.join(this.dataDir, 'push-subs.json'), JSON.stringify(all));
  }

  private subscriptions(): PushSub[] {
    const file = path.join(this.dataDir, 'push-subs.json');
    if (!fs.existsSync(file)) return [];
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as PushSub[]; } catch { return []; }
  }
}
