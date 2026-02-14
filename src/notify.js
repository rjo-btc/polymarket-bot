const fs = require('fs');
const path = require('path');

const NOTIFY_FILE = path.join(__dirname, '..', 'data', 'notifications.jsonl');

// Telegram config for direct delivery
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;  // polybot-alerts bot token
const TG_CHAT_ID = process.env.TG_CHAT_ID;      // Ryan's chat ID

async function sendTelegram(message) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_notification: false,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error('[Notify] Telegram send failed:', err);
    } else {
      console.log('[Notify] Telegram message sent');
    }
  } catch (e) {
    console.error('[Notify] Telegram error:', e.message);
  }
}

function notify(message, type = 'info') {
  const line = JSON.stringify({ ts: Date.now(), message, type }) + '\n';
  try {
    fs.mkdirSync(path.dirname(NOTIFY_FILE), { recursive: true });
    fs.appendFileSync(NOTIFY_FILE, line);
  } catch (e) {
    console.error('[Notify] Failed to write:', e.message);
  }

  // Send loss analysis and circuit breaker alerts directly to Telegram
  if (type === 'loss_analysis') {
    sendTelegram(message);
  }
}

function drainNotifications() {
  try {
    if (!fs.existsSync(NOTIFY_FILE)) return [];
    const raw = fs.readFileSync(NOTIFY_FILE, 'utf8').trim();
    if (!raw) return [];
    fs.writeFileSync(NOTIFY_FILE, '');
    return raw.split('\n').map(l => JSON.parse(l)).filter(n => n.type === 'loss_analysis');
  } catch (e) {
    return [];
  }
}

module.exports = { notify, drainNotifications };
