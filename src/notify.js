const fs = require('fs');
const path = require('path');

const NOTIFY_FILE = path.join(__dirname, '..', 'data', 'notifications.jsonl');

function notify(message) {
  const line = JSON.stringify({ ts: Date.now(), message }) + '\n';
  try {
    fs.mkdirSync(path.dirname(NOTIFY_FILE), { recursive: true });
    fs.appendFileSync(NOTIFY_FILE, line);
  } catch (e) {
    console.error('[Notify] Failed to write:', e.message);
  }
}

function drainNotifications() {
  try {
    if (!fs.existsSync(NOTIFY_FILE)) return [];
    const raw = fs.readFileSync(NOTIFY_FILE, 'utf8').trim();
    if (!raw) return [];
    fs.writeFileSync(NOTIFY_FILE, '');
    return raw.split('\n').map(l => JSON.parse(l));
  } catch (e) {
    return [];
  }
}

module.exports = { notify, drainNotifications };
