import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDraft, slidesTools } from '../src/slides.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('slide-by-slide decks', () => {
  it('starts a draft, checks each slide as it is added, and keeps drafts per owner', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-draft-')); dirs.push(dir);
    const draft = slidesTools({ dataDir: dir }).find((tool) => tool.name === 'slide_draft')!;
    const ctx = { agent: { id: 'a', ownerId: 'acct_member' } } as never;
    const started = await draft.execute({ action: 'start', title: 'Bees' }, ctx);
    const id = started.match(/draft_[a-f0-9]{12}/)![0];
    await draft.execute({ action: 'add', draft_id: id, slide: { layout: 'title', title: 'Bees' } }, ctx);
    await draft.execute({ action: 'add', draft_id: id, slide: { layout: 'cards', title: 'Why', bullets: ['Pollination', 'Honey'] } }, ctx);
    await expect(draft.execute({ action: 'add', draft_id: id, slide: { layout: 'stats', title: 'Numbers', stats: [{ value: 3 }] } }, ctx)).rejects.toThrow(/stat needs a value and a label/);
    const shown = await draft.execute({ action: 'replace', draft_id: id, index: 2, slide: { layout: 'cards', title: 'Why bees matter' } }, ctx);
    expect(shown).toContain('2. [cards] Why bees matter');
    expect(readDraft(dir, id, 'acct_member')!.slides.length).toBe(2);
    expect(readDraft(dir, id, 'acct_other')).toBeNull();
    await expect(draft.execute({ action: 'add', draft_id: 'draft_000000000000', slide: { title: 'x' } }, ctx)).rejects.toThrow(/No draft/);
    const make = slidesTools({ dataDir: dir }).find((tool) => tool.name === 'make_slides')!;
    await expect(make.execute({}, ctx)).rejects.toThrow(/Pass deck .* or draft_id/);
  });
});
