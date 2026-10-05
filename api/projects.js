// Lists the projects the pages can show, whether Revizto is connected, and who is signed in.
//   GET /api/projects   (signed in)

import { requireAuth } from './_auth.js';
import { listProjects } from './_projects.js';
import { connectionsWithStatus } from './_revizto.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = requireAuth(req, res);
  if (!session) return;

  let list;
  try {
    list = await listProjects();
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }

  let connections = [];
  try {
    connections = (await connectionsWithStatus()).map(c => ({ id: c.id, label: c.label, connected: c.connected }));
  } catch { /* shown as not connected */ }

  return res.status(200).json({
    ok: true,
    session: { role: session.role, expiresAt: session.expiresAt },
    projects: list.projects.map(p => ({
      key: p.key,
      name: p.name,
      reviztoConnection: p.reviztoConnection || 'main',
      settings: p.settings
    })),
    needsSetup: list.needsSetup,
    revizto: { connections }
  });
}
