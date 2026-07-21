'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// 数据库选择：设置了 DATABASE_URL（如 Koyeb 托管 Postgres）则用 Postgres，否则用本地 SQLite
const DATABASE_URL = process.env.DATABASE_URL || '';
const usePg = !!DATABASE_URL;

let sqliteDb = null;
let pgPool = null;
if (usePg) {
  const { Pool } = require('pg');
  const ssl = DATABASE_URL.startsWith('postgres://') ? { rejectUnauthorized: false } : false;
  pgPool = new Pool({ connectionString: DATABASE_URL, ssl });
} else {
  const { DatabaseSync } = require('node:sqlite');
  sqliteDb = new DatabaseSync(path.join(DATA_DIR, 'hr.db'));
  sqliteDb.exec('PRAGMA journal_mode = WAL;');
  sqliteDb.exec('PRAGMA foreign_keys = ON;');
}

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  company_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  gender TEXT,
  phone TEXT,
  email TEXT,
  position TEXT,
  source TEXT,
  stage INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  owner_id INTEGER,
  owner_name TEXT,
  expected_salary TEXT,
  current_org TEXT,
  education TEXT,
  interview_note TEXT,
  notes TEXT,
  tags TEXT,
  expected_onboard_date TEXT,
  hired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS onboarding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  candidate_name TEXT,
  position TEXT,
  handler_id INTEGER,
  handler_name TEXT,
  items TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  user_name TEXT,
  action TEXT,
  candidate_id INTEGER,
  candidate_name TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
`;

const PG_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    company_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS candidates (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    gender TEXT,
    phone TEXT,
    email TEXT,
    position TEXT,
    source TEXT,
    stage INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    owner_id INTEGER,
    owner_name TEXT,
    expected_salary TEXT,
    current_org TEXT,
    education TEXT,
    interview_note TEXT,
    notes TEXT,
    tags TEXT,
    expected_onboard_date TEXT,
    hired_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS onboarding (
    id SERIAL PRIMARY KEY,
    candidate_id INTEGER NOT NULL,
    candidate_name TEXT,
    position TEXT,
    handler_id INTEGER,
    handler_name TEXT,
    items TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS activities (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    user_name TEXT,
    action TEXT,
    candidate_id INTEGER,
    candidate_name TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL
  )`
];

// 公司密钥与初始管理员（可通过环境变量覆盖，便于部署时修改）
const COMPANY_KEY = process.env.COMPANY_KEY || 'hualian2026';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const now = () => new Date().toISOString();
const uid = () => crypto.randomBytes(24).toString('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(pw, salt, 64).toString('hex');
  return salt + ':' + derived;
}
function verifyPassword(pw, stored) {
  const [salt, key] = String(stored).split(':');
  if (!salt || !key) return false;
  const derived = crypto.scryptSync(pw, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(derived, 'hex'));
  } catch { return false; }
}

// ---------- DB 抽象层（SQLite / Postgres 统一接口）----------
const ID_TABLES = new Set(['users', 'candidates', 'onboarding', 'activities']);
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}
function prepare(sql) {
  if (!usePg) {
    const stmt = sqliteDb.prepare(sql);
    return {
      get: (...p) => Promise.resolve(stmt.get(...p)),
      all: (...p) => Promise.resolve(stmt.all(...p)),
      run: (...p) => Promise.resolve(stmt.run(...p)),
    };
  }
  const m = sql.match(/^\s*insert\s+into\s+([a-z_]+)/i);
  const table = m ? m[1] : null;
  const needReturning = !!m && ID_TABLES.has(table);
  const pgSql = needReturning ? toPgSql(sql) + ' RETURNING id' : toPgSql(sql);
  return {
    async get(...p) { const r = await pgPool.query(pgSql, p); return r.rows[0] || null; },
    async all(...p) { const r = await pgPool.query(pgSql, p); return r.rows; },
    async run(...p) {
      const r = await pgPool.query(pgSql, p);
      const lastId = (needReturning && r.rows[0]) ? r.rows[0].id : undefined;
      return { lastInsertRowid: lastId, changes: r.rowCount };
    }
  };
}
const db = { prepare };

// ---------- 初始化 ----------
async function initSchema() {
  if (usePg) {
    for (const s of PG_SCHEMA) await pgPool.query(s);
  } else {
    sqliteDb.exec(SQLITE_SCHEMA);
  }
}
async function seedAdmin() {
  const row = await db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (Number(row.c) === 0) {
    await db.prepare('INSERT INTO users (username, password, name, role, company_key, created_at) VALUES (?,?,?,?,?,?)')
      .run('admin', hashPassword(ADMIN_PASSWORD), '系统管理员', 'admin', COMPANY_KEY, now());
  }
}

// ---------- Helpers ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) reject(new Error('payload too large')); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function getToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}
async function getUserFromToken(req) {
  const token = getToken(req);
  if (!token) return null;
  const row = await db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return await db.prepare('SELECT id, username, name, role FROM users WHERE id = ?').get(row.user_id) || null;
}
async function logActivity(user, action, candidate, detail) {
  try {
    await db.prepare('INSERT INTO activities (user_id, user_name, action, candidate_id, candidate_name, detail, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(user ? user.id : null, user ? user.name : '系统', action, candidate ? candidate.id : null, candidate ? candidate.name : null, detail || '', now());
  } catch (e) { /* ignore */ }
}

const STAGES = ['简历筛选', '初试', '复试', '终面', 'Offer', '入职'];

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' }); return res.end(); }

    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const q = url.searchParams;

    // Static files
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      return serveStatic(pathname, res);
    }

    // ---- Auth endpoints ----
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.username || !b.password || !b.name || !b.company_key)
        return sendJSON(res, 400, { error: '请填写用户名、密码、姓名和公司密钥' });
      if (String(b.company_key).trim() !== COMPANY_KEY)
        return sendJSON(res, 403, { error: '公司密钥不正确，无法注册' });
      const exists = await db.prepare('SELECT id FROM users WHERE username = ?').get(b.username);
      if (exists) return sendJSON(res, 409, { error: '该用户名已被占用' });
      const info = await db.prepare('INSERT INTO users (username, password, name, role, company_key, created_at) VALUES (?,?,?,?,?,?)')
        .run(b.username, hashPassword(b.password), b.name, 'member', COMPANY_KEY, now());
      const token = uid();
      const exp = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
      await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, Number(info.lastInsertRowid), exp);
      return sendJSON(res, 200, { token, user: { id: Number(info.lastInsertRowid), username: b.username, name: b.name, role: 'member' } });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const b = await readBody(req);
      const u = await db.prepare('SELECT * FROM users WHERE username = ?').get(b.username);
      if (!u || !verifyPassword(b.password || '', u.password))
        return sendJSON(res, 401, { error: '用户名或密码错误' });
      const token = uid();
      const exp = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
      await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, u.id, exp);
      return sendJSON(res, 200, { token, user: { id: u.id, username: u.username, name: u.name, role: u.role } });
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const token = getToken(req);
      if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const u = await getUserFromToken(req);
      if (!u) return sendJSON(res, 401, { error: '未登录' });
      return sendJSON(res, 200, { user: u, company_key: COMPANY_KEY });
    }

    // ---- Protected API ----
    const user = await getUserFromToken(req);
    if (!user) return sendJSON(res, 401, { error: '未登录或登录已过期' });

    // Candidates list
    if (pathname === '/api/candidates' && req.method === 'GET') {
      const clauses = [];
      const params = [];
      const status = q.get('status');
      if (status) { clauses.push('status = ?'); params.push(status); }
      const stage = q.get('stage');
      if (stage !== null && stage !== '') { clauses.push('stage = ?'); params.push(Number(stage)); }
      const owner = q.get('owner');
      if (owner) { clauses.push('owner_id = ?'); params.push(Number(owner)); }
      const search = q.get('q');
      if (search) { clauses.push('(name LIKE ? OR phone LIKE ? OR position LIKE ?)'); const s = '%' + search + '%'; params.push(s, s, s); }
      const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
      const rows = await db.prepare(`SELECT * FROM candidates ${where} ORDER BY updated_at DESC`).all(...params);
      return sendJSON(res, 200, { candidates: rows, stages: STAGES });
    }

    // Create candidate
    if (pathname === '/api/candidates' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.name) return sendJSON(res, 400, { error: '请填写候选人姓名' });
      const stage = (b.stage !== undefined && b.stage !== '') ? Number(b.stage) : 0;
      const info = await db.prepare(`INSERT INTO candidates
        (name, gender, phone, email, position, source, stage, status, owner_id, owner_name, expected_salary, current_org, education, interview_note, notes, tags, expected_onboard_date, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(b.name, b.gender || '', b.phone || '', b.email || '', b.position || '', b.source || '',
          stage, 'active', user.id, user.name, b.expected_salary || '', b.current_org || '', b.education || '',
          b.interview_note || '', b.notes || '', b.tags || '', b.expected_onboard_date || '', now(), now());
      const cand = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(Number(info.lastInsertRowid));
      await logActivity(user, '新增候选人', cand, `添加候选人 ${cand.name}（${STAGES[stage]}）`);
      return sendJSON(res, 200, { candidate: cand });
    }

    // candidate detail / update / delete
    const m = pathname.match(/^\/api\/candidates\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (req.method === 'GET') {
        const c = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
        if (!c) return sendJSON(res, 404, { error: '未找到' });
        return sendJSON(res, 200, { candidate: c });
      }
      if (req.method === 'PUT') {
        const b = await readBody(req);
        const c = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
        if (!c) return sendJSON(res, 404, { error: '未找到' });
        const upd = {
          name: b.name ?? c.name, gender: b.gender ?? c.gender, phone: b.phone ?? c.phone,
          email: b.email ?? c.email, position: b.position ?? c.position, source: b.source ?? c.source,
          stage: (b.stage !== undefined && b.stage !== '') ? Number(b.stage) : c.stage,
          owner_id: (b.owner_id !== undefined) ? b.owner_id : c.owner_id,
          owner_name: (b.owner_name !== undefined) ? b.owner_name : c.owner_name,
          expected_salary: b.expected_salary ?? c.expected_salary, current_org: b.current_org ?? c.current_org,
          education: b.education ?? c.education, interview_note: b.interview_note ?? c.interview_note,
          notes: b.notes ?? c.notes, tags: b.tags ?? c.tags, expected_onboard_date: b.expected_onboard_date ?? c.expected_onboard_date
        };
        await db.prepare(`UPDATE candidates SET name=?,gender=?,phone=?,email=?,position=?,source=?,stage=?,owner_id=?,owner_name=?,expected_salary=?,current_org=?,education=?,interview_note=?,notes=?,tags=?,expected_onboard_date=?,updated_at=? WHERE id=?`)
          .run(upd.name, upd.gender, upd.phone, upd.email, upd.position, upd.source, upd.stage, upd.owner_id, upd.owner_name, upd.expected_salary, upd.current_org, upd.education, upd.interview_note, upd.notes, upd.tags, upd.expected_onboard_date, now(), id);
        const nc = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
        await logActivity(user, '更新候选人', nc, `更新 ${nc.name} 的资料`);
        return sendJSON(res, 200, { candidate: nc });
      }
      if (req.method === 'DELETE') {
        const c = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
        if (!c) return sendJSON(res, 404, { error: '未找到' });
        await db.prepare('DELETE FROM candidates WHERE id = ?').run(id);
        await logActivity(user, '删除候选人', c, `删除候选人 ${c.name}`);
        return sendJSON(res, 200, { ok: true });
      }
    }

    // advance stage
    const mAdv = pathname.match(/^\/api\/candidates\/(\d+)\/advance$/);
    if (mAdv && req.method === 'POST') {
      const id = Number(mAdv[1]);
      const c = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
      if (!c) return sendJSON(res, 404, { error: '未找到' });
      if (c.status !== 'active') return sendJSON(res, 400, { error: '该候选人不在招聘流程中' });
      let stage = c.stage + 1;
      let status = 'active';
      if (stage >= STAGES.length) { stage = STAGES.length - 1; status = 'hired'; }
      const b = await readBody(req);
      const hiredAt = status === 'hired' ? now() : c.hired_at;
      await db.prepare('UPDATE candidates SET stage=?, status=?, hired_at=?, interview_note=COALESCE(?,interview_note), updated_at=? WHERE id=?')
        .run(stage, status, hiredAt, b.interview_note || null, now(), id);
      const nc = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
      await logActivity(user, '推进阶段', nc, `${c.name} 进入「${STAGES[stage]}」`);
      if (status === 'hired') await ensureOnboarding(nc);
      return sendJSON(res, 200, { candidate: nc });
    }

    // set back stage (退回)
    const mBack = pathname.match(/^\/api\/candidates\/(\d+)\/backward$/);
    if (mBack && req.method === 'POST') {
      const id = Number(mBack[1]);
      const c = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
      if (!c) return sendJSON(res, 404, { error: '未找到' });
      let stage = Math.max(0, c.stage - 1);
      await db.prepare('UPDATE candidates SET stage=?, status=?, updated_at=? WHERE id=?').run(stage, 'active', now(), id);
      const nc = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
      await logActivity(user, '退回阶段', nc, `${c.name} 退回至「${STAGES[stage]}」`);
      return sendJSON(res, 200, { candidate: nc });
    }

    // move to talent pool
    const mPool = pathname.match(/^\/api\/candidates\/(\d+)\/pool$/);
    if (mPool && req.method === 'POST') {
      const id = Number(mPool[1]);
      const c = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
      if (!c) return sendJSON(res, 404, { error: '未找到' });
      const b = await readBody(req);
      await db.prepare('UPDATE candidates SET status=?, tags=COALESCE(?,tags), notes=COALESCE(?,notes), updated_at=? WHERE id=?')
        .run('in_pool', b.tags || null, b.notes || null, now(), id);
      const nc = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
      await logActivity(user, '转入人才库', nc, `${c.name} 进入人才库`);
      return sendJSON(res, 200, { candidate: nc });
    }

    // reject
    const mRej = pathname.match(/^\/api\/candidates\/(\d+)\/reject$/);
    if (mRej && req.method === 'POST') {
      const id = Number(mRej[1]);
      const c = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
      if (!c) return sendJSON(res, 404, { error: '未找到' });
      await db.prepare('UPDATE candidates SET status=?, updated_at=? WHERE id=?').run('rejected', now(), id);
      const nc = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
      await logActivity(user, '淘汰候选人', nc, `${c.name} 被标记为淘汰`);
      return sendJSON(res, 200, { candidate: nc });
    }

    // hire directly
    const mHire = pathname.match(/^\/api\/candidates\/(\d+)\/hire$/);
    if (mHire && req.method === 'POST') {
      const id = Number(mHire[1]);
      const c = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
      if (!c) return sendJSON(res, 404, { error: '未找到' });
      await db.prepare('UPDATE candidates SET status=?, stage=?, hired_at=?, updated_at=? WHERE id=?')
        .run('hired', STAGES.length - 1, now(), now(), id);
      const nc = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
      await logActivity(user, '标记为入职', nc, `${c.name} 标记为已入职`);
      await ensureOnboarding(nc);
      return sendJSON(res, 200, { candidate: nc });
    }

    // reactivate from pool/rejected
    const mRe = pathname.match(/^\/api\/candidates\/(\d+)\/reactivate$/);
    if (mRe && req.method === 'POST') {
      const id = Number(mRe[1]);
      const c = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
      if (!c) return sendJSON(res, 404, { error: '未找到' });
      await db.prepare('UPDATE candidates SET status=?, updated_at=? WHERE id=?').run('active', now(), id);
      const nc = await db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
      await logActivity(user, '重新激活', nc, `${c.name} 重新进入招聘流程`);
      return sendJSON(res, 200, { candidate: nc });
    }

    // Onboarding list
    if (pathname === '/api/onboarding' && req.method === 'GET') {
      const rows = await db.prepare('SELECT * FROM onboarding ORDER BY created_at DESC').all();
      return sendJSON(res, 200, { onboarding: rows });
    }
    const mOnb = pathname.match(/^\/api\/onboarding\/(\d+)$/);
    if (mOnb) {
      const id = Number(mOnb[1]);
      if (req.method === 'GET') {
        const o = await db.prepare('SELECT * FROM onboarding WHERE id = ?').get(id);
        if (!o) return sendJSON(res, 404, { error: '未找到' });
        return sendJSON(res, 200, { onboarding: o });
      }
      if (req.method === 'PUT') {
        const b = await readBody(req);
        const o = await db.prepare('SELECT * FROM onboarding WHERE id = ?').get(id);
        if (!o) return sendJSON(res, 404, { error: '未找到' });
        let items = o.items;
        if (b.items) items = JSON.stringify(b.items);
        const completed = b.completed_at !== undefined ? b.completed_at : o.completed_at;
        await db.prepare('UPDATE onboarding SET items=?, handler_id=?, handler_name=?, completed_at=? WHERE id=?')
          .run(items, b.handler_id !== undefined ? b.handler_id : o.handler_id, b.handler_name !== undefined ? b.handler_name : o.handler_name, completed, id);
        const no = await db.prepare('SELECT * FROM onboarding WHERE id = ?').get(id);
        await logActivity(user, '更新入职办理', { name: no.candidate_name }, `更新 ${no.candidate_name} 的入职清单`);
        return sendJSON(res, 200, { onboarding: no });
      }
    }

    // Users list (employees)
    if (pathname === '/api/users' && req.method === 'GET') {
      const rows = await db.prepare('SELECT id, username, name, role, created_at FROM users ORDER BY created_at').all();
      return sendJSON(res, 200, { users: rows, company_key: COMPANY_KEY });
    }

    // Activities
    if (pathname === '/api/activities' && req.method === 'GET') {
      const limit = Number(q.get('limit') || 30);
      const rows = await db.prepare('SELECT * FROM activities ORDER BY id DESC LIMIT ?').all(limit);
      return sendJSON(res, 200, { activities: rows });
    }

    // Stats / dashboard
    if (pathname === '/api/stats' && req.method === 'GET') {
      const all = await db.prepare('SELECT * FROM candidates').all();
      const active = all.filter(c => c.status === 'active');
      const pool = all.filter(c => c.status === 'in_pool');
      const hired = all.filter(c => c.status === 'hired');
      const rejected = all.filter(c => c.status === 'rejected');
      // 招聘漏斗（累积式）：按候选人到达过的最远阶段统计，保证单调递减
      const reachOf = (c) => c.status === 'hired' ? STAGES.length - 1 : (c.stage || 0);
      const funnel = STAGES.map((label, i) => ({ stage: i, label, count: all.filter(c => reachOf(c) >= i).length }));
      const sourceDist = {};
      all.forEach(c => { if (c.source) sourceDist[c.source] = (sourceDist[c.source] || 0) + 1; });
      const sourceArr = Object.entries(sourceDist).map(([k, v]) => ({ source: k, count: v })).sort((a, b) => b.count - a.count);
      const startMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
      const newThisMonth = all.filter(c => c.created_at >= startMonth).length;
      const totalDecided = hired.length + rejected.length;
      const hireRate = totalDecided ? Math.round((hired.length / totalDecided) * 100) : 0;
      return sendJSON(res, 200, {
        stats: {
          active: active.length, pool: pool.length, hired: hired.length, rejected: rejected.length,
          total: all.length, newThisMonth, hireRate, funnel, sourceArr
        }
      });
    }

    return sendJSON(res, 404, { error: '接口不存在' });
  } catch (e) {
    console.error(e);
    sendJSON(res, 500, { error: '服务器错误: ' + e.message });
  }
});

async function ensureOnboarding(c) {
  const exists = await db.prepare('SELECT id FROM onboarding WHERE candidate_id = ?').get(c.id);
  if (exists) return;
  const defaultItems = [
    '签订劳动合同', '收集身份证/学历证复印件', '办理工牌', '开通邮箱/企业微信账号',
    '入职培训', '分配工位与设备', '社保公积金开户'
  ].map((label, i) => ({ key: 'item' + i, label, done: false }));
  await db.prepare('INSERT INTO onboarding (candidate_id, candidate_name, position, handler_id, handler_name, items, started_at, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(c.id, c.name, c.position || '', null, '', JSON.stringify(defaultItems), now(), now());
}

// ---------- Static ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  const base = path.basename(filePath);
  if (['server.js', 'package.json'].includes(base) || filePath.includes(path.join(PUBLIC_DIR, 'data'))) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- 启动 ----------
(async () => {
  try {
    await initSchema();
    await seedAdmin();
    server.listen(PORT, HOST, () => {
      console.log(`HR Talent System running at http://${HOST}:${PORT} [${usePg ? 'Postgres' : 'SQLite'}]`);
    });
  } catch (e) {
    console.error('启动失败:', e);
    process.exit(1);
  }
})();

module.exports = server;
