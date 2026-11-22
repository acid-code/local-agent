// Pure update-status logic, shared by updater.js and its tests (no Electron imports here).
// Status shape sent to the window: { state, current, version?, percent?, error?, portable }.
// state: idle | development | checking | up-to-date | available | downloading | downloaded | portable-available | error

const RELEASES_URL = 'https://github.com/acid-code/local-agent/releases/latest';
// electron-updater reads latest.yml from here. "latest/download" always redirects to the newest
// release that GitHub marks Latest, so the tag name (main-<sha>) does not matter.
const FEED_URL = 'https://github.com/acid-code/local-agent/releases/latest/download';

function initialStatus(current, { packaged, portable }) {
  return { state: packaged ? 'idle' : 'development', current, portable: Boolean(portable) };
}

/** Applies one electron-updater event to the status. */
function reduce(status, event, payload = {}) {
  switch (event) {
    case 'checking-for-update':
      // A finished download stays ready to install; checking again must not hide it.
      if (status.state === 'downloaded' || status.state === 'downloading') return status;
      return { ...status, state: 'checking', error: undefined };
    case 'update-not-available':
      return { ...status, state: 'up-to-date', version: payload.version || status.current, percent: undefined, error: undefined };
    case 'update-available':
      return status.portable
        ? { ...status, state: 'portable-available', version: payload.version, error: undefined }
        : { ...status, state: 'downloading', version: payload.version, percent: 0, error: undefined };
    case 'download-progress':
      return { ...status, state: 'downloading', percent: Math.max(0, Math.min(100, Math.round(Number(payload.percent) || 0))) };
    case 'update-downloaded':
      return { ...status, state: 'downloaded', version: payload.version || status.version, percent: 100, error: undefined };
    case 'error':
      // A failed background check after a good download keeps the download usable.
      if (status.state === 'downloaded') return status;
      return { ...status, state: 'error', percent: undefined, error: friendlyError(payload.message) };
    default:
      return status;
  }
}

function friendlyError(message) {
  const text = String(message || 'Update check failed.');
  if (/latest\.yml/i.test(text) && /404/.test(text)) return 'The newest release has no Windows update file yet (latest.yml). Try again in a few minutes.';
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ERR_INTERNET_DISCONNECTED|net::/i.test(text)) return 'Could not reach GitHub. Check the internet connection.';
  return text.split('\n')[0].slice(0, 240);
}

/** Whether a check may start now (no second check while one is running or a download is in progress). */
function canCheck(status) {
  return status.state !== 'checking' && status.state !== 'downloading';
}

module.exports = { RELEASES_URL, FEED_URL, initialStatus, reduce, friendlyError, canCheck };
