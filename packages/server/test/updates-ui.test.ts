import { describe, expect, it } from 'vitest';
import { checkDisabled, describeUpdate, hasStatusApi } from '../../web/src/lib/updates.js';

describe('Settings → About & updates', () => {
  it('describes every desktop update state', () => {
    expect(describeUpdate({ state: 'up-to-date', current: '0.2.190' }).tone).toBe('ok');
    expect(describeUpdate({ state: 'downloading', current: '0.2.190', version: '0.2.191', percent: 42 })).toMatchObject({ text: 'Downloading {0}… {1}%', args: ['0.2.191', '42'] });
    expect(describeUpdate({ state: 'downloaded', current: '0.2.190', version: '0.2.191' }).tone).toBe('action');
    expect(describeUpdate({ state: 'error', current: '0.2.190', error: 'Could not reach GitHub.' }).text).toBe('Could not reach GitHub.');
    expect(describeUpdate(null).text).toBe('');
  });
  it('blocks a second check while checking or downloading', () => {
    expect(checkDisabled({ state: 'checking', current: '1' })).toBe(true);
    expect(checkDisabled({ state: 'downloading', current: '1' })).toBe(true);
    expect(checkDisabled({ state: 'up-to-date', current: '1' })).toBe(false);
    expect(checkDisabled({ state: 'downloaded', current: '1' })).toBe(false);
  });
  it('tells old desktop builds (dialog-only updater) from new ones', () => {
    expect(hasStatusApi({ getAppInfo: async () => ({ name: 'x', version: '0.2.187', packaged: true, platform: 'win32' }), checkForUpdates: async () => ({ ok: true }) })).toBe(false);
    expect(hasStatusApi({ getUpdateStatus: async () => ({ state: 'idle', current: '1' }), onUpdateStatus: () => () => {}, installUpdate: async () => ({ ok: true }) })).toBe(true);
    expect(hasStatusApi(null)).toBe(false);
  });
});
