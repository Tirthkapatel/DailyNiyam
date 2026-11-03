/* Daily Niyam Server — auth + daily reports + private groups + admin (Vercel + Turso ready)
   Pattern mirrors Snapmark: single Node file, action dispatch over POST /api
   { action, args, token }. Exports a Vercel handler; listens locally when run
   directly (and serves the built client from ../dist on the same origin).
   DB: Turso (libSQL) when TURSO_DATABASE_URL is set; otherwise a local libSQL
   file (data/daily-niyam.db) for development.
   Auth: email + password ONLY (no OTP anywhere). Passwords PBKDF2-hashed.
   Signup issues 8 one-time backup codes (only hashes stored). The FIRST
   registered user becomes admin. */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');

const PORT = process.env.PORT || 8793;
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-prod';
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const EDIT_WINDOW_MS = 5 * 60 * 1000; // reports editable only 5 minutes after first save
const RECOVERY_MAX_FAILS = 5;
const RECOVERY_LOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

const LOCAL_DB = path.join(__dirname, '..', 'data', 'daily-niyam.db');
if (!process.env.TURSO_DATABASE_URL) fs.mkdirSync(path.dirname(LOCAL_DB), { recursive: true });
const db = process.env.TURSO_DATABASE_URL
  ? createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
  : createClient({ url: 'file:' + LOCAL_DB });

/* ---------------- schema ---------------- */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     email TEXT UNIQUE NOT NULL,
     pass_hash TEXT NOT NULL,
     is_admin INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS reports (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL,
     date TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(user_id, date)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_reports_user_date ON reports(user_id, date)`,
  `CREATE TABLE IF NOT EXISTS groups (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     invite_code TEXT UNIQUE NOT NULL,
     admin_id INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS group_members (
     group_id INTEGER NOT NULL,
     user_id INTEGER NOT NULL,
     joined_at INTEGER NOT NULL,
     PRIMARY KEY (group_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_gm_user ON group_members(user_id)`,
  `CREATE TABLE IF NOT EXISTS group_join_requests (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     group_id INTEGER NOT NULL,
     user_id INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_gjr_group ON group_join_requests(group_id, status)`,
  `CREATE TABLE IF NOT EXISTS backup_codes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL,
     code_hash TEXT NOT NULL,
     used_at INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_bc_user ON backup_codes(user_id)`,
  `CREATE TABLE IF NOT EXISTS auth_guards (
     key TEXT PRIMARY KEY,
     count INTEGER NOT NULL DEFAULT 0,
     window_start INTEGER NOT NULL,
     locked_until INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS support_messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     email TEXT NOT NULL,
     type TEXT NOT NULL,
     message TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     read_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     announcement_text TEXT NOT NULL DEFAULT '',
     announcement_on INTEGER NOT NULL DEFAULT 0,
     maintenance_on INTEGER NOT NULL DEFAULT 0,
     maintenance_msg TEXT NOT NULL DEFAULT '',
     latest_version TEXT NOT NULL DEFAULT '',
     update_notes TEXT NOT NULL DEFAULT '',
     download_url TEXT NOT NULL DEFAULT '',
     force_update INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS user_settings (
     user_id INTEGER PRIMARY KEY,
     reminder_enabled INTEGER NOT NULL DEFAULT 1,
     reminder_time TEXT NOT NULL DEFAULT '21:00',
     smaran_enabled INTEGER NOT NULL DEFAULT 0,
     smaran_interval INTEGER NOT NULL DEFAULT 30
   )`,
];

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const stmt of SCHEMA) await db.execute(stmt);
      await db.execute(`INSERT OR IGNORE INTO app_settings (id) VALUES (1)`);
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

/* ---------------- crypto helpers ---------------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256');
  return `pbkdf2$120000$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  try {
    const [scheme, iter, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'pbkdf2') return false;
    const hash = crypto.pbkdf2Sync(String(password), Buffer.from(saltHex, 'hex'), parseInt(iter, 10), 32, 'sha256');
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch { return false; }
}
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function tokenHash(token) { return sha256(token + '|' + SECRET); }
function newToken() { return crypto.randomBytes(32).toString('base64url'); }

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L ambiguity
function genBackupCode() {
  const pick = () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  const part = () => Array.from({ length: 4 }, pick).join('');
  return `${part()}-${part()}`;
}
function genInviteCode() {
  const pick = () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return 'NIYAM-' + Array.from({ length: 6 }, pick).join('');
}
function normalizeCode(c) { return String(c || '').trim().toUpperCase().replace(/\s+/g, ''); }

/* ---------------- db helpers ---------------- */
async function one(sql, args = []) { const r = await db.execute({ sql, args }); return r.rows[0] || null; }
async function all(sql, args = []) { const r = await db.execute({ sql, args }); return r.rows; }

async function createSession(userId) {
  const token = newToken();
  const now = Date.now();
  await db.execute({ sql: `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
    args: [tokenHash(token), userId, now, now + SESSION_TTL_MS] });
  return token;
}
async function userFromToken(token) {
  if (!token) return null;
  const s = await one(`SELECT * FROM sessions WHERE token_hash = ?`, [tokenHash(token)]);
  if (!s || s.expires_at < Date.now()) return null;
  const u = await one(`SELECT * FROM users WHERE id = ?`, [s.user_id]);
  return u || null;
}
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, isAdmin: !!u.is_admin, createdAt: u.created_at };
}
async function requireUser(token) {
  const u = await userFromToken(token);
  if (!u) throw { code: 'unauthorized' };
  return u;
}
async function requireAdmin(token) {
  const u = await requireUser(token);
  if (!u.is_admin) throw { code: 'forbidden' };
  return u;
}

/* auth guard: failed-attempt counting + lockout, per key */
async function guardLocked(key) {
  const g = await one(`SELECT * FROM auth_guards WHERE key = ?`, [key]);
  return !!(g && g.locked_until > Date.now());
}
async function guardFail(key, maxFails, lockMs) {
  const now = Date.now();
  const g = await one(`SELECT * FROM auth_guards WHERE key = ?`, [key]);
  const count = (g ? g.count : 0) + 1;
  const lockedUntil = count >= maxFails ? now + lockMs : (g ? g.locked_until : 0);
  await db.execute({ sql: `INSERT INTO auth_guards (key, count, window_start, locked_until) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until`,
    args: [key, count, g ? g.window_start : now, lockedUntil] });
  return count >= maxFails;
}
async function guardClear(key) {
  await db.execute({ sql: `DELETE FROM auth_guards WHERE key = ?`, args: [key] });
}

/* backup codes */
async function issueBackupCodes(userId) {
  const codes = [];
  const now = Date.now();
  for (let i = 0; i < 8; i++) {
    const code = genBackupCode();
    codes.push(code);
    await db.execute({ sql: `INSERT INTO backup_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)`,
      args: [userId, sha256(normalizeCode(code)), now] });
  }
  return codes;
}

/* reports */
function computeCompletion(d) {
  if (!d) return 0;
  let n = 0;
  if (d.mangala) n++;
  if (d.dhyan === 'done' || d.dhyan === 'partial') n++;
  if (d.katha) n++;
  if (d.vachanamrut) n++;
  if (d.chesta) n++;
  if (d.mandir) n++;
  if ((d.dandvat || 0) > 0) n++;
  if ((d.bhajanMinutes || 0) > 0) n++;
  if ((d.dhunMinutes || 0) > 0) n++;
  if ((d.pradakshina || 0) > 0) n++;
  if ((d.mansiPuja || 0) > 0) n++;
  if (d.vvrat === 'yes') n++;
  return Math.round((n / 12) * 100);
}
function cleanReportData(a) {
  const t = (v) => (v === 'done' || v === 'partial' || v === 'no' ? v : null);
  const nonNegInt = (v) => { const n = Math.floor(Number(v) || 0); return n < 0 ? 0 : n; };
  const timeStr = (v) => (typeof v === 'string' && /^(0?[1-9]|1[0-2]):[0-5][0-9]\s?(AM|PM)$/i.test(v.trim()) ? v.trim() : null);
  return {
    wakeTime: timeStr(a.wakeTime),
    mangala: !!a.mangala,
    dhyan: t(a.dhyan),
    dhyanMinutes: a.dhyan === 'partial' ? nonNegInt(a.dhyanMinutes) : 0,
    katha: !!a.katha,
    vachanamrut: !!a.vachanamrut,
    chesta: !!a.chesta,
    mandir: !!a.mandir,
    dandvat: nonNegInt(a.dandvat),
    bhajanMinutes: nonNegInt(a.bhajanMinutes),
    dhunMinutes: nonNegInt(a.dhunMinutes),
    pradakshina: nonNegInt(a.pradakshina),
    pradakshinaPlace: String(a.pradakshinaPlace || '').slice(0, 120),
    mansiPuja: Math.min(5, nonNegInt(a.mansiPuja)),
    sleepTime: timeStr(a.sleepTime),
    mantavya: String(a.mantavya || '').slice(0, 2000),
    vvrat: a.vvrat === 'yes' || a.vvrat === 'no' ? a.vvrat : null,
    vvratNote: String(a.vvratNote || '').slice(0, 500),
  };
}
function reportRow(r) {
  const data = JSON.parse(r.data);
  delete data.mangalaAarti; // legacy field (same niyam as mangala) — tolerated on read, never returned/counted
  return {
    date: r.date, data, completion: computeCompletion(data),
    createdAt: r.created_at, updatedAt: r.updated_at,
    editDeadline: r.created_at + EDIT_WINDOW_MS,
    editable: Date.now() < r.created_at + EDIT_WINDOW_MS,
  };
}
function validDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

/* ---------------- actions ---------------- */
const actions = {
  async getAppStatus() {
    const s = await one(`SELECT * FROM app_settings WHERE id = 1`);
    return {
      announcement: { on: !!s.announcement_on, text: s.announcement_text || '' },
      maintenance: { on: !!s.maintenance_on, msg: s.maintenance_msg || '' },
      update: {
        latestVersion: s.latest_version || '', notes: s.update_notes || '',
        downloadUrl: s.download_url || '', forceUpdate: !!s.force_update,
      },
    };
  },

  async signup(a) {
    const name = String(a.name || '').trim();
    const email = String(a.email || '').trim().toLowerCase();
    const password = String(a.password || '');
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) throw { code: 'invalid_input' };
    if (password.length < 6) throw { code: 'weak_password' };
    if (await one(`SELECT id FROM users WHERE email = ?`, [email])) throw { code: 'email_taken' };
    const countRow = await one(`SELECT COUNT(*) AS c FROM users`);
    const isAdmin = Number(countRow.c) === 0 ? 1 : 0; // FIRST registered user becomes admin
    const now = Date.now();
    const r = await db.execute({ sql: `INSERT INTO users (name, email, pass_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)`,
      args: [name, email, hashPassword(password), isAdmin, now] });
    const userId = Number(r.lastInsertRowid);
    const backupCodes = await issueBackupCodes(userId);
    const token = await createSession(userId);
    const u = await one(`SELECT * FROM users WHERE id = ?`, [userId]);
    return { token, user: publicUser(u), backupCodes };
  },

  async login(a) {
    const email = String(a.email || '').trim().toLowerCase();
    const password = String(a.password || '');
    const key = 'login:' + email;
    if (await guardLocked(key)) throw { code: 'locked' };
    const u = await one(`SELECT * FROM users WHERE email = ?`, [email]);
    if (!u || !verifyPassword(password, u.pass_hash)) {
      await guardFail(key, LOGIN_MAX_FAILS, LOGIN_LOCK_MS);
      throw { code: 'invalid_credentials' };
    }
    await guardClear(key);
    const token = await createSession(u.id);
    return { token, user: publicUser(u) };
  },

  async logout(a, token) {
    if (token) await db.execute({ sql: `DELETE FROM sessions WHERE token_hash = ?`, args: [tokenHash(token)] });
    return { ok: true };
  },

  async me(a, token) {
    const u = await requireUser(token);
    return { user: publicUser(u) };
  },

  async recoverWithBackupCode(a) {
    const email = String(a.email || '').trim().toLowerCase();
    const code = normalizeCode(a.code);
    const newPassword = String(a.newPassword || '');
    if (newPassword.length < 6) throw { code: 'weak_password' };
    const key = 'recover:' + email;
    if (await guardLocked(key)) throw { code: 'locked' };
    const u = await one(`SELECT * FROM users WHERE email = ?`, [email]);
    const row = u ? await one(`SELECT * FROM backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
      [u.id, sha256(code)]) : null;
    if (!row) {
      await guardFail(key, RECOVERY_MAX_FAILS, RECOVERY_LOCK_MS);
      throw { code: 'invalid_code' };
    }
    await guardClear(key);
    await db.execute({ sql: `UPDATE backup_codes SET used_at = ? WHERE id = ?`, args: [Date.now(), row.id] });
    await db.execute({ sql: `UPDATE users SET pass_hash = ? WHERE id = ?`, args: [hashPassword(newPassword), u.id] });
    await db.execute({ sql: `DELETE FROM sessions WHERE user_id = ?`, args: [u.id] }); // sign out everywhere
    return { ok: true };
  },

  async changePassword(a, token) {
    const u = await requireUser(token);
    if (!verifyPassword(String(a.currentPassword || ''), u.pass_hash)) throw { code: 'wrong_password' };
    const np = String(a.newPassword || '');
    if (np.length < 6) throw { code: 'weak_password' };
    await db.execute({ sql: `UPDATE users SET pass_hash = ? WHERE id = ?`, args: [hashPassword(np), u.id] });
    return { ok: true };
  },

  async getBackupStatus(a, token) {
    const u = await requireUser(token);
    const total = await one(`SELECT COUNT(*) AS c FROM backup_codes WHERE user_id = ?`, [u.id]);
    const left = await one(`SELECT COUNT(*) AS c FROM backup_codes WHERE user_id = ? AND used_at IS NULL`, [u.id]);
    return { total: Number(total.c), remaining: Number(left.c) };
  },

  async regenerateBackupCodes(a, token) {
    const u = await requireUser(token);
    if (!verifyPassword(String(a.currentPassword || ''), u.pass_hash)) throw { code: 'wrong_password' };
    await db.execute({ sql: `DELETE FROM backup_codes WHERE user_id = ?`, args: [u.id] }); // old codes invalidated
    const backupCodes = await issueBackupCodes(u.id);
    return { backupCodes };
  },

  /* ---- reports ---- */
  async saveReport(a, token) {
    const u = await requireUser(token);
    if (!validDate(a.date)) throw { code: 'invalid_input' };
    const data = cleanReportData(a);
    const now = Date.now();
    const existing = await one(`SELECT * FROM reports WHERE user_id = ? AND date = ?`, [u.id, a.date]);
    if (existing) {
      if (now >= existing.created_at + EDIT_WINDOW_MS) throw { code: 'edit_window_expired' };
      await db.execute({ sql: `UPDATE reports SET data = ?, updated_at = ? WHERE id = ?`,
        args: [JSON.stringify(data), now, existing.id] });
    } else {
      await db.execute({ sql: `INSERT INTO reports (user_id, date, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        args: [u.id, a.date, JSON.stringify(data), now, now] });
    }
    const r = await one(`SELECT * FROM reports WHERE user_id = ? AND date = ?`, [u.id, a.date]);
    return { report: reportRow(r) };
  },

  async getReport(a, token) {
    const u = await requireUser(token);
    if (!validDate(a.date)) throw { code: 'invalid_input' };
    const r = await one(`SELECT * FROM reports WHERE user_id = ? AND date = ?`, [u.id, a.date]);
    return { report: r ? reportRow(r) : null };
  },

  async listReports(a, token) {
    const u = await requireUser(token);
    const rows = await all(`SELECT * FROM reports WHERE user_id = ? ORDER BY date ASC`, [u.id]);
    return { reports: rows.map(reportRow) };
  },

  /* ---- user settings (reminder + smaran bell) ---- */
  async getUserSettings(a, token) {
    const u = await requireUser(token);
    const s = await one(`SELECT * FROM user_settings WHERE user_id = ?`, [u.id]);
    if (!s) return { settings: { reminderEnabled: true, reminderTime: '21:00', smaranEnabled: false, smaranInterval: 30 } };
    return { settings: {
      reminderEnabled: !!s.reminder_enabled, reminderTime: s.reminder_time,
      smaranEnabled: !!s.smaran_enabled, smaranInterval: s.smaran_interval } };
  },

  async setUserSettings(a, token) {
    const u = await requireUser(token);
    const time = /^\d{2}:\d{2}$/.test(String(a.reminderTime || '')) ? String(a.reminderTime) : null;
    if (!time) throw { code: 'invalid_input' };
    const [hh, mm] = time.split(':').map(Number);
    if (hh > 23 || mm > 59) throw { code: 'invalid_input' };
    const rawInterval = Number(a.smaranInterval);
    const interval = Number.isFinite(rawInterval) ? Math.floor(rawInterval) : NaN;
    if (!Number.isFinite(interval) || interval < 1 || interval > 480) throw { code: 'invalid_input' };
    await db.execute({ sql: `INSERT INTO user_settings (user_id, reminder_enabled, reminder_time, smaran_enabled, smaran_interval)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET reminder_enabled = excluded.reminder_enabled,
      reminder_time = excluded.reminder_time, smaran_enabled = excluded.smaran_enabled, smaran_interval = excluded.smaran_interval`,
      args: [u.id, a.reminderEnabled ? 1 : 0, time, a.smaranEnabled ? 1 : 0, interval] });
    return actions.getUserSettings(a, token);
  },

  /* ---- support ---- */
  async submitSupportMessage(a, token) {
    const u = await requireUser(token);
    const type = a.type === 'problem' ? 'problem' : 'contact';
    const message = String(a.message || '').trim().slice(0, 4000);
    if (!message) throw { code: 'invalid_input' };
    await db.execute({ sql: `INSERT INTO support_messages (user_id, name, email, type, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [u.id, u.name, u.email, type, message, Date.now()] });
    return { ok: true };
  },

  /* ---- groups ---- */
  async createGroup(a, token) {
    const u = await requireUser(token);
    const name = String(a.name || '').trim().slice(0, 80);
    if (!name) throw { code: 'invalid_input' };
    let code = genInviteCode();
    while (await one(`SELECT id FROM groups WHERE invite_code = ?`, [code])) code = genInviteCode();
    const r = await db.execute({ sql: `INSERT INTO groups (name, invite_code, admin_id, created_at) VALUES (?, ?, ?, ?)`,
      args: [name, code, u.id, Date.now()] });
    const gid = Number(r.lastInsertRowid);
    await db.execute({ sql: `INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)`, args: [gid, u.id, Date.now()] });
    return { group: { id: gid, name, inviteCode: code, adminId: u.id } };
  },

  async joinGroup(a, token) {
    const u = await requireUser(token);
    const code = normalizeCode(a.code);
    const g = await one(`SELECT * FROM groups WHERE invite_code = ?`, [code]);
    if (!g) throw { code: 'invalid_code' };
    if (await one(`SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?`, [g.id, u.id])) throw { code: 'already_member' };
    const pending = await one(`SELECT * FROM group_join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending'`, [g.id, u.id]);
    if (pending) throw { code: 'already_requested' };
    await db.execute({ sql: `INSERT INTO group_join_requests (group_id, user_id, status, created_at) VALUES (?, ?, 'pending', ?)`,
      args: [g.id, u.id, Date.now()] });
    return { ok: true, groupName: g.name };
  },

  async listMyGroups(a, token) {
    const u = await requireUser(token);
    const rows = await all(`SELECT g.*, (SELECT COUNT(*) FROM group_members m2 WHERE m2.group_id = g.id) AS member_count
      FROM groups g JOIN group_members m ON m.group_id = g.id AND m.user_id = ? ORDER BY g.created_at ASC`, [u.id]);
    const groups = [];
    for (const g of rows) {
      let incomingPending = 0;
      if (g.admin_id === u.id) {
        const c = await one(`SELECT COUNT(*) AS c FROM group_join_requests WHERE group_id = ? AND status = 'pending'`, [g.id]);
        incomingPending = Number(c.c);
      }
      groups.push({ id: g.id, name: g.name, inviteCode: g.invite_code, adminId: g.admin_id,
        isGroupAdmin: g.admin_id === u.id, memberCount: Number(g.member_count), incomingPending });
    }
    // groups where I have a pending outgoing request
    const pend = await all(`SELECT g.name FROM groups g JOIN group_join_requests r ON r.group_id = g.id
      WHERE r.user_id = ? AND r.status = 'pending'`, [u.id]);
    return { groups, pendingRequests: pend.map((p) => ({ groupName: p.name })) };
  },

  async getGroupDetail(a, token) {
    const u = await requireUser(token);
    const g = await one(`SELECT * FROM groups WHERE id = ?`, [Number(a.groupId) || 0]);
    if (!g) throw { code: 'not_found' };
    const membership = await one(`SELECT * FROM group_members WHERE group_id = ? AND user_id = ?`, [g.id, u.id]);
    if (!membership) throw { code: 'not_member' }; // outsiders get nothing
    const isGroupAdmin = g.admin_id === u.id;
    const memberRows = await all(`SELECT u.id, u.name, u.email FROM group_members m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ? ORDER BY m.joined_at ASC`, [g.id]);
    const members = memberRows.map((m) => ({ id: m.id, name: m.name, email: m.email, isGroupAdmin: m.id === g.admin_id }));
    // feed: every member's reports for today + previous 6 days, full detail
    const today = new Date();
    const dates = [];
    for (let i = 0; i < 7; i++) { const d = new Date(today); d.setDate(d.getDate() - i); dates.push(d.toISOString().slice(0, 10)); }
    const feedRows = await all(`SELECT r.*, u.name AS uname FROM reports r JOIN users u ON u.id = r.user_id
      WHERE r.user_id IN (SELECT user_id FROM group_members WHERE group_id = ?) AND r.date IN (${dates.map(() => '?').join(',')})
      ORDER BY r.date DESC`, [g.id, ...dates]);
    const feed = {};
    for (const r of feedRows) {
      if (!feed[r.date]) feed[r.date] = [];
      feed[r.date].push({ userId: r.user_id, userName: r.uname, ...reportRow(r) });
    }
    let requests = [];
    if (isGroupAdmin) {
      const reqs = await all(`SELECT r.id, r.user_id, u.name, u.email, r.created_at FROM group_join_requests r
        JOIN users u ON u.id = r.user_id WHERE r.group_id = ? AND r.status = 'pending' ORDER BY r.created_at ASC`, [g.id]);
      requests = reqs.map((r) => ({ id: r.id, userId: r.user_id, name: r.name, email: r.email, createdAt: r.created_at }));
    }
    return { group: { id: g.id, name: g.name, inviteCode: g.invite_code, adminId: g.admin_id, isGroupAdmin },
      members, requests, feed, feedDates: dates };
  },

  async approveJoinRequest(a, token) {
    const u = await requireUser(token);
    const req = await one(`SELECT * FROM group_join_requests WHERE id = ? AND status = 'pending'`, [Number(a.requestId) || 0]);
    if (!req) throw { code: 'not_found' };
    const g = await one(`SELECT * FROM groups WHERE id = ?`, [req.group_id]);
    if (!g || g.admin_id !== u.id) throw { code: 'forbidden' };
    await db.execute({ sql: `UPDATE group_join_requests SET status = 'approved' WHERE id = ?`, args: [req.id] });
    await db.execute({ sql: `INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)`,
      args: [g.id, req.user_id, Date.now()] });
    return { ok: true };
  },

  async rejectJoinRequest(a, token) {
    const u = await requireUser(token);
    const req = await one(`SELECT * FROM group_join_requests WHERE id = ? AND status = 'pending'`, [Number(a.requestId) || 0]);
    if (!req) throw { code: 'not_found' };
    const g = await one(`SELECT * FROM groups WHERE id = ?`, [req.group_id]);
    if (!g || g.admin_id !== u.id) throw { code: 'forbidden' };
    await db.execute({ sql: `UPDATE group_join_requests SET status = 'rejected' WHERE id = ?`, args: [req.id] });
    return { ok: true };
  },

  async removeMember(a, token) {
    const u = await requireUser(token);
    const g = await one(`SELECT * FROM groups WHERE id = ?`, [Number(a.groupId) || 0]);
    if (!g) throw { code: 'not_found' };
    const targetId = Number(a.userId) || 0;
    if (g.admin_id !== u.id) throw { code: 'forbidden' };
    if (targetId === g.admin_id) throw { code: 'invalid_input' }; // admin cannot be removed
    await db.execute({ sql: `DELETE FROM group_members WHERE group_id = ? AND user_id = ?`, args: [g.id, targetId] });
    return { ok: true };
  },

  async leaveGroup(a, token) {
    const u = await requireUser(token);
    const g = await one(`SELECT * FROM groups WHERE id = ?`, [Number(a.groupId) || 0]);
    if (!g) throw { code: 'not_found' };
    if (g.admin_id === u.id) throw { code: 'admin_cannot_leave' };
    await db.execute({ sql: `DELETE FROM group_members WHERE group_id = ? AND user_id = ?`, args: [g.id, u.id] });
    return { ok: true };
  },

  async resetInviteCode(a, token) {
    const u = await requireUser(token);
    const g = await one(`SELECT * FROM groups WHERE id = ?`, [Number(a.groupId) || 0]);
    if (!g) throw { code: 'not_found' };
    if (g.admin_id !== u.id) throw { code: 'forbidden' };
    let code = genInviteCode();
    while (await one(`SELECT id FROM groups WHERE invite_code = ?`, [code])) code = genInviteCode();
    await db.execute({ sql: `UPDATE groups SET invite_code = ? WHERE id = ?`, args: [code, g.id] });
    return { inviteCode: code };
  },

  /* ---- admin (every action re-checks admin server-side) ---- */
  async adminListUsers(a, token) {
    await requireAdmin(token);
    const rows = await all(`SELECT u.id, u.name, u.email, u.is_admin, u.created_at,
      (SELECT COUNT(*) FROM reports r WHERE r.user_id = u.id) AS report_count,
      (SELECT COUNT(*) FROM group_members m WHERE m.user_id = u.id) AS group_count
      FROM users u ORDER BY u.created_at ASC`);
    return { users: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, isAdmin: !!r.is_admin,
      createdAt: r.created_at, reportCount: Number(r.report_count), groupCount: Number(r.group_count) })) };
  },

  async adminGetUserReports(a, token) {
    await requireAdmin(token);
    const target = await one(`SELECT * FROM users WHERE id = ?`, [Number(a.userId) || 0]);
    if (!target) throw { code: 'not_found' };
    const rows = await all(`SELECT * FROM reports WHERE user_id = ? ORDER BY date DESC`, [target.id]);
    return { user: publicUser(target), reports: rows.map(reportRow) };
  },

  async adminSetUserPassword(a, token) {
    await requireAdmin(token);
    const target = await one(`SELECT * FROM users WHERE id = ?`, [Number(a.userId) || 0]);
    if (!target) throw { code: 'not_found' };
    const np = String(a.newPassword || '');
    if (np.length < 6) throw { code: 'weak_password' };
    await db.execute({ sql: `UPDATE users SET pass_hash = ? WHERE id = ?`, args: [hashPassword(np), target.id] });
    await db.execute({ sql: `DELETE FROM sessions WHERE user_id = ?`, args: [target.id] });
    return { ok: true };
  },

  async adminListGroups(a, token) {
    await requireAdmin(token);
    const rows = await all(`SELECT g.id, g.name, g.invite_code, g.created_at, u.name AS admin_name, u.email AS admin_email,
      (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
      FROM groups g JOIN users u ON u.id = g.admin_id ORDER BY g.created_at ASC`);
    return { groups: rows.map((r) => ({ id: r.id, name: r.name, inviteCode: r.invite_code, createdAt: r.created_at,
      adminName: r.admin_name, adminEmail: r.admin_email, memberCount: Number(r.member_count) })) };
  },

  async adminListSupportMessages(a, token) {
    await requireAdmin(token);
    const rows = await all(`SELECT * FROM support_messages ORDER BY created_at DESC LIMIT 500`);
    return { messages: rows.map((r) => ({ id: r.id, userId: r.user_id, name: r.name, email: r.email,
      type: r.type, message: r.message, createdAt: r.created_at, readAt: r.read_at })) };
  },

  async adminMarkSupportRead(a, token) {
    await requireAdmin(token);
    await db.execute({ sql: `UPDATE support_messages SET read_at = ? WHERE id = ?`, args: [Date.now(), Number(a.messageId) || 0] });
    return { ok: true };
  },

  async adminGetAppControls(a, token) {
    await requireAdmin(token);
    const s = await one(`SELECT * FROM app_settings WHERE id = 1`);
    return { controls: {
      announcementText: s.announcement_text || '', announcementOn: !!s.announcement_on,
      maintenanceOn: !!s.maintenance_on, maintenanceMsg: s.maintenance_msg || '',
      latestVersion: s.latest_version || '', updateNotes: s.update_notes || '',
      downloadUrl: s.download_url || '', forceUpdate: !!s.force_update } };
  },

  async adminSetAppControls(a, token) {
    await requireAdmin(token);
    await db.execute({ sql: `UPDATE app_settings SET announcement_text = ?, announcement_on = ?, maintenance_on = ?,
      maintenance_msg = ?, latest_version = ?, update_notes = ?, download_url = ?, force_update = ? WHERE id = 1`,
      args: [String(a.announcementText || '').slice(0, 500), a.announcementOn ? 1 : 0, a.maintenanceOn ? 1 : 0,
        String(a.maintenanceMsg || '').slice(0, 500), String(a.latestVersion || '').trim().slice(0, 32),
        String(a.updateNotes || '').slice(0, 1000), String(a.downloadUrl || '').trim().slice(0, 500),
        a.forceUpdate ? 1 : 0] });
    return actions.adminGetAppControls(a, token);
  },

  /* ---- admin demo data (testing aid for the admin's OWN account) ----
     Seed fills the last 45 days (ending yesterday) with varied sample
     reports so every function (graphs, calendar, streaks, groups, history)
     can be checked with realistic data. Every seeded report carries the
     DEMO_TAG in mantavya; days that already have a report are SKIPPED, so
     real data is never overwritten. Clear removes ONLY tagged reports. */
  async adminSeedDemo(a, token) {
    const u = await requireAdmin(token);
    const DEMO_TAG = '🧪 Demo data';
    const rnd = (seed) => { // deterministic per date: same pattern every run
      let x = seed;
      return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
    };
    const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
    let added = 0, skipped = 0;
    const now = Date.now();
    for (let back = 1; back <= 45; back++) {
      const d = new Date(now - back * 86400000);
      const iso = d.toISOString().slice(0, 10);
      if (await one(`SELECT id FROM reports WHERE user_id = ? AND date = ?`, [u.id, iso])) { skipped++; continue; }
      const r = rnd(back * 7919 + 13);
      if (r() < 0.14) { skipped++; continue; } // some days stay empty, like real life
      const full = r() < 0.3;
      const data = cleanReportData({
        wakeTime: pick(r, ['4:45 AM', '5:00 AM', '5:15 AM', '5:30 AM', '5:45 AM', '6:00 AM']),
        mangala: full || r() < 0.85,
        dhyan: full ? 'done' : pick(r, ['done', 'partial', 'done', null]),
        dhyanMinutes: pick(r, [10, 15, 20, 25, 30]),
        katha: full || r() < 0.8,
        vachanamrut: full || r() < 0.75,
        chesta: full || r() < 0.7,
        mandir: full || r() < 0.65,
        dandvat: full ? pick(r, [11, 21, 51]) : pick(r, [0, 5, 11, 21]),
        bhajanMinutes: full ? 60 + Math.floor(r() * 45) : Math.floor(r() * 75),
        dhunMinutes: full ? 30 + Math.floor(r() * 30) : Math.floor(r() * 40),
        pradakshina: full ? pick(r, [5, 11]) : pick(r, [0, 0, 1, 5]),
        pradakshinaPlace: pick(r, ['વડતાલ', 'વિરસદ', 'ઘર મંદિર', '']),
        mansiPuja: full ? pick(r, [3, 5]) : Math.floor(r() * 4),
        sleepTime: pick(r, ['10:00 PM', '10:15 PM', '10:30 PM', '10:45 PM', '11:00 PM']),
        mantavya: DEMO_TAG,
        vvrat: r() < 0.8 ? 'yes' : 'no',
        vvratNote: '',
      });
      const created = now - back * 86400000 + 3600000;
      await db.execute({ sql: `INSERT INTO reports (user_id, date, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        args: [u.id, iso, JSON.stringify(data), created, created] });
      added++;
    }
    return { added, skipped };
  },

  async adminClearDemo(a, token) {
    const u = await requireAdmin(token);
    const rows = await all(`SELECT id, data FROM reports WHERE user_id = ?`, [u.id]);
    let removed = 0;
    for (const row of rows) {
      try {
        if (JSON.parse(row.data).mantavya === '🧪 Demo data') {
          await db.execute({ sql: `DELETE FROM reports WHERE id = ?`, args: [row.id] });
          removed++;
        }
      } catch (_) { /* unparsable legacy row: leave it alone */ }
    }
    return { removed };
  },
};

/* ---------------- http layer ---------------- */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const DIST = path.join(__dirname, '..', 'dist');

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api' || url.pathname === '/api/') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' });
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2_000_000) req.destroy(); });
    req.on('end', async () => {
      try {
        await ensureSchema();
        const body = JSON.parse(raw || '{}');
        const fn = actions[body.action];
        if (!fn) return send(res, 400, { ok: false, error: 'unknown_action' });
        const result = await fn(body.args || {}, body.token || null);
        return send(res, 200, { ok: true, ...result });
      } catch (e) {
        if (e && e.code) return send(res, 200, { ok: false, error: e.code });
        console.error('API error:', e);
        return send(res, 500, { ok: false, error: 'server_error' });
      }
    });
    return;
  }
  // static client (local dev only — Vercel serves dist/ itself)
  if (req.method === 'GET') {
    let file = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h1>Daily Niyam API is running.</h1><p>Client not built yet — run <code>npm run build</code>, then reload.</p>');
  }
  send(res, 404, { ok: false, error: 'not_found' });
}

if (require.main === module) {
  fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
  http.createServer(handler).listen(PORT, () =>
    console.log(`Daily Niyam server on http://localhost:${PORT} (app + API, one origin)`));
}
module.exports = handler;
