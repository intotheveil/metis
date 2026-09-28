-- Themis tenancy: profiles, workspaces, memberships, invites (PLAN P1.4, spec §5a/§6/§7).
--
-- Every object lives in schema `themis` (ADR-0002). `auth.users` is shared with Hephaestus: it is
-- only REFERENCED here, never written, and no trigger is added on it. Idempotent-safe: the gate
-- applies the whole archive twice, so tables use `if not exists`, functions `create or replace`,
-- triggers `create or replace trigger`, and every policy is dropped before it is created.
--
-- Recursion rule (Hephaestus `20260709000008_fix_rls_recursion`): NO policy subqueries
-- `themis.memberships`. Membership is asked only through the SECURITY DEFINER helpers below, which
-- read memberships as the function owner (RLS not applied), so a memberships policy that calls
-- them cannot recurse into itself.
--
-- Writes the client may NOT do directly, by design (they arrive as SECURITY DEFINER RPCs):
--   * creating a workspace + its first owner membership  -> P2.5 bootstrap_me()
--   * creating / accepting / revoking invites            -> P2.6 create_invite(), accept_invite(), …
--   * changing a role or removing a member               -> P2.6 set_member_role(), remove_member()
--     (a direct UPDATE/DELETE on memberships would bypass the last-owner and no-admin-to-owner rules)

-- === tables ======================================================================================

-- Themis's own profile per shared auth user. Hephaestus's profiles table is never touched.
create table if not exists themis.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists themis.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  -- The logo lives in the row, not in Storage (ADR-0002 rule 7): a data URL of a raster image,
  -- <= 100 KB of image, which is <= 140000 characters once base64-encoded with its prefix.
  -- SVG is refused: it can carry script.
  logo_data_url text check (
    logo_data_url is null
    or (
      length(logo_data_url) <= 140000
      and logo_data_url ~ '^data:image/(png|jpeg|webp);base64,'
    )
  ),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists themis.memberships (
  workspace_id uuid not null references themis.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- unique(workspace_id, user_id): one role per user per workspace.
  constraint memberships_pkey primary key (workspace_id, user_id)
);

-- The helpers look memberships up by user; the primary key already covers workspace-first scans.
create index if not exists memberships_user_id_idx on themis.memberships (user_id);

create table if not exists themis.invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references themis.workspaces (id) on delete cascade,
  -- No citext (create extension is off-limits in a shared project): the address is stored
  -- lower-cased and the check refuses anything else, so equality is case-insensitive by storage.
  email text not null check (email = lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  role text not null check (role in ('owner', 'admin', 'editor', 'viewer')),
  -- sha256 of the raw token, hex-encoded; the raw token is never stored (P2.6).
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists invites_workspace_id_idx on themis.invites (workspace_id);

-- === updated_at ==================================================================================

create or replace trigger profiles_touch_updated_at before update on themis.profiles
  for each row execute function themis.touch_updated_at();
create or replace trigger workspaces_touch_updated_at before update on themis.workspaces
  for each row execute function themis.touch_updated_at();
create or replace trigger memberships_touch_updated_at before update on themis.memberships
  for each row execute function themis.touch_updated_at();
create or replace trigger invites_touch_updated_at before update on themis.invites
  for each row execute function themis.touch_updated_at();

-- === recursion-safe membership helpers ===========================================================
-- SECURITY DEFINER: they read memberships as the owner, so RLS on memberships is not re-entered.
-- auth.uid() is evaluated inside the function, so a caller cannot ask about someone else.
-- search_path is pinned empty and every name is qualified.

create or replace function themis.is_member(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from themis.memberships m
     where m.workspace_id = ws
       and m.user_id = auth.uid()
  )
$fn$;

create or replace function themis.has_role(ws uuid, roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from themis.memberships m
     where m.workspace_id = ws
       and m.user_id = auth.uid()
       and m.role = any (roles)
  )
$fn$;

-- For the profiles policy: does the caller share at least one workspace with `other`?
create or replace function themis.shares_workspace(other uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
      from themis.memberships mine
      join themis.memberships theirs on theirs.workspace_id = mine.workspace_id
     where mine.user_id = auth.uid()
       and theirs.user_id = other
  )
$fn$;

revoke execute on function themis.is_member(uuid) from public, anon;
revoke execute on function themis.has_role(uuid, text[]) from public, anon;
revoke execute on function themis.shares_workspace(uuid) from public, anon;
grant execute on function themis.is_member(uuid) to authenticated;
grant execute on function themis.has_role(uuid, text[]) to authenticated;
grant execute on function themis.shares_workspace(uuid) to authenticated;

-- === RLS =========================================================================================

alter table themis.profiles enable row level security;
alter table themis.workspaces enable row level security;
alter table themis.memberships enable row level security;
alter table themis.invites enable row level security;

-- profiles: your own row, or the profile of someone you share a workspace with.
drop policy if exists profiles_select on themis.profiles;
create policy profiles_select on themis.profiles
  for select to authenticated
  using (user_id = auth.uid() or themis.shares_workspace(user_id));

drop policy if exists profiles_insert_self on themis.profiles;
create policy profiles_insert_self on themis.profiles
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists profiles_update_self on themis.profiles;
create policy profiles_update_self on themis.profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- workspaces: members read; owner|admin edit name/logo; only an owner deletes.
drop policy if exists workspaces_select on themis.workspaces;
create policy workspaces_select on themis.workspaces
  for select to authenticated
  using (themis.is_member(id));

drop policy if exists workspaces_update on themis.workspaces;
create policy workspaces_update on themis.workspaces
  for update to authenticated
  using (themis.has_role(id, array['owner', 'admin']))
  with check (themis.has_role(id, array['owner', 'admin']));

drop policy if exists workspaces_delete on themis.workspaces;
create policy workspaces_delete on themis.workspaces
  for delete to authenticated
  using (themis.has_role(id, array['owner']));

-- memberships: members see the member list of their own workspaces. Writes are RPC-only (above).
drop policy if exists memberships_select on themis.memberships;
create policy memberships_select on themis.memberships
  for select to authenticated
  using (themis.is_member(workspace_id));

-- invites: only owner|admin of the workspace see its invites. Writes are RPC-only (above).
drop policy if exists invites_select on themis.invites;
create policy invites_select on themis.invites
  for select to authenticated
  using (themis.has_role(workspace_id, array['owner', 'admin']));

-- === grants ======================================================================================
-- Nothing to anon, nothing to PUBLIC. authenticated gets exactly the verbs its policies admit
-- (column-limited where a policy alone would let an immutable column change); service_role
-- (BYPASSRLS, server-side only) gets full DML for the Edge Functions.

revoke all on table themis.profiles, themis.workspaces, themis.memberships, themis.invites
  from public, anon;

grant select on table themis.profiles, themis.workspaces, themis.memberships, themis.invites
  to authenticated;
grant insert (user_id, display_name) on table themis.profiles to authenticated;
grant update (display_name) on table themis.profiles to authenticated;
grant update (name, logo_data_url) on table themis.workspaces to authenticated;
grant delete on table themis.workspaces to authenticated;

grant select, insert, update, delete
  on table themis.profiles, themis.workspaces, themis.memberships, themis.invites
  to service_role;
