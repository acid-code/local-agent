import { describe, expect, it } from 'vitest';
import { shouldSendNotification } from '../../web/src/lib/notifications';

describe('desktop notification triggers', () => {
  it('notifies for approvals/secrets when unfocused, hidden, or viewing another persona', () => {
    expect(shouldSendNotification({ kind: 'approval', focused: false, hidden: false, enabled: true, samePersona: true })).toBe(true);
    expect(shouldSendNotification({ kind: 'approval', focused: true, hidden: true, enabled: true, samePersona: true })).toBe(true);
    expect(shouldSendNotification({ kind: 'approval', focused: true, hidden: false, enabled: true, samePersona: false })).toBe(true);
    expect(shouldSendNotification({ kind: 'approval', focused: true, hidden: false, enabled: true, samePersona: true })).toBe(false);
    expect(shouldSendNotification({ kind: 'secret', focused: false, hidden: false, enabled: true, samePersona: true })).toBe(true);
  });

  it('notifies for completed/failed runs only when unfocused or hidden, and respects mute/disable', () => {
    expect(shouldSendNotification({ kind: 'done', status: 'completed', focused: false, hidden: false, enabled: true })).toBe(true);
    expect(shouldSendNotification({ kind: 'done', status: 'failed', focused: true, hidden: true, enabled: true })).toBe(true);
    expect(shouldSendNotification({ kind: 'done', status: 'completed', focused: true, hidden: false, enabled: true })).toBe(false);
    expect(shouldSendNotification({ kind: 'done', status: 'stopped', focused: false, hidden: false, enabled: true })).toBe(false);
    expect(shouldSendNotification({ kind: 'done', status: 'completed', focused: false, hidden: false, enabled: true, muted: true })).toBe(false);
    expect(shouldSendNotification({ kind: 'approval', focused: false, hidden: false, enabled: false })).toBe(false);
  });
});
