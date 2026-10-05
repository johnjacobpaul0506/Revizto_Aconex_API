// Revizto: connections (one per Revizto account), sign-in, token storage/renewal (via Supabase),
// project lists and 2D sheet lists.
//
// A Revizto custom app only works for licences in the Revizto account where it was registered.
// So the app can hold several "connections", each = one custom app + its own saved sign-in:
//   • "main"  – the app in Vercel's REVIZTO_CLIENT_ID / REVIZTO_CLIENT_SECRET
//   • others  – added by the admin in the dashboard (Manage Projects → Revizto accounts),
//               stored in Supabase (app_secrets, name "revizto_app:<id>")
// Each project remembers which connection reaches it.

import crypto from 'node:crypto';
import { getSecret, setSecret, insertSecretIfAbsent, deleteSecret, listSecrets } from './_supabase.js';
import { deriveKey } from './_session.js';

export const REGION = String(process.env.REVIZTO_REGION || 'sydney').trim().toLowerCase();
export const BASE = `https://api.${REGION}.revizto.com`;
export const REDIRECT_URI = String(
  process.env.REVIZTO_REDIRECT_URI || 'https://jjp-digital-poc.vercel.app/api/revizto-callback'
).trim();

export const MAIN = 'main';
const APP_PREFIX = 'revizto_app:';
const LICENCE_MAP = 'revizto_licence_map';
const EARLY_RENEW_MS = 2 * 60 * 1000;   // renew a little before the hour is up
const LOCK_STALE_MS = 30 * 1000;
const ID_RX = /^[a-z0-9-]{1,40}$/;

// ── Connections ─────────────────────────────────────────────────

function mainConnection() {
  const clientId = String(process.env.REVIZTO_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.REVIZTO_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  return { id: MAIN, label: 'Main account', clientId, clientSecret, builtIn: true };
}

// All connections, main first. Never send clientSecret to the browser.
export async function getConnections() {
  const list = [];
  const main = mainConnection();
  if (main) list.push(main);
  let rows = [];
  try { rows = await listSecrets(APP_PREFIX); } catch { rows = []; }
  for (const r of rows) {
    try {
      const c = JSON.parse(r.value);
      if (c && ID_RX.test(c.id) && c.clientId && c.clientSecret) list.push({ ...c, builtIn: false });
    } catch { /* skip broken row */ }
  }
  return list;
}

export async function getConnection(id = MAIN) {
  const want = id || MAIN;
  if (want === MAIN) {
    const m = mainConnection();
    if (!m) throw new Error('Revizto is not set up: missing REVIZTO_CLIENT_ID or REVIZTO_CLIENT_SECRET.');
    return m;
  }
  if (!ID_RX.test(want)) throw new Error('Unknown Revizto account');
  const row = await getSecret(APP_PREFIX + want);
  if (!row) throw new Error('That Revizto account has been removed from the app. Edit the project and pick its Revizto project again.');
  const c = JSON.parse(row.value);
  return { ...c, builtIn: false };
}

export async function addConnection({ label, clientId, clientSecret }) {
  const existing = await getConnections();
  if (existing.some(c => c.clientId === clientId)) {
    const e = new Error('That client ID is already added.');
    e.status = 409; e.userFacing = true;
    throw e;
  }
  const base = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'account';
  const id = `${base}-${crypto.randomBytes(3).toString('hex')}`;
  const record = { id, label, clientId, clientSecret, createdAt: new Date().toISOString() };
  await setSecret(APP_PREFIX + id, JSON.stringify(record));
  return { id, label, clientId };
}

export async function removeConnection(id) {
  if (!id || id === MAIN) {
    const e = new Error('The main Revizto account is set in Vercel and can\'t be removed here.');
    e.status = 400; e.userFacing = true;
    throw e;
  }
  await deleteSecret(APP_PREFIX + id);
  await deleteSecret(tokenName(id)).catch(() => {});
  await deleteSecret(lockName(id)).catch(() => {});
  const map = await readLicenceMap();
  let changed = false;
  for (const [lic, conn] of Object.entries(map)) if (conn === id) { delete map[lic]; changed = true; }
  if (changed) await setSecret(LICENCE_MAP, JSON.stringify(map)).catch(() => {});
}

// Main keeps the original storage names, so the existing sign-in carries over
function tokenName(id) { return !id || id === MAIN ? 'revizto_token' : `revizto_token:${id}`; }
function lockName(id) { return !id || id === MAIN ? 'revizto_token_lock' : `revizto_token_lock:${id}`; }

// ── Sign-in round trip ──────────────────────────────────────────

export function authorizeUrl(state, conn) {
  return `${BASE}/v5/oauth2/authorize?` + new URLSearchParams({
    response_type: 'code',
    client_id: conn.clientId,
    redirect_uri: REDIRECT_URI,
    state
  });
}

// Signed, time-limited "state" that also says which connection is signing in
const STATE_MAX_AGE_MS = 15 * 60 * 1000;

function stateSignature(payload) {
  const key = deriveKey('revizto-state');
  if (!key) throw new Error('Server signing key is missing (SESSION_SECRET or SUPABASE_SECRET_KEY).');
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

export function makeState(connId = MAIN) {
  const payload = `${Date.now()}.${connId}.${crypto.randomBytes(12).toString('base64url')}`;
  return `${payload}.${stateSignature(payload)}`;
}

// { connId } if valid, otherwise { problem }
export function checkState(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 4) return { problem: 'missing or malformed' };
  const payload = parts.slice(0, 3).join('.');
  let expected;
  try { expected = stateSignature(payload); } catch (e) { return { problem: e.message }; }
  const a = Buffer.from(parts[3]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { problem: 'signature does not match' };
  if (Date.now() - Number(parts[0]) > STATE_MAX_AGE_MS) return { problem: 'older than 15 minutes' };
  if (!ID_RX.test(parts[1])) return { problem: 'unknown account' };
  return { connId: parts[1] };
}

async function tokenRequest(params, conn) {
  const r = await fetch(`${BASE}/v5/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: conn.clientId, client_secret: conn.clientSecret })
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
  if (!j.access_token) {
    const why = j.error_description || j.message || j.error || j.raw || `HTTP ${r.status}`;
    const e = new Error(`Revizto token request failed: ${typeof why === 'string' ? why : JSON.stringify(why)}`);
    e.revizto = j;
    throw e;
  }
  return j;
}

// First sign-in: swap the code from the redirect for tokens, and store them for that connection
export async function exchangeCodeAndSave(code, connId = MAIN) {
  const conn = await getConnection(connId);
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }, conn);
  await saveTokens(connId, t, null);
  return t.access_token;
}

async function saveTokens(connId, t, previousRefresh) {
  const record = {
    access_token: t.access_token,
    // Revizto rotates refresh tokens: always keep the newest one
    refresh_token: t.refresh_token || previousRefresh,
    expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000,
    saved_at: new Date().toISOString()
  };
  if (!record.refresh_token) throw new Error('Revizto did not return a refresh token, so the sign-in cannot be kept.');
  await setSecret(tokenName(connId), JSON.stringify(record));
}

async function readTokens(connId) {
  const row = await getSecret(tokenName(connId));
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function stillValid(t) {
  return t && t.access_token && Number(t.expires_at) - Date.now() > EARLY_RENEW_MS;
}

// Is a sign-in saved for this connection, and how fresh is it?
export async function connectionStatus(connId = MAIN) {
  const t = await readTokens(connId);
  if (!t) return { connected: false };
  return {
    connected: true,
    savedAt: t.saved_at || null,
    accessTokenMinutesLeft: Math.max(0, Math.round((Number(t.expires_at) - Date.now()) / 60000))
  };
}

// Every connection with its sign-in status (no secrets)
export async function connectionsWithStatus() {
  const conns = await getConnections();
  return Promise.all(conns.map(async c => {
    let st = { connected: false };
    try { st = await connectionStatus(c.id); } catch { /* treat as not connected */ }
    return { id: c.id, label: c.label, clientId: c.clientId, builtIn: c.builtIn, connected: st.connected, savedAt: st.savedAt || null };
  }));
}

function notConnectedMsg(label) {
  return `Revizto (${label}) is not connected yet. The admin needs to connect it from the dashboard.`;
}
function expiredMsg(label) {
  return `The saved Revizto sign-in for ${label} has expired or was revoked. The admin needs to reconnect it from the dashboard.`;
}

// Returns a working access token for a connection, renewing it if needed.
// A lock row makes sure only one request renews at a time, because each renewal
// invalidates the previous refresh token.
export async function getAccessToken(connId = MAIN) {
  const conn = await getConnection(connId);
  const id = conn.id;
  let t = await readTokens(id);
  if (!t) throw new Error(notConnectedMsg(conn.label));
  if (stillValid(t)) return t.access_token;

  for (let attempt = 0; attempt < 12; attempt++) {
    const gotLock = await insertSecretIfAbsent(lockName(id), String(Date.now()));
    if (gotLock) {
      try {
        t = await readTokens(id);                 // another request may have just renewed it
        if (stillValid(t)) return t.access_token;
        if (!t?.refresh_token) throw new Error(notConnectedMsg(conn.label));
        let fresh;
        try {
          fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token }, conn);
        } catch (e) {
          throw new Error(`${expiredMsg(conn.label)} (${e.message})`);
        }
        await saveTokens(id, fresh, t.refresh_token);
        return fresh.access_token;
      } finally {
        await deleteSecret(lockName(id)).catch(() => {});
      }
    }

    // Someone else is renewing. Clear a stuck lock, otherwise wait and re-check.
    const lock = await getSecret(lockName(id));
    if (lock && Date.now() - Number(lock.value) > LOCK_STALE_MS) {
      await deleteSecret(lockName(id)).catch(() => {});
      continue;
    }
    await new Promise(r => setTimeout(r, 1500));
    t = await readTokens(id);
    if (stillValid(t)) return t.access_token;
  }
  throw new Error('Revizto sign-in renewal is busy. Try again in a minute.');
}

// Runs fn(accessToken). If Revizto says the access token is no longer valid (it can be cut
// short before its hour is up), renews the sign-in once and tries again. If renewing fails,
// the error says the admin needs to reconnect.
const AUTH_CODES = new Set([-21, -22, -31]);
export async function withRevizto(connId, fn) {
  const token = await getAccessToken(connId);
  try {
    return await fn(token);
  } catch (e) {
    if (!AUTH_CODES.has(e?.code)) throw e;
    const id = (await getConnection(connId)).id;
    const t = await readTokens(id);
    if (t) await setSecret(tokenName(id), JSON.stringify({ ...t, expires_at: 0 }));
    return fn(await getAccessToken(connId));
  }
}

// ── API calls ───────────────────────────────────────────────────

// Revizto returns HTTP 200 even for handled errors, with a non-zero "result".
// HTTP 429 (result -2300) means too many requests at once: wait as asked, then try again.
async function reviztoCall(accessToken, path, { method = 'GET', body = null, timeoutMs = 0 } = {}) {
  // With a time limit, give up before the server function itself runs out of time
  const stopAt = timeoutMs ? Date.now() + timeoutMs : 0;
  for (let attempt = 0; ; attempt++) {
    const left = stopAt ? stopAt - Date.now() : 0;
    if (stopAt && left < 1000) throw tooSlow();
    const ctrl = stopAt ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), left) : null;
    let r, text;
    try {
      r = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          ...(body != null ? { 'Content-Type': 'application/json' } : {})
        },
        body: body != null ? body : undefined,
        signal: ctrl ? ctrl.signal : undefined
      });
      text = await r.text();
    } catch (e) {
      if (ctrl && ctrl.signal.aborted) throw tooSlow();
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
    let j;
    try { j = JSON.parse(text); } catch { j = null; }
    const busy = r.status === 429 || j?.result === -2300;
    if (busy && attempt < 3) {
      const wait = Math.min(Math.max(Number(r.headers.get('retry-after')) || 2, 1), 8);
      if (stopAt && Date.now() + wait * 1000 > stopAt) throw tooSlow();
      await new Promise(res => setTimeout(res, wait * 1000));
      continue;
    }
    if (!j) throw new Error(`Revizto ${path.split('?')[0]} returned HTTP ${r.status}: ${text.slice(0, 200)}`);
    if (busy) throw new Error('Revizto is busy (too many requests at once). Try again in a minute.');
    if (!r.ok) throw new Error(`Revizto ${path.split('?')[0]} returned HTTP ${r.status}`);
    if (typeof j.result === 'number' && j.result !== 0) {
      let msg = typeof j.message === 'string' ? j.message : JSON.stringify(j.message || '');
      if (j.data && Array.isArray(j.data.fields) && j.data.fields.length) msg += ` (check: ${j.data.fields.join(', ')})`;
      const e = new Error(`Revizto error ${j.result}: ${msg}`);
      e.code = j.result;
      throw e;
    }
    return j.data !== undefined ? j.data : j;
  }
}

function tooSlow() {
  const e = new Error('Revizto took too long to answer this part.');
  e.timeout = true;
  return e;
}

export function reviztoGet(accessToken, path) {
  return reviztoCall(accessToken, path);
}

// body: a JSON string (built by the caller, so 64-bit Revizto Ids keep every digit)
// timeoutMs: give up (with error.timeout = true) if Revizto hasn't answered in time
export function reviztoPost(accessToken, path, body, { timeoutMs = 0 } = {}) {
  return reviztoCall(accessToken, path, { method: 'POST', body, timeoutMs });
}

// Error -20: the licence/project sits in a Revizto account where this app isn't enabled
function isAppNotEnabled(e) {
  return e?.code === -20 || /error -20\b|not enabled for this account/i.test(String(e?.message || ''));
}
function isNotFound(e) {
  return e?.code === -12 || /error -12\b|does not exist/i.test(String(e?.message || ''));
}

// Current (latest, not deleted) 2D sheets of a project
export async function listCurrentSheets(accessToken, projectUuid) {
  const data = await reviztoGet(accessToken, `/v5/project/${projectUuid}/sheet/list`);
  const all = Array.isArray(data?.entities) ? data.entities : (Array.isArray(data) ? data : []);
  const current = all.filter(s => !s.isDeleted && s.isLast !== false && s.sheetNumber);
  return {
    totalReturned: all.length,
    sheets: current.map(s => ({
      sheetNo: String(s.sheetNumber).trim(),
      rev: String(s.sheetVersion ?? '').trim(),
      name: s.description || s.title || '',
      folder: Array.isArray(s.path) ? s.path.join(' / ') : '',
      lastSynced: s.lastSynced || '',
      reviztoRevision: Number(s.reviztoRevisionNumber) || 0
    }))
  };
}

export async function getCurrentUser(accessToken) {
  try {
    const u = await reviztoGet(accessToken, '/v5/user');
    return {
      email: u?.email || null,
      name: [u?.firstName || u?.firstname, u?.lastName || u?.lastname].filter(Boolean).join(' ') || u?.fullname || null
    };
  } catch {
    return null;
  }
}

// ── Project lists (for the admin's Manage projects screen) ──────

// Find the list of records in a Revizto response, wherever it sits.
// (The same search the original connection test used successfully on the live account.)
function findList(data, depth = 0) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object' || depth > 3) return [];
  for (const key of ['entities', 'items', 'data', 'list', 'licenses', 'licences', 'projects', 'result']) {
    if (Array.isArray(data[key])) return data[key];
  }
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  for (const v of Object.values(data)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = findList(v, depth + 1);
      if (inner.length) return inner;
    }
  }
  return [];
}

// Structure of a response (key names and types only, no values), for troubleshooting
function shapeOf(data, depth = 0) {
  if (Array.isArray(data)) return depth > 2 ? 'array' : [`array(${data.length})`, data[0] ? shapeOf(data[0], depth + 1) : null];
  if (data && typeof data === 'object') {
    if (depth > 2) return 'object';
    return Object.fromEntries(Object.entries(data).slice(0, 20).map(([k, v]) => [k, shapeOf(v, depth + 1)]));
  }
  return typeof data;
}

function licenceUsable(l) {
  if (l.frozen) return false;
  const exp = Date.parse(l.expires || l.expirationDate || '');
  return Number.isNaN(exp) || exp + 24 * 3600 * 1000 > Date.now();
}

// One retry, because a burst of requests can occasionally be refused
async function getWithRetry(token, path) {
  try {
    return await reviztoGet(token, path);
  } catch (e) {
    if (isAppNotEnabled(e) || isNotFound(e)) throw e;
    await new Promise(r => setTimeout(r, 900));
    return reviztoGet(token, path);
  }
}

async function readLicenceMap() {
  try {
    const row = await getSecret(LICENCE_MAP);
    return row ? JSON.parse(row.value) || {} : {};
  } catch { return {}; }
}

// All projects in one licence, read through one connection.
// Throws if the first page can't be read (e.g. the app isn't enabled for that licence's account).
async function projectsInLicence(token, licence, conn, deadline, report) {
  const licUuid = licence.uuid || licence.id;
  const out = [];
  const seen = new Set();
  for (let page = 0; page < 40; page++) {
    if (Date.now() > deadline) return { out, partial: true };
    let data;
    try {
      data = await getWithRetry(token, `/v5/project/list/${licUuid}/paged?page=${page}`);
    } catch (e) {
      if (page === 0) throw e;
      return { out, partial: true };
    }
    const batch = findList(data);
    if (!report.firstPageShape) report.firstPageShape = shapeOf(data);
    if (!batch.length) break;
    let added = 0;
    for (const p of batch) {
      const id = p.uuid || p.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      added++;
      out.push({
        uuid: String(id).toLowerCase(),
        name: p.title || p.name || p.projectName || '(untitled)',
        archived: Boolean(p.archived),
        licence: licence.name || licence.title || '',
        licenceActive: licenceUsable(licence),
        connection: conn.id,
        connectionLabel: conn.label
      });
    }
    // Page 0 and 1 may be the same if Revizto counts from 1, so only stop on a repeat from page 2 on
    if (!added && page >= 2) break;
  }
  return { out, partial: false };
}

// Every Revizto project reachable through the connected accounts.
// Each licence is read through the connection whose account it belongs to (remembered between runs).
// Current projects first (licence valid, project not archived), then the rest.
export async function listAllReviztoProjects({ budgetMs = 45000 } = {}) {
  const deadline = Date.now() + budgetMs;
  const conns = await getConnections();
  const usable = [];
  const notConnected = [];
  for (const c of conns) {
    try { usable.push({ conn: c, token: await getAccessToken(c.id) }); }
    catch (e) { notConnected.push({ id: c.id, label: c.label, message: e.message }); }
  }
  if (!usable.length) {
    const e = new Error(conns.length
      ? 'No Revizto account is connected yet. Connect one under Revizto accounts.'
      : 'Revizto is not set up: missing REVIZTO_CLIENT_ID or REVIZTO_CLIENT_SECRET.');
    e.status = 409; e.userFacing = true;
    throw e;
  }

  // Licences from every signed-in connection (usually the same person, so the same list)
  const licences = new Map();
  let licData = null;
  for (const u of usable) {
    try {
      const data = await getWithRetry(u.token, '/v5/user/licenses');
      if (!licData) licData = data;
      for (const l of findList(data).slice(0, 80)) {
        const id = l.uuid || l.id;
        if (id && !licences.has(id)) licences.set(id, l);
      }
    } catch { /* try the next connection */ }
  }

  const map = await readLicenceMap();
  const newMap = { ...map };
  const report = { issues: [], firstPageShape: null };
  const results = [];
  let partial = false;

  const queue = [...licences.values()];
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (queue.length) {
      const l = queue.shift();
      const licUuid = l.uuid || l.id;
      const name = l.name || l.title || String(licUuid);
      const active = licenceUsable(l);
      // The remembered connection first, then the others
      const order = [...usable].sort((a, b) => (b.conn.id === map[licUuid]) - (a.conn.id === map[licUuid]));
      let done = false;
      let lastError = null;
      let blockedEverywhere = true;
      for (const u of order) {
        if (Date.now() > deadline) { partial = true; break; }
        try {
          const { out, partial: p } = await projectsInLicence(u.token, l, u.conn, deadline, report);
          results.push(...out);
          if (p) partial = true;
          newMap[licUuid] = u.conn.id;
          done = true;
          break;
        } catch (e) {
          if (!isAppNotEnabled(e)) { blockedEverywhere = false; lastError = e; }
        }
      }
      if (!done && !(Date.now() > deadline)) {
        if (newMap[licUuid]) delete newMap[licUuid];
        report.issues.push(blockedEverywhere
          ? { licence: name, active, kind: 'app-not-enabled', message: 'Not covered by any connected Revizto account' }
          : { licence: name, active, kind: 'error', message: String(lastError?.message || 'Unknown error').slice(0, 200) });
      }
    }
  }));

  if (JSON.stringify(newMap) !== JSON.stringify(map)) {
    await setSecret(LICENCE_MAP, JSON.stringify(newMap)).catch(() => {});
  }

  const byId = new Map();
  for (const p of results) if (!byId.has(p.uuid)) byId.set(p.uuid, p);
  const projects = [...byId.values()].sort((a, b) =>
    (b.licenceActive && !b.archived) - (a.licenceActive && !a.archived) || a.name.localeCompare(b.name));

  // Licences that couldn't be read: active ones first
  const issues = report.issues.sort((a, b) => (b.active - a.active) || a.licence.localeCompare(b.licence));
  const out = {
    projects,
    partial,
    licenceCount: licences.size,
    issues,
    connections: conns.map(c => ({ id: c.id, label: c.label })),
    notConnected
  };
  // Nothing found: include the response structure (no values) so the cause can be seen
  if (!projects.length) {
    out.diagnostics = { licenceResponse: shapeOf(licData), firstProjectPage: report.firstPageShape };
  }
  return out;
}

// Finds which connection can open a project. Tries `preferred` first, then the rest.
// Returns the connection id, or throws a clear, user-facing error.
export async function findConnectionForProject(projectUuid, preferred) {
  const conns = await getConnections();
  const order = [...conns].sort((a, b) => (b.id === preferred) - (a.id === preferred));
  let sawNotConnected = false;
  let lastOther = null;
  for (const c of order) {
    let token;
    try { token = await getAccessToken(c.id); } catch { sawNotConnected = true; continue; }
    try {
      await reviztoGet(token, `/v5/project/${projectUuid}/team`);
      return c.id;
    } catch (e) {
      if (!isAppNotEnabled(e) && !isNotFound(e)) lastOther = e;
    }
  }
  const msg = lastOther
    ? `Revizto could not open that project: ${lastOther.message}`
    : sawNotConnected
      ? 'None of the connected Revizto accounts can open that project. One of the added accounts isn\'t signed in yet. Connect it under Revizto accounts and try again.'
      : 'None of the connected Revizto accounts can open that project. Add the custom app for its Revizto account under Revizto accounts.';
  const err = new Error(msg);
  err.status = 400;
  err.userFacing = true;
  throw err;
}
