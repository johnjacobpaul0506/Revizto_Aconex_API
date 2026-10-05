// Access checks for the API, based on the sign-in cookie (see _session.js).
//   requireAuth  – anyone signed in (team or admin)
//   requireAdmin – admin sign-in only

import { readSession } from './_session.js';

export function getSession(req) {
  return readSession(req);
}

export function requireAuth(req, res) {
  const s = readSession(req);
  if (s) return s;
  res.status(401).json({ ok: false, error: 'Not signed in', signIn: '/' });
  return null;
}

export function requireAdmin(req, res) {
  const s = readSession(req);
  if (s?.role === 'admin') return s;
  if (s) res.status(403).json({ ok: false, error: 'Admin sign-in required' });
  else res.status(401).json({ ok: false, error: 'Not signed in', signIn: '/' });
  return null;
}
