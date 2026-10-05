// Sign in / check sign-in.
//   GET  /api/login                         → { signedIn, role, expiresAt }
//   POST /api/login  { username, password } → sets the sign-in cookie

import {
  checkCredentials, createSessionCookie, readSession, configProblems,
  lockStatus, recordFailure, clearFailures
} from './_session.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const s = readSession(req);
    return res.status(200).json({ ok: true, signedIn: Boolean(s), role: s?.role || null, expiresAt: s?.expiresAt || null });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use POST' });

  const problems = configProblems();
  if (problems.length) {
    return res.status(500).json({ ok: false, error: `Sign-in is not set up yet. Add in Vercel: ${problems.join('; ')}. Then redeploy.` });
  }

  const lock = await lockStatus(req);
  if (lock.locked) {
    return res.status(429).json({
      ok: false,
      error: `Too many incorrect attempts. Try again in ${lock.minutesLeft} minute${lock.minutesLeft === 1 ? '' : 's'}.`
    });
  }

  const { username, password } = readBody(req);
  const account = checkCredentials(username, password);
  if (!account) {
    await recordFailure(req);
    await new Promise(r => setTimeout(r, 600));   // slow down guessing
    return res.status(401).json({ ok: false, error: 'Username or password is incorrect.' });
  }

  await clearFailures(req);
  const { cookie, expiresAt } = createSessionCookie(account);
  res.setHeader('Set-Cookie', cookie);
  return res.status(200).json({ ok: true, role: account.role, expiresAt });
}

function readBody(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch { /* not JSON */ }
    return Object.fromEntries(new URLSearchParams(b));
  }
  return {};
}
