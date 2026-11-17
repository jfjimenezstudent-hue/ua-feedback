'use strict';
/*
 * UA Office Feedback and Satisfaction System - server
 * ---------------------------------------------------
 * Node.js (22.13+). No npm packages needed.
 *
 *  - Student and administrator accounts (passwords hashed with scrypt)
 *  - Feedback is encrypted with AES-256-GCM before it is stored
 *  - Average rating and classification are calculated on the server
 *  - Administrators see summarized feedback and can download a CSV backup
 *  - Storage: Turso (free hosted database, survives restarts) when TURSO_* is set,
 *    otherwise a local SQLite file in DATA_DIR
 *
 * Environment variables:
 *   PORT                 port to listen on (Render sets this)
 *   FEEDBACK_KEY         secret text used to derive the AES-256 key (REQUIRED with Turso)
 *   ADMIN_USERNAME       first administrator's username (created once)
 *   ADMIN_PASSWORD       first administrator's password (min 8 characters)
 *   TURSO_DATABASE_URL   e.g. libsql://your-db-name.turso.io
 *   TURSO_AUTH_TOKEN     database token from the Turso dashboard
 *   DATA_DIR             folder for the local database file when Turso is not used (default ./data)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TURSO_URL = (process.env.TURSO_DATABASE_URL || '').trim();
const TURSO_TOKEN = (process.env.TURSO_AUTH_TOKEN || '').trim();

const OFFICES = [
  "Registrar's Office",
  'Library',
  "Cashier's Office",
  'Guidance and Counseling Office',
  'Clinic',
  'Admissions Office',
  'Student Affairs Office',
  'IT Services',
  'Canteen / Cafeteria',
];

const QUESTIONS = [
  'The staff were courteous and respectful.',
  'My concern was resolved in a reasonable amount of time.',
  'The staff were knowledgeable and helpful.',
  'The office or facility was clean and well organized.',
  'I would recommend this office to other students.',
];

const LEVELS = ['Excellent', 'Very Satisfactory', 'Satisfactory', 'Needs Improvement', 'Poor'];

const classify = (avg) =>
  avg >= 4.5 ? LEVELS[0] : avg >= 3.5 ? LEVELS[1] : avg >= 2.5 ? LEVELS[2] : avg >= 1.5 ? LEVELS[3] : LEVELS[4];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const round2 = (n) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Storage layer: one small interface, two backends
//   store.query(sql, args) -> Promise<{ rows: [ {column: value} ] }>
// ---------------------------------------------------------------------------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS students (
     id INTEGER PRIMARY KEY, student_id TEXT UNIQUE NOT NULL,
     salt TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admins (
     id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
     salt TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS feedback (
     id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL)`,
];

function localStore() {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, 'feedback.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  return {
    kind: 'local SQLite file in ' + DATA_DIR,
    async query(sql, args = []) {
      const st = db.prepare(sql);
      if (/^\s*select/i.test(sql)) return { rows: st.all(...args) };
      st.run(...args);
      return { rows: [] };
    },
  };
}

function tursoStore(url, token) {
  const endpoint = url.replace(/^libsql:\/\//i, 'https://').replace(/\/+$/, '') + '/v2/pipeline';
  const toArg = (v) => {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
    return { type: 'text', value: String(v) };
  };
  const fromValue = (c) => {
    if (!c || c.type === 'null') return null;
    if (c.type === 'integer') return Number(c.value);
    if (c.type === 'float') return Number(c.value);
    return c.value;
  };
  return {
    kind: 'Turso database ' + new URL(endpoint).host,
    async query(sql, args = []) {
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: args.map(toArg) } }, { type: 'close' }] }),
          signal: AbortSignal.timeout(15000),
        });
      } catch (e) {
        throw new Error('Cannot reach the Turso database: ' + (e.cause ? e.cause.message : e.message));
      }
      if (!res.ok) {
        const hint = res.status === 401 || res.status === 403 ? ' (check TURSO_AUTH_TOKEN)' : res.status === 404 ? ' (check TURSO_DATABASE_URL)' : '';
        throw new Error('Turso returned HTTP ' + res.status + hint);
      }
      const data = await res.json();
      const first = data.results && data.results[0];
      if (!first || first.type === 'error') {
        throw new Error('Turso error: ' + (first && first.error ? first.error.message : 'no result'));
      }
      const result = first.response.result;
      const names = (result.cols || []).map((c) => c.name);
      const rows = (result.rows || []).map((r) => Object.fromEntries(names.map((n, i) => [n, fromValue(r[i])])));
      return { rows };
    },
  };
}

const store = TURSO_URL ? tursoStore(TURSO_URL, TURSO_TOKEN) : localStore();

// ---------------------------------------------------------------------------
// AES-256-GCM encryption of feedback records
// ---------------------------------------------------------------------------
function loadKey() {
  if (process.env.FEEDBACK_KEY) {
    return crypto.scryptSync(process.env.FEEDBACK_KEY, 'ua-office-feedback', 32);
  }
  if (TURSO_URL) {
    console.error('FEEDBACK_KEY is required when using Turso. Without a fixed key, saved feedback could not be read after a restart.');
    process.exit(1);
  }
  const file = path.join(DATA_DIR, 'aes256.key');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600 });
  console.warn('NOTE: FEEDBACK_KEY is not set, so a key file was created in ' + DATA_DIR + '.');
  return key;
}
const KEY = loadKey();

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function decrypt(token) {
  const raw = Buffer.from(token, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const pt = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

async function loadRecords() {
  const out = [];
  const { rows } = await store.query('SELECT created_at, data FROM feedback ORDER BY id');
  for (const row of rows) {
    try {
      out.push({ t: row.created_at, ...decrypt(row.data) });
    } catch (e) {
      console.warn('A feedback record could not be decrypted (wrong key or altered data). Skipped.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Passwords and sessions (sessions live in memory: a restart logs everyone out)
// ---------------------------------------------------------------------------
const DUMMY_SALT = crypto.randomBytes(16);
const hashPw = (pw, salt) => scrypt(pw, salt, 64);

async function makeCred(pw) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('hex'), hash: (await hashPw(pw, salt)).toString('hex') };
}

async function checkCred(row, pw) {
  const h = await hashPw(pw, row ? Buffer.from(row.salt, 'hex') : DUMMY_SALT); // hash even when the user is unknown
  return !!row && crypto.timingSafeEqual(h, Buffer.from(row.hash, 'hex'));
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const COOKIE = { student: 'ua_s', admin: 'ua_a' };
const TTL = { student: 12 * 3600e3, admin: 2 * 3600e3 };
const sessions = new Map();

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function startSession(ctx, role, name) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(sha(token), { role, name, expires: Date.now() + TTL[role] });
  const secure = ctx.req.headers['x-forwarded-proto'] === 'https' || ctx.req.socket.encrypted;
  ctx.cookies.push(`${COOKIE[role]}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL[role] / 1000}${secure ? '; Secure' : ''}`);
}

function endSession(ctx, role) {
  const t = parseCookies(ctx.req)[COOKIE[role]];
  if (t) sessions.delete(sha(t));
  ctx.cookies.push(`${COOKIE[role]}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function getSession(req, role) {
  const t = parseCookies(req)[COOKIE[role]];
  if (!t) return null;
  const s = sessions.get(sha(t));
  return s && s.role === role && s.expires > Date.now() ? s : null;
}

function requireRole(ctx, role) {
  const s = getSession(ctx.req, role);
  if (!s) throw new HttpError(401, role === 'admin' ? 'Please log in as an administrator.' : 'Please log in with your student account.');
  return s;
}

setInterval(() => { const now = Date.now(); for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k); }, 600e3).unref();

// ---------------------------------------------------------------------------
// Rate limiting (in memory)
// ---------------------------------------------------------------------------
const hits = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => hits.clear(), 3600e3).unref();

function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || 'unknown';
}

function limitAuth(ctx) {
  if (tooMany('auth:' + ctx.ip, 15, 15 * 60e3)) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}

// ---------------------------------------------------------------------------
// Tiny router
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const routes = new Map();
const route = (method, p, fn) => routes.set(method + ' ' + p, fn);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20000) { reject(new HttpError(413, 'Request is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
route('GET', '/api/config', () => ({ offices: OFFICES, questions: QUESTIONS, levels: LEVELS }));

route('GET', '/api/me', (ctx) => ({
  student: (getSession(ctx.req, 'student') || {}).name || null,
  admin: (getSession(ctx.req, 'admin') || {}).name || null,
}));

// ----- students
function checkStudentFields(body) {
  const id = String(body.studentId || '').trim().toLowerCase();
  const pw = String(body.password || '');
  if (!/^[a-z0-9-]{4,20}$/.test(id)) throw new HttpError(400, 'Student ID must be 4 to 20 letters, numbers or dashes.');
  if (pw.length < 8 || pw.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');
  return { id, pw };
}

route('POST', '/api/student/register', async (ctx) => {
  limitAuth(ctx);
  const { id, pw } = checkStudentFields(ctx.body);
  const exists = await store.query('SELECT 1 AS x FROM students WHERE student_id = ?', [id]);
  if (exists.rows.length) throw new HttpError(409, 'That student ID already has an account.');
  const { salt, hash } = await makeCred(pw);
  try {
    await store.query('INSERT INTO students (student_id, salt, hash, created_at) VALUES (?,?,?,?)', [id, salt, hash, new Date().toISOString()]);
  } catch (e) {
    if (/unique|constraint/i.test(e.message)) throw new HttpError(409, 'That student ID already has an account.');
    throw e;
  }
  startSession(ctx, 'student', id);
  return { name: id };
});

route('POST', '/api/student/login', async (ctx) => {
  limitAuth(ctx);
  const id = String(ctx.body.studentId || '').trim().toLowerCase();
  const row = (await store.query('SELECT student_id, salt, hash FROM students WHERE student_id = ?', [id])).rows[0];
  if (!(await checkCred(row, String(ctx.body.password || '')))) throw new HttpError(401, 'Incorrect student ID or password.');
  startSession(ctx, 'student', row.student_id);
  return { name: row.student_id };
});

route('POST', '/api/student/logout', (ctx) => { endSession(ctx, 'student'); return { ok: true }; });

// ----- feedback
route('POST', '/api/feedback', async (ctx) => {
  requireRole(ctx, 'student');
  if (tooMany('fb:' + ctx.ip, 60, 3600e3)) throw new HttpError(429, 'Too many submissions. Please try again later.');
  const { office, overall, answers, comment } = ctx.body;
  const okRating = (n) => Number.isInteger(n) && n >= 1 && n <= 5;
  if (!OFFICES.includes(office)) throw new HttpError(400, 'Please choose an office from the list.');
  if (!okRating(overall) || !Array.isArray(answers) || answers.length !== QUESTIONS.length || !answers.every(okRating)) {
    throw new HttpError(400, 'Please answer every rating question with a number from 1 to 5.');
  }
  const text = String(comment || '').trim().slice(0, 500);
  const average = round2(mean([overall, ...answers]));
  const level = classify(average);
  // The record is NOT linked to the student account, so responses stay anonymous.
  await store.query('INSERT INTO feedback (created_at, data) VALUES (?,?)',
    [new Date().toISOString(), encrypt({ office, overall, answers, average, level, comment: text })]);
  return { average, level };
});

// ----- administrators
route('POST', '/api/admin/login', async (ctx) => {
  limitAuth(ctx);
  const name = String(ctx.body.username || '').trim().toLowerCase();
  const row = (await store.query('SELECT username, salt, hash FROM admins WHERE username = ?', [name])).rows[0];
  if (!(await checkCred(row, String(ctx.body.password || '')))) throw new HttpError(401, 'Incorrect username or password.');
  startSession(ctx, 'admin', row.username);
  return { name: row.username };
});

route('POST', '/api/admin/logout', (ctx) => { endSession(ctx, 'admin'); return { ok: true }; });

route('POST', '/api/admin/create', async (ctx) => {
  requireRole(ctx, 'admin');
  const name = String(ctx.body.username || '').trim().toLowerCase();
  const pw = String(ctx.body.password || '');
  if (!/^[a-z0-9._-]{3,30}$/.test(name)) throw new HttpError(400, 'Username must be 3 to 30 letters, numbers, dots or dashes.');
  if (pw.length < 8 || pw.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');
  const exists = await store.query('SELECT 1 AS x FROM admins WHERE username = ?', [name]);
  if (exists.rows.length) throw new HttpError(409, 'That username already exists.');
  const { salt, hash } = await makeCred(pw);
  await store.query('INSERT INTO admins (username, salt, hash, created_at) VALUES (?,?,?,?)', [name, salt, hash, new Date().toISOString()]);
  return { name };
});

route('GET', '/api/admin/summary', async (ctx) => {
  requireRole(ctx, 'admin');
  const records = await loadRecords();
  const by = new Map();
  for (const r of records) { if (!by.has(r.office)) by.set(r.office, []); by.get(r.office).push(r); }
  const offices = [...by.keys()].sort().map((office) => {
    const avg = round2(mean(by.get(office).map((r) => r.average)));
    return { office, count: by.get(office).length, average: avg, level: classify(avg) };
  });
  const total = records.length ? round2(mean(records.map((r) => r.average))) : null;
  return { offices, total: { count: records.length, average: total, level: total === null ? null : classify(total) } };
});

route('GET', '/api/admin/office', async (ctx) => {
  requireRole(ctx, 'admin');
  const office = ctx.url.searchParams.get('name');
  const group = (await loadRecords()).filter((r) => r.office === office);
  if (!group.length) throw new HttpError(404, 'No feedback for that office yet.');
  return {
    office,
    count: group.length,
    overall: round2(mean(group.map((r) => r.overall))),
    questions: QUESTIONS.map((q, i) => ({ question: q, mean: round2(mean(group.map((r) => r.answers[i]))) })),
    distribution: LEVELS.map((level) => ({ level, count: group.filter((r) => r.level === level).length })),
    comments: group.filter((r) => r.comment).map((r) => ({ t: r.t, average: r.average, comment: r.comment })),
  };
});

route('GET', '/api/admin/export.csv', async (ctx) => {
  requireRole(ctx, 'admin');
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const head = ['timestamp', 'office', 'overall', ...QUESTIONS.map((_, i) => 'q' + (i + 1)), 'average', 'classification', 'comment'];
  const lines = [head.map(cell).join(',')];
  for (const r of await loadRecords()) {
    lines.push([r.t, r.office, r.overall, ...r.answers, r.average, r.level, r.comment].map(cell).join(','));
  }
  // The leading BOM makes Excel open accents and symbols correctly.
  return { __raw: '﻿' + lines.join('\r\n') + '\r\n', type: 'text/csv; charset=utf-8', filename: 'ua-feedback-' + today() + '.csv' };
});

route('GET', '/api/admin/export.json', async (ctx) => {
  requireRole(ctx, 'admin');
  const records = (await loadRecords()).map((r) => ({
    timestamp: r.t, office: r.office, overall: r.overall, answers: r.answers,
    average: r.average, classification: r.level, comment: r.comment,
  }));
  const backup = { system: 'UA Office Feedback', exportedAt: new Date().toISOString(), questions: QUESTIONS, count: records.length, records };
  return { __raw: JSON.stringify(backup, null, 2), type: 'application/json; charset=utf-8', filename: 'ua-feedback-backup-' + today() + '.json' };
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.json': 'application/json',
};

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { rel = '/'; }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');

  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  }

  const ctx = { req, res, url, ip: clientIp(req), cookies: [], body: {} };
  try {
    const fn = routes.get(req.method + ' ' + url.pathname);
    if (!fn) throw new HttpError(404, 'Not found.');
    if (req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'Send JSON.');
      ctx.body = await readBody(req);
    }
    const result = await fn(ctx);
    if (ctx.cookies.length) res.setHeader('Set-Cookie', ctx.cookies);
    res.setHeader('Cache-Control', 'no-store');
    if (result && result.__raw !== undefined) {
      res.writeHead(200, { 'Content-Type': result.type, 'Content-Disposition': `attachment; filename="${result.filename}"` });
      return res.end(result.__raw);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (ctx.cookies.length) res.setHeader('Set-Cookie', ctx.cookies);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong on the server.' : e.message }));
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function bootstrapAdmin() {
  const count = (await store.query('SELECT COUNT(*) AS c FROM admins')).rows[0].c;
  if (count > 0) return;
  let user = (process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  let pass = process.env.ADMIN_PASSWORD || '';
  let generated = false;
  if (!user || pass.length < 8) {
    user = 'admin';
    pass = crypto.randomBytes(9).toString('base64url');
    generated = true;
  }
  const { salt, hash } = await makeCred(pass);
  await store.query('INSERT INTO admins (username, salt, hash, created_at) VALUES (?,?,?,?)', [user, salt, hash, new Date().toISOString()]);
  if (generated) {
    console.log('==============================================================');
    console.log(' First administrator created (shown only once):');
    console.log('   username: ' + user);
    console.log('   password: ' + pass);
    console.log(' Set ADMIN_USERNAME and ADMIN_PASSWORD to choose your own.');
    console.log('==============================================================');
  } else {
    console.log(`First administrator "${user}" created from ADMIN_USERNAME / ADMIN_PASSWORD.`);
  }
}

(async () => {
  try {
    for (const sql of SCHEMA) await store.query(sql);
    console.log('Storage: ' + store.kind);
    await bootstrapAdmin();
  } catch (e) {
    console.error('Could not start because the database is not working: ' + e.message);
    process.exit(1);
  }
  server.listen(PORT, '0.0.0.0', () => console.log(`UA Office Feedback is running on port ${PORT}`));
})();
