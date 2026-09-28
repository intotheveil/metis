// THE SHARED-PROJECT SHIM for `npm run db:gate`.
//
// Themis does not own its database. It lives in schema `themis` inside Hephaestus's LIVE
// Supabase project `lss-platform` (ADR-0002). So a rehearsal on an empty Postgres proves too
// little: it would pass a migration that collides with, or quietly edits, the tenant next door.
// This shim rebuilds the parts of that project a Themis migration can touch or depend on:
//
//   1. What Supabase provides and no migration restates: the API roles, the `auth` schema with
//      auth.uid() and auth.users, and Supabase's DEFAULT PRIVILEGES in `public` (which is why,
//      in `public`, the policies are the only boundary).
//   2. A Hephaestus-shaped `public`: the five tables whose NAMES Themis reuses inside its own
//      schema (organizations, profiles, memberships, workspaces, tasks), with RLS on, and
//      Hephaestus's migration ledger `supabase_migrations.schema_migrations` holding 25 rows.
//
// What it deliberately does NOT do: grant anything on schema `themis`. Live Supabase has no
// default privileges on a custom schema, so every grant Themis needs must come from Themis's
// own migrations. If the shim pre-granted, a migration that forgot a grant would pass here and
// break on the live project; instead it must show up as a failing positive-path check.

export const HEPHAESTUS_TABLES = ['organizations', 'profiles', 'memberships', 'workspaces', 'tasks']
export const HEPHAESTUS_MIGRATION_ROWS = 25

/** @param {import('@electric-sql/pglite').PGlite} db */
export async function installShim(db) {
  // --- Supabase roles, auth schema, default privileges --------------------------------------
  // service_role bypasses RLS on the real platform; mirror it so a service-only table behaves
  // the same here as live.
  await db.exec(`
    create role anon nologin noinherit;
    create role authenticated nologin noinherit;
    create role service_role nologin noinherit bypassrls;

    create schema auth;
    create table auth.users (
      id uuid primary key,
      email text,
      created_at timestamptz not null default now()
    );
    create or replace function auth.uid() returns uuid language sql stable
      as $fn$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;

    grant usage on schema public to anon, authenticated, service_role;
    grant usage on schema auth to anon, authenticated, service_role;
    alter default privileges in schema public
      grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public
      grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public
      grant all on functions to anon, authenticated, service_role;
  `)

  // --- Hephaestus's `public` (shape only; the names are what matter) ------------------------
  await db.exec(`
    create table public.organizations (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      created_at timestamptz not null default now()
    );
    create table public.profiles (
      id uuid primary key references auth.users (id) on delete cascade,
      full_name text,
      created_at timestamptz not null default now()
    );
    create table public.memberships (
      organization_id uuid not null references public.organizations (id) on delete cascade,
      user_id uuid not null references auth.users (id) on delete cascade,
      role text not null default 'member',
      primary key (organization_id, user_id)
    );
    create table public.workspaces (
      id uuid primary key default gen_random_uuid(),
      organization_id uuid not null references public.organizations (id) on delete cascade,
      name text not null
    );
    create table public.tasks (
      id uuid primary key default gen_random_uuid(),
      workspace_id uuid not null references public.workspaces (id) on delete cascade,
      title text not null,
      done boolean not null default false
    );

    alter table public.organizations enable row level security;
    alter table public.profiles enable row level security;
    alter table public.memberships enable row level security;
    alter table public.workspaces enable row level security;
    alter table public.tasks enable row level security;

    create policy profiles_self on public.profiles
      for all to authenticated using (id = auth.uid()) with check (id = auth.uid());
    create policy memberships_self on public.memberships
      for select to authenticated using (user_id = auth.uid());
    create policy organizations_member on public.organizations
      for select to authenticated using (exists (
        select 1 from public.memberships m
        where m.organization_id = organizations.id and m.user_id = auth.uid()));
    create policy workspaces_member on public.workspaces
      for select to authenticated using (exists (
        select 1 from public.memberships m
        where m.organization_id = workspaces.organization_id and m.user_id = auth.uid()));
    create policy tasks_member on public.tasks
      for all to authenticated using (exists (
        select 1 from public.workspaces w join public.memberships m
          on m.organization_id = w.organization_id
        where w.id = tasks.workspace_id and m.user_id = auth.uid()));
  `)

  // --- Hephaestus's migration ledger (owned by the Supabase CLI; Themis never writes it) -----
  await db.exec(`
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations (
      version text primary key,
      statements text[],
      name text
    );
  `)
  await db.query(
    `insert into supabase_migrations.schema_migrations (version, statements, name)
     select to_char(timestamp '2026-01-01' + (g || ' days')::interval, 'YYYYMMDDHH24MISS'),
            array['-- hephaestus migration ' || g],
            'hephaestus_' || lpad(g::text, 2, '0')
       from generate_series(1, $1::int) as g`,
    [HEPHAESTUS_MIGRATION_ROWS],
  )
}
