const express = require('express'), http = require('http'), crypto = require('crypto');
const { WebSocketServer } = require('ws'), { Pool } = require('pg');

const app = express();
app.get('/', (q, r) => r.sendFile(__dirname + '/index.html'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const url = process.env.DATABASE_URL;
const pool = new Pool({ connectionString: url, ssl: url && !/localhost|railway\.internal/.test(url) ? { rejectUnauthorized: false } : false });

const hash = (p, s = crypto.randomBytes(8).toString('hex')) => s + ':' + crypto.scryptSync(p, s, 32).toString('hex');
const check = (p, h) => { const a = Buffer.from(hash(p, h.split(':')[0])), b = Buffer.from(h); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const str = (s, n = 500) => String(s ?? '').slice(0, n);

const M = { users: {}, teams: {}, matches: {}, gmsg: {}, tmsg: {}, mutes: {}, sess: {} };
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

const arr = o => Object.entries(o).map(([id, x]) => ({ id, ...x }));
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

function view(ws) {
  const u = M.users[ws.uid], seen = new Set(), online = [];
  wss.clients.forEach(c => { const x = c.uid && M.users[c.uid]; if (x && !seen.has(c.uid)) { seen.add(c.uid); online.push({ uid: c.uid, name: x.name, role: x.role }); } });
  const sort = l => l.sort((a, b) => a.ts - b.ts);
  return {
    a: 'state', me: { id: ws.uid, name: u.name, role: u.role, team: u.team },
    users: arr(M.users).map(x => ({ id: x.id, name: x.name, role: x.role, team: x.team })),
    teams: arr(M.teams), matches: arr(M.matches),
    g: sort(arr(M.gmsg)).slice(-100),
    t: sort(arr(M.tmsg).filter(m => u.role === 'owner' || m.team === u.team)).slice(-300),
    mutes: Object.keys(M.mutes), online
  };
}
const broadcast = () => wss.clients.forEach(ws => { if (ws.uid && M.users[ws.uid]) send(ws, view(ws)); });

wss.on('connection', ws => {
  ws.fails = 0;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.a === 'login') {
      const e = Object.entries(M.users).find(([, u]) => u.name === str(m.name, 30) && check(str(m.pin, 60), u.pin));
      if (!e) { if (++ws.fails > 8) return ws.close(); return send(ws, { a: 'err', msg: 'الاسم أو الرمز غلط' }); }
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
    const owner = u.role === 'owner', staff = owner || u.role === 'admin';
    const { c, i } = m, d = m.d || {};
    if (!['set', 'upd', 'del'].includes(m.a) || typeof i !== 'string' || i.length > 40) return;

    if (c === 'users' && owner) {
      if (m.a === 'del') { if (M.users[i] && M.users[i].role !== 'owner') rm('users', i); }
      else if (m.a === 'set') save('users', i, { name: str(d.name, 30), pin: hash(str(d.pin, 60)), role: d.role === 'admin' ? 'admin' : 'player', team: str(d.team, 40) });
      else { const x = M.users[i]; if (x && x.role !== 'owner') { const n = { ...x }; if (d.role) n.role = d.role === 'admin' ? 'admin' : 'player'; if ('team' in d) n.team = str(d.team, 40); save('users', i, n); } }
    } else if (c === 'teams' && staff && m.a === 'set') {
      save('teams', i, { name: str(d.name, 30) });
    } else if (c === 'matches' && staff) {
      if (m.a === 'del') { if (owner) rm('matches', i); }
      else {
        const n = { ...(M.matches[i] || {}) };
        ['home', 'away', 'time', 'round', 'leg', 'hs', 'as', 'scorers', 'assists'].forEach(k => {
          if (k in d) n[k] = typeof d[k] === 'number' ? d[k] : d[k] === null ? null : str(d[k], 200);
        });
        save('matches', i, n);
      }
    } else if (c === 'gmsg') {
      if (m.a === 'set' && !M.gmsg[i] && !M.mutes[ws.uid]) save('gmsg', i, { u: ws.uid, name: u.name, role: u.role, text: str(d.text), ts: Date.now() });
      else if (m.a === 'del' && staff) rm('gmsg', i);
    } else if (c === 'tmsg' && m.a === 'set' && !M.tmsg[i]) {
      const team = owner ? str(d.team, 40) : u.team;
      if (team) save('tmsg', i, { u: ws.uid, name: u.name, role: u.role, team, text: str(d.text), ts: Date.now() });
    } else if (c === 'mutes' && owner) {
      m.a === 'set' ? save('mutes', i, { on: true }) : rm('mutes', i);
    }
    broadcast();
  });
  ws.on('close', broadcast);
});

boot();
