// Sign out: clears the sign-in cookie.
//   POST /api/logout → { ok: true }
//   GET  /api/logout → back to the sign-in page

import { clearSessionCookie } from './_session.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', clearSessionCookie());
  if (req.method === 'POST') return res.status(200).json({ ok: true });
  res.statusCode = 302;
  res.setHeader('Location', '/?signedout=1');
  return res.end();
}
