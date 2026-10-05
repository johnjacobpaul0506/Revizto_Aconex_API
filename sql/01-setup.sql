-- Digital Corner: database setup. Run once in Supabase → SQL Editor → New query → paste → Run.
-- Safe to run again: it only creates what is missing.
-- Row level security is on for every table with no rules, so only the app's server
-- (using the secret key) can read or write. Nobody can reach the data from a browser.

-- Private settings: Revizto sign-ins, extra Revizto apps, failed sign-in counts, cached lookups
create table if not exists public.app_secrets (
  name       text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_secrets enable row level security;

-- Projects, shared by all tools (one Revizto project each)
create table if not exists public.projects (
  key                   text primary key,          -- short id used in links, e.g. nnshs
  name                  text not null,             -- shown on the pages
  revizto_project_uuid  text not null,
  revizto_project_name  text,
  revizto_connection    text,                      -- which Revizto account reaches it; empty = main
  aconex_project_id     text,                      -- for the 2D audit, when it moves in (Phase 2)
  aconex_project_name   text,
  settings              jsonb not null default '{}'::jsonb,   -- e.g. {"dropThreshold": 10}
  active                boolean not null default true,         -- false = archived (hidden, data kept)
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
alter table public.projects enable row level security;

-- Object Data: the baseline. Each row is a fixed piece of text a model file name must contain.
--   status 'required' = this model must be in Revizto
--   status 'ignored'  = a model you have chosen not to flag
create table if not exists public.od_baseline (
  id          bigint generated always as identity primary key,
  project_key text not null references public.projects(key) on update cascade on delete cascade,
  match_text  text not null,
  label       text,
  status      text not null default 'required' check (status in ('required', 'ignored')),
  created_at  timestamptz not null default now()
);
create unique index if not exists od_baseline_unique
  on public.od_baseline (project_key, status, lower(match_text));
alter table public.od_baseline enable row level security;

-- Object Data: element counts, one row per model per count
create table if not exists public.od_model_counts (
  id               bigint generated always as identity primary key,
  project_key      text not null references public.projects(key) on update cascade on delete cascade,
  scene_id         text not null,
  model_id         text not null,
  file_name        text,
  element_count    integer not null,
  model_synced_at  timestamptz,
  import_revision  integer,
  counted_at       timestamptz not null default now()
);
create index if not exists od_model_counts_lookup
  on public.od_model_counts (project_key, model_id, counted_at desc);
alter table public.od_model_counts enable row level security;

-- Object Data: saved property searches (like Revizto search sets), usable in every project
create table if not exists public.od_searches (
  id          bigint generated always as identity primary key,
  name        text not null,
  definition  jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists od_searches_name_unique on public.od_searches (lower(name));
alter table public.od_searches enable row level security;
