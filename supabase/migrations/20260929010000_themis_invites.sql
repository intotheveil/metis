-- Themis membership and invite RPCs (PLAN P2.6, spec §5a/§6, ADR-0002, DECISIONS P1.4).
--
-- Every object lives in schema `themis` (ADR-0002). Idempotent-safe: the gate applies the whole
-- archive twice, so every function is `create or replace` and the grants are re-runnable.
--
-- P1.4 keeps memberships and invites SELECT-only for clients: a direct write would bypass the rules
-- below. These five SECURITY DEFINER functions are the ONLY client path that writes them:
--   create_invite(ws, email, role) -> text   the raw token, returned ONCE (only its sha256 is stored)
--   accept_invite(token)           -> uuid   the workspace id
--   revoke_invite(invite_id)       -> void
--   set_member_role(ws, member_id, role) -> void
--   remove_member(ws, member_id)   -> void
-- All are `search_path = ''` with fully-qualified names, and the caller is ONLY ever auth.uid():
-- no function takes the acting user as an argument.
--
-- Role rules (DECISIONS P1.4):
--   * only owner|admin create/revoke invites and change/remove members;
--   * an admin cannot invite as owner, promote anyone to owner (itself included), or change or
--     remove an owner; only an owner can grant, revoke or change the owner role;
--   * the LAST owner of a workspace can be neither demoted nor removed.
--
-- Invites: the raw token is 64 lower-hex chars (two gen_random_uuid(), 244 random bits). The row
-- stores encode(sha256(token), 'hex') in token_hash (P1.4's 64-hex check) and expires 7 days after
-- creation. accept_invite requires that the invite is unexpired and unaccepted, that the caller's
-- auth.users.email equals the invite email and is CONFIRMED (email_confirmed_at; in the shared
-- project an unconfirmed sign-up would otherwise let anyone who registers the invitee's address take
-- the invite), and that whoever created it still holds the authority to create it.
--
-- Serialisation: every membership mutation takes a transaction-scoped advisory lock in the TWO-int4
-- keyspace, class hashtext('themis.memberships'), key hashtext(workspace id). Two concurrent demotions
-- of the only two owners therefore run one after the other, and the second sees one owner left.
-- The two-key space never collides with another app's bigint advisory locks in the shared project.
--
-- Audit: none here. PLAN P4.2 writes audit_log for membership role changes by TRIGGER, which will
-- also cover these RPCs; writing rows here too would double them (DECISIONS P2.6).
--
-- EXECUTE: Postgres grants every new function to PUBLIC and the bootstrap's schema default revoke is
-- a no-op (DECISIONS B2), so each function revokes EXECUTE from public, anon and service_role and
-- grants it to authenticated only (service_role has no auth.uid(), so it would only ever fail).
--
-- Errors (SQLSTATE, message prefix): 28000 not_authenticated · 42501 not_authorized,
-- invite_email_mismatch, email_not_verified · 22023 invalid_argument · P0002 invite_invalid,
-- invite_not_found, member_not_found · 55000 invite_used, invite_expired, last_owner ·
-- 23505 already_member.

-- === create_invite(ws, email, role) ==============================================================

create or replace function themis.create_invite(ws uuid, email text, role text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  me uuid := auth.uid();
  my_role text;
  addr text := pg_catalog.lower(pg_catalog.btrim(create_invite.email));
  tok text;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select m.role
    into my_role
    from themis.memberships m
   where m.workspace_id = create_invite.ws
     and m.user_id = me;
  if my_role is null or my_role not in ('owner', 'admin') then
    raise exception 'not_authorized: owner or admin of the workspace required' using errcode = '42501';
  end if;

  if create_invite.role is null or create_invite.role not in ('owner', 'admin', 'editor', 'viewer') then
    raise exception 'invalid_argument: role must be owner, admin, editor or viewer' using errcode = '22023';
  end if;
  if create_invite.role = 'owner' and my_role <> 'owner' then
    raise exception 'not_authorized: only an owner can invite an owner' using errcode = '42501';
  end if;
  if addr is null or pg_catalog.char_length(addr) > 320 or addr !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'invalid_argument: email is not an address' using errcode = '22023';
  end if;

  tok := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
      || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');

  insert into themis.invites (workspace_id, email, role, token_hash, expires_at, created_by)
  values (
    create_invite.ws,
    addr,
    create_invite.role,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(tok, 'UTF8')), 'hex'),
    pg_catalog.now() + interval '7 days',
    me
  );

  -- The only time the raw token exists outside the inviter's hands: it is not stored anywhere.
  return tok;
end;
$fn$;

-- === accept_invite(token) ========================================================================

create or replace function themis.accept_invite(token text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  me uuid := auth.uid();
  inv record;
  my_email text;
  confirmed timestamptz;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if accept_invite.token is null or accept_invite.token !~ '^[0-9a-f]{64}$' then
    raise exception 'invite_invalid: unknown invite' using errcode = 'P0002';
  end if;

  select i.id, i.workspace_id, i.email, i.role, i.expires_at, i.accepted_at, i.created_by
    into inv
    from themis.invites i
   where i.token_hash
       = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(accept_invite.token, 'UTF8')), 'hex')
     for update;
  if not found then
    raise exception 'invite_invalid: unknown invite' using errcode = 'P0002';
  end if;

  -- The invite binds to ONE address: the caller's own, confirmed.
  select pg_catalog.lower(u.email), u.email_confirmed_at
    into my_email, confirmed
    from auth.users u
   where u.id = me;
  if my_email is distinct from inv.email then
    raise exception 'invite_email_mismatch: this invite is for another email address'
      using errcode = '42501';
  end if;
  if confirmed is null then
    raise exception 'email_not_verified: confirm your email address first' using errcode = '42501';
  end if;

  if inv.accepted_at is not null then
    raise exception 'invite_used: this invite was already accepted' using errcode = '55000';
  end if;
  if inv.expires_at <= pg_catalog.now() then
    raise exception 'invite_expired: this invite has expired' using errcode = '55000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('themis.memberships'),
    pg_catalog.hashtext(inv.workspace_id::text)
  );

  -- The inviter must still hold the authority the invite grants (an owner invite needs an owner).
  if inv.created_by is null or not exists (
    select 1
      from themis.memberships m
     where m.workspace_id = inv.workspace_id
       and m.user_id = inv.created_by
       and m.role = any (case when inv.role = 'owner' then array['owner'] else array['owner', 'admin'] end)
  ) then
    raise exception 'invite_invalid: the inviter no longer manages this workspace' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from themis.memberships m where m.workspace_id = inv.workspace_id and m.user_id = me
  ) then
    raise exception 'already_member: you are already a member of this workspace' using errcode = '23505';
  end if;

  insert into themis.memberships (workspace_id, user_id, role)
  values (inv.workspace_id, me, inv.role);
  update themis.invites i set accepted_at = pg_catalog.now() where i.id = inv.id;

  return inv.workspace_id;
end;
$fn$;

-- === revoke_invite(invite_id) ====================================================================
-- Deletes a PENDING invite (the table has no revoked state; an accepted one stays as history).
-- "Unknown" and "not yours" give the same error, so an id cannot be probed across workspaces.

create or replace function themis.revoke_invite(invite_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  me uuid := auth.uid();
  inv record;
  my_role text;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select i.id, i.workspace_id, i.role
    into inv
    from themis.invites i
   where i.id = revoke_invite.invite_id;
  if found then
    select m.role
      into my_role
      from themis.memberships m
     where m.workspace_id = inv.workspace_id
       and m.user_id = me;
  end if;
  if not found or my_role is null or my_role not in ('owner', 'admin') then
    raise exception 'invite_not_found: no such invite in a workspace you manage' using errcode = 'P0002';
  end if;
  if inv.role = 'owner' and my_role <> 'owner' then
    raise exception 'not_authorized: only an owner can revoke an owner invite' using errcode = '42501';
  end if;

  delete from themis.invites i where i.id = inv.id and i.accepted_at is null;
  if not found then
    raise exception 'invite_used: this invite was already accepted' using errcode = '55000';
  end if;
end;
$fn$;

-- === set_member_role(ws, member_id, role) ========================================================

create or replace function themis.set_member_role(ws uuid, member_id uuid, role text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  me uuid := auth.uid();
  my_role text;
  their_role text;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if set_member_role.role is null
     or set_member_role.role not in ('owner', 'admin', 'editor', 'viewer') then
    raise exception 'invalid_argument: role must be owner, admin, editor or viewer' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('themis.memberships'),
    pg_catalog.hashtext(coalesce(set_member_role.ws::text, ''))
  );

  -- Read under the lock, so a concurrent demotion of the caller is already visible.
  select m.role
    into my_role
    from themis.memberships m
   where m.workspace_id = set_member_role.ws
     and m.user_id = me;
  if my_role is null or my_role not in ('owner', 'admin') then
    raise exception 'not_authorized: owner or admin of the workspace required' using errcode = '42501';
  end if;

  select m.role
    into their_role
    from themis.memberships m
   where m.workspace_id = set_member_role.ws
     and m.user_id = set_member_role.member_id;
  if their_role is null then
    raise exception 'member_not_found: not a member of this workspace' using errcode = 'P0002';
  end if;

  if my_role <> 'owner' and (set_member_role.role = 'owner' or their_role = 'owner') then
    raise exception 'not_authorized: only an owner can grant or change the owner role'
      using errcode = '42501';
  end if;
  if their_role = set_member_role.role then
    return;
  end if;
  if their_role = 'owner' and (
    select pg_catalog.count(*)
      from themis.memberships m
     where m.workspace_id = set_member_role.ws
       and m.role = 'owner'
  ) <= 1 then
    raise exception 'last_owner: a workspace keeps at least one owner' using errcode = '55000';
  end if;

  update themis.memberships m
     set role = set_member_role.role
   where m.workspace_id = set_member_role.ws
     and m.user_id = set_member_role.member_id;
end;
$fn$;

-- === remove_member(ws, member_id) ================================================================
-- An owner|admin removes a member (itself included, subject to the rules). An admin cannot remove
-- an owner, and nobody removes the last owner.

create or replace function themis.remove_member(ws uuid, member_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  me uuid := auth.uid();
  my_role text;
  their_role text;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('themis.memberships'),
    pg_catalog.hashtext(coalesce(remove_member.ws::text, ''))
  );

  select m.role
    into my_role
    from themis.memberships m
   where m.workspace_id = remove_member.ws
     and m.user_id = me;
  if my_role is null or my_role not in ('owner', 'admin') then
    raise exception 'not_authorized: owner or admin of the workspace required' using errcode = '42501';
  end if;

  select m.role
    into their_role
    from themis.memberships m
   where m.workspace_id = remove_member.ws
     and m.user_id = remove_member.member_id;
  if their_role is null then
    raise exception 'member_not_found: not a member of this workspace' using errcode = 'P0002';
  end if;

  if their_role = 'owner' and my_role <> 'owner' then
    raise exception 'not_authorized: only an owner can remove an owner' using errcode = '42501';
  end if;
  if their_role = 'owner' and (
    select pg_catalog.count(*)
      from themis.memberships m
     where m.workspace_id = remove_member.ws
       and m.role = 'owner'
  ) <= 1 then
    raise exception 'last_owner: a workspace keeps at least one owner' using errcode = '55000';
  end if;

  delete from themis.memberships m
   where m.workspace_id = remove_member.ws
     and m.user_id = remove_member.member_id;
end;
$fn$;

-- === EXECUTE: authenticated only =================================================================

revoke execute on function themis.create_invite(uuid, text, text) from public, anon, service_role;
revoke execute on function themis.accept_invite(text) from public, anon, service_role;
revoke execute on function themis.revoke_invite(uuid) from public, anon, service_role;
revoke execute on function themis.set_member_role(uuid, uuid, text) from public, anon, service_role;
revoke execute on function themis.remove_member(uuid, uuid) from public, anon, service_role;
grant execute on function themis.create_invite(uuid, text, text) to authenticated;
grant execute on function themis.accept_invite(text) to authenticated;
grant execute on function themis.revoke_invite(uuid) to authenticated;
grant execute on function themis.set_member_role(uuid, uuid, text) to authenticated;
grant execute on function themis.remove_member(uuid, uuid) to authenticated;
