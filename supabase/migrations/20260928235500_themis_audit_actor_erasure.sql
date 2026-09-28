-- Themis audit_log: let the actor FK's ON DELETE SET NULL through the append-only guard.
--
-- BUG fixed (found by the P1.7 tests): `themis.audit_log.actor` references auth.users(id)
-- `on delete set null`, and the SET NULL the foreign key performs is itself an UPDATE of
-- audit_log. The P1.7 BEFORE UPDATE trigger `audit_log_no_update` refused EVERY update, so
-- deleting ANY auth user who is an actor in any audit row failed with `audit_log_append_only`.
-- auth.users is SHARED with Hephaestus (ADR-0002), so this would also have blocked user deletion
-- on Hephaestus's side, and Themis account deletion (spec §7.6).
--
-- The fix replaces the trigger FUNCTION only (same name, same trigger, create or replace, so the
-- P1.7 file stays untouched and this file is idempotent). The one UPDATE it now permits is the
-- erasure of the actor: `actor` goes from non-null to NULL and every other column is unchanged.
-- Everything else still raises `audit_log_append_only`, for every role, the owner included.
--
-- No privilege changes: the foreign-key action runs as the owner of audit_log, not as the role
-- that deleted the auth user, so no role needs (or gets) UPDATE on audit_log. service_role keeps
-- SELECT + INSERT only.

create or replace function themis.audit_log_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.actor is not null
     and new.actor is null
     and (to_jsonb(new) - 'actor') = (to_jsonb(old) - 'actor') then
    return new;
  end if;
  raise exception 'audit_log_append_only' using errcode = '42501';
end;
$$;

revoke execute on function themis.audit_log_append_only() from public, anon, authenticated;
