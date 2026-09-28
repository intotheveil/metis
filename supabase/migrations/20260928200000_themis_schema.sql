-- Themis bootstrap: schema `themis`, its migration ledger, the shared updated_at trigger function.
--
-- Themis lives in Hephaestus's LIVE Supabase project (ADR-0002). Everything here is created in
-- schema `themis` only; nothing in `public`, `auth`, `storage` or `supabase_migrations` is touched.
-- Idempotent-safe: every statement can run twice on the same database without error or change.

create schema if not exists themis;

-- The API roles may resolve names in the schema. This grants NO table or function access by
-- itself; every table and RPC grants its own privileges in the migration that creates it.
grant usage on schema themis to anon, authenticated, service_role;

-- Postgres grants EXECUTE on every new function to PUBLIC, which would hand anon every Themis
-- function. Stop that for all future functions this role creates in `themis`; an RPC meant for
-- signed-in users must grant EXECUTE to `authenticated` explicitly.
alter default privileges in schema themis revoke execute on functions from public;

-- Themis's own migration ledger. Hephaestus owns supabase_migrations.schema_migrations, so a
-- Themis version is recorded HERE, by `npm run db:apply`, never there.
create table if not exists themis.schema_migrations (
  version text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
);

-- RLS on and NO policy: invisible to anon and authenticated even if a grant ever slipped in.
alter table themis.schema_migrations enable row level security;
revoke all on table themis.schema_migrations from anon, authenticated;

-- Shared BEFORE UPDATE trigger function for every `updated_at` column.
-- search_path is pinned empty: now() resolves from pg_catalog, which is always searched.
create or replace function themis.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.updated_at := now();
  return new;
end
$fn$;

-- A trigger function is never called directly. Default privileges are per creating role, so
-- revoke explicitly as well rather than rely on the line above alone.
revoke execute on function themis.touch_updated_at() from public, anon, authenticated;
