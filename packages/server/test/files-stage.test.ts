import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { ensureFilesTable, saveFile, stageFileIntoWorkspace } from '../src/files.js';
import { expandMentions } from '../src/mentions.js';

const dirs: string[] = [];
function tmpDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workspace staging for uploaded chat files', () => {
  it('copies shell-hostile filenames safely, avoids collisions, and includes Workspace path in mentions', () => {
    const dataDir = tmpDir('la-stage-data-');
    const wsDir = tmpDir('la-stage-ws-');
    const store = new Store(path.join(dataDir, 'test.db'));
    ensureFilesTable(store);

    const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
    const uploadedImg = saveFile(store, dataDir, {
      name: '$R30DEMA.jpg',
      bytes: jpgBytes,
      mime: 'image/jpeg',
      source: 'upload',
    });

    const rel1 = stageFileIntoWorkspace(store, dataDir, uploadedImg.id, wsDir);
    expect(rel1).toBe('uploads/R30DEMA.jpg');
    expect(fs.readFileSync(path.join(wsDir, rel1!))).toEqual(jpgBytes);

    // Same sanitized filename with a different byte size gets a unique file-id prefix instead of overwriting.
    const otherJpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x01, 0x02, 0x03]);
    const secondImg = saveFile(store, dataDir, {
      name: '$R30DEMA.jpg',
      bytes: otherJpgBytes,
      mime: 'image/jpeg',
      source: 'upload',
    });
    const rel2 = stageFileIntoWorkspace(store, dataDir, secondImg.id, wsDir);
    expect(rel2).toBe(`uploads/${secondImg.id}_R30DEMA.jpg`);
    expect(fs.readFileSync(path.join(wsDir, rel1!))).toEqual(jpgBytes);
    expect(fs.readFileSync(path.join(wsDir, rel2!))).toEqual(otherJpgBytes);

    const textFile = saveFile(store, dataDir, {
      name: 'notes final.txt',
      bytes: Buffer.from('hello from upload'),
      mime: 'text/plain',
      source: 'upload',
    });

    const expanded = expandMentions(
      store,
      [{ kind: 'file', id: uploadedImg.id }, { kind: 'file', id: textFile.id }],
      'owner',
      { stageFile: (f) => stageFileIntoWorkspace(store, dataDir, f.id, wsDir) },
    );

    expect(expanded).toContain('Workspace path (readable in shell/scripts with cwd="workspace"): uploads/R30DEMA.jpg');
    expect(expanded).toContain('Workspace path (readable in shell/scripts with cwd="workspace"): uploads/notes_final.txt');
    expect(expanded).toContain('hello from upload');
    store.close();
  });
});
