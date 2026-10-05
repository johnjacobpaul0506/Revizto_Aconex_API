// Sign-in for Digital Corner: an admin login (you) and, later, a shared team login.
// Accounts come from Vercel environment variables:
//   ADMIN_USERNAME / ADMIN_PASSWORD  – admin login (everything, for now the only login)
//   APP_USERNAME / APP_PASSWORD      – optional shared team login (for the team pages, coming later)
//   SESSION_HOURS                    – optional, how long a sign-in lasts (default 12)
//   SESSION_SECRET                   – optional, signing key (otherwise derived from SUPABASE_SECRET_KEY)
//
// The sign-in is a signed cookie the browser can't read or change. Changing a password
// signs out everyone who used it.

import crypto from 'node:crypto';
import { getSecret, setSecret, deleteSecret } from './_supabase.js';

const COOKIE = 'dc_session';
const MAX_FAILS = 10;                 // failed attempts allowed per network address…
const WINDOW_MS = 15 * 60 * 1000;     // …within 15 minutes, then locked until the window ends

function accounts() {
  const list = [];
  const au = String(process.env.ADMIN_USERNAME || '').trim();
  const ap = String(process.env.ADMIN_PASSWORD || '');
  if (au && ap) list.push({ role: 'admin', username: au, password: ap });
  const vu = String(process.env.APP_USERNAME || '').trim();
  const vp = String(process.env.APP_PASSWORD || '');
  if (vu && vp) list.push({ role: 'viewer', username: vu, password: vp });
  return list;
}

function sessionHours() {
  const h = Number(process.env.SESSION_HOURS);
  return Number.isFinite(h) && h >= 1 ? Math.min(h, 24 * 30) : 12;
}

function signingKey() {
  const s = String(process.env.SESSION_SECRET || '');
  if (s.length >= 32) return s;
  const base = String(process.env.SUPABASE_SECRET_KEY || '');
  if (base.length >= 32) return crypto.createHmac('sha256', base).update('digital-corner-session-v1').digest('hex');
  return null;
}

// A separate server-side key for another purpose (e.g. signing the Revizto sign-in round trip)
export function deriveKey(purpose) {
  const k = signingKey();
  return k ? crypto.createHmac('sha256', k).update(`derive:${purpose}`).digest('hex') : null;
}

export function configProblems() {
  const p = [];
  if (!accounts().some(a => a.role === 'admin')) p.push('ADMIN_USERNAME and ADMIN_PASSWORD');
  if (!signingKey()) p.push('SESSION_SECRET (or SUPABASE_SECRET_KEY)');
  return p;
}

// Compare without leaking timing or length
function same(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// Returns the matching account, or null. Checks every account so timing doesn't reveal which exists.
export function checkCredentials(username, password) {
  const u = String(username || '').trim().toLowerCase();
  const p = String(password || '');
  let match = null;
  for (const a of accounts()) {
    const ok = same(u, a.username.toLowerCase()) & same(p, a.password);
    if (ok && !match) match = a;
  }
  return match;
}

function binding(account) {
  return crypto.createHash('sha256').update(`${account.role}\n${account.username.toLowerCase()}\n${account.password}`).digest('base64url');
}

function sign(payload, account, key) {
  return crypto.createHmac('sha256', key).update(`${payload}.${binding(account)}`).digest('base64url');
}

export function createSessionCookie(account) {
  const key = signingKey();
  const maxAge = Math.round(sessionHours() * 3600);
  const exp = Date.now() + maxAge * 1000;
  const payload = Buffer.from(JSON.stringify({ v: 1, r: account.role, exp })).toString('base64url');
  return {
    cookie: cookieString(`${payload}.${sign(payload, account, key)}`, maxAge),
    expiresAt: new Date(exp).toISOString()
  };
}

export function clearSessionCookie() {
  return cookieString('', 0);
}

// { role: 'admin' | 'viewer', expiresAt } or null
export function readSession(req) {
  const key = signingKey();
  if (!key) return null;
  const raw = parseCookies(req.headers?.cookie)[COOKIE];
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;

  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  const account = accounts().find(a => a.role === data?.r);
  if (!account) return null;
  if (!same(sig, sign(payload, account, key))) return null;   // nothing is trusted before this check
  if (!Number.isFinite(data.exp) || Date.now() > data.exp) return null;
  return { role: account.role, expiresAt: new Date(data.exp).toISOString() };
}

function cookieString(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) {
      const k = part.slice(0, i).trim();
      if (!(k in out)) out[k] = part.slice(i + 1).trim();
    }
  });
  return out;
}

// ── Too many wrong passwords: lock that network address for a while ──
// Stored in Supabase (app_secrets), keyed by a one-way hash of the address.
// If Supabase can't be reached, sign-in still works (never lock people out by accident).

function attemptKey(req) {
  const fwd = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || String(req.headers?.['x-real-ip'] || '') || 'unknown';
  return 'login_fail:' + crypto.createHash('sha256').update(`${ip}|${signingKey() || ''}`).digest('hex').slice(0, 24);
}

export async function lockStatus(req) {
  try {
    const row = await getSecret(attemptKey(req));
    if (!row) return { locked: false };
    const d = JSON.parse(row.value);
    const left = d.first + WINDOW_MS - Date.now();
    if (left <= 0) return { locked: false };
    if (d.n >= MAX_FAILS) return { locked: true, minutesLeft: Math.max(1, Math.ceil(left / 60000)) };
    return { locked: false };
  } catch {
    return { locked: false };
  }
}

export async function recordFailure(req) {
  try {
    const key = attemptKey(req);
    const row = await getSecret(key);
    let d = null;
    try { d = row ? JSON.parse(row.value) : null; } catch { d = null; }
    if (!d || Date.now() - d.first > WINDOW_MS) d = { n: 0, first: Date.now() };
    d.n += 1;
    await setSecret(key, JSON.stringify(d));
  } catch { /* ignore */ }
}

export async function clearFailures(req) {
  try { await deleteSecret(attemptKey(req)); } catch { /* ignore */ }
}
