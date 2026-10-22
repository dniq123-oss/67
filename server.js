const express = require('express'), http = require('http'), crypto = require('crypto');
const { WebSocketServer } = require('ws'), { Pool } = require('pg');

const M = { users: {}, teams: {}, matches: {}, gmsg: {}, tmsg: {}, mutes: {}, sess: {}, cfg: {} };
const app = express();
app.get('/', (q, r) => r.sendFile(__dirname + '/index.html'));
app.get('/av/:id', (q, r) => {
  const u = M.users[q.params.id], a = u && u.avatar, p = 'data:image/jpeg;base64,';
  if (!a || !a.startsWith(p)) return r.sendStatus(404);
  r.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public,max-age=31536000' }).send(Buffer.from(a.slice(p.length), 'base64'));
});
const server = http.createServer(app), wss = new WebSocketServer({ server });
const url = process.env.DATABASE_URL;
const pool = new Pool({ connectionString: url, ssl: url && !/localhost|railway\.internal/.test(url) ? { rejectUnauthorized: false } : false });

const hash = (p, s = crypto.randomBytes(8).toString('hex')) => s + ':' + crypto.scryptSync(p, s, 32).toString('hex');
const check = (p, h) => { const a = Buffer.from(hash(p, h.split(':')[0])), b = Buffer.from(h); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const str = (s, n = 500) => String(s ?? '').slice(0, n);
const save = (c, i, d) => { M[c][i] = d; pool.query('insert into docs(col,id,data) values($1,$2,$3) on conflict(col,id) do update set data=$3', [c, i, d]).catch(console.error); };
const rm = (c, i) => { delete M[c][i]; pool.query('delete from docs where col=$1 and id=$2', [c, i]).catch(console.error); };

async function boot() {
  await pool.query('create table if not exists docs(col text, id text, data jsonb, primary key(col,id))');
  (await pool.query('select * from docs')).rows.forEach(r => { if (M[r.col]) M[r.col][r.id] = r.data; });
  if (!Object.values(M.users).some(u => u.role === 'owner')) {
    if (!process.env.OWNER_NAME || !process.env.OWNER_PIN) console.warn('حط OWNER_NAME و OWNER_PIN في Variables');
    else save('users', 'owner', { name: process.env.OWNER_NAME, pin: hash(process.env.OWNER_PIN), role: 'owner', team: '' });
  }
  server.listen(process.env.PORT || 3000, () => console.log('running'));
}

const STAFF = ['owner', 'deputy', 'admin'];
const arr = o => Object.entries(o).map(([id, x]) => ({ id, ...x }));
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const pub = x => ({ id: x.id, name: x.name, role: x.role, team: x.team, av: x.av || 0 });
const lim = (l, n) => { l.sort((a, b) => a.ts - b.ts); return l.filter((m, i) => i >= l.length - n || m.pin); };

function view(ws) {
  const u = M.users[ws.uid], staff = STAFF.includes(u.role), cf = M.cfg.sec || {}, seen = new Set(), online = [];
  wss.clients.forEach(c => { const x = c.uid && M.users[c.uid]; if (x && !seen.has(c.uid)) { seen.add(c.uid); online.push({ uid: c.uid, name: x.name, role: x.role }); } });
  const hid = k => cf[k] && cf[k].hidden && !staff;
  return {
    a: 'state', me: pub({ id: ws.uid, ...u }), users: arr(M.users).map(pub),
    teams: arr(M.teams), matches: arr(M.matches),
    g: hid('g') ? [] : lim(arr(M.gmsg), 100),
    t: hid('t') ? [] : lim(arr(M.tmsg).filter(m => u.role === 'owner' || m.team === u.team), 300),
    mutes: Object.keys(M.mutes), cfg: cf, online
  };
}
const broadcast = () => wss.clients.forEach(ws => { if (ws.uid && M.users[ws.uid]) send(ws, view(ws)); });

const caps = new Map();
function newCap() {
  const a = 1 + Math.floor(Math.random() * 9), b = 1 + Math.floor(Math.random() * 9), plus = Math.random() < 0.5;
  const id = crypto.randomBytes(8).toString('hex');
  caps.set(id, { ans: plus ? a + b : a * b, exp: Date.now() + 300000 });
  return { a: 'cap', id, q: a + (plus ? ' + ' : ' × ') + b };
}
setInterval(() => { const n = Date.now(); caps.forEach((v, k) => { if (v.exp < n) caps.delete(k); }); }, 60000);

wss.on('connection', ws => {
  ws.fails = 0;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.a === 'cap') { if (caps.size < 5000) send(ws, newCap()); return; }
    if (m.a === 'login') {
      const cp = caps.get(m.cid); caps.delete(m.cid);
      const ans = String(m.cv ?? '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).trim();
      if (!cp || cp.exp < Date.now() || String(cp.ans) !== ans) { send(ws, { a: 'err', msg: 'جواب التحقق غلط' }); return send(ws, newCap()); }
      const e = Object.entries(M.users).find(([, u]) => u.name === str(m.name, 30) && check(str(m.pin, 60), u.pin));
      if (!e) { if (++ws.fails > 8) return ws.close(); send(ws, { a: 'err', msg: 'الاسم أو الرمز غلط' }); return send(ws, newCap()); }
      const tk = crypto.randomBytes(24).toString('hex'); save('sess', tk, { uid: e[0] });
      ws.uid = e[0]; send(ws, { a: 'token', token: tk }); return broadcast();
    }
    if (m.a === 'resume') {
      const s = M.sess[m.token];
      if (!s || !M.users[s.uid]) return send(ws, { a: 'out' });
      ws.uid = s.uid; return broadcast();
    }
    const u = ws.uid && M.users[ws.uid]; if (!u) return;
    if (m.a === 'logout') { if (M.sess[m.token]) rm('sess', m.token); ws.uid = null; return broadcast(); }
    const owner = u.role === 'owner', mgr = owner || u.role === 'deputy', staff = STAFF.includes(u.role);
    const cf = M.cfg.sec || {}, locked = k => !staff && cf[k] && cf[k].locked;

    if (m.a === 'profile') {
      const n = str(m.name, 30).trim(), p = 'data:image/jpeg;base64,', x = { ...u };
      if (n && n !== u.name) {
        if (Object.entries(M.users).some(([k, y]) => k !== ws.uid && y.name === n)) return send(ws, { a: 'err', msg: 'الاسم مستخدم' });
        x.name = n;
      }
      if (typeof m.avatar === 'string' && m.avatar.startsWith(p) && m.avatar.length < 60000) { x.avatar = m.avatar; x.av = Date.now(); }
      save('users', ws.uid, x); send(ws, { a: 'ok', msg: 'تم حفظ حسابك' }); return broadcast();
    }
    if (m.a === 'pass') {
      if (!check(str(m.old, 60), u.pin)) return send(ws, { a: 'err', msg: 'الرمز الحالي غلط' });
      if (str(m.nw, 60).length < 3) return send(ws, { a: 'err', msg: 'الرمز قصير' });
      save('users', ws.uid, { ...u, pin: hash(str(m.nw, 60)) }); return send(ws, { a: 'ok', msg: 'تم تغيير الرمز' });
    }
    if (m.a === 'cfg') {
      if (staff && ['m', 's', 'p', 'g', 't'].includes(m.k) && ['hidden', 'locked'].includes(m.f)) {
        const c = { ...(M.cfg.sec || {}) }; c[m.k] = { ...(c[m.k] || {}), [m.f]: !!m.v }; save('cfg', 'sec', c);
      }
      return broadcast();
    }
    if (m.a === 'pin') {
      const col = m.c === 'tmsg' ? 'tmsg' : 'gmsg', doc = M[col][m.i];
      if (doc && (col === 'gmsg' ? mgr : owner || (u.role === 'captain' && doc.team === u.team))) save(col, m.i, { ...doc, pin: !!m.on });
      return broadcast();
    }

    const { c, i } = m, d = m.d || {};
    if (!['set', 'upd', 'del'].includes(m.a) || typeof i !== 'string' || i.length > 40) return;

    if (c === 'users') {
      const allowed = owner ? ['player', 'captain', 'admin', 'deputy'] : ['player', 'captain', 'admin'];
      if (m.a === 'set' && mgr) save('users', i, { name: str(d.name, 30), pin: hash(str(d.pin, 60)), role: allowed.includes(d.role) ? d.role : 'player', team: str(d.team, 40) });
      else if (owner && M.users[i] && M.users[i].role !== 'owner') {
        if (m.a === 'del') rm('users', i);
        else if (m.a === 'upd') { const n = { ...M.users[i] }; if (['player', 'captain', 'admin', 'deputy'].includes(d.role)) n.role = d.role; if ('team' in d) n.team = str(d.team, 40); save('users', i, n); }
      }
    } else if (c === 'teams' && staff) {
      if (m.a === 'set') save('teams', i, { name: str(d.name, 30) });
      else if (m.a === 'del' && mgr) {
        rm('teams', i);
        arr(M.matches).forEach(x => { if (x.home === i || x.away === i) rm('matches', x.id); });
        arr(M.tmsg).forEach(x => { if (x.team === i) rm('tmsg', x.id); });
        arr(M.users).forEach(x => { if (x.team === i) save('users', x.id, { ...M.users[x.id], team: '' }); });
      }
    } else if (c === 'matches' && staff) {
      if (m.a === 'del') { if (mgr) rm('matches', i); }
      else {
        const n = { ...(M.matches[i] || {}) };
        ['home', 'away', 'time', 'round', 'leg', 'hs', 'as', 'scorers', 'assists', 'hf', 'af', 'hp', 'ap', 'hsc', 'has', 'asc', 'aas'].forEach(k => {
          if (k in d) n[k] = typeof d[k] === 'number' ? d[k] : d[k] === null ? null : str(d[k], 200);
        });
        save('matches', i, n);
      }
    } else if (c === 'gmsg') {
      if (m.a === 'set' && !M.gmsg[i] && !M.mutes[ws.uid] && !locked('g')) save('gmsg', i, { u: ws.uid, name: u.name, role: u.role, text: str(d.text), ts: Date.now() });
      else if (m.a === 'del' && staff) rm('gmsg', i);
    } else if (c === 'tmsg' && m.a === 'set' && !M.tmsg[i] && !locked('t')) {
      const team = owner ? str(d.team, 40) : u.team;
      if (team) save('tmsg', i, { u: ws.uid, name: u.name, role: u.role, team, text: str(d.text), ts: Date.now() });
    } else if (c === 'mutes' && mgr) {
      m.a === 'set' ? save('mutes', i, { on: true }) : rm('mutes', i);
    }
    broadcast();
  });
  ws.on('close', broadcast);
});

boot();
