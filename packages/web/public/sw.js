const CACHE = 'local-agent-shell-v3';
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'local-agent', body: 'Something needs you.' };
  const options = { body: data.body || '', data: { url: '/' } };
  if (data.kind === 'approval' && data.approvalId) {
    // One notification per approval (tag), with buttons. High-risk actions are never one-tap: they open the app to confirm.
    options.tag = `approval-${data.approvalId}`;
    options.requireInteraction = true;
    options.data = { url: '/', approvalId: data.approvalId, risk: data.risk || 'high' };
    options.actions = data.risk === 'high'
      ? [{ action: 'open', title: 'Review' }, { action: 'deny', title: 'Deny' }]
      : [{ action: 'approve', title: 'Approve' }, { action: 'deny', title: 'Deny' }];
  }
  event.waitUntil(self.registration.showNotification(data.title || 'local-agent', options));
});

async function decide(id, decision) {
  const response = await fetch(`/api/approvals/${encodeURIComponent(id)}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }),
  });
  const text = response.ok ? (decision === 'approve' ? 'Approved' : 'Denied') : response.status === 409 ? 'Already decided' : 'Could not reach local-agent. Open the app to decide.';
  await self.registration.showNotification('local-agent', { body: text, tag: `approval-${id}` });
}

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  event.notification.close();
  if (data.approvalId && event.action === 'deny') return event.waitUntil(decide(data.approvalId, 'deny'));
  if (data.approvalId && event.action === 'approve' && data.risk !== 'high') return event.waitUntil(decide(data.approvalId, 'approve'));
  event.waitUntil(self.clients.openWindow(data.url || '/'));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});
