// Serves the pages, only to people who are signed in.
// The pages live in _pages.js, so they are never published as public files.
// vercel.json sends /home and /object-data here.

import { readSession } from './_session.js';
import pages from './_pages.js';

// Which sign-in each page needs
const ACCESS = { home: 'any', 'object-data': 'admin' };

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  const session = readSession(req);
  if (!session) {
    res.statusCode = 302;
    res.setHeader('Location', '/');
    return res.end();
  }

  const name = String(req.query?.page || 'home');
  const page = pages[name];
  if (!page) {
    res.statusCode = 302;
    res.setHeader('Location', '/home');
    return res.end();
  }
  if (ACCESS[name] === 'admin' && session.role !== 'admin') {
    res.statusCode = 302;
    res.setHeader('Location', '/home?admin=1');
    return res.end();
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(page);
}
