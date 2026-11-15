import { test as base, expect, type APIRequestContext, type Page, type BrowserContext } from '@playwright/test';
import { FakeOllama } from './fake-ollama';
import { startServer, type RunningServer } from './server';

export const OWNER = { username: 'owner', password: ['e2e', 'owner', 'pass', '42'].join('-') };
export const MEMBER = { username: 'noa', password: ['e2e', 'member', 'pass', '42'].join('-') };

interface Fixtures {
  ollama: FakeOllama;
  server: RunningServer;
  /** A browser page already signed in as the owner, with models discovered. */
  owner: Page;
  api: APIRequestContext;
  consoleErrors: string[];
  /** Extra server env for one spec: test.use({ serverEnv: { ... } }). */
  serverEnv: Record<string, string>;
}

/** Console errors and page errors fail the test (except network errors the test causes on purpose). */
export const test = base.extend<Fixtures>({
  serverEnv: [{}, { option: true }],
  consoleErrors: async ({}, use) => { await use([]); },
  ollama: async ({}, use) => { const fake = await new FakeOllama().start(); await use(fake); await fake.stop(); },
  server: async ({ ollama, serverEnv }, use) => { const server = await startServer({ ollamaUrl: ollama.url, env: serverEnv }); await use(server); await server.stop(); },
  api: async ({ playwright, server }, use) => {
    const ctx = await playwright.request.newContext({ baseURL: server.url });
    const setup = await ctx.post('/api/setup', { data: OWNER });
    expect(setup.status(), await setup.text()).toBeLessThan(300);
    await ctx.post('/api/models/scan');
    await use(ctx);
    await ctx.dispose();
  },
  owner: async ({ browser, server, api, consoleErrors }, use, info) => {
    const state = await api.storageState();
    const context = await browser.newContext({ baseURL: server.url, storageState: state, viewport: { width: 1280, height: 820 } });
    const page = await context.newPage();
    watch(page, consoleErrors);
    await page.goto('/');
    await use(page);
    await context.close();
    const unexpected = consoleErrors.filter((line) => !ALLOWED.some((pattern) => pattern.test(line)));
    if (info.status === 'passed') expect(unexpected, 'console errors').toEqual([]);
  },
});

/** Errors a test provokes on purpose (403s, an Ollama outage, a full disk) show up as failed requests; those are fine. */
export const ALLOWED = [/status of (401|403|404|409|413|429|500|502|503|507)/, /WebSocket connection .* failed/, /net::ERR_/];

export function watch(page: Page, sink: string[]) {
  page.on('console', (message) => { if (message.type() === 'error') sink.push(message.text()); });
  page.on('pageerror', (error) => sink.push(`pageerror: ${error.message}`));
}

export async function signIn(context: BrowserContext, who: { username: string; password: string }, existing?: Page) {
  const page = existing ?? await context.newPage();
  await page.goto('/');
  await page.fill('input[autocomplete="username"]', who.username);
  await page.fill('input[type="password"]', who.password);
  await page.click('button[type="submit"]');
  await expect(page.locator('.sidebar')).toBeVisible();
  return page;
}

/** Sends a message from the composer and waits for the reply text. */
export async function send(page: Page, text: string) {
  // Wait until a chat is open (the persona pill shows), like a person would.
  await page.locator('.persona-name').first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  const box = page.getByRole('textbox', { name: /message/i }).first();
  await box.fill(text);
  await box.press('Enter');
}

export async function firstAgent(api: APIRequestContext) {
  const agents = (await (await api.get('/api/agents')).json()).agents as { id: string; name: string }[];
  return agents[0]!;
}

export { expect };

/** A persona with the given tools, plus a chat for it; returns ids. */
export async function personaWithChat(api: APIRequestContext, name: string, tools: string[]) {
  const agent = (await (await api.post('/api/agents', { data: { name, systemPrompt: 'Follow the user.', toolAllowlist: tools } })).json()).agent as { id: string };
  const session = (await (await api.post('/api/sessions', { data: { agentId: agent.id, title: `${name} chat` } })).json()).session as { id: string };
  return { agentId: agent.id, sessionId: session.id };
}

export async function waitForRun(api: APIRequestContext, sessionId: string, statuses = ['completed', 'failed', 'stopped', 'interrupted', 'awaiting_approval']) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const runs = ((await (await api.get('/api/runs')).json()).runs as { id: string; sessionId: string; status: string; error?: string }[]).filter((run) => run.sessionId === sessionId);
    const latest = runs[0];
    if (latest && statuses.includes(latest.status)) return latest;
    if (Date.now() > deadline) throw new Error(`run did not finish: ${JSON.stringify(latest)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
