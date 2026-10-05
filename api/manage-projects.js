// Manage projects (admin sign-in only).
//   GET   /api/manage-projects                 → all projects (incl. archived)
//   GET   /api/manage-projects?source=revizto  → Revizto projects the connected accounts can see (&fresh=1 to reload)
//   POST  /api/manage-projects  { name, revizto, reviztoName, reviztoConnection }                → add
//   PATCH /api/manage-projects  { key, name?, revizto?, reviztoName?, reviztoConnection?, active? } → edit / archive / restore

import { requireAdmin } from './_auth.js';
import { listProjects, createProject, updateProject, userError } from './_projects.js';
import { listAllReviztoProjects, findConnectionForProject, connectionsWithStatus } from './_revizto.js';

export const config = { maxDuration: 60 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIZTO_CACHE_MS = 10 * 60 * 1000;
let reviztoCache = { at: 0, sig: '', data: null };   // reused while this server instance stays warm

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      if (req.query?.source === 'revizto') {
        const fresh = req.query?.fresh === '1';
        // Adding, removing or (re)connecting a Revizto account changes this, which forces a reload
        const sig = (await connectionsWithStatus()).map(c => `${c.id}:${c.connected}:${c.savedAt || ''}`).join('|');
        if (fresh || !reviztoCache.data || reviztoCache.sig !== sig || Date.now() - reviztoCache.at > REVIZTO_CACHE_MS) {
          const data = await listAllReviztoProjects();
          // Only keep a complete, error-free list for reuse
          reviztoCache = data.projects.length && !data.partial && !data.issues.some(i => i.kind === 'error')
            ? { at: Date.now(), sig, data }
            : { at: 0, sig: '', data: null };
          return res.status(200).json({ ok: true, ...data, loadedAt: new Date().toISOString() });
        }
        return res.status(200).json({ ok: true, ...reviztoCache.data, loadedAt: new Date(reviztoCache.at).toISOString() });
      }
      return res.status(200).json(await listWithLabels());
    }

    const body = readBody(req);

    if (req.method === 'POST') {
      const name = cleanName(body.name);
      const rv = await checkRevizto(body.revizto, body.reviztoConnection);
      const project = await createProject({ name, ...rv, reviztoName: cleanName(body.reviztoName, true) });
      return res.status(201).json({ ok: true, project });
    }

    if (req.method === 'PATCH') {
      const changes = {};
      if (body.name !== undefined) changes.name = cleanName(body.name);
      if (body.active !== undefined) changes.active = Boolean(body.active);
      if (body.revizto !== undefined) {
        Object.assign(changes, await checkRevizto(body.revizto, body.reviztoConnection));
        changes.reviztoName = cleanName(body.reviztoName, true);
      }
      if (!Object.keys(changes).length) throw userError('Nothing to change.');
      const project = await updateProject(body.key, changes);
      return res.status(200).json({ ok: true, project });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    const status = e.status || 502;
    return res.status(status).json({ ok: false, error: e.message });
  }
}

async function listWithLabels() {
  const { projects, needsSetup } = await listProjects({ includeArchived: true });
  let labels = new Map();
  try { labels = new Map((await connectionsWithStatus()).map(c => [c.id, c.label])); } catch { /* labels optional */ }
  for (const p of projects) {
    p.reviztoConnectionLabel = labels.get(p.reviztoConnection) || (p.reviztoConnection === 'main' ? 'Main account' : 'Removed account');
  }
  return { ok: true, needsSetup, projects };
}

// Confirms a connected Revizto account can open the project; returns the uuid and that account
async function checkRevizto(reviztoRaw, preferredConnection) {
  const revizto = String(reviztoRaw ?? '').trim().toLowerCase();
  if (!UUID.test(revizto)) throw userError('Choose a Revizto project.');
  let connection;
  try {
    connection = await findConnectionForProject(revizto, String(preferredConnection || ''));
  } catch (e) {
    throw e?.userFacing ? e : userError(`Could not check Revizto: ${e?.message || e}`, 502);
  }
  return { revizto, reviztoConnection: connection };
}

function cleanName(v, optional = false) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) {
    if (optional) return null;
    throw userError('Enter a project name.');
  }
  if (s.length > 80) {
    if (optional) return s.slice(0, 120);
    throw userError('Keep the project name to 80 characters or fewer.');
  }
  return s;
}

function readBody(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') { try { return JSON.parse(b); } catch { /* fall through */ } }
  return {};
}
