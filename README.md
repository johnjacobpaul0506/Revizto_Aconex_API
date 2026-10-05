# Digital Corner

BIM data tools in one place, starting with **Revizto Object Data**:

- **Models & sync**: every model file in a Revizto project with its last sync date, checked against a
  baseline list of required models. Each baseline line is text the file name must contain, so revision
  tags like `[14]` can change freely. New models are flagged until you approve or ignore them.
- **Element counts**: counts each model file's elements (like Revizto's "Elements only") and compares
  them with the previous sync. A drop of 10% or more (you can change this) is flagged.
- **Property search**: Revizto-style search sets, a selection-inspector style table, totals, formulas,
  group-by and CSV export. Searches can be saved and reused in any project.

The 2D Sheet Audit (Aconex vs Revizto) is linked from the start page and moves in later (Phase 2).

## How it fits together

- `public/index.html`: the sign-in page (the only page anyone can open without signing in)
- `/home` (start page) and `/object-data`: served by `api/app.js` only to signed-in users
- `src/pages/*.html`: the page designs. Run `node src/build.mjs` to seal them into `api/_pages.js`
  (don't edit `api/_pages.js` by hand)
- `api/`: server functions on Vercel. Files starting with `_` are shared code, not web addresses.
  The Vercel Hobby plan allows 12 functions per site, so all Object Data requests go through `api/od.js`.
- `sql/01-setup.sql`: run once in Supabase (SQL Editor) to create the tables
- `vercel.json`: sends `/home` and `/object-data` to `api/app.js`, adds basic security headers

## Environment variables (set in Vercel, never in this repo)

| Name | Purpose |
| --- | --- |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Admin sign-in |
| `APP_USERNAME` / `APP_PASSWORD` | Optional team sign-in (for the team pages, coming later) |
| `SESSION_HOURS` | Optional, how long a sign-in lasts (default 12) |
| `SESSION_SECRET` | Optional, 32+ characters; otherwise derived from `SUPABASE_SECRET_KEY` |
| `REVIZTO_CLIENT_ID` / `REVIZTO_CLIENT_SECRET` | Revizto custom app (Developer Portal) for the main account |
| `REVIZTO_REGION` | Optional, defaults to `sydney` |
| `REVIZTO_REDIRECT_URI` | Optional, defaults to `https://jjp-digital-poc.vercel.app/api/revizto-callback` |
| `SUPABASE_URL` / `SUPABASE_SECRET_KEY` | Supabase project URL and secret (service_role) key |

## Revizto setting needed per project

Element counts and property search read object data. In Revizto, open the project's
**Project info → Extended API access** and tick **Enable API access to object properties**.
Without it only the model list and sync dates are available.

## Revizto accounts

A Revizto custom app only works for licences in the Revizto account where it was created.
The app in Vercel is the **main account**. For each other account that holds a licence, create a
custom app there (same redirect URI), then add it under **Manage Projects → Revizto accounts** and click
**Connect**.
