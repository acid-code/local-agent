import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ModelProvider } from '../src/providers.js';
import { ScriptedProvider } from '../src/providers.js';
import { listSkills, renderSkillMd, saveSkill, skillVersions } from '../src/skills.js';
import { findToolsTool, rankSkills } from '../src/toolsearch.js';
import { skillNudge } from '../src/learning.js';
import type { Tool } from '../src/tools.js';
import { savedSkills, type WorkGroup } from '../../web/src/lib/work-steps';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-skills-')); dirs.push(dir);
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => new ScriptedProvider([{ text: 'ok' }]) as unknown as ModelProvider });
  const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: ['fixture', 'owner', '13'].join('-') } });
  const cookies = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
  return { ...built, dir, cookies };
}
const md = (body: string) => renderSkillMd({ name: 'Deploy site', description: 'Use when deploying the site to Vercel.', body });

describe('skills: versions, restore, delete', () => {
  it('keeps the last 3 versions, restores an old one as a new version, and deletes everything', async () => {
    const built = await setup();
    for (const n of [1, 2, 3, 4, 5]) await saveSkill(built.store, built.dir, md(`Step list number ${n}.`), 'deploy-site');
    expect(skillVersions(built.store, 'deploy-site').map((row) => row.version)).toEqual([5, 4, 3]);

    const restored = await built.app.inject({ method: 'POST', url: '/api/skills/deploy-site/restore', cookies: built.cookies, payload: { version: 3 } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().skill.version).toBe(6);
    expect(listSkills(built.store).find((skill) => skill.slug === 'deploy-site')!.body).toBe('Step list number 3.');
    expect(skillVersions(built.store, 'deploy-site').map((row) => row.version)).toEqual([6, 5, 4]);
    expect((await built.app.inject({ method: 'POST', url: '/api/skills/deploy-site/restore', cookies: built.cookies, payload: { version: 1 } })).statusCode).toBe(404);

    expect(fs.existsSync(path.join(built.dir, 'skills', 'deploy-site', 'SKILL.md'))).toBe(true);
    const gone = await built.app.inject({ method: 'DELETE', url: '/api/skills/deploy-site', cookies: built.cookies });
    expect(gone.statusCode).toBe(200);
    expect(listSkills(built.store).some((skill) => skill.slug === 'deploy-site')).toBe(false);
    expect(skillVersions(built.store, 'deploy-site')).toHaveLength(0);
    expect(fs.existsSync(path.join(built.dir, 'skills', 'deploy-site'))).toBe(false);
    expect((await built.app.inject({ method: 'DELETE', url: '/api/skills/deploy-site', cookies: built.cookies })).statusCode).toBe(404);
    expect([401, 403]).toContain((await built.app.inject({ method: 'DELETE', url: '/api/skills/x' })).statusCode);
    await built.app.close();
  });
});

describe('find_tools searches skills', () => {
  const skills = [
    { slug: 'deploy-site', name: 'Deploy site', description: 'Use when deploying the site to Vercel.' },
    { slug: 'summarize-paper', name: 'Summarize a paper', description: 'Use when the user asks for a summary of a PDF.' },
  ];
  it('ranks skills by name and description', () => {
    expect(rankSkills(skills, 'deploy the site').map((row) => row.skill.slug)).toEqual(['deploy-site']);
    expect(rankSkills(skills, 'weather')).toEqual([]);
  });
  it('returns load_skill hints alongside or instead of tools', async () => {
    const tool: Tool = { name: 'vercel__deploy', description: 'Deploy a project', parameters: { type: 'object', properties: {} }, mutates: () => true, approval: () => null, execute: async () => '' };
    const added: string[] = [];
    const finder = findToolsTool({ discoverable: [tool], servers: new Map(), offered: () => new Set(), add: (names) => added.push(...names), skills: () => skills });
    const both = await finder.execute({ query: 'deploy site' }, {} as never);
    expect(both).toContain('vercel__deploy');
    expect(both).toContain('load_skill deploy-site');
    const onlySkill = await finder.execute({ query: 'summary of a paper' }, {} as never);
    expect(onlySkill).toMatch(/^Saved skills that fit/);
    expect(onlySkill).toContain('load_skill summarize-paper');
  });
});

describe('save-skill nudge and notice', () => {
  it('nudges once after several working steps and points at the loaded skill', () => {
    const names = ['propose_skill'];
    expect(skillNudge(2, names)).toBe('');
    expect(skillNudge(4, names)).toMatch(/call propose_skill once/);
    expect(skillNudge(4, names, { proposed: true })).toBe('');
    expect(skillNudge(4, names, { lastFailed: true })).toBe('');
    expect(skillNudge(4, names, { loaded: ['deploy-site'] })).toContain('deploy-site');
    expect(skillNudge(4, [])).toBe('');
  });
  it('finds saved skills in a work group for the chat notice', () => {
    const step = (output: string, failed = false) => ({ type: 'step' as const, id: output, icon: 'tool' as const, verb: 'Used', target: 'propose_skill', files: [], durationMs: null, args: null, output, failed, pending: false });
    const group: WorkGroup = { kind: 'work', id: 'g', stepCount: 3, durationMs: null, runIds: ['r'], rows: [step('Saved shared skill deploy-site v2. Every persona can now load and use it.'), step('other'), step('Saved shared skill broken v1.', true)] };
    expect(savedSkills(group)).toEqual([{ slug: 'deploy-site', version: 2 }]);
  });
});
