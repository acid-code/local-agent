const urlInput = document.querySelector('#url');
const tokenInput = document.querySelector('#token');
const note = document.querySelector('#note');

const saved = localStorage.getItem('local-agent-url');
const savedToken = localStorage.getItem('local-agent-token');
if (saved) urlInput.value = saved;
if (savedToken) tokenInput.value = savedToken;

const params = new URLSearchParams(location.search);
if (params.get('share') && saved) {
  const target = new URL(saved);
  target.searchParams.set('share', params.get('share'));
  location.replace(target.toString());
}

document.querySelector('#setup').addEventListener('submit', (event) => {
  event.preventDefault();
  const url = urlInput.value.trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(url)) {
    note.textContent = 'The URL should start with http:// or https://.';
    return;
  }
  localStorage.setItem('local-agent-url', url);
  const token = tokenInput.value.trim();
  if (token) localStorage.setItem('local-agent-token', token);
  else localStorage.removeItem('local-agent-token');
  if (window.LocalAgentAndroid && token) {
    window.LocalAgentAndroid.saveNotificationToken(url, token);
  }
  const share = params.get('share');
  const next = new URL(url);
  if (share) next.searchParams.set('share', share);
  location.assign(next.toString());
});
