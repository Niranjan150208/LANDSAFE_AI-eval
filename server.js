'use strict';
/* LANDSAFE AI backend. Zero npm dependencies. Needs Node >= 22.13 (built-in node:sqlite). */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { makeSync } = require('./datasync');

// ---- tiny .env loader -------------------------------------------------------
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const PORT = +process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('[warn] JWT_SECRET not set: logins will reset on restart. Set it in .env');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'landsafe.db');
const PUBLIC = path.join(__dirname, 'public');

// ---- database ---------------------------------------------------------------
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY, name TEXT NOT NULL, pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Public', phone TEXT DEFAULT '', zone INTEGER DEFAULT 0,
  created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT, zone INTEGER NOT NULL, hazard TEXT NOT NULL,
  username TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending',
  created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS checkins(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, zone INTEGER NOT NULL,
  kind TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS alerts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, zone INTEGER NOT NULL, level INTEGER NOT NULL,
  message TEXT NOT NULL, by_user TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sms_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, to_phone TEXT NOT NULL, message TEXT NOT NULL,
  status TEXT NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS zone_metrics(
  zone TEXT PRIMARY KEY, rain_mm_24h REAL, ndvi REAL, insar_mm REAL, slope_deg REAL,
  elevation_m REAL, past_slides INTEGER, updated TEXT DEFAULT CURRENT_TIMESTAMP);
`);

const sync = makeSync(db);

// ---- passwords + tokens (Node crypto only) ----------------------------------
const hashPw = (pw) => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 32).toString('hex'); };
const checkPw = (pw, stored) => {
  const [s, h] = String(stored).split(':'); if (!s || !h) return false;
  const a = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (p) => { const body = b64({ ...p, exp: Date.now() + 12 * 3600e3 }); return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url'); };
const verifyTok = (t) => {
  try {
    const [body, sig] = String(t).split('.');
    const ok = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
    if (sig.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
};

// seed demo accounts (same as the console's demo buttons)
for (const [u, pw, role, name] of [['admin', 'admin123', 'Admin', 'Administrator'], ['officer', 'officer123', 'Field Officer', 'Field Officer'], ['public', 'public123', 'Public', 'Resident']]) {
  if (!db.prepare('SELECT 1 FROM users WHERE username=?').get(u))
    db.prepare('INSERT INTO users(username,name,pass,role,zone) VALUES(?,?,?,?,2)').run(u, name, hashPw(pw), role);
}
// seed sample reports once so the officer queue is not empty
if (!db.prepare('SELECT 1 FROM reports').get()) {
  db.prepare('INSERT INTO reports(zone,hazard,username) VALUES(8,?,?)').run('Rockfall', 'resident_gtk');
  db.prepare('INSERT INTO reports(zone,hazard,username) VALUES(5,?,?)').run('Water seepage', 'resident_cpj');
}

// ---- SMS (Twilio if configured, otherwise dry-run) ---------------------------
async function sendSms(to, message) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok, TWILIO_FROM: from } = process.env;
  let status = 'dry-run (set TWILIO_* in .env to send real SMS)';
  if (sid && tok && from) {
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: from, Body: message }),
      });
      status = r.ok ? 'sent' : 'provider error ' + r.status;
    } catch (e) { status = 'network error: ' + e.message; }
  }
  db.prepare('INSERT INTO sms_log(to_phone,message,status) VALUES(?,?,?)').run(to, message, status);
  console.log(`[sms] ${to}: ${status}`);
  return status;
}

// ---- helpers ------------------------------------------------------------------
const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(b); };
const readBody = (req) => new Promise((ok, no) => {
  let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) { no(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(new Error('bad json')); } });
});
const fmtTime = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const pro = (u) => u && (u.role === 'Admin' || u.role === 'Field Officer');
const publicUser = (u) => ({ n: u.username, r: u.role, name: u.name, zone: u.zone, phone: u.phone });
const attempts = new Map(); // naive login rate limit per ip
const tooMany = (ip) => { const now = Date.now(), a = (attempts.get(ip) || []).filter((t) => now - t < 60000); a.push(now); attempts.set(ip, a); return a.length > 10; };

const rep = (r) => ({ id: 'LR-' + (1000 + r.id), dbid: r.id, zi: r.zone, hz: r.hazard, u: r.username, t: fmtTime(r.created), st: r.status });
const chk = (c, zoneNames) => ({ id: c.id, t: fmtTime(c.created), u: c.username, zi: c.zone, k: c.kind, d: c.handled ? 1 : 0 });

// ---- routes -------------------------------------------------------------------
async function api(req, res, url) {
  const ip = req.socket.remoteAddress || '';
  const m = req.method, p = url.pathname;
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  const claims = verifyTok(tok);
  const me = claims ? db.prepare('SELECT * FROM users WHERE username=?').get(claims.u) : null;
  const need = (cond = true) => { if (!me) { json(res, 401, { error: 'Sign in required' }); return false; } if (!cond) { json(res, 403, { error: 'Not allowed for your role' }); return false; } re[...]

  if (p === '/api/health') return json(res, 200, { ok: true, sms: !!process.env.TWILIO_ACCOUNT_SID ? 'twilio' : 'dry-run' });

  if (p === '/api/auth/login' && m === 'POST') {
    if (tooMany(ip)) return json(res, 429, { error: 'Too many attempts, wait a minute' });
    const b = await readBody(req);
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(b.username || '').toLowerCase());
    if (!u || !checkPw(String(b.password || ''), u.pass)) return json(res, 401, { error: 'Wrong username or password.' });
    return json(res, 200, { token: sign({ u: u.username }), user: publicUser(u) });
  }

  if (p === '/api/auth/signup' && m === 'POST') {
    if (tooMany(ip)) return json(res, 429, { error: 'Too many attempts, wait a minute' });
    const b = await readBody(req);
    const name = String(b.name || '').trim(), u = String(b.username || '').trim().toLowerCase(), pw = String(b.password || ''), ph = String(b.phone || '').trim();
    if (name.length < 2) return json(res, 400, { error: 'Enter your name.' });
    if (!/^[a-z0-9_]{3,20}$/.test(u)) return json(res, 400, { error: 'Username: 3 to 20 letters, numbers or underscores.' });
    if (pw.length < 8) return json(res, 400, { error: 'Password needs at least 8 characters.' });
    if (ph && !/^\+\d{10,15}$/.test(ph)) return json(res, 400, { error: 'Phone must start with + and the country code.' });
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(u)) return json(res, 409, { error: 'That username is taken.' });
    const zone = Math.max(0, Math.min(99, +b.zone || 0));
    db.prepare('INSERT INTO users(username,name,pass,role,phone,zone) VALUES(?,?,?,?,?,?)').run(u, name.slice(0, 60), hashPw(pw), 'Public', ph, zone);
    const nu = db.prepare('SELECT * FROM users WHERE username=?').get(u);
    return json(res, 201, { token: sign({ u }), user: publicUser(nu) });
  }

  if (p === '/api/me' && m === 'GET') { if (!need()) return; return json(res, 200, { user: publicUser(me) }); }

  // admin: list users and promote to Field Officer
  if (p === '/api/users' && m === 'GET') {
    if (!need(me && me.role === 'Admin')) return;
    return json(res, 200, db.prepare('SELECT username,name,role,zone,phone,created FROM users ORDER BY created').all());
  }
  let mm;
  if ((mm = p.match(/^\/api\/users\/([a-z0-9_]+)\/role$/)) && m === 'PATCH') {
    if (!need(me && me.role === 'Admin')) return;
    const b = await readBody(req);
    if (!['Public', 'Field Officer', 'Admin'].includes(b.role)) return json(res, 400, { error: 'Bad role' });
    db.prepare('UPDATE users SET role=? WHERE username=?').run(b.role, mm[1]);
    return json(res, 200, { ok: true });
  }

  if ((mm = p.match(/^\/api\/users\/([a-z0-9_]+)$/)) && m === 'DELETE') {
    if (!need(me && me.role === 'Admin')) return;
    if (['admin', 'officer', 'public', me.username].includes(mm[1])) return json(res, 400, { error: 'Cannot remove this account' });
    db.prepare('DELETE FROM users WHERE username=?').run(mm[1]);
    return json(res, 200, { ok: true });
  }

  // citizen reports
  if (p === '/api/reports' && m === 'GET') {
    if (!need()) return;
    const rows = pro(me) ? db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 200').all()
      : db.prepare('SELECT * FROM reports WHERE username=? ORDER BY id DESC LIMIT 100').all(me.username);
    return json(res, 200, rows.map(rep));
  }
  if (p === '/api/reports' && m === 'POST') {
    if (!need()) return;
    const b = await readBody(req);
    const hz = String(b.hazard || '').slice(0, 60), zone = Number.isInteger(+b.zone) ? +b.zone : me.zone;
    if (!hz) return json(res, 400, { error: 'Choose a hazard' });
    const r = db.prepare('INSERT INTO reports(zone,hazard,username) VALUES(?,?,?)').run(zone, hz, me.username);
    return json(res, 201, rep(db.prepare('SELECT * FROM reports WHERE id=?').get(r.lastInsertRowid)));
  }
  if ((mm = p.match(/^\/api\/reports\/(\d+)$/)) && m === 'PATCH') {
    if (!need(pro(me))) return;
    const b = await readBody(req);
    if (!['Verified', 'Dismissed'].includes(b.status)) return json(res, 400, { error: 'Bad status' });
    db.prepare('UPDATE reports SET status=? WHERE id=?').run(b.status, +mm[1]);
    return json(res, 200, rep(db.prepare('SELECT * FROM reports WHERE id=?').get(+mm[1])));
  }

  // check-ins ("I'm safe" / "I need help")
  if (p === '/api/checkins' && m === 'GET') {
    if (!need(pro(me))) return;
    return json(res, 200, db.prepare('SELECT * FROM checkins ORDER BY id DESC LIMIT 50').all().map(chk));
  }
  if (p === '/api/checkins' && m === 'POST') {
    if (!need()) return;
    const b = await readBody(req);
    if (!['safe', 'help'].includes(b.kind)) return json(res, 400, { error: 'Bad kind' });
    const r = db.prepare('INSERT INTO checkins(username,zone,kind) VALUES(?,?,?)').run(me.username, me.zone, b.kind);
    return json(res, 201, chk(db.prepare('SELECT * FROM checkins WHERE id=?').get(r.lastInsertRowid)));
  }
  if ((mm = p.match(/^\/api\/checkins\/(\d+)\/handled$/)) && m === 'PATCH') {
    if (!need(pro(me))) return;
    db.prepare('UPDATE checkins SET handled=1 WHERE id=?').run(+mm[1]);
    return json(res, 200, { ok: true });
  }

  // alerts: officers raise an alert; it is stored and texted to registered residents of that zone
  if (p === '/api/alerts' && m === 'GET') {
    if (!need()) return;
    return json(res, 200, db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 50').all()
      .map((a) => ({ id: a.id, zi: a.zone, lv: a.level, m: a.message, t: fmtTime(a.created) })));
  }
  if (p === '/api/alerts' && m === 'POST') {
    if (!need(pro(me))) return;
    const b = await readBody(req);
    const zone = +b.zone, level = +b.level, msg = String(b.message || '').slice(0, 300);
    if (!Number.isInteger(zone) || ![0, 1, 2, 3].includes(level) || !msg) return json(res, 400, { error: 'zone, level (0-3) and message required' });
    db.prepare('INSERT INTO alerts(zone,level,message,by_user) VALUES(?,?,?,?)').run(zone, level, msg, me.username);
    const subs = level >= 2 ? db.prepare("SELECT phone FROM users WHERE zone=? AND phone<>''").all(zone) : [];
    const results = [];
    for (const s of subs) results.push(await sendSms(s.phone, msg));
    return json(res, 201, { ok: true, texted: subs.length, results });
  }

  // compatibility with the console's "SMS backend URL" box
  if (p === '/send' && m === 'POST') {
    if (!need(pro(me))) return;
    const b = await readBody(req);
    if (!/^\+\d{10,15}$/.test(String(b.to || '')) || !b.message) return json(res, 400, { error: 'to (+countrycode) and message required' });
    const status = await sendSms(b.to, String(b.message).slice(0, 300));
    return json(res, status.startsWith('provider') || status.startsWith('network') ? 502 : 200, { status });
  }
  if (p === '/api/sms' && m === 'GET') {
    if (!need(me && me.role === 'Admin')) return;
    return json(res, 200, db.prepare('SELECT * FROM sms_log ORDER BY id DESC LIMIT 50').all());
  }

  if (p === '/api/datasources' && m === 'GET') return json(res, 200, sync.statusRows());
  if (p === '/api/sync' && m === 'POST') {
    if (!need(me && me.role === 'Admin')) return;
    await sync.runAll(true);
    return json(res, 200, sync.statusRows());
  }

  // satellite / GIS feed the console can load (Sources page -> Feed URL). Admin uploads rows, everyone's console reads them.
  if ((p === '/api/zone_metrics.json' || p === '/zone_metrics.json') && m === 'GET')
    return json(res, 200, db.prepare('SELECT zone,rain_mm_24h,soil_pct,ndvi,insar_mm,slope_deg,elevation_m,past_slides FROM zone_metrics').all());
  if (p === '/api/zone_metrics' && m === 'PUT') {
    if (!need(me && me.role === 'Admin')) return;
    const rows = await readBody(req);
    if (!Array.isArray(rows)) return json(res, 400, { error: 'Send a JSON array of zone rows' });
    const st = db.prepare(`INSERT INTO zone_metrics(zone,rain_mm_24h,soil_pct,ndvi,insar_mm,slope_deg,elevation_m,past_slides,updated) VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(zone) DO UPDATE SET rain_mm_24h=COALESCE(excluded.rain_mm_24h,rain_mm_24h),soil_pct=COALESCE(excluded.soil_pct,soil_pct),ndvi=COALESCE(excluded.ndvi,ndvi),insar_mm=COALESCE(excl[...]
    const n = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
    for (const r of rows) if (r.zone) st.run(String(r.zone), n(r.rain_mm_24h), n(r.soil_pct), n(r.ndvi), n(r.insar_mm), n(r.slope_deg), n(r.elevation_m), n(r.past_slides));
    return json(res, 200, { ok: true, rows: rows.length });
  }

  return json(res, 404, { error: 'Not found' });
}

// ---- static files + server ----------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '[...]
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/') || url.pathname === '/send' || url.pathname === '/zone_metrics.json') return await api(req, res, url);
    let f = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, e.message === 'bad json' ? 400 : 500, { error: e.message === 'bad json' ? 'Invalid JSON' : 'Server error' });
  }
});
if (require.main === module) server.listen(PORT, () => {
  console.log(`LANDSAFE AI running on http://localhost:${PORT}  (SMS: ${process.env.TWILIO_ACCOUNT_SID ? 'Twilio' : 'dry-run'})`);
  if (!process.env.NO_SYNC) {
    console.log('Fetching live data (Open-Meteo, NASA landslide catalog) in the background...');
    sync.runAll().catch((e) => console.error('[sync]', e.message));
    setInterval(() => sync.weather().catch(() => {}), 30 * 60 * 1000).unref();
  }
});
module.exports = server;
