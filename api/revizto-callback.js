// Revizto sign-in for the app. Each Revizto account (connection) is signed in once;
// the sign-in is saved in Supabase and renewed automatically by each sync.
//
// All of these need the admin sign-in:
//  Connect:        /api/revizto-callback?connection=<id>      (default: main)
//                  → Revizto sign-in, then back to the dashboard
//  Status:         /api/revizto-callback?status=1
//  Find projects:  /api/revizto-callback?list=1&find=<part of project name>

import { requireAdmin } from './_auth.js';
import {
  authorizeUrl, makeState, checkState, exchangeCodeAndSave, connectionsWithStatus,
  getConnection, listAllReviztoProjects, REGION, MAIN
} from './_revizto.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};

  // Revizto sent back an error instead of a code (e.g. sign-in cancelled)
  if (q.error) {
    return res.status(400).json({ ok: false, step: 'revizto-sign-in', error: q.error, description: q.error_description || null });
  }

  // Returning from Revizto
  if (q.code) return handleReturn(req, res);

  if (!requireAdmin(req, res)) return;

  if (q.status) {
    try {
      return res.status(200).json({ ok: true, region: REGION, connections: await connectionsWithStatus() });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  }

  if (q.list) {
    try {
      return res.status(200).json(await findProjects(q.find));
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  }

  // Start sign-in for one connection
  try {
    const conn = await getConnection(String(q.connection || MAIN));
    res.statusCode = 302;
    res.setHeader('Location', authorizeUrl(makeState(conn.id), conn));
    return res.end();
  } catch (e) {
    return res.status(400).json({ ok: false, step: 'config', error: e.message });
  }
}

async function handleReturn(req, res) {
  const { connId, problem } = checkState(req.query.state);
  if (problem) {
    return res.status(400).json({
      ok: false,
      step: 'state-check',
      error: `This sign-in link is not valid (${problem}). Start again from the dashboard (admin sign-in).`
    });
  }

  try {
    await exchangeCodeAndSave(String(req.query.code), connId);
  } catch (e) {
    return res.status(502).json({
      ok: false,
      step: 'save-sign-in',
      error: e.message,
      note: 'Each sign-in link works once. If you refreshed this page after connecting, you are already done.'
    });
  }

  // Back to the dashboard
  res.statusCode = 302;
  res.setHeader('Location', `/object-data?revizto=connected${connId === MAIN ? '' : '&manage=accounts'}`);
  return res.end();
}

// Search the connected accounts' Revizto projects by name
async function findProjects(find) {
  const needle = String(find || '').trim().toLowerCase();
  const { projects, partial, issues } = await listAllReviztoProjects();
  const matches = projects
    .filter(p => !needle || p.name.toLowerCase().includes(needle))
    .map(p => ({ project: p.name, uuid: p.uuid, archived: p.archived, licence: p.licence, licenceActive: p.licenceActive, account: p.connectionLabel }));
  return { ok: true, searchedFor: needle || null, matches: matches.length, partial, issues, projects: matches };
}
