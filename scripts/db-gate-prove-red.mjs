// PROVE THE GATE RED — `npm run db:gate:prove-red` (PLAN.md P1.9)
//
// A gate nobody has ever seen fail is not a gate. This script sabotages a COPY of the migration
// archive in many known-bad ways, one sabotage per run, runs `scripts/db-gate.mjs` against each copy
// (DB_GATE_MIGRATIONS), and asserts that the gate:
//   (1) exits 1, and
//   (2) prints the EXPECTED `FAIL` line(s) for that sabotage, so a failure for the wrong reason
//       (a crash, an unrelated check) does not count as proof.
// A CONTROL run on the untouched copy must exit 0 with `GATE PASSED`, which proves the harness itself
// does not turn everything red.
//
// Every sabotage is appended as ONE new migration file (sorted last), so it runs on the real archive
// state, twice (the gate re-applies the archive for idempotency). Sabotage SQL is therefore written
// idempotently wherever the point is not the idempotency itself. The committed archive in
// `supabase/migrations/` is only READ. Copies live under os.tmpdir() and this script removes them.
//
// Exit 0 only if the control is green AND every sabotage went red on its expected line.
//
// Usage: node scripts/db-gate-prove-red.mjs [--jobs N] [--only id,id,...]
//   --jobs  parallel gate runs (default: min(8, available cores); env PROVE_RED_JOBS)
//   --only  run just these sabotage ids (plus the control), for debugging one sabotage

import { spawn } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ARCHIVE = fileURLToPath(new URL('../supabase/migrations', import.meta.url))
const GATE = fileURLToPath(new URL('./db-gate.mjs', import.meta.url))
// Sorts after every real migration and matches the guard's filename rule.
const SABOTAGE_FILE = '29991231235959_themis_zz_sabotage.sql'
const RUN_TIMEOUT_MS = 300_000
// The lines by which the gate (and the static guard it runs first) reports red.
const RED_LINE = /^(FAIL|GATE FAILED|APPLY FAILED|MIGRATION GUARD FAILED)/

/**
 * One sabotage: SQL appended to a copy of the archive, and the FAIL line(s) it must produce.
 * Each `expect` item must match at least one of the gate's RED lines (`RED_LINE`: a `FAIL  …` check
 * line, or the `GATE FAILED` / `APPLY FAILED` / `MIGRATION GUARD FAILED` verdict; a string is a substring
 * match, a RegExp is tested against the whole line). `plan` names the PLAN.md item it covers
 * (a letter = P1.9 a–f). The P1.8 BUILD_LOG list (mutations 01–28) is the source of most of the P1
 * ones; the P2.7 ones re-create a real RPC body with one check removed (`mutateRpc`).
 * @typedef {{ id: string, plan?: string, what: string, sql: string, expect: (string | RegExp)[] }} Sabotage
 */

/**
 * The `create or replace function themis.<name>(…) … $fn$;` statement of a client RPC, read from the
 * committed archive (LF-normalised), with `from` replaced by `to`. A P2.7 sabotage is the REAL body
 * with ONE check removed, re-created after the archive (create or replace keeps the grants), so it
 * cannot drift from the migration. `from` must occur exactly once in that body; otherwise prove-red
 * stops at startup (exit 2), so an edited migration cannot turn a sabotage into a silent no-op.
 * @param {string} file  a migration file name in the archive
 * @param {string} name  the function name in schema themis
 * @param {string} from
 * @param {string} to
 */
const mutateRpc = (file, name, from, to) => {
  const text = readFileSync(path.join(ARCHIVE, file), 'utf8').replace(/\r\n/g, '\n')
  const start = text.indexOf(`create or replace function themis.${name}(`)
  const end = start < 0 ? -1 : text.indexOf('\n$fn$;', start)
  if (start < 0 || end < 0) {
    console.log(
      `prove-red: cannot build the sabotages — mutateRpc: themis.${name} not found in ${file}`,
    )
    process.exit(2)
  }
  const body = text.slice(start, end + '\n$fn$;'.length)
  const hits = body.split(from).length - 1
  if (hits !== 1) {
    console.log(
      `prove-red: cannot build the sabotages — mutateRpc: ${JSON.stringify(from)} occurs ${hits}× in themis.${name} (need 1)`,
    )
    process.exit(2)
  }
  return body.replace(from, () => to)
}
const ONBOARDING = '20260929000000_themis_onboarding.sql'
const INVITES = '20260929010000_themis_invites.sql'

/** @type {Sabotage[]} */
const SABOTAGES = [
  // --- PLAN.md P1.9 (a)–(f) ------------------------------------------------------------------
  {
    id: 'decisions-select-true',
    plan: 'a',
    what: 'a SELECT policy using (true) on themis.decisions (TO public)',
    sql: `drop policy if exists decisions_leak on themis.decisions;
create policy decisions_leak on themis.decisions for select using (true);`,
    expect: [
      'themis.decisions: UB reads ZERO rows of A',
      /every themis policy is TO authenticated .* — decisions\.decisions_leak/,
      /every workspace-scoped policy asks through themis\.is_member\/has_role — .*decisions\.decisions_leak/,
    ],
  },
  {
    id: 'scores-rls-disabled',
    plan: 'b',
    what: 'alter table themis.scores disable row level security',
    sql: `alter table themis.scores disable row level security;`,
    expect: [
      /RLS is enabled on every themis table \(\d+\) — scores$/,
      'themis.scores: UB reads ZERO rows of A',
    ],
  },
  {
    id: 'table-without-leak-entry',
    plan: 'c',
    what: 'a new table themis.leaky(id int) with no RLS, no policy and no leak-matrix entry',
    sql: `create table if not exists themis.leaky (id int);`,
    expect: [/NO ENTRY: leaky — /, /RLS is enabled on every themis table \(\d+\) — leaky$/],
  },
  {
    id: 'public-table',
    plan: 'd',
    what: 'create table public.x (the static guard catches it first; nothing is applied)',
    sql: `create table if not exists public.x (id int);`,
    expect: [
      `${SABOTAGE_FILE}:1  [forbidden-schema]`,
      'GATE FAILED — the static migration guard is red',
    ],
  },
  {
    id: 'auth-users-trigger',
    plan: 'e',
    what: 'create trigger … on auth.users (the static guard catches it first)',
    sql: `create trigger themis_leak_trg after insert on auth.users
  for each row execute function themis.touch_updated_at();`,
    expect: ['[auth-users-trigger]', 'GATE FAILED — the static migration guard is red'],
  },
  {
    id: 'scores-composite-fk-dropped',
    plan: 'f',
    what: 'drop the composite FK scores (decision_id, workspace_id) → decisions',
    sql: `alter table themis.scores drop constraint if exists scores_decision_fkey;`,
    expect: ["themis.scores: UB's child row (workspace B) pointing at A's parent is refused"],
  },

  // --- the P1.8 mutation list (BUILD_LOG.md P1.8) ------------------------------------------------
  {
    id: 'table-rls-policy-no-entry',
    what: 'a well-formed table (RLS + helper policy) that has no leak-matrix entry: coverage only',
    sql: `create table if not exists themis.leaky_rls (
  id int primary key,
  workspace_id uuid not null references themis.workspaces (id) on delete cascade
);
alter table themis.leaky_rls enable row level security;
drop policy if exists leaky_rls_select on themis.leaky_rls;
create policy leaky_rls_select on themis.leaky_rls for select to authenticated
  using (themis.is_member(workspace_id));`,
    expect: [/NO ENTRY: leaky_rls — /],
  },
  {
    id: 'update-policy-to-public',
    what: 'an UPDATE policy on themis.options with no TO clause (PUBLIC)',
    sql: `drop policy if exists options_leak on themis.options;
create policy options_leak on themis.options for update
  using (themis.is_member(workspace_id)) with check (true);`,
    expect: [
      /no write policy admits anon or PUBLIC — .*options\.options_leak/,
      "themis.options: A's viewer cannot write A's data",
    ],
  },
  {
    id: 'definer-no-search-path',
    what: 'a SECURITY DEFINER function with no search_path and default EXECUTE',
    sql: `create or replace function themis.leak_fn() returns int
language sql security definer as $fn$ select 1 $fn$;`,
    expect: [
      /search_path is pinned on every themis function \(\d+\) — .*themis\.leak_fn\(\)/,
      /anon has EXECUTE on no themis function — .*themis\.leak_fn\(\)/,
      /PUBLIC has EXECUTE on no themis function — .*themis\.leak_fn\(\)/,
    ],
  },
  {
    id: 'definer-search-path-public',
    what: 'a SECURITY DEFINER function with search_path = public (static guard)',
    sql: `create or replace function themis.leak_fn() returns int
language sql security definer set search_path = public as $fn$ select 1 $fn$;
revoke execute on function themis.leak_fn() from public, anon;`,
    expect: ['[forbidden-schema]  search_path includes public'],
  },
  {
    id: 'definer-search-path-pg-temp',
    what: 'a SECURITY DEFINER function with search_path = pg_temp, themis',
    sql: `create or replace function themis.leak_fn() returns int
language sql security definer set search_path = pg_temp, themis as $fn$ select 1 $fn$;
revoke execute on function themis.leak_fn() from public, anon;`,
    expect: [
      /no SECURITY DEFINER function has public\/\$user\/pg_temp on its search_path — .*themis\.leak_fn\(\)/,
    ],
  },
  {
    id: 'execute-to-public',
    what: 'grant execute on themis.has_role to public',
    sql: `grant execute on function themis.has_role(uuid, text[]) to public;`,
    expect: [
      /PUBLIC has EXECUTE on no themis function — .*themis\.has_role\(uuid,text\[\]\)/,
      /anon has EXECUTE on no themis function — .*themis\.has_role/,
    ],
  },
  {
    id: 'execute-to-anon',
    what: 'grant execute on themis.is_member to anon',
    sql: `grant execute on function themis.is_member(uuid) to anon;`,
    expect: [/anon has EXECUTE on no themis function — .*themis\.is_member\(uuid\)/],
  },
  {
    id: 'anon-select-grant',
    what: 'grant select on themis.decisions to anon',
    sql: `grant select on table themis.decisions to anon;`,
    expect: [
      /anon holds exactly SELECT on themis\.plans and no other themis privilege — .*decisions\.SELECT/,
    ],
  },
  {
    id: 'policy-reads-memberships',
    what: 'a policy with an inline memberships subquery (the recursion rule)',
    sql: `drop policy if exists options_select2 on themis.options;
create policy options_select2 on themis.options for select to authenticated
  using (exists (select 1 from themis.memberships m
                  where m.workspace_id = options.workspace_id and m.user_id = auth.uid()));`,
    expect: [
      /no policy expression references memberships directly \(recursion rule\) — .*options\.options_select2/,
    ],
  },
  {
    id: 'enum-mismatch',
    what: "the methodology CHECK admits 'kanban', which decision.ts does not know",
    sql: `alter table themis.decisions drop constraint if exists decisions_methodology_check;
alter table themis.decisions add constraint decisions_methodology_check
  check (methodology in ('waterfall', 'agile', 'yolo', 'kanban'));`,
    expect: [/decisions\.methodology CHECK admits exactly the decision\.ts values — db .*kanban/],
  },
  {
    id: 'fk-not-valid-orphans',
    what: 'a NOT VALID FK plans.ws → workspaces over dangling values',
    sql: `alter table themis.plans add column if not exists ws uuid
  default '00000000-0000-4000-8000-00000000dead';
do $do$ begin
  alter table themis.plans add constraint plans_orphan_fk
    foreign key (ws) references themis.workspaces (id) not valid;
exception when duplicate_object then null;
end $do$;`,
    expect: [
      /every themis foreign key is validated \(convalidated\) — .*plans_orphan_fk/,
      /orphan scan: .* — .*plans_orphan_fk: \d+/,
    ],
  },
  {
    id: 'helper-returns-true',
    what: 'themis.is_member() returns true (structurally perfect, functionally open)',
    sql: `create or replace function themis.is_member(ws uuid)
returns boolean language sql stable security definer set search_path = ''
as $fn$ select ws is not null $fn$;`,
    expect: [
      'themis.workspaces: UB reads ZERO rows of A',
      'themis.decisions: UB reads ZERO rows of A',
      "themis.comments: UB's INSERT of a row of A is refused",
    ],
  },
  {
    id: 'locked-down-update-grant',
    what: 'revoke the decisions UPDATE column grant (a locked schema must fail the positive path)',
    sql: `revoke update (question, methodology, scale) on table themis.decisions from authenticated;`,
    expect: ["themis.decisions: UA writes A's data (takes effect)"],
  },
  {
    id: 'client-grant-on-server-table',
    what: 'grant insert on the server-written themis.usage_monthly to authenticated',
    sql: `grant insert on table themis.usage_monthly to authenticated;`,
    expect: [
      /themis\.usage_monthly: server-written — authenticated holds no write privilege — .*INSERT/,
    ],
  },
  {
    id: 'view-owner-rights',
    what: 'a themis view without security_invoker (reads around RLS)',
    sql: `create or replace view themis.v_decisions as select id, workspace_id from themis.decisions;`,
    expect: [/no themis view bypasses RLS .* — .*v_decisions/],
  },
  {
    id: 'public-function-evading-guard',
    what: 'a public function created by format() with a concatenated schema name (guard-blind)',
    sql: `do $do$ begin
  execute format('create or replace function %I.themis_fn() returns int language sql as %L',
                 'pub' || 'lic', 'select 1');
end $do$;`,
    expect: [/zero objects in public\/auth\/supabase_migrations changed .* — changed: .*functions/],
  },
  {
    id: 'auth-users-trigger-evading-guard',
    what: 'a trigger on auth.users built from concatenated strings in EXECUTE (guard-blind)',
    sql: `create or replace function themis.leak_trg_fn() returns trigger
language plpgsql security definer set search_path = '' as $fn$ begin return new; end $fn$;
revoke execute on function themis.leak_trg_fn() from public, anon;
do $do$ begin
  if not exists (select 1 from pg_trigger where tgname = 'themis_leak_trg') then
    execute 'create trigger themis_leak_trg before update on au' || 'th.users '
         || 'for each row execute function themis.leak_trg_fn()';
  end if;
end $do$;`,
    expect: [
      /no trigger on auth\.users — .*themis_leak_trg/,
      /zero objects in public\/auth\/supabase_migrations changed .* — changed: .*triggers/,
    ],
  },
  {
    // B4 widened the guard to allow a READ `from auth.users`. This proves the widening did not
    // open writes: an UPDATE of auth.users inside a definer function body (never run by the gate,
    // so only the static guard can see it) must still stop the gate at the guard.
    id: 'auth-users-write-in-function',
    what: 'a definer function that reads auth.users (allowed) AND updates it (the guard must stay red)',
    sql: `create or replace function themis.leak_email(new_email text) returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  perform 1 from auth.users u where u.id = auth.uid();
  update auth.users set email = new_email where id = auth.uid();
end $fn$;
revoke execute on function themis.leak_email(text) from public, anon;`,
    expect: [
      `${SABOTAGE_FILE}:5  [forbidden-schema]  reference to auth.users`,
      'GATE FAILED — the static migration guard is red',
    ],
  },
  {
    id: 'anon-insert-plans',
    what: 'grant insert on themis.plans to anon',
    sql: `grant insert on table themis.plans to anon;`,
    expect: [
      /themis\.plans: no client role holds a write privilege — .*anon:INSERT/,
      /anon holds exactly SELECT on themis\.plans and no other themis privilege — .*plans\.INSERT/,
    ],
  },
  {
    id: 'service-only-grant',
    what: 'grant select on themis.schema_migrations to authenticated',
    sql: `grant select on table themis.schema_migrations to authenticated;`,
    expect: [
      /service-only themis\.schema_migrations grants nothing to anon\/authenticated — .*authenticated:SELECT/,
      'authenticated holds no privilege on themis.schema_migrations',
    ],
  },
  {
    id: 'update-policy-true',
    what: 'an UPDATE policy using (true) on themis.decisions TO authenticated',
    sql: `drop policy if exists decisions_upd_leak on themis.decisions;
create policy decisions_upd_leak on themis.decisions for update to authenticated
  using (true) with check (true);`,
    expect: [
      "themis.decisions: A's viewer cannot write A's data",
      /every workspace-scoped policy asks through themis\.is_member\/has_role — .*decisions\.decisions_upd_leak/,
    ],
  },
  {
    id: 'anon-read-policy',
    what: 'a SELECT policy TO anon plus the SELECT grant on themis.decisions',
    sql: `drop policy if exists decisions_anon on themis.decisions;
create policy decisions_anon on themis.decisions for select to anon using (true);
grant select on table themis.decisions to anon;`,
    expect: [
      /anon reads nothing in themis\.decisions — \d+ rows/,
      /every themis policy is TO authenticated .* — .*decisions\.decisions_anon/,
    ],
  },
  {
    id: 'delete-policy-true',
    what: 'a DELETE policy using (true) on themis.risks TO authenticated',
    sql: `drop policy if exists risks_del_leak on themis.risks;
create policy risks_del_leak on themis.risks for delete to authenticated using (true);`,
    expect: [
      "themis.risks: A's viewer cannot write A's data",
      /every workspace-scoped policy asks through themis\.is_member\/has_role — .*risks\.risks_del_leak/,
    ],
  },
  {
    id: 'audit-log-readable-by-viewer',
    what: 'audit_log readable by any member (it is admin|owner only)',
    sql: `drop policy if exists audit_log_member_select on themis.audit_log;
create policy audit_log_member_select on themis.audit_log for select to authenticated
  using (themis.is_member(workspace_id));`,
    expect: ["themis.audit_log: A's viewer reads none of A's rows (role-gated)"],
  },
  {
    id: 'table-dropped-stale-entry',
    what: 'themis.ai_runs dropped after the archive (its leak-matrix entry goes stale)',
    sql: `drop table if exists themis.ai_runs cascade;`,
    expect: [/every leak-matrix entry names an existing themis table — .*ai_runs/],
  },
  {
    id: 'select-update-delete-true',
    what: 'SELECT, UPDATE and DELETE policies using (true) on themis.risks',
    sql: `drop policy if exists risks_sel_leak on themis.risks;
drop policy if exists risks_upd_leak on themis.risks;
drop policy if exists risks_del_leak on themis.risks;
create policy risks_sel_leak on themis.risks for select to authenticated using (true);
create policy risks_upd_leak on themis.risks for update to authenticated using (true) with check (true);
create policy risks_del_leak on themis.risks for delete to authenticated using (true);`,
    expect: [
      'themis.risks: UB reads ZERO rows of A',
      "themis.risks: UB's UPDATE of A's rows has no effect",
      "themis.risks: UB's DELETE of A's rows has no effect",
    ],
  },
  {
    id: 'select-locked-out',
    what: 'options_select replaced by a helper policy that admits nobody (the positive path)',
    sql: `drop policy if exists options_select on themis.options;
create policy options_select on themis.options for select to authenticated
  using (themis.is_member(workspace_id) and false);`,
    expect: [
      "themis.options: UB reads all of B's own rows (not locked out)",
      "themis.options: UA reads all of A's rows",
      "themis.options: A's viewer reads all of A's rows",
    ],
  },

  // --- the P1.2 gate contract: fresh-DB apply and idempotency -----------------------------------
  {
    id: 'not-idempotent',
    what: 'a CREATE TABLE without IF NOT EXISTS (fails on the second apply)',
    sql: `create table themis.twice (id int);`,
    expect: [`re-apply ${SABOTAGE_FILE} (idempotent-safe)`],
  },
  {
    id: 'apply-error',
    what: 'a migration that errors on a fresh DB',
    sql: `alter table themis.no_such_table add column x int;`,
    expect: [`apply ${SABOTAGE_FILE}`, 'APPLY FAILED'],
  },

  // --- P2.7: the client RPCs (P2.5 onboarding, P2.6 invites and membership) ----------------------
  // Catalogue kind: definer / search_path / EXECUTE per RPC, and the functional anon/service refusal.
  {
    id: 'rpc-execute-service-role',
    what: 'grant execute on import_local_decision to service_role',
    sql: `grant execute on function themis.import_local_decision(uuid, jsonb) to service_role;`,
    expect: [
      /^FAIL {2}themis\.import_local_decision\(uuid,jsonb\): SECURITY DEFINER, search_path='', EXECUTE for authenticated only/,
      /^FAIL {2}service_role cannot EXECUTE import_local_decision/,
    ],
  },
  {
    id: 'rpc-execute-anon',
    what: 'grant execute on accept_invite to anon',
    sql: `grant execute on function themis.accept_invite(text) to anon;`,
    expect: [
      /^FAIL {2}themis\.accept_invite\(text\): SECURITY DEFINER/,
      /^FAIL {2}anon cannot EXECUTE accept_invite/,
    ],
  },
  {
    id: 'rpc-security-invoker',
    what: 'bootstrap_me() switched to SECURITY INVOKER',
    sql: `alter function themis.bootstrap_me() security invoker;`,
    expect: [
      /^FAIL {2}themis\.bootstrap_me\(\): SECURITY DEFINER/,
      /^FAIL {2}bootstrap_me: a fresh user gets a personal workspace/,
    ],
  },
  // bootstrap_me: idempotency.
  {
    id: 'bootstrap-not-idempotent',
    what: 'bootstrap_me creates a new workspace on every call (the lookup of the personal one ignored)',
    sql: mutateRpc(ONBOARDING, 'bootstrap_me', 'if ws is null then', 'if true then'),
    expect: [
      /^FAIL {2}bootstrap_me: called twice → the same workspace, one profile, one new workspace/,
      /^FAIL {2}bootstrap_me: an existing owner \(A's\) gets A back/,
    ],
  },
  // import_local_decision: dedupe, atomicity, authorization.
  {
    id: 'import-no-dedupe',
    what: 'import_local_decision never returns the earlier import (no dedupe by client_import_id)',
    sql: mutateRpc(ONBOARDING, 'import_local_decision', 'if dec is not null then', 'if false then'),
    expect: [
      /^FAIL {2}import_local_decision: the same client_import_id twice → one decision/,
      /^FAIL {2}import_local_decision: a minimal payload .* upper-case key dedupes/,
    ],
  },
  {
    id: 'import-not-atomic',
    what: 'import_local_decision returns (keeping its partial writes) on an out-of-range score',
    sql: mutateRpc(
      ONBOARDING,
      'import_local_decision',
      `raise exception 'invalid_payload: a score must be an integer 1..5' using errcode = '22023';`,
      'return dec;',
    ),
    expect: [
      /^FAIL {2}import_local_decision refuses: score 6/,
      /^FAIL {2}import_local_decision: the refused payloads left 0 residue/,
    ],
  },
  {
    id: 'import-no-role-check',
    what: 'import_local_decision without the editor|admin|owner check (any signed-in user, any workspace)',
    sql: mutateRpc(
      ONBOARDING,
      'import_local_decision',
      `if ws is null or not themis.has_role(ws, array['owner', 'admin', 'editor']) then`,
      'if ws is null then',
    ),
    expect: [
      /^FAIL {2}import_local_decision: UA into B → not_authorized, B unchanged/,
      /^FAIL {2}import_local_decision: A's viewer, a non-member and a null\/unknown workspace are refused/,
    ],
  },
  // create_invite: token storage and who may invite.
  {
    id: 'invite-stores-raw-token',
    what: 'create_invite stores the raw token in token_hash instead of its sha256',
    sql: mutateRpc(
      INVITES,
      'create_invite',
      `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(tok, 'UTF8')), 'hex'),`,
      'tok,',
    ),
    expect: [/^FAIL {2}create_invite: the row stores only sha256\(token\) hex/],
  },
  {
    id: 'invite-by-editor',
    what: 'create_invite lets an editor invite',
    sql: mutateRpc(
      INVITES,
      'create_invite',
      `if my_role is null or my_role not in ('owner', 'admin') then`,
      `if my_role is null or my_role not in ('owner', 'admin', 'editor') then`,
    ),
    expect: [/^FAIL {2}create_invite: an editor, a viewer, B's owner and a non-member are refused/],
  },
  {
    id: 'invite-owner-by-admin',
    what: 'create_invite lets an admin invite an owner',
    sql: mutateRpc(
      INVITES,
      'create_invite',
      `if create_invite.role = 'owner' and my_role <> 'owner' then`,
      'if false then',
    ),
    expect: [/^FAIL {2}create_invite: an admin cannot invite an owner/],
  },
  // accept_invite: every refusal the invite depends on.
  {
    id: 'accept-no-email-check',
    plan: 'P2.7',
    what: 'accept_invite without the email check (anyone holding the token joins)',
    sql: mutateRpc(
      INVITES,
      'accept_invite',
      'if my_email is distinct from inv.email then',
      'if false then',
    ),
    expect: [/^FAIL {2}accept_invite: a user with the WRONG email → invite_email_mismatch/],
  },
  {
    id: 'accept-no-confirmed-check',
    what: 'accept_invite without the email_confirmed_at check',
    sql: mutateRpc(INVITES, 'accept_invite', 'if confirmed is null then', 'if false then'),
    expect: [/^FAIL {2}accept_invite: an UNCONFIRMED email \(email_confirmed_at null\)/],
  },
  {
    id: 'accept-no-expiry-check',
    what: 'accept_invite without the expiry check',
    sql: mutateRpc(
      INVITES,
      'accept_invite',
      'if inv.expires_at <= pg_catalog.now() then',
      'if false then',
    ),
    expect: [/^FAIL {2}accept_invite: an EXPIRED invite → invite_expired/],
  },
  {
    id: 'accept-no-used-check',
    what: 'accept_invite without the accepted_at check (an invite works more than once)',
    sql: mutateRpc(
      INVITES,
      'accept_invite',
      'if inv.accepted_at is not null then',
      'if false then',
    ),
    expect: [
      /^FAIL {2}accept_invite: a REUSED invite → invite_used/,
      /^FAIL {2}accept_invite: a used invite cannot re-admit a member removed since/,
    ],
  },
  {
    id: 'accept-no-inviter-recheck',
    what: "accept_invite without the re-check of the inviter's current authority",
    sql: mutateRpc(
      INVITES,
      'accept_invite',
      'if inv.created_by is null or not exists (',
      'if false and exists (',
    ),
    expect: [
      /^FAIL {2}accept_invite: the inviter demoted since → invite_invalid/,
      /^FAIL {2}accept_invite: an owner invite whose inviter is now only admin/,
    ],
  },
  // revoke_invite: who may revoke.
  {
    id: 'revoke-no-authz',
    what: 'revoke_invite without the owner|admin-of-that-workspace check',
    sql: mutateRpc(
      INVITES,
      'revoke_invite',
      `if not found or my_role is null or my_role not in ('owner', 'admin') then`,
      'if false then',
    ),
    expect: [/^FAIL {2}revoke_invite: an editor, and B's owner \(cross-tenant\)/],
  },
  // set_member_role / remove_member: the owner role and the last owner.
  {
    id: 'set-role-admin-grants-owner',
    what: 'set_member_role lets an admin grant owner (itself included)',
    sql: mutateRpc(
      INVITES,
      'set_member_role',
      `if my_role <> 'owner' and (set_member_role.role = 'owner' or their_role = 'owner') then`,
      `if my_role <> 'owner' and their_role = 'owner' then`,
    ),
    expect: [
      /^FAIL {2}set_member_role: an admin self-promoting to owner → not_authorized/,
      /^FAIL {2}set_member_role: an admin promoting an editor to owner/,
    ],
  },
  {
    id: 'set-role-no-last-owner',
    what: 'set_member_role without the last-owner check',
    sql: mutateRpc(INVITES, 'set_member_role', ') <= 1 then', ') < 0 then'),
    expect: [
      /^FAIL {2}set_member_role: the LAST owner demoting self → last_owner/,
      /^FAIL {2}set_member_role: with two owners one may step down; the remaining owner cannot/,
    ],
  },
  {
    id: 'remove-no-last-owner',
    what: 'remove_member without the last-owner check',
    sql: mutateRpc(INVITES, 'remove_member', ') <= 1 then', ') < 0 then'),
    expect: [/^FAIL {2}remove_member: the LAST owner cannot remove self → last_owner/],
  },
  {
    id: 'remove-owner-by-admin',
    what: 'remove_member lets an admin remove an owner',
    sql: mutateRpc(
      INVITES,
      'remove_member',
      `if their_role = 'owner' and my_role <> 'owner' then`,
      'if false then',
    ),
    expect: [/^FAIL {2}remove_member: an admin cannot remove the owner/],
  },
]

// --- CLI ----------------------------------------------------------------------------------------
const argv = process.argv.slice(2)
const flag = (/** @type {string} */ name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const jobs = Math.max(
  1,
  Number(flag('--jobs') ?? process.env.PROVE_RED_JOBS ?? Math.min(8, availableParallelism())) || 1,
)
const only = flag('--only')?.split(',').filter(Boolean)
const selected = only ? SABOTAGES.filter((s) => only.includes(s.id)) : SABOTAGES
if (only && selected.length !== only.length) {
  const known = new Set(SABOTAGES.map((s) => s.id))
  console.log(`unknown sabotage id(s): ${only.filter((x) => !known.has(x)).join(', ')}`)
  process.exit(2)
}
const ids = SABOTAGES.map((s) => s.id)
const dupIds = ids.filter((x, i) => ids.indexOf(x) !== i)
if (dupIds.length) {
  console.log(`duplicate sabotage id(s): ${dupIds.join(', ')}`)
  process.exit(2)
}

// --- temp copies (always removed) ---------------------------------------------------------------
const root = mkdtempSync(path.join(tmpdir(), 'themis-prove-red-'))
let cleaned = false
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  rmSync(root, { recursive: true, force: true })
}
process.on('exit', cleanup)
for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(sig, () => {
    cleanup()
    process.exit(130)
  })
}

const archiveFiles = readdirSync(ARCHIVE).filter((f) => f.endsWith('.sql'))
if (archiveFiles.length === 0) {
  console.log(`no migrations in ${ARCHIVE} — nothing to sabotage`)
  process.exit(1)
}

/**
 * Copy the archive to a fresh dir under `root`, optionally add the sabotage file.
 * @param {string} name
 * @param {string | undefined} sql
 */
const prepare = (name, sql) => {
  const dir = path.join(root, name)
  mkdirSync(dir)
  for (const f of archiveFiles) cpSync(path.join(ARCHIVE, f), path.join(dir, f))
  if (sql !== undefined) writeFileSync(path.join(dir, SABOTAGE_FILE), sql + '\n')
  return dir
}

/**
 * Run the gate against `dir`; resolve with its exit code and combined output.
 * @param {string} dir
 * @returns {Promise<{ code: number | null, out: string, ms: number }>}
 */
const runGate = (dir) =>
  new Promise((resolve) => {
    const t0 = performance.now()
    const child = spawn(process.execPath, [GATE], {
      env: { ...process.env, DB_GATE_MIGRATIONS: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => {
      out += `\n[prove-red] timed out after ${RUN_TIMEOUT_MS / 1000}s`
      child.kill()
    }, RUN_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, ms: performance.now() - t0 })
    })
  })

/**
 * @typedef {{ id: string, ok: boolean, line: string, detail: string[] }} Verdict
 */

/** @param {Sabotage} s @returns {Promise<Verdict>} */
const prove = async (s) => {
  const r = await runGate(prepare(s.id, s.sql))
  const failLines = r.out.split(/\r?\n/).filter((l) => RED_LINE.test(l))
  const missing = s.expect.filter((e) =>
    typeof e === 'string'
      ? !failLines.some((l) => l.includes(e))
      : !failLines.some((l) => e.test(l)),
  )
  const passed = /GATE PASSED/.test(r.out)
  const ok = r.code === 1 && missing.length === 0 && !passed
  const tag = s.plan ? `(${s.plan}) ` : ''
  const secs = (r.ms / 1000).toFixed(1)
  if (ok) {
    return {
      id: s.id,
      ok,
      line: `RED    ${tag}${s.id} — exit 1, ${failLines.filter((l) => l.startsWith('FAIL')).length} FAIL line(s), ${s.expect.length} expected matched (${secs}s)`,
      detail: [],
    }
  }
  const why =
    r.code === 0 || passed
      ? 'the gate PASSED — the sabotage was not caught'
      : r.code !== 1
        ? `exit ${r.code} (expected 1)`
        : 'red for the WRONG reason'
  return {
    id: s.id,
    ok,
    line: `WRONG  ${tag}${s.id} — ${why} (${secs}s)`,
    detail: [
      `sabotage: ${s.what}`,
      ...missing.map((m) => `missing expected red line: ${String(m)}`),
      ...(failLines.length ? failLines.map((l) => `saw: ${l}`) : ['saw no red line']),
      ...(r.code !== 1
        ? r.out
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(-5)
            .map((l) => `tail: ${l}`)
        : []),
    ],
  }
}

/** Run `tasks` with at most `n` in flight, keeping input order in the result. */
const pool = async (/** @type {(() => Promise<Verdict>)[]} */ tasks, /** @type {number} */ n) => {
  /** @type {Verdict[]} */
  const results = new Array(tasks.length)
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker))
  return results
}

// --- run ----------------------------------------------------------------------------------------
const t0 = performance.now()
console.log(
  `prove-red: ${selected.length} sabotage(s) + 1 control against a copy of ${archiveFiles.length} migration(s), ${jobs} parallel job(s)\n`,
)

/** @type {() => Promise<Verdict>} */
const control = async () => {
  const r = await runGate(prepare('control', undefined))
  const ok = r.code === 0 && /GATE PASSED/.test(r.out) && !/^FAIL/m.test(r.out)
  const passCount = (r.out.match(/^PASS/gm) ?? []).length
  return {
    id: 'control',
    ok,
    line: ok
      ? `GREEN  control — the untouched archive copy: exit 0, GATE PASSED, ${passCount} PASS (${(r.ms / 1000).toFixed(1)}s)`
      : `WRONG  control — the untouched archive copy did not pass: exit ${r.code}`,
    detail: ok
      ? []
      : r.out
          .trim()
          .split(/\r?\n/)
          .filter((l) => l.startsWith('FAIL') || /GATE|APPLY/.test(l))
          .map((l) => `saw: ${l}`),
  }
}

let results
try {
  results = await pool([control, ...selected.map((s) => () => prove(s))], jobs)
} finally {
  cleanup()
}

for (const v of results) {
  console.log(v.line)
  for (const d of v.detail) console.log(`         ${d}`)
}

const wall = ((performance.now() - t0) / 1000).toFixed(1)
const red = results.filter((v) => v.id !== 'control' && v.ok).length
const controlOk = results[0].ok
// A one-letter tag is a PLAN P1.9 item (a–f); a longer tag names its own PLAN task (e.g. P2.7).
const planLetters = selected
  .filter((s) => s.plan)
  .map((s) => (String(s.plan).length === 1 ? `P1.9 ${s.plan}` : String(s.plan)))
console.log('')
if (controlOk && red === selected.length) {
  console.log(
    `PROVE-RED PASSED — ${red}/${selected.length} sabotages went RED on the expected FAIL line` +
      (planLetters.length ? ` (PLAN ${planLetters.join(', ')} included)` : '') +
      `; control GREEN. Wall ${wall}s.`,
  )
  process.exit(0)
}
console.log(
  `PROVE-RED FAILED — ${red}/${selected.length} sabotages RED on the expected line; control ${controlOk ? 'GREEN' : 'NOT GREEN'}. Wall ${wall}s.`,
)
process.exit(1)
