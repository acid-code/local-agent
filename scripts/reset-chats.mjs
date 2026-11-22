#!/usr/bin/env node
// Fresh start through the server's owner-only endpoint (the server takes the backup and checks no reply is running).
//   LA_URL=http://127.0.0.1:8787 LA_TOKEN=la_… node scripts/reset-chats.mjs          dry run: counts only
//   LA_URL=… LA_TOKEN=… node scripts/reset-chats.mjs --yes                          backup, then delete
// Deletes chats, messages, runs and their history. Keeps personas, skills, memory, knowledge base, settings,
// secrets, models, files, workspaces, rooms and triggers. The token is sent as a Bearer header and never printed.
const base = (process.env.LA_URL || '').replace(/\/$/, '');
const token = process.env.LA_TOKEN || '';
const yes = process.argv.includes('--yes');
if (!base || !token) {
  console.error('Set LA_URL (e.g. http://127.0.0.1:8787) and LA_TOKEN (an owner API token from Settings → Tokens).');
  process.exit(2);
}
const call = async (body) => {
  const response = await fetch(`${base}/api/admin/reset`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
};
try {
  const preview = await call({});
  console.log(`Would delete ${preview.total} rows:`);
  for (const row of preview.counts) if (row.rows) console.log(`  ${String(row.rows).padStart(7)}  ${row.label}`);
  if (preview.filesUnlinked) console.log(`  ${String(preview.filesUnlinked).padStart(7)}  files unlinked from chats (kept in the library)`);
  console.log(`Kept: ${preview.kept.join(', ')}.`);
  if (!yes) { console.log('Dry run. Nothing was deleted. Run again with --yes to back up and delete.'); process.exit(0); }
  const done = await call({ confirm: true, phrase: 'DELETE ALL CHATS' });
  console.log(`Deleted ${done.total} rows. Backup: ${done.backup?.file ?? done.backup?.id}.`);
} catch (error) {
  console.error(`Reset failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
