// Supabase access for server functions only (uses the secret / service_role key).
// Files starting with "_" in /api are not exposed as web addresses by Vercel.

function baseUrl() {
  return String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
}
function secretKey() {
  return String(process.env.SUPABASE_SECRET_KEY || '').trim();
}

function headers(extra = {}) {
  const key = secretKey();
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  // Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys do not
  if (!key.startsWith('sb_')) h.Authorization = `Bearer ${key}`;
  return h;
}

export async function rest(path, options = {}) {
  if (!baseUrl() || !secretKey()) {
    throw new Error('Supabase is not set up: add SUPABASE_URL and SUPABASE_SECRET_KEY in Vercel, then redeploy.');
  }
  const r = await fetch(`${baseUrl()}/rest/v1/${path}`, { ...options, headers: headers(options.headers) });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

export function fail(action, r) {
  const detail = r.body && typeof r.body === 'object' ? (r.body.message || r.body.hint || JSON.stringify(r.body)) : String(r.body || '');
  let hint = '';
  if (r.status === 401 || r.status === 403) hint = ' Check SUPABASE_SECRET_KEY is the secret or service_role key (not the anon/publishable key).';
  if (r.status === 404 || /relation .* does not exist|Could not find the table/i.test(detail)) hint = ' Check the SQL that creates the tables was run in this Supabase project.';
  return new Error(`Supabase ${action} failed (HTTP ${r.status}): ${String(detail).slice(0, 200)}.${hint}`);
}

// ── Private settings (app_secrets) ─────────────────────────────
export async function getSecret(name) {
  const r = await rest(`app_secrets?name=eq.${encodeURIComponent(name)}&select=value,updated_at`);
  if (!r.ok) throw fail('read', r);
  return Array.isArray(r.body) && r.body[0] ? r.body[0] : null;
}

export async function setSecret(name, value) {
  const r = await rest('app_secrets?on_conflict=name', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ name, value, updated_at: new Date().toISOString() })
  });
  if (!r.ok) throw fail('save', r);
}

// Insert only if the row does not exist yet. Returns false if it already exists (used as a lock).
export async function insertSecretIfAbsent(name, value) {
  const r = await rest('app_secrets', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ name, value, updated_at: new Date().toISOString() })
  });
  if (r.ok) return true;
  if (r.status === 409) return false;
  throw fail('lock', r);
}

// All rows whose name starts with `prefix` (e.g. "revizto_app:")
export async function listSecrets(prefix) {
  const r = await rest(`app_secrets?name=like.${encodeURIComponent(prefix)}*&select=name,value,updated_at&order=name.asc`);
  if (!r.ok) throw fail('read', r);
  return Array.isArray(r.body) ? r.body : [];
}

export async function deleteSecret(name) {
  const r = await rest(`app_secrets?name=eq.${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' }
  });
  if (!r.ok) throw fail('delete', r);
}

// ── Simple table helpers ───────────────────────────────────────
// select('od_baseline', 'project_key=eq.x&order=id.asc')
export async function select(table, query = '') {
  const r = await rest(`${table}?${query}`);
  if (!r.ok) throw fail(`read ${table}`, r);
  return Array.isArray(r.body) ? r.body : [];
}

export async function insert(table, rows) {
  const r = await rest(table, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw fail(`save to ${table}`, r);
  return Array.isArray(r.body) ? r.body : [r.body];
}

export async function update(table, query, patch) {
  const r = await rest(`${table}?${query}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch)
  });
  if (!r.ok) throw fail(`update ${table}`, r);
  return Array.isArray(r.body) ? r.body : [];
}

export async function remove(table, query) {
  const r = await rest(`${table}?${query}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (!r.ok) throw fail(`delete from ${table}`, r);
}

// Is this failure "the table doesn't exist yet" (setup SQL not run)?
export function tableMissing(r) {
  const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
  return r.status === 404 || /PGRST205|42P01|does not exist|Could not find the table/i.test(text);
}
