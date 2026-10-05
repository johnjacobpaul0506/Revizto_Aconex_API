// Projects, shared by every tool in Digital Corner. Stored in Supabase (table: projects),
// managed by the admin from the Object Data page's "Manage Projects" screen.
// Each project is one Revizto project. (Aconex columns are kept for when the 2D audit moves in.)

import { rest, fail, tableMissing } from './_supabase.js';

const KEY_RX = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DEFAULT_SETTINGS = { dropThreshold: 10 };

function fromRow(r) {
  return {
    key: r.key,
    name: r.name,
    revizto: String(r.revizto_project_uuid || '').toLowerCase(),
    reviztoName: r.revizto_project_name || null,
    // Which Revizto account (connection) reaches this project; empty = the main one
    reviztoConnection: r.revizto_connection || 'main',
    settings: { ...DEFAULT_SETTINGS, ...(r.settings && typeof r.settings === 'object' ? r.settings : {}) },
    active: r.active !== false,
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null
  };
}

// An error whose message is safe and useful to show the admin
export function userError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  e.userFacing = true;
  return e;
}

const NEED_SQL = 'The database tables are not set up yet. Run sql/01-setup.sql in Supabase (SQL Editor), then try again.';

// { projects, needsSetup }
export async function listProjects({ includeArchived = false } = {}) {
  const r = await rest(`projects?select=*&order=name.asc${includeArchived ? '' : '&active=is.true'}`);
  if (!r.ok) {
    if (tableMissing(r)) return { projects: [], needsSetup: true };
    throw fail('read projects', r);
  }
  return { projects: (r.body || []).map(fromRow), needsSetup: false };
}

// An active project by key, or null. Archived projects can't be opened.
export async function findProject(key) {
  const k = String(key || '').trim().toLowerCase();
  if (!KEY_RX.test(k)) return null;
  const r = await rest(`projects?key=eq.${encodeURIComponent(k)}&select=*`);
  if (!r.ok) {
    if (tableMissing(r)) return null;
    throw fail('read project', r);
  }
  const p = Array.isArray(r.body) && r.body[0] ? fromRow(r.body[0]) : null;
  return p && p.active ? p : null;
}

export async function createProject({ name, revizto, reviztoName, reviztoConnection = 'main' }) {
  const { projects, needsSetup } = await listProjects({ includeArchived: true });
  if (needsSetup) throw userError(NEED_SQL, 409);

  const dup = projects.find(p => p.revizto === revizto);
  if (dup) throw userError(`That Revizto project is already set up as "${dup.name}"${dup.active ? '' : ' (archived, restore it instead)'}.`, 409);

  const key = uniqueKey(name, new Set(projects.map(p => p.key)));
  const row = {
    key,
    name,
    revizto_project_uuid: revizto,
    revizto_project_name: reviztoName || null,
    revizto_connection: reviztoConnection && reviztoConnection !== 'main' ? reviztoConnection : null,
    settings: { ...DEFAULT_SETTINGS },
    active: true
  };
  const r = await rest('projects', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row)
  });
  if (!r.ok) {
    if (r.status === 409) throw userError('That project already exists. Refresh the list and try again.', 409);
    throw fail('save project', r);
  }
  return fromRow(r.body[0]);
}

// changes: any of { name, revizto, reviztoName, reviztoConnection, active, settings }
export async function updateProject(key, changes) {
  const k = String(key || '').trim().toLowerCase();
  if (!KEY_RX.test(k)) throw userError('Unknown project', 404);

  const { projects, needsSetup } = await listProjects({ includeArchived: true });
  if (needsSetup) throw userError(NEED_SQL, 409);
  const current = projects.find(p => p.key === k);
  if (!current) throw userError('Unknown project', 404);

  if (changes.revizto !== undefined) {
    const dup = projects.find(p => p.key !== k && p.revizto === changes.revizto);
    if (dup) throw userError(`That Revizto project is already set up as "${dup.name}".`, 409);
  }

  const patch = { updated_at: new Date().toISOString() };
  if (changes.name !== undefined) patch.name = changes.name;
  if (changes.revizto !== undefined) patch.revizto_project_uuid = changes.revizto;
  if (changes.reviztoName !== undefined) patch.revizto_project_name = changes.reviztoName;
  if (changes.active !== undefined) patch.active = Boolean(changes.active);
  if (changes.reviztoConnection !== undefined) {
    const want = changes.reviztoConnection || 'main';
    patch.revizto_connection = want === 'main' ? null : want;
  }
  if (changes.settings !== undefined) patch.settings = { ...current.settings, ...changes.settings };

  const r = await rest(`projects?key=eq.${encodeURIComponent(k)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch)
  });
  if (!r.ok) throw fail('update project', r);
  return fromRow(r.body[0]);
}

function uniqueKey(name, taken) {
  let base = String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  if (!base || !/^[a-z0-9]/.test(base)) base = 'project';
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
  return key;
}
