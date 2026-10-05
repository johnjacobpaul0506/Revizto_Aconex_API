# 2D Sheet Audit | Aconex vs Revizto

Compares drawing revisions in the Aconex document register against 2D sheets in Revizto.

## How it fits together

- `public/index.html` – the sign-in page (the only page anyone can open without signing in)
- `/dashboard` – the dashboard, served by `api/app.js` only to signed-in users
- `api/` – server functions on Vercel. Files starting with `_` are shared code, not web addresses.
- `vercel.json` – sends `/dashboard` to `api/app.js`, adds basic security headers
- Supabase – stores the Revizto sign-in, saved sync results and failed sign-in counts

`api/_dashboard-page.js` is generated from `src/dashboard.html` (`node src/build.mjs`); don't edit it by hand.

## Environment variables (set in Vercel, never in this repo)

| Name | Purpose |
| --- | --- |
| `APP_USERNAME` / `APP_PASSWORD` | Shared team sign-in (view, refresh, export, rename) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Admin sign-in (also reconnects Revizto, manages projects) |
| `SESSION_HOURS` | Optional, how long a sign-in lasts (default 12) |
| `SESSION_SECRET` | Optional, 32+ characters; otherwise derived from `SUPABASE_SECRET_KEY` |
| `ACONEX_CLIENT_ID` / `ACONEX_CLIENT_SECRET` | Aconex User-Bound OAuth client |
| `ACONEX_USER_ID` / `ACONEX_USER_SITE` | Only if the bound Lobby account has more than one Aconex account |
| `REVIZTO_CLIENT_ID` / `REVIZTO_CLIENT_SECRET` | Revizto custom app (Developer Portal) |
| `REVIZTO_REGION` | Optional, defaults to `sydney` |
| `REVIZTO_REDIRECT_URI` | Optional, defaults to `https://aconexrevizto2d.vercel.app/api/revizto-callback` |
| `SUPABASE_URL` / `SUPABASE_SECRET_KEY` | Supabase project URL and secret (service_role) key |

Changing a password signs out everyone who used it. Ten wrong passwords from one network
address within 15 minutes locks that address until the 15 minutes are up.

## Adding a project (until the Manage projects screen exists)

Edit `api/_projects.js`. The Revizto project uuid can be found while signed in as admin at
`/api/revizto-callback?list=1&find=<part of project name>`.
