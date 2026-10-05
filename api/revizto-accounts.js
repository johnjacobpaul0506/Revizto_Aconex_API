// Revizto accounts the app can use (admin sign-in only).
// Each one is a custom app registered in that Revizto account's Developer Portal.
//   GET    /api/revizto-accounts                               → list with sign-in status
//   POST   /api/revizto-accounts  { label, clientId, clientSecret } → add
//   DELETE /api/revizto-accounts?id=<id>                        → remove (only if no project uses it)
//
// Client secrets are stored in Supabase (private table) and never sent back to the browser.

import { requireAdmin } from './_auth.js';
import { connectionsWithStatus, addConnection, removeConnection, MAIN } from './_revizto.js';
import { listProjects } from './_projects.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const [accounts, { projects }] = await Promise.all([connectionsWithStatus(), listProjects({ includeArchived: true })]);
      const used = new Map();
      for (const p of projects) {
        const id = p.reviztoConnection || MAIN;
        used.set(id, (used.get(id) || 0) + 1);
      }
      return res.status(200).json({
        ok: true,
        accounts: accounts.map(a => ({ ...a, clientId: maskId(a.clientId), projects: used.get(a.id) || 0 }))
      });
    }

    const body = readBody(req);

    if (req.method === 'POST') {
      const label = clean(body.label, 60, 'Enter a name for this Revizto account.');
      const clientId = clean(body.clientId, 200, 'Paste the client ID.').replace(/\s+/g, '');
      const clientSecret = clean(body.clientSecret, 500, 'Paste the client secret.').replace(/\s+/g, '');
      const account = await addConnection({ label, clientId, clientSecret });
      return res.status(201).json({ ok: true, account: { ...account, clientId: maskId(account.clientId) } });
    }

    if (req.method === 'DELETE') {
      const id = String(req.query?.id || '').trim();
      if (!id || id === MAIN) {
        return res.status(400).json({ ok: false, error: 'The main Revizto account is set in Vercel and can\'t be removed here.' });
      }
      const { projects } = await listProjects({ includeArchived: true });
      const users = projects.filter(p => p.active && (p.reviztoConnection || MAIN) === id);
      if (users.length) {
        return res.status(409).json({
          ok: false,
          error: `${users.length} project${users.length > 1 ? 's use' : ' uses'} this Revizto account (${users.map(p => p.name).join(', ')}). Re-pair or archive ${users.length > 1 ? 'them' : 'it'} first.`
        });
      }
      await removeConnection(id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(e.status || 502).json({ ok: false, error: e.message });
  }
}

function maskId(id) {
  const s = String(id || '');
  return s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

function clean(v, max, emptyMessage) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) throw Object.assign(new Error(emptyMessage), { status: 400, userFacing: true });
  if (s.length > max) throw Object.assign(new Error(`That value is too long (max ${max} characters).`), { status: 400, userFacing: true });
  return s;
}

function readBody(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') { try { return JSON.parse(b); } catch { /* fall through */ } }
  return {};
}
