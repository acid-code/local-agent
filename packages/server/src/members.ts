import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FREE_TIER_SNAPSHOT, geminiQuotaDay, quotaAvailability } from '@local-agent/shared';
import { hashPassword } from './auth.js';
import {
  OWNER_ID, accountDir, accountOf, createMember, deleteMember, getTheme, listMembers, setTheme, updateMember, workspaceFor, type Account,
} from './accounts.js';
import type { Store } from './db.js';
import fs from 'node:fs';

const http = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw http(400, result.error.issues[0]?.message || 'Invalid input.');
  return result.data;
};
const ownerOnly = (account: Account) => { if (account.role !== 'owner') throw http(403, 'Only the owner can do that.'); };

const themeSchema = z.object({
  preset: z.string().max(40).optional(),
  followSystem: z.boolean().optional(),
  lightPreset: z.string().max(40).optional(),
  darkPreset: z.string().max(40).optional(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  fontScale: z.number().min(0.85).max(1.3).optional(),
  roundness: z.number().min(0).max(2).optional(),
  density: z.enum(['compact', 'cozy', 'roomy']).optional(),
  bubbles: z.enum(['classic', 'soft', 'minimal']).optional(),
  font: z.string().max(40).optional(),
  decor: z.boolean().optional(),
}).strict();

const limitsSchema = z.object({ cloud: z.boolean().optional(), maxAgents: z.number().int().min(1).max(100).optional() }).strict();

/** A friendly first persona so a new member lands in a working chat. */
function starterPersona(store: Store, dataDir: string, memberId: string, displayName: string) {
  const workspace = workspaceFor(dataDir, memberId, 'Buddy');
  fs.mkdirSync(workspace, { recursive: true });
  const agent = store.createAgent({
    name: 'Buddy', description: `${displayName}'s helper`, ownerId: memberId, workspacePath: workspace,
    systemPrompt: `You are Buddy, a warm and practical assistant for ${displayName}. Keep answers short and kind. Use the tools when they help.`,
    toolAllowlist: ['web_search', 'web_fetch', 'read_file', 'write_file', 'list_dir', 'remember', 'recall', 'kb_search'],
  });
  store.updateAgent(agent.id, { accent: '#e88aa8', emoji: '🌸', avatarKind: 'initials' });
  return agent;
}

export function registerAccounts(app: FastifyInstance, ctx: { store: Store; config: { dataDir: string } }) {
  const { store, config } = ctx;

  app.get('/api/me', async (req) => {
    const account = accountOf(req);
    return { account: { id: account.id, role: account.role, username: account.username, displayName: account.displayName, limits: account.role === 'member' ? account.limits : null } };
  });

  app.get('/api/me/theme', async (req) => ({ theme: getTheme(store, accountOf(req).id) }));
  app.put('/api/me/theme', async (req) => {
    const theme = parse(themeSchema, req.body);
    setTheme(store, accountOf(req).id, theme);
    return { theme };
  });

  /** Shared Gemini quota, read-only. The owner sets the limits; members see what is left today. */
  app.get('/api/me/quota', async (req) => {
    const account = accountOf(req);
    const day = geminiQuotaDay();
    const minute = new Date().toISOString().slice(0, 16);
    const settings = store.getSettings();
    const keyed = Boolean(process.env.GEMINI_API_KEY) && store.listProviders().some((provider) => provider.kind === 'gemini' && provider.enabled);
    const models = FREE_TIER_SNAPSHOT.filter((row) => row.chat).map((row) => {
      const used = store.quotaUse(row.apiName, day);
      const configured = settings.quotaLimits[row.apiName];
      const limited = { ...row, rpd: { ...row.rpd, limit: configured?.rpd ?? row.rpd.limit }, rpm: { ...row.rpm, limit: configured?.rpm ?? row.rpm.limit } };
      const availability = quotaAvailability(limited, { rpm: used.rpmWindow === minute ? used.rpm : 0, tpm: used.tpmWindow === minute ? used.tpm : 0, rpd: used.rpd });
      return { name: row.displayName, apiName: row.apiName, rpdLimit: limited.rpd.limit, rpdRemaining: availability.rpdRemaining, open: availability.open };
    }).filter((row) => row.rpdLimit);
    return { cloudAllowed: account.role === 'owner' || account.limits.cloud, keyed, tier: settings.geminiTier, models };
  });

  // People: the owner manages member accounts. Members never reach these routes.
  app.get('/api/members', async (req) => {
    ownerOnly(accountOf(req));
    return {
      members: listMembers(store).map((member) => {
        const stats = store.db.prepare(`SELECT
          (SELECT COUNT(*) FROM agents WHERE owner_id = ?) AS agents,
          (SELECT COUNT(*) FROM chat_sessions WHERE owner_id = ? AND archived = 0) AS chats`).get(member.id, member.id) as { agents: number; chats: number };
        return { ...member, agents: Number(stats.agents), chats: Number(stats.chats) };
      }),
    };
  });
  app.post('/api/members', async (req) => {
    ownerOnly(accountOf(req));
    const body = parse(z.object({ username: z.string().min(1).max(32), displayName: z.string().max(60).optional(), password: z.string().min(8).max(200), limits: limitsSchema.optional() }), req.body);
    let member;
    try {
      member = createMember(store, { username: body.username, displayName: body.displayName, passwordHash: await hashPassword(body.password), limits: body.limits });
    } catch (error) {
      throw http(400, error instanceof Error ? error.message : 'Could not create that account.');
    }
    fs.mkdirSync(accountDir(config.dataDir, member.id), { recursive: true });
    starterPersona(store, config.dataDir, member.id, member.displayName);
    store.addLog('info', `Member ${member.username} created.`);
    return { member };
  });
  app.patch('/api/members/:id', async (req) => {
    ownerOnly(accountOf(req));
    const body = parse(z.object({ displayName: z.string().min(1).max(60).optional(), limits: limitsSchema.optional(), disabled: z.boolean().optional(), password: z.string().min(8).max(200).optional() }), req.body);
    const member = updateMember(store, (req.params as { id: string }).id, {
      displayName: body.displayName, limits: body.limits, disabled: body.disabled, passwordHash: body.password ? await hashPassword(body.password) : undefined,
    });
    if (!member) throw http(404, 'Member not found.');
    return { member };
  });
  app.delete('/api/members/:id', async (req) => {
    ownerOnly(accountOf(req));
    const id = (req.params as { id: string }).id;
    if (id === OWNER_ID || !listMembers(store).some((member) => member.id === id)) throw http(404, 'Member not found.');
    deleteMember(store, config.dataDir, id);
    return { ok: true };
  });
}
