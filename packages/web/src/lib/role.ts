/** The signed-in account's role, set once by App after /api/auth/me. Owner-only calls check it so members never hit a 403. */
let role: 'owner' | 'member' = 'owner';
export function setRole(next: 'owner' | 'member') { role = next; }
export const isOwner = () => role !== 'member';
