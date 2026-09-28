// THE MIGRATION GATE — `npm run db:gate`
//
// CLAUDE.md §9 says P1 is not claimed until its migrations "apply on a FRESH db with zero errors"
// and isolation is proven. This file IS that gate, re-runnable by anyone on any checkout.
//
// It runs the committed migrations against REAL PostgreSQL (PGlite is Postgres compiled to wasm,
// not an emulation) in a throwaway in-memory database. It NEVER touches the live Supabase project
// and needs no credential. Pattern: argus-news/scripts/db-gate.mjs.
//
// Themis shares Hephaestus's live project (ADR-0002), so the database is first dressed as THAT
// project by ./db-gate/shim.mjs (Supabase roles + auth, Hephaestus's `public` and migration
// ledger), and nothing is pre-granted on schema `themis`: a grant a migration forgot must fail a
// positive-path check here, not surface live.
//
// P1.2 scope: the harness, apply + re-apply (idempotency), and the bootstrap's own contract.
// P1.3 runs the static guard (./check-migrations.mjs) before anything is applied.
// P1.8 adds the structural sweep over every themis table and object, a coverage check (every
// themis table has an entry in ./db-gate/leak-matrix.mjs, derived from the CATALOGUE, so a new
// table without an entry turns the gate RED), the orphan scan over the seeded fixture, and the
// functional A/B leak matrix with its positive path (owner writes, viewer reads but cannot write).
// P2.7 adds the client RPCs (P2.5 bootstrap_me/import_local_decision, P2.6 invites and membership):
// per RPC the catalogue (definer, search_path, EXECUTE authenticated only) and the anon/service_role
// refusal, then their behaviour, each check in its own rolled-back session over the same fixture.

import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { installShim, HEPHAESTUS_MIGRATION_ROWS } from './db-gate/shim.mjs'
import { runGuard } from './check-migrations.mjs'
import {
  ACTORS,
  ANON,
  CLIENT_RPCS,
  INVITEE_EMAIL,
  RPC_USERS,
  U,
  UNVERIFIED_EMAIL,
  WA,
  WB,
  addRpcUsers,
  CROSS_INSERTED,
  LEAK_MATRIX,
  PARENTS,
  SERVICE,
  SERVICE_ONLY_TABLES,
  SUPERUSER,
  checkValues,
  createHarness,
  fkRefused,
  foreignSnapshot,
  noEffect,
  refused,
  seedFixture,
  snapshot,
} from './db-gate/leak-matrix.mjs'
import { METHODOLOGIES, SCALES } from '../src/lib/decision.ts'

// Overridable so the gate can be pointed at a MUTATED copy of the archive and proven to go red
// (P1.9). A gate nobody has ever seen fail is not a gate.
const MIG =
  process.env.DB_GATE_MIGRATIONS ??
  fileURLToPath(new URL('../supabase/migrations', import.meta.url))

// Every exit path RETURNS its code; nothing calls process.exit(). On Windows an immediate
// process.exit() after PGlite work can crash node (libuv `!(handle->flags & UV_HANDLE_CLOSING)`,
// 0xC0000409) instead of exiting 1, which prove-red then reads as a WRONG sabotage (BRAIN §5, B3).
// So PGlite is closed on every path and `process.exitCode` is set once, here.
process.exitCode = await main()

/** @returns {Promise<number>} the exit code */
async function main() {
  // --- static guard first (P1.3): nothing outside schema `themis`, well-formed names ----------------
  // A migration that reaches into Hephaestus's schemas must never even be executed, not even in wasm.
  if (!runGuard(MIG)) {
    console.log(
      '\nGATE FAILED — the static migration guard is red (npm run db:check); nothing was applied.',
    )
    return 1
  }
  console.log('')

  const db = new PGlite()
  try {
    return await runGate(db)
  } finally {
    await db.close()
  }
}

/**
 * Apply the archive twice, then every structural, coverage and leak-matrix check.
 * @param {PGlite} db a fresh in-memory database, closed by the caller
 * @returns {Promise<number>} 0 = GATE PASSED, 1 = red
 */
async function runGate(db) {
  const q = (sql, params) => db.query(sql, params)
  let failures = 0
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
    if (!ok) failures++
  }

  // --- the shared project, as Themis finds it ----------------------------------------------------
  await installShim(db)
  // Taken BEFORE the archive runs: the structural sweep diffs Hephaestus's schemas against it.
  const foreignBefore = await foreignSnapshot(db)
  const hephLedger = await q(`select count(*)::int as n from supabase_migrations.schema_migrations`)
  check(
    `shim: Hephaestus migration ledger holds ${HEPHAESTUS_MIGRATION_ROWS} rows`,
    hephLedger.rows[0].n === HEPHAESTUS_MIGRATION_ROWS,
    `${hephLedger.rows[0].n} rows`,
  )

  // --- apply, in order, zero errors --------------------------------------------------------------
  const files = existsSync(MIG)
    ? readdirSync(MIG)
        .filter((f) => f.endsWith('.sql'))
        .sort()
    : []
  if (files.length === 0) {
    console.log(`FAIL  no migrations found in ${MIG} — the gate has nothing to prove`)
    return 1
  }
  for (const f of files) {
    try {
      await db.exec(readFileSync(path.join(MIG, f), 'utf8'))
      console.log(`applied  ${f}`)
    } catch (e) {
      check(`apply ${f}`, false, e instanceof Error ? e.message : String(e))
      console.log('\nAPPLY FAILED — stopping.')
      return 1
    }
  }

  // --- idempotent-safe: the whole archive runs a second time without error (CLAUDE.md §3.3) -------
  for (const f of files) {
    try {
      await db.exec(readFileSync(path.join(MIG, f), 'utf8'))
      check(`re-apply ${f} (idempotent-safe)`, true)
    } catch (e) {
      check(`re-apply ${f} (idempotent-safe)`, false, e instanceof Error ? e.message : String(e))
    }
  }
  console.log('')

  // --- bootstrap contract ------------------------------------------------------------------------
  const schema = await q(`select 1 from pg_namespace where nspname = 'themis'`)
  check('schema themis exists', schema.rows.length === 1)

  const cols = await q(
    `select a.attname, format_type(a.atttypid, a.atttypmod) as type
       from pg_attribute a
      where a.attrelid = to_regclass('themis.schema_migrations') and a.attnum > 0
        and not a.attisdropped
      order by a.attnum`,
  )
  const gotCols = cols.rows.map((r) => `${r.attname}:${r.type}`).join(',')
  check(
    'themis.schema_migrations has (version text, name text, checksum text, applied_at timestamptz)',
    gotCols === 'version:text,name:text,checksum:text,applied_at:timestamp with time zone',
    gotCols || 'table missing',
  )

  const pk = await q(
    `select a.attname from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.conrelid = to_regclass('themis.schema_migrations') and c.contype = 'p'`,
  )
  check(
    'themis.schema_migrations primary key is version',
    pk.rows.length === 1 && pk.rows[0].attname === 'version',
    pk.rows.map((r) => r.attname).join(','),
  )

  const ledgerRls = await q(
    `select c.relrowsecurity,
            (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
       from pg_class c where c.oid = to_regclass('themis.schema_migrations')`,
  )
  check('themis.schema_migrations has RLS enabled', ledgerRls.rows[0]?.relrowsecurity === true)
  check(
    'themis.schema_migrations has NO policies',
    ledgerRls.rows[0]?.policies === 0,
    `${ledgerRls.rows[0]?.policies ?? '?'} policies`,
  )

  for (const role of ['anon', 'authenticated']) {
    const priv = await q(
      `select p.priv from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(priv)
        where has_table_privilege($1, 'themis.schema_migrations', p.priv)`,
      [role],
    )
    check(
      `${role} holds no privilege on themis.schema_migrations`,
      priv.rows.length === 0,
      priv.rows.map((r) => r.priv).join(','),
    )
  }

  // Positive path: the API roles must be able to USE the schema, or every later grant is dead.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const u = await q(`select has_schema_privilege($1, 'themis', 'USAGE') as ok`, [role])
    check(`${role} has USAGE on schema themis`, u.rows[0].ok === true)
  }

  const fn = await q(
    `select p.oid, p.proconfig, p.prorettype::regtype::text as rettype from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'themis' and p.proname = 'touch_updated_at'`,
  )
  check(
    'themis.touch_updated_at() exists and returns trigger',
    fn.rows.length === 1 && fn.rows[0].rettype === 'trigger',
  )
  check(
    'themis.touch_updated_at() has search_path pinned',
    fn.rows.length === 1 &&
      (fn.rows[0].proconfig ?? []).some((c) => String(c).startsWith('search_path=')),
    String(fn.rows[0]?.proconfig ?? 'none'),
  )
  if (fn.rows.length === 1) {
    const anonExec = await q(`select has_function_privilege('anon', $1::oid, 'EXECUTE') as ok`, [
      fn.rows[0].oid,
    ])
    check('anon holds no EXECUTE on themis.touch_updated_at()', anonExec.rows[0].ok === false)
  }

  // Functional: the trigger function actually bumps updated_at (on a temp table, not in themis).
  try {
    await db.exec(`
      create temp table gate_touch (id int primary key, v int, updated_at timestamptz);
      create trigger gate_touch_bump before update on gate_touch
        for each row execute function themis.touch_updated_at();
      insert into gate_touch values (1, 0, '2000-01-01T00:00:00Z');
    `)
    await q(`update gate_touch set v = 1 where id = 1`)
    const bumped = await q(
      `select updated_at > timestamptz '2000-01-02' as ok from gate_touch where id = 1`,
    )
    check('themis.touch_updated_at() sets updated_at on UPDATE', bumped.rows[0]?.ok === true)
    await db.exec(`drop table gate_touch`)
  } catch (e) {
    check(
      'themis.touch_updated_at() sets updated_at on UPDATE',
      false,
      e instanceof Error ? e.message : String(e),
    )
  }

  // The bootstrap must not have written Hephaestus's ledger.
  const hephAfter = await q(`select count(*)::int as n from supabase_migrations.schema_migrations`)
  check(
    `supabase_migrations.schema_migrations still holds ${HEPHAESTUS_MIGRATION_ROWS} rows`,
    hephAfter.rows[0].n === HEPHAESTUS_MIGRATION_ROWS,
    `${hephAfter.rows[0].n} rows`,
  )

  // =================================================================================================
  // P1.8 — STRUCTURAL SWEEP over every object in schema `themis` (derived from the catalogue)
  // =================================================================================================
  console.log('\n--- structural sweep ---')
  const errMsg = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e))
  /** Run a check whose body may throw (a missing table, a bad column): a throw is a FAIL, not a crash. */
  const guarded = async (
    /** @type {string} */ name,
    /** @type {() => Promise<[boolean, string?]>} */ fn,
  ) => {
    try {
      const [ok, detail] = await fn()
      check(name, ok, detail ?? '')
    } catch (e) {
      check(name, false, `threw: ${errMsg(e)}`)
    }
  }
  const list = (/** @type {string[]} */ xs) => (xs.length ? xs.join(', ') : '')

  const tables = (
    await q(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'themis' and c.relkind in ('r', 'p') order by 1`,
    )
  ).rows.map((r) => String(r.relname))

  // RLS on every table.
  const noRls = (
    await q(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'themis' and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1`,
    )
  ).rows.map((r) => String(r.relname))
  check(`RLS is enabled on every themis table (${tables.length})`, noRls.length === 0, list(noRls))

  // A view runs with its OWNER's rights unless security_invoker: it would read around RLS.
  const badViews = (
    await q(
      `select c.relname || case c.relkind when 'm' then ' (materialized)' else '' end as v
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'themis' and c.relkind in ('v', 'm')
          and (c.relkind = 'm' or not coalesce('security_invoker=true' = any (c.reloptions), false)
                                and not coalesce('security_invoker=on' = any (c.reloptions), false))
        order by 1`,
    )
  ).rows.map((r) => String(r.v))
  check(
    'no themis view bypasses RLS (views are security_invoker, no materialized views)',
    badViews.length === 0,
    list(badViews),
  )

  // Every table has a policy set, except the service-only tables, which must hold ZERO API grants.
  const noPolicy = (
    await q(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'themis' and c.relkind in ('r', 'p')
          and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
        order by 1`,
    )
  ).rows.map((r) => String(r.relname))
  const noPolicyUnexpected = noPolicy.filter((t) => !SERVICE_ONLY_TABLES.includes(t))
  check(
    `every themis table has at least one policy (service-only exceptions: ${SERVICE_ONLY_TABLES.join(', ')})`,
    noPolicyUnexpected.length === 0,
    list(noPolicyUnexpected),
  )
  const ALL_TABLE_PRIVS = [
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'TRUNCATE',
    'REFERENCES',
    'TRIGGER',
  ]
  /** Verbs `role` holds on `rel` (table-level or through any column grant). */
  const relPrivs = async (/** @type {string} */ role, /** @type {string} */ rel) =>
    (
      await q(
        `select p from unnest($3::text[]) p
          where has_table_privilege($1, $2, p)
             or (p in ('SELECT','INSERT','UPDATE','REFERENCES') and has_any_column_privilege($1, $2, p))`,
        [role, rel, ALL_TABLE_PRIVS],
      )
    ).rows.map((r) => String(r.p))
  for (const t of SERVICE_ONLY_TABLES) {
    await guarded(`service-only themis.${t} grants nothing to anon/authenticated`, async () => {
      const got = []
      for (const role of ['anon', 'authenticated'])
        for (const p of await relPrivs(role, `themis.${t}`)) got.push(`${role}:${p}`)
      return [got.length === 0, list(got)]
    })
  }

  // Functions: search_path pinned everywhere; definers never on a path an attacker can write;
  // EXECUTE for neither anon nor PUBLIC. proacl NULL means the DEFAULT acl, which grants PUBLIC.
  const fns = (
    await q(
      `select p.oid, p.oid::regprocedure::text as sig, p.prosecdef as definer,
              coalesce(p.proconfig, '{}') as config,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'themis' order by 2`,
    )
  ).rows
  const pathOf = (/** @type {any} */ f) =>
    /** @type {string[]} */ (f.config).find((c) => String(c).startsWith('search_path='))
  const unpinned = fns.filter((f) => !pathOf(f)).map((f) => String(f.sig))
  check(
    `search_path is pinned on every themis function (${fns.length})`,
    unpinned.length === 0,
    list(unpinned),
  )
  const loosePath = fns
    .filter((f) => f.definer && pathOf(f) && /public|\$user|pg_temp/.test(String(pathOf(f))))
    .map((f) => `${f.sig} ${pathOf(f)}`)
  check(
    'no SECURITY DEFINER function has public/$user/pg_temp on its search_path',
    loosePath.length === 0,
    list(loosePath),
  )
  const anonExec = fns.filter((f) => f.anon_exec).map((f) => String(f.sig))
  check('anon has EXECUTE on no themis function', anonExec.length === 0, list(anonExec))
  const publicExec = fns.filter((f) => f.public_exec).map((f) => String(f.sig))
  check('PUBLIC has EXECUTE on no themis function', publicExec.length === 0, list(publicExec))

  // Policies.
  const policies = (
    await q(
      `select c.relname || '.' || p.polname as name, c.relname as tbl, p.polcmd::text as cmd,
              p.polroles::regrole[]::text as roles,
              (0::oid = any (p.polroles) or 'anon'::regrole::oid = any (p.polroles)) as admits_anon,
              coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
              coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
         from pg_policy p join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'themis' order by 1`,
    )
  ).rows
  /** The documented exceptions to "every policy is TO authenticated" (plans is public reference data). */
  const POLICY_ROLE_EXCEPTIONS = /** @type {Record<string, { roles: string, cmd: string }>} */ ({
    'plans.plans_select': { roles: '{anon,authenticated}', cmd: 'r' },
  })
  const writeAnon = policies
    .filter((p) => p.cmd !== 'r' && p.admits_anon)
    .map((p) => `${p.name} (${p.cmd} ${p.roles})`)
  check('no write policy admits anon or PUBLIC', writeAnon.length === 0, list(writeAnon))
  const notAuthOnly = policies
    .filter((p) => {
      const ex = POLICY_ROLE_EXCEPTIONS[String(p.name)]
      return ex ? !(p.roles === ex.roles && p.cmd === ex.cmd) : p.roles !== '{authenticated}'
    })
    .map((p) => `${p.name} (${p.cmd} ${p.roles})`)
  check(
    `every themis policy is TO authenticated (exceptions: ${Object.keys(POLICY_ROLE_EXCEPTIONS).join(', ')} SELECT)`,
    notAuthOnly.length === 0,
    list(notAuthOnly),
  )
  const recursive = policies
    .filter((p) => /memberships/.test(String(p.expr)))
    .map((p) => String(p.name))
  check(
    'no policy expression references memberships directly (recursion rule)',
    recursive.length === 0,
    list(recursive),
  )
  const WORKSPACE_SCOPED = LEAK_MATRIX.filter(
    (e) => e.kind === 'tenant' && e.scope === 'workspace',
  ).map((e) => e.table)
  const noHelper = policies
    .filter((p) => WORKSPACE_SCOPED.includes(String(p.tbl)))
    .filter((p) => !/themis\.(is_member|has_role)\(/.test(String(p.expr)))
    .map((p) => String(p.name))
  check(
    'every workspace-scoped policy asks through themis.is_member/has_role',
    noHelper.length === 0,
    list(noHelper),
  )

  // anon: SELECT on plans and nothing else, on any themis relation or sequence.
  await guarded(
    'anon holds exactly SELECT on themis.plans and no other themis privilege',
    async () => {
      const rels = (
        await q(
          `select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'themis' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') order by 1`,
        )
      ).rows
      const got = []
      for (const r of rels) {
        const rel = `themis.${r.relname}`
        if (r.relkind === 'S') {
          const s = await q(
            `select p from unnest(array['USAGE','SELECT','UPDATE']) p where has_sequence_privilege('anon', $1, p)`,
            [rel],
          )
          for (const x of s.rows) got.push(`${r.relname}.${x.p}`)
        } else for (const p of await relPrivs('anon', rel)) got.push(`${r.relname}.${p}`)
      }
      return [JSON.stringify(got) === JSON.stringify(['plans.SELECT']), list(got) || 'nothing']
    },
  )

  // Hephaestus's side: zero objects in public/auth/supabase_migrations changed, no auth.users trigger.
  await guarded(
    'zero objects in public/auth/supabase_migrations changed (pg_class, pg_policy, pg_proc, triggers)',
    async () => {
      const after = await foreignSnapshot(db)
      const changed = /** @type {(keyof typeof after)[]} */ (Object.keys(after)).filter(
        (k) => after[k] !== foreignBefore[k],
      )
      return [changed.length === 0, changed.length ? `changed: ${changed.join(', ')}` : '']
    },
  )
  const authTriggers = (
    await q(
      `select tgname from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal`,
    )
  ).rows.map((r) => String(r.tgname))
  check('no trigger on auth.users', authTriggers.length === 0, list(authTriggers))

  // Foreign keys: all validated (NOT VALID would skip the existing rows).
  const unvalidated = (
    await q(
      `select c.conrelid::regclass::text || '.' || c.conname as fk from pg_constraint c
        join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = 'themis' and c.contype = 'f' and not c.convalidated order by 1`,
    )
  ).rows.map((r) => String(r.fk))
  check(
    'every themis foreign key is validated (convalidated)',
    unvalidated.length === 0,
    list(unvalidated),
  )

  // The DB enums match src/lib/decision.ts (moved here from the P1.5 Vitest; the test stays too).
  for (const [col, ts] of /** @type {[string, string[]][]} */ ([
    ['methodology', Object.keys(METHODOLOGIES)],
    ['scale', Object.keys(SCALES)],
  ])) {
    await guarded(`decisions.${col} CHECK admits exactly the decision.ts values`, async () => {
      const db_ = await checkValues(db, 'decisions', col)
      const want = [...ts].sort()
      return [
        JSON.stringify(db_) === JSON.stringify(want),
        `db ${db_ ? db_.join('|') : 'no single CHECK'} vs ts ${want.join('|')}`,
      ]
    })
  }

  // =================================================================================================
  // P1.8 — COVERAGE: every table in the catalogue has a leak-matrix entry, and vice versa
  // =================================================================================================
  console.log('\n--- leak-matrix coverage ---')
  const inMatrix = LEAK_MATRIX.map((e) => e.table)
  const uncovered = tables.filter((t) => !inMatrix.includes(t) && !SERVICE_ONLY_TABLES.includes(t))
  check(
    `every themis table (except ${SERVICE_ONLY_TABLES.join(', ')}) has a leak-matrix entry`,
    uncovered.length === 0,
    uncovered.length
      ? `NO ENTRY: ${uncovered.join(', ')} — add it to scripts/db-gate/leak-matrix.mjs`
      : '',
  )
  const stale = inMatrix.filter((t) => !tables.includes(t))
  check('every leak-matrix entry names an existing themis table', stale.length === 0, list(stale))
  const dupes = inMatrix.filter((t, i) => inMatrix.indexOf(t) !== i)
  check('the leak matrix names each table once', dupes.length === 0, list(dupes))

  // =================================================================================================
  // P1.8 — FIXTURE + ORPHAN SCAN
  // =================================================================================================
  console.log('\n--- fixture and orphan scan ---')
  try {
    await seedFixture(db)
    check('fixture seeded (workspaces A and B, rows in every tenant table)', true)
  } catch (e) {
    check('fixture seeded (workspaces A and B, rows in every tenant table)', false, errMsg(e))
    console.log(`\nGATE FAILED — ${failures} check(s) red; the leak matrix needs the fixture.`)
    return 1
  }

  await guarded('orphan scan: zero dangling references over every themis foreign key', async () => {
    const fks = (
      await q(
        `select c.conname, c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
                array(select a.attname from unnest(c.conkey) with ordinality k(n, i)
                        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.i)::text[] as ccols,
                array(select a.attname from unnest(c.confkey) with ordinality k(n, i)
                        join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by k.i)::text[] as pcols
           from pg_constraint c join pg_class t on t.oid = c.conrelid
           join pg_namespace n on n.oid = t.relnamespace
          where n.nspname = 'themis' and c.contype = 'f' order by 1`,
      )
    ).rows
    const orphans = []
    for (const fk of fks) {
      const cc = /** @type {string[]} */ (fk.ccols)
      const pc = /** @type {string[]} */ (fk.pcols)
      const r = await q(
        `select count(*)::int as n from ${fk.child} c
          where ${cc.map((x) => `c.${x} is not null`).join(' and ')}
            and not exists (select 1 from ${fk.parent} p where ${cc.map((x, i) => `p.${pc[i]} = c.${x}`).join(' and ')})`,
      )
      const n = Number(r.rows[0].n)
      if (n > 0) orphans.push(`${fk.conname}: ${n}`)
    }
    return [
      fks.length > 0 && orphans.length === 0,
      orphans.length ? list(orphans) : `${fks.length} FKs clean`,
    ]
  })

  // =================================================================================================
  // P1.8 — THE LEAK MATRIX: UB against workspace A, per table; the positive path for A's members
  // =================================================================================================
  console.log('\n--- leak matrix (UB = owner of B against workspace A) ---')
  const { actAs } = createHarness(db)
  /** @param {keyof typeof ACTORS} a */
  const who = (a) => ACTORS[a]
  const CLIENT_WRITE_PRIVS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']

  // anon reads nothing but reference data, on EVERY themis table (from the catalogue).
  for (const t of tables) {
    const ref = LEAK_MATRIX.find((e) => e.table === t && e.kind === 'reference')
    await guarded(
      `anon reads ${ref && ref.kind === 'reference' ? `exactly ${ref.rows} rows of` : 'nothing in'} themis.${t}`,
      () =>
        actAs(ANON, async (s) => {
          const o = await s.attempt(`select 1 from themis.${t} limit 1`)
          if (!o.ok) return [!ref && refused(o), o.error]
          const n = await s.count(t)
          return [ref && ref.kind === 'reference' ? n === ref.rows : n === 0, `${n} rows`]
        }),
    )
  }

  for (const e of LEAK_MATRIX) {
    const T = `themis.${e.table}`
    if (e.kind === 'reference') {
      await guarded(`${T} holds ${e.rows} rows`, () =>
        actAs(SUPERUSER, async (s) => {
          const n = await s.count(e.table)
          return [n === e.rows, `${n} rows`]
        }),
      )
      for (const a of /** @type {const} */ (['UA', 'UB'])) {
        await guarded(`${T}: ${a} reads all ${e.rows} rows`, () =>
          actAs(who(a), async (s) => {
            const n = await s.count(e.table)
            return [n === e.rows, `${n} rows`]
          }),
        )
      }
      for (const [label, w] of /** @type {[string, import('./db-gate/leak-matrix.mjs').Who][]} */ ([
        ['UA', who('UA')],
        ['anon', ANON],
      ])) {
        await guarded(`${T}: ${label}'s UPDATE and DELETE have no effect`, () =>
          actAs(w, async (s) => {
            const before = await snapshot(s, e.table, 'true')
            const u = await s.attempt(`update ${T} set ${e.probe}`)
            const d = await s.attempt(`delete from ${T}`)
            const after = await snapshot(s, e.table, 'true')
            return [noEffect(u) && noEffect(d) && before.h === after.h, JSON.stringify({ u, d })]
          }),
        )
      }
      await guarded(`${T}: no client role holds a write privilege`, async () => {
        const got = []
        for (const role of ['anon', 'authenticated'])
          for (const p of await relPrivs(role, T))
            if (CLIENT_WRITE_PRIVS.includes(p)) got.push(`${role}:${p}`)
        return [got.length === 0, list(got)]
      })
      continue
    }

    // --- tenant table ---
    const viewerOfA = e.viewerOfA ?? e.ofA
    await guarded(`${T}: fixture is non-vacuous (A and B both have rows)`, () =>
      actAs(SUPERUSER, async (s) => {
        const a = await s.count(e.table, e.ofA)
        const b = await s.count(e.table, e.ofB)
        return [a > 0 && b > 0, `A ${a}, B ${b}`]
      }),
    )
    await guarded(`${T}: UB reads ZERO rows of A`, () =>
      actAs(who('UB'), async (s) => {
        const n = await s.count(e.table, e.ofA)
        return [n === 0, `${n} rows`]
      }),
    )
    await guarded(`${T}: UB reads all of B's own rows (not locked out)`, () =>
      actAs(who('UB'), async (s) => {
        const want = await s.sudo(() => s.count(e.table, e.ofB))
        const n = await s.count(e.table, e.ofB)
        return [n === want && n > 0, `${n}/${want}`]
      }),
    )
    await guarded(`${T}: UB's UPDATE of A's rows has no effect`, () =>
      actAs(who('UB'), async (s) => {
        const before = await snapshot(s, e.table, e.ofA)
        const o = await s.attempt(`update ${T} set ${e.probe} where ${e.ofA}`)
        const after = await snapshot(s, e.table, e.ofA)
        return [noEffect(o) && before.h === after.h, JSON.stringify(o)]
      }),
    )
    await guarded(`${T}: UB's DELETE of A's rows has no effect`, () =>
      actAs(who('UB'), async (s) => {
        const before = await snapshot(s, e.table, e.ofA)
        const o = await s.attempt(`delete from ${T} where ${e.ofA}`)
        const after = await snapshot(s, e.table, e.ofA)
        return [noEffect(o) && before.h === after.h && after.n > 0, JSON.stringify(o)]
      }),
    )
    await guarded(`${T}: UB's INSERT of a row of A is refused`, () =>
      actAs(who('UB'), async (s) => {
        const before = await snapshot(s, e.table, e.ofA)
        const o = await s.attempt(e.insert.sql)
        const leaked = await s.sudo(() => s.count(e.table, e.insert.inserted))
        const after = await snapshot(s, e.table, e.ofA)
        return [refused(o) && leaked === 0 && before.h === after.h, JSON.stringify(o)]
      }),
    )
    await guarded(`${T}: control — the same INSERT succeeds as ${e.insert.as}`, () =>
      actAs(who(e.insert.as), async (s) => {
        const o = await s.attempt(e.insert.sql)
        const made = await s.sudo(() => s.count(e.table, e.insert.inserted))
        return [o.ok && o.affected === 1 && made >= 1, JSON.stringify(o)]
      }),
    )
    const cross = e.cross
    if (cross) {
      await guarded(`${T}: UB's child row (workspace B) pointing at A's parent is refused`, () =>
        actAs(who('UB'), async (s) => {
          const o = await s.attempt(cross(PARENTS.A))
          const leaked = await s.sudo(() => s.count(e.table, CROSS_INSERTED))
          return [(refused(o) || fkRefused(o)) && leaked === 0, JSON.stringify(o)]
        }),
      )
      await guarded(
        `${T}: control — the same child row pointing at B's parent succeeds (service)`,
        () =>
          actAs(SERVICE, async (s) => {
            const o = await s.attempt(cross(PARENTS.B))
            return [o.ok && o.affected === 1, JSON.stringify(o)]
          }),
      )
    }
    await guarded(`${T}: anon's UPDATE and DELETE of A's rows have no effect`, () =>
      actAs(ANON, async (s) => {
        const before = await snapshot(s, e.table, e.ofA)
        const u = await s.attempt(`update ${T} set ${e.probe} where ${e.ofA}`)
        const d = await s.attempt(`delete from ${T} where ${e.ofA}`)
        const after = await snapshot(s, e.table, e.ofA)
        return [noEffect(u) && noEffect(d) && before.h === after.h, JSON.stringify({ u, d })]
      }),
    )

    // Positive path: without it, a fully locked (broken) schema would pass everything above.
    await guarded(`${T}: UA reads all of A's rows`, () =>
      actAs(who('UA'), async (s) => {
        const want = await s.sudo(() => s.count(e.table, e.ofA))
        const n = await s.count(e.table, e.ofA)
        return [n === want && n > 0, `${n}/${want}`]
      }),
    )
    await guarded(
      `${T}: A's viewer reads ${e.viewerReads ? "all of A's rows" : "none of A's rows (role-gated)"}`,
      () =>
        actAs(who('viewer'), async (s) => {
          const all = await s.sudo(() => s.count(e.table, e.ofA))
          const n = await s.count(e.table, e.ofA)
          return [e.viewerReads ? n === all && n > 0 : n === 0, `${n}/${all}`]
        }),
    )
    await guarded(`${T}: ${e.write.as} writes A's data (takes effect)`, () =>
      actAs(who(e.write.as), async (s) => {
        const before = await snapshot(s, e.table, e.ofA)
        const o = await s.attempt(e.write.sql)
        const after = await snapshot(s, e.table, e.ofA)
        return [o.ok && o.affected >= 1 && before.h !== after.h, JSON.stringify(o)]
      }),
    )
    await guarded(`${T}: A's viewer cannot write A's data`, () =>
      actAs(who('viewer'), async (s) => {
        const before = await snapshot(s, e.table, e.ofA)
        const outcomes = [
          await s.attempt(`update ${T} set ${e.probe} where ${viewerOfA}`),
          await s.attempt(`delete from ${T} where ${viewerOfA}`),
          await s.attempt(e.write.sql),
        ]
        const after = await snapshot(s, e.table, e.ofA)
        return [outcomes.every(noEffect) && before.h === after.h, JSON.stringify(outcomes)]
      }),
    )
    if (e.write.as === 'service') {
      // Declared server-written: the catalogue must agree, and even A's owner cannot write it.
      await guarded(`${T}: server-written — authenticated holds no write privilege`, async () => {
        const got = (await relPrivs('authenticated', T)).filter((p) =>
          CLIENT_WRITE_PRIVS.includes(p),
        )
        return [got.length === 0, list(got)]
      })
      await guarded(`${T}: server-written — UA's writes have no effect`, () =>
        actAs(who('UA'), async (s) => {
          const before = await snapshot(s, e.table, e.ofA)
          const outcomes = [
            await s.attempt(`update ${T} set ${e.probe} where ${e.ofA}`),
            await s.attempt(`delete from ${T} where ${e.ofA}`),
            await s.attempt(e.write.sql),
          ]
          const after = await snapshot(s, e.table, e.ofA)
          return [outcomes.every(noEffect) && before.h === after.h, JSON.stringify(outcomes)]
        }),
      )
    }
  }

  // =================================================================================================
  // P2.7 — THE CLIENT RPCs: P2.5 bootstrap_me/import_local_decision, P2.6 invites and membership
  // =================================================================================================
  // Every check runs in its own rolled-back actAs, so each starts from the committed fixture. The
  // extra users (invitee, unverified, owner2) are added per check by addRpcUsers. `s.sudo` restores
  // the actAs identity, so a check that switched caller with `callAs` re-sets it after every sudo.
  /** @typedef {import('./db-gate/leak-matrix.mjs').Session} Session */
  /** @typedef {import('./db-gate/leak-matrix.mjs').Outcome} Outcome */
  console.log('\n--- client RPCs: catalogue ---')
  /** Switch the signed-in caller inside the current actAs (whose identity must be a uuid). */
  const callAs = (/** @type {Session} */ s, /** @type {string} */ uid) =>
    s.rows(`select set_config('request.jwt.claim.sub', $1, true)`, [uid])
  /** The first column of the first row (throws on error: a throw is a FAIL via `guarded`). */
  const one = async (
    /** @type {Session} */ s,
    /** @type {string} */ sql,
    /** @type {unknown[]} */ params = [],
  ) => Object.values((await s.rows(sql, params))[0] ?? {})[0]
  const erred = (/** @type {Outcome} */ o, /** @type {RegExp} */ re) => !o.ok && re.test(o.error)
  const denied = (/** @type {Outcome} */ o) => erred(o, /permission denied for function/)
  const show = (/** @type {unknown} */ x) => JSON.stringify(x)
  /** @returns {Promise<string | null>} */
  const roleOf = (/** @type {Session} */ s, /** @type {string} */ ws, /** @type {string} */ u) =>
    s.sudo(
      async () =>
        /** @type {string | null} */ (
          (
            await s.rows(
              `select role from themis.memberships where workspace_id = $1 and user_id = $2`,
              [ws, u],
            )
          )[0]?.role ?? null
        ),
    )
  const sha256hex = (/** @type {string} */ t) =>
    createHash('sha256').update(t, 'utf8').digest('hex')
  /** One gate line = one rolled-back session as `w`. */
  const rpc = (
    /** @type {string} */ name,
    /** @type {import('./db-gate/leak-matrix.mjs').Who} */ w,
    /** @type {(s: Session) => Promise<[boolean, string?]>} */ fn,
  ) => guarded(name, () => actAs(w, fn))
  const invite = (
    /** @type {Session} */ s,
    /** @type {string} */ email,
    /** @type {string} */ role,
  ) => one(s, `select themis.create_invite($1, $2, $3)`, [WA, email, role]).then(String)
  const inviteId = (/** @type {Session} */ s, /** @type {string} */ tok) =>
    s.sudo(() => one(s, `select id from themis.invites where token_hash = $1`, [sha256hex(tok)]))

  for (const f of CLIENT_RPCS) {
    await guarded(
      `${f.sig}: SECURITY DEFINER, search_path='', EXECUTE for authenticated only (not anon, service_role, PUBLIC)`,
      async () => {
        const r = (
          await q(
            `select p.prosecdef as definer, p.proconfig as config,
                    has_function_privilege('authenticated', p.oid, 'EXECUTE') as authn,
                    has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                    has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
                    exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                             where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub
               from pg_proc p where p.oid = to_regprocedure($1)`,
            [f.sig],
          )
        ).rows[0]
        if (!r) return [false, 'function missing']
        const pinned = show(r.config) === show(['search_path=""'])
        return [r.definer === true && pinned && r.authn && !r.anon && !r.svc && !r.pub, show(r)]
      },
    )
    await rpc(`anon cannot EXECUTE ${f.name}`, ANON, async (s) => {
      const o = await s.attempt(f.call)
      return [denied(o), show(o)]
    })
    await rpc(`service_role cannot EXECUTE ${f.name}`, SERVICE, async (s) => {
      const o = await s.attempt(f.call)
      return [denied(o), show(o)]
    })
  }

  // --- P2.5 bootstrap_me ---------------------------------------------------------------------------
  console.log('\n--- client RPCs: bootstrap_me ---')
  await rpc(
    'bootstrap_me: a fresh user gets a personal workspace they created and own, visible to them',
    U.loner,
    async (s) => {
      const ws = await one(s, `select themis.bootstrap_me()`)
      const row = await s.sudo(() =>
        s.rows(
          `select w.name, w.created_by, m.role from themis.workspaces w
             join themis.memberships m on m.workspace_id = w.id where w.id = $1`,
          [ws],
        ),
      )
      const seen = await s.rows(`select id from themis.workspaces`)
      const ok =
        row.length === 1 &&
        row[0].created_by === U.loner &&
        row[0].role === 'owner' &&
        seen.length === 1 &&
        seen[0].id === ws
      return [ok, show({ row, seen })]
    },
  )
  await rpc(
    'bootstrap_me: called twice → the same workspace, one profile, one new workspace (idempotent)',
    U.loner,
    async (s) => {
      const count = () =>
        s.sudo(() =>
          one(
            s,
            `select (select count(*) from themis.workspaces)::int * 1000
                  + (select count(*) from themis.profiles where user_id = $1)::int`,
            [U.loner],
          ),
        )
      const before = Number(await count())
      const a = await one(s, `select themis.bootstrap_me()`)
      const b = await one(s, `select themis.bootstrap_me()`)
      const after = Number(await count())
      // +1 workspace (×1000) and +1 profile, once.
      return [a === b && after - before === 1001, show({ a, b, before, after })]
    },
  )
  await rpc(
    "bootstrap_me: an invited-only user (A's viewer) gets their own workspace, stable, and stays viewer in A",
    U.viewerA,
    async (s) => {
      const a = await one(s, `select themis.bootstrap_me()`)
      const b = await one(s, `select themis.bootstrap_me()`)
      const inA = await roleOf(s, WA, U.viewerA)
      return [a !== WA && a === b && inA === 'viewer', show({ a, b, inA })]
    },
  )
  await rpc(
    "bootstrap_me: an existing owner (A's) gets A back, no new workspace, profile kept",
    U.ownerA,
    async (s) => {
      const n0 = await s.sudo(() => s.count('workspaces'))
      const ws = await one(s, `select themis.bootstrap_me()`)
      const n1 = await s.sudo(() => s.count('workspaces'))
      const name = await s.sudo(() =>
        one(s, `select display_name from themis.profiles where user_id = $1`, [U.ownerA]),
      )
      return [ws === WA && n1 === n0 && name === 'Owner A', show({ ws, n0, n1, name })]
    },
  )
  await rpc('bootstrap_me: no JWT subject → not_authenticated', '', async (s) => {
    const o = await s.attempt(`select themis.bootstrap_me()`)
    return [erred(o, /not_authenticated/), show(o)]
  })

  // --- P2.5 import_local_decision ------------------------------------------------------------------
  console.log('\n--- client RPCs: import_local_decision ---')
  const KEY = '7a1c0e52-3f7e-4b3a-9d55-0c3f2b9b1e01'
  const PAYLOAD = Object.freeze({
    client_import_id: KEY,
    question: 'Build or buy?',
    methodology: 'agile',
    scale: 'mid',
    criteria: [
      { id: 'c1', name: 'Cost', weight: 5 },
      { id: 'c2', name: 'Speed', weight: 0 },
    ],
    options: [
      { id: 'o1', name: 'Build' },
      { id: 'o2', name: 'Buy' },
    ],
    scores: { o1: { c1: 1, c2: 5 }, o2: { c1: 4 } },
  })
  const imp = (/** @type {Session} */ s, /** @type {unknown} */ ws, /** @type {unknown} */ p) =>
    s.attempt(`select themis.import_local_decision($1, $2::jsonb)`, [ws, JSON.stringify(p)])
  const impId = (/** @type {Session} */ s, /** @type {unknown} */ ws, /** @type {unknown} */ p) =>
    one(s, `select themis.import_local_decision($1, $2::jsonb)`, [ws, JSON.stringify(p)])
  /** Rows of every table an import writes, in workspace `ws` (read as the superuser). */
  const importRows = (/** @type {Session} */ s, /** @type {string} */ ws) =>
    s.sudo(() =>
      one(
        s,
        `select concat_ws(',', (select count(*) from themis.decisions where workspace_id = $1),
                               (select count(*) from themis.options where workspace_id = $1),
                               (select count(*) from themis.criteria where workspace_id = $1),
                               (select count(*) from themis.scores where workspace_id = $1),
                               (select count(*) from themis.audit_log where workspace_id = $1))`,
        [ws],
      ),
    )

  await rpc(
    'import_local_decision: an editor imports into A — decision, criteria, options and scores as sent, one audit row',
    U.editorA,
    async (s) => {
      const id = await impId(s, WA, PAYLOAD)
      const got = await s.sudo(async () => ({
        d: await s.rows(
          `select question, methodology, scale, status, frozen, revision, created_by
             from themis.decisions where id = $1`,
          [id],
        ),
        c: (
          await s.rows(
            `select name, weight, position from themis.criteria where decision_id = $1 order by position`,
            [id],
          )
        ).map((r) => [r.name, r.weight, r.position]),
        o: (
          await s.rows(
            `select name, position from themis.options where decision_id = $1 order by position`,
            [id],
          )
        ).map((r) => [r.name, r.position]),
        sc: (
          await s.rows(
            `select o.name as o, c.name as c, x.value from themis.scores x
               join themis.options o on o.id = x.option_id
               join themis.criteria c on c.id = x.criterion_id
              where x.decision_id = $1 order by 1, 2`,
            [id],
          )
        ).map((r) => [r.o, r.c, r.value]),
        a: await s.rows(
          `select actor, action, after ->> 'client_import_id' as k from themis.audit_log where entity_id = $1`,
          [id],
        ),
      }))
      const d = got.d[0]
      const ok =
        d?.question === 'Build or buy?' &&
        d.methodology === 'agile' &&
        d.scale === 'mid' &&
        d.status === 'draft' &&
        d.frozen === false &&
        d.revision === 1 &&
        d.created_by === U.editorA &&
        show(got.c) ===
          show([
            ['Cost', 5, 0],
            ['Speed', 0, 1],
          ]) &&
        show(got.o) ===
          show([
            ['Build', 0],
            ['Buy', 1],
          ]) &&
        show(got.sc) ===
          show([
            ['Build', 'Cost', 1],
            ['Build', 'Speed', 5],
            ['Buy', 'Cost', 4],
          ]) &&
        got.a.length === 1 &&
        got.a[0].actor === U.editorA &&
        got.a[0].action === 'import_local' &&
        got.a[0].k === KEY
      return [ok, show(got)]
    },
  )
  await rpc(
    'import_local_decision: the same client_import_id twice → one decision (the same id), one audit row',
    U.editorA,
    async (s) => {
      const before = await importRows(s, WA)
      const a = await impId(s, WA, PAYLOAD)
      const mid = await importRows(s, WA)
      const b = await impId(s, WA, PAYLOAD)
      const after = await importRows(s, WA)
      return [a === b && mid === after && before !== mid, show({ a, b, before, mid, after })]
    },
  )
  await rpc(
    'import_local_decision: the same key by another editor+ of A with a different payload → the first id, nothing written',
    U.editorA,
    async (s) => {
      const a = await impId(s, WA, PAYLOAD)
      const mid = await importRows(s, WA)
      await callAs(s, U.ownerA)
      const b = await impId(s, WA, { ...PAYLOAD, question: 'changed', options: [] })
      const after = await importRows(s, WA)
      return [a === b && mid === after, show({ a, b, mid, after })]
    },
  )
  await rpc(
    'import_local_decision: UA into B → not_authorized, B unchanged (no decision, no audit row)',
    U.ownerA,
    async (s) => {
      const before = await importRows(s, WB)
      const o = await imp(s, WB, PAYLOAD)
      const after = await importRows(s, WB)
      return [erred(o, /not_authorized/) && before === after, show({ o, before, after })]
    },
  )
  await rpc(
    "import_local_decision: UB into A with A's used key → not_authorized, A's decision id not revealed",
    U.editorA,
    async (s) => {
      const id = String(await impId(s, WA, PAYLOAD))
      const before = await importRows(s, WA)
      await callAs(s, U.ownerB)
      const o = await imp(s, WA, PAYLOAD)
      const after = await importRows(s, WA)
      const leaked = !o.ok && o.error.includes(id)
      return [erred(o, /not_authorized/) && !leaked && before === after, show({ o, before, after })]
    },
  )
  await rpc(
    "import_local_decision: A's viewer, a non-member and a null/unknown workspace are refused, nothing written",
    U.viewerA,
    async (s) => {
      const before = await importRows(s, WA)
      const outcomes = [await imp(s, WA, PAYLOAD)]
      await callAs(s, U.loner)
      outcomes.push(await imp(s, WA, PAYLOAD))
      await callAs(s, U.adminA)
      outcomes.push(await imp(s, null, PAYLOAD))
      outcomes.push(await imp(s, '99999999-0000-4000-8000-000000000000', PAYLOAD))
      const after = await importRows(s, WA)
      return [
        outcomes.every((o) => erred(o, /not_authorized/)) && before === after,
        show({ outcomes, before, after }),
      ]
    },
  )
  await rpc(
    'import_local_decision: the same key in B by B → a separate decision in B (the key is per workspace)',
    U.editorA,
    async (s) => {
      const a = await impId(s, WA, PAYLOAD)
      await callAs(s, U.ownerB)
      const b = await impId(s, WB, PAYLOAD)
      const inB = await s.sudo(() =>
        one(s, `select workspace_id from themis.decisions where id = $1`, [b]),
      )
      return [a !== b && inB === WB, show({ a, b, inB })]
    },
  )

  // Every bad payload is refused, and together they leave ZERO residue (the import is atomic).
  let badKey = 10
  const bad = (/** @type {string} */ label, /** @type {Record<string, unknown>} */ patch) =>
    /** @type {[string, unknown]} */ ([
      label,
      { ...PAYLOAD, client_import_id: `7a1c0e52-3f7e-4b3a-9d55-0c3f2b9b1e${badKey++}`, ...patch },
    ])
  /** @type {[string, unknown][]} */
  const BAD_PAYLOADS = [
    ['not an object', [1, 2]],
    ['no client_import_id', { ...PAYLOAD, client_import_id: undefined }],
    ['client_import_id not a uuid', { ...PAYLOAD, client_import_id: 'abc' }],
    ['client_import_id a number', { ...PAYLOAD, client_import_id: 5 }],
    bad('weight 6', { criteria: [{ id: 'c1', name: 'x', weight: 6 }] }),
    bad('weight -1', { criteria: [{ id: 'c1', name: 'x', weight: -1 }] }),
    bad('weight 2.5', { criteria: [{ id: 'c1', name: 'x', weight: 2.5 }] }),
    bad('weight "3"', { criteria: [{ id: 'c1', name: 'x', weight: '3' }] }),
    bad('weight missing', { criteria: [{ id: 'c1', name: 'x' }] }),
    bad('score 0', { scores: { o1: { c1: 0 } } }),
    bad('score 6', { scores: { o1: { c1: 6 } } }),
    bad('score 4.5', { scores: { o1: { c1: 4.5 } } }),
    bad('score null', { scores: { o1: { c1: null } } }),
    bad('score of an unknown option', { scores: { zz: { c1: 3 } } }),
    bad('score of an unknown criterion', { scores: { o1: { zz: 3 } } }),
    bad('scores an array', { scores: [1] }),
    bad('duplicate option id', {
      options: [
        { id: 'o1', name: 'a' },
        { id: 'o1', name: 'b' },
      ],
    }),
    bad('duplicate criterion id', {
      criteria: [
        { id: 'c1', name: 'a', weight: 1 },
        { id: 'c1', name: 'b', weight: 1 },
      ],
    }),
    bad('empty option id', { options: [{ id: '', name: 'a' }], scores: {} }),
    bad('option id over 64 chars', { options: [{ id: 'x'.repeat(65), name: 'a' }], scores: {} }),
    bad('option without a name', { options: [{ id: 'o1' }] }),
    bad('options not an array', { options: { id: 'o1' } }),
    bad('unknown methodology', { methodology: 'kanban' }),
    bad('scale missing', { scale: undefined }),
    bad('question a number', { question: 5 }),
    bad('question over 1000 chars', { question: 'q'.repeat(1001) }),
    bad('option name over 200 chars', {
      options: [{ id: 'o1', name: 'n'.repeat(201) }],
      scores: {},
    }),
    bad('101 options', {
      options: Array.from({ length: 101 }, (_, i) => ({ id: `o${i}`, name: 'x' })),
      scores: {},
    }),
  ]
  await guarded(`import_local_decision: ${BAD_PAYLOADS.length} bad payloads are each refused`, () =>
    actAs(U.editorA, async (s) => {
      const accepted = []
      for (const [label, p] of BAD_PAYLOADS) {
        const o = await imp(s, WA, p)
        check(`import_local_decision refuses: ${label}`, !o.ok, o.ok ? 'ACCEPTED' : '')
        if (o.ok) accepted.push(label)
      }
      return [accepted.length === 0, accepted.join(', ')]
    }),
  )
  await rpc(
    'import_local_decision: the refused payloads left 0 residue (decisions, options, criteria, scores, audit_log)',
    U.editorA,
    async (s) => {
      const before = await importRows(s, WA)
      for (const [, p] of BAD_PAYLOADS) await imp(s, WA, p)
      const after = await importRows(s, WA)
      return [before === after, `before ${before}, after ${after}`]
    },
  )
  await rpc(
    'import_local_decision: a minimal payload and scores: null are accepted; an upper-case key dedupes with its lower-case form',
    U.editorA,
    async (s) => {
      const k2 = '8a1c0e52-3f7e-4b3a-9d55-0c3f2b9b1e02'
      const min = await imp(s, WA, {
        client_import_id: '8a1c0e52-3f7e-4b3a-9d55-0c3f2b9b1e01',
        methodology: 'yolo',
        scale: 'small',
      })
      const a = await impId(s, WA, { ...PAYLOAD, client_import_id: k2, scores: null })
      const b = await impId(s, WA, { ...PAYLOAD, client_import_id: k2.toUpperCase() })
      return [min.ok && a === b, show({ min, a, b })]
    },
  )
  await rpc(
    'import_local_decision: once the imported decision is deleted, the same key imports again',
    U.editorA,
    async (s) => {
      const a = await impId(s, WA, PAYLOAD)
      const del = await s.attempt(`delete from themis.decisions where id = $1`, [a])
      const b = await impId(s, WA, PAYLOAD)
      return [del.ok && del.affected === 1 && a !== b, show({ a, b, del })]
    },
  )

  // --- P2.6 create_invite --------------------------------------------------------------------------
  console.log('\n--- client RPCs: create_invite ---')
  await rpc('create_invite: an owner gets a raw 64 lower-hex token', U.ownerA, async (s) => {
    const tok = await invite(s, INVITEE_EMAIL, 'editor')
    return [/^[0-9a-f]{64}$/.test(tok), tok]
  })
  await rpc(
    'create_invite: the row stores only sha256(token) hex; the raw token is stored nowhere in invites',
    U.ownerA,
    async (s) => {
      const tok = await invite(s, INVITEE_EMAIL, 'editor')
      const rows = await s.sudo(() =>
        s.rows(`select token_hash from themis.invites where email = $1`, [INVITEE_EMAIL]),
      )
      const anywhere = await s.sudo(() =>
        one(
          s,
          `select count(*)::int from themis.invites i where strpos(to_jsonb(i)::text, $1) > 0`,
          [tok],
        ),
      )
      const ok = rows.length === 1 && rows[0].token_hash === sha256hex(tok) && anywhere === 0
      return [ok, show({ rows, anywhere })]
    },
  )
  await rpc(
    'create_invite: email lower-cased and trimmed, role as asked, created_by = caller, expires in 7 days; two invites, two tokens',
    U.ownerA,
    async (s) => {
      const tok = await invite(s, '  Invitee@EXAMPLE.com ', 'editor')
      const tok2 = await invite(s, INVITEE_EMAIL, 'editor')
      const r = (
        await s.sudo(() =>
          s.rows(
            `select email, role, created_by,
                    extract(epoch from (expires_at - now())) / 86400 as days
               from themis.invites where token_hash = $1`,
            [sha256hex(tok)],
          ),
        )
      )[0]
      const ok =
        r?.email === INVITEE_EMAIL &&
        r.role === 'editor' &&
        r.created_by === U.ownerA &&
        Math.abs(Number(r.days) - 7) < 0.001 &&
        tok !== tok2
      return [ok, show(r)]
    },
  )
  await rpc('create_invite: an admin may invite an editor and an admin', U.adminA, async (s) => {
    const e = await s.attempt(`select themis.create_invite($1, 'e@example.com', 'editor')`, [WA])
    const a = await s.attempt(`select themis.create_invite($1, 'e@example.com', 'admin')`, [WA])
    return [e.ok && a.ok, show({ e, a })]
  })
  await rpc(
    'create_invite: an admin cannot invite an owner (not_authorized, nothing stored)',
    U.adminA,
    async (s) => {
      const before = await s.sudo(() => s.count('invites'))
      const o = await s.attempt(`select themis.create_invite($1, 'o@example.com', 'owner')`, [WA])
      const after = await s.sudo(() => s.count('invites'))
      return [erred(o, /not_authorized/) && before === after, show(o)]
    },
  )
  await rpc(
    "create_invite: an editor, a viewer, B's owner and a non-member are refused (not_authorized, nothing stored)",
    U.editorA,
    async (s) => {
      const before = await s.sudo(() => s.count('invites'))
      const outcomes = []
      for (const u of [U.editorA, U.viewerA, U.ownerB, U.loner]) {
        await callAs(s, u)
        outcomes.push(
          await s.attempt(`select themis.create_invite($1, 'e@example.com', 'viewer')`, [WA]),
        )
      }
      const after = await s.sudo(() => s.count('invites'))
      return [outcomes.every((o) => erred(o, /not_authorized/)) && before === after, show(outcomes)]
    },
  )
  await rpc(
    "create_invite: A's owner into B, or a null workspace → not_authorized",
    U.ownerA,
    async (s) => {
      const b = await s.attempt(`select themis.create_invite($1, 'o@example.com', 'viewer')`, [WB])
      const n = await s.attempt(`select themis.create_invite(null, 'o@example.com', 'viewer')`)
      return [erred(b, /not_authorized/) && erred(n, /not_authorized/), show({ b, n })]
    },
  )
  await rpc(
    'create_invite: a bad or null role or email → invalid_argument',
    U.ownerA,
    async (s) => {
      const outcomes = [
        await s.attempt(`select themis.create_invite($1, 'o@example.com', 'boss')`, [WA]),
        await s.attempt(`select themis.create_invite($1, 'o@example.com', null)`, [WA]),
        await s.attempt(`select themis.create_invite($1, null, 'viewer')`, [WA]),
      ]
      for (const e of ['nope', '', 'a b@c.d', 'a@b@c'])
        outcomes.push(await s.attempt(`select themis.create_invite($1, $2, 'viewer')`, [WA, e]))
      return [outcomes.every((o) => erred(o, /invalid_argument/)), show(outcomes)]
    },
  )
  await rpc('create_invite: a direct INSERT into invites is still refused', U.ownerA, async (s) => {
    const o = await s.attempt(
      `insert into themis.invites (workspace_id, email, role, token_hash, expires_at)
       values ($1, 'z@example.com', 'viewer', repeat('c', 64), now() + interval '1 day')`,
      [WA],
    )
    return [refused(o), show(o)]
  })

  // --- P2.6 accept_invite --------------------------------------------------------------------------
  console.log('\n--- client RPCs: accept_invite ---')
  await rpc(
    'accept_invite: the invitee (mixed-case, confirmed email) joins with the invite role; accepted_at set',
    U.ownerA,
    async (s) => {
      await addRpcUsers(s)
      const tok = await invite(s, INVITEE_EMAIL, 'editor')
      await callAs(s, RPC_USERS.invitee)
      const unseen = await s.count('invites')
      const ws = await one(s, `select themis.accept_invite($1)`, [tok])
      const role = await roleOf(s, WA, RPC_USERS.invitee)
      const at = await s.sudo(() =>
        one(s, `select accepted_at is not null from themis.invites where token_hash = $1`, [
          sha256hex(tok),
        ]),
      )
      return [
        unseen === 0 && ws === WA && role === 'editor' && at === true,
        show({ unseen, ws, role, at }),
      ]
    },
  )
  await rpc(
    'accept_invite: a user with the WRONG email → invite_email_mismatch, no membership, invite still pending',
    U.ownerA,
    async (s) => {
      await addRpcUsers(s)
      const tok = await invite(s, INVITEE_EMAIL, 'editor')
      await callAs(s, U.loner)
      const o = await s.attempt(`select themis.accept_invite($1)`, [tok])
      const role = await roleOf(s, WA, U.loner)
      const pending = await s.sudo(() =>
        one(s, `select accepted_at is null from themis.invites where token_hash = $1`, [
          sha256hex(tok),
        ]),
      )
      return [
        erred(o, /invite_email_mismatch/) && role === null && pending === true,
        show({ o, role }),
      ]
    },
  )
  await rpc(
    'accept_invite: an UNCONFIRMED email (email_confirmed_at null) → email_not_verified, no membership',
    U.ownerA,
    async (s) => {
      await addRpcUsers(s)
      const nul = await s.sudo(() =>
        one(s, `select email_confirmed_at is null from auth.users where id = $1`, [
          RPC_USERS.unverified,
        ]),
      )
      const tok = await invite(s, UNVERIFIED_EMAIL, 'viewer')
      await callAs(s, RPC_USERS.unverified)
      const o = await s.attempt(`select themis.accept_invite($1)`, [tok])
      const role = await roleOf(s, WA, RPC_USERS.unverified)
      return [
        nul === true && erred(o, /email_not_verified/) && role === null,
        show({ nul, o, role }),
      ]
    },
  )
  await rpc(
    'accept_invite: an EXPIRED invite → invite_expired, no membership',
    U.ownerA,
    async (s) => {
      await addRpcUsers(s)
      const tok = await invite(s, INVITEE_EMAIL, 'viewer')
      await s.sudo(() =>
        s.rows(
          `update themis.invites set expires_at = now() - interval '1 second' where token_hash = $1`,
          [sha256hex(tok)],
        ),
      )
      await callAs(s, RPC_USERS.invitee)
      const o = await s.attempt(`select themis.accept_invite($1)`, [tok])
      const role = await roleOf(s, WA, RPC_USERS.invitee)
      return [erred(o, /invite_expired/) && role === null, show({ o, role })]
    },
  )
  await rpc('accept_invite: a REUSED invite → invite_used', U.ownerA, async (s) => {
    await addRpcUsers(s)
    const tok = await invite(s, INVITEE_EMAIL, 'viewer')
    await callAs(s, RPC_USERS.invitee)
    const first = await s.attempt(`select themis.accept_invite($1)`, [tok])
    const again = await s.attempt(`select themis.accept_invite($1)`, [tok])
    return [first.ok && erred(again, /invite_used/), show({ first, again })]
  })
  await rpc(
    'accept_invite: a used invite cannot re-admit a member removed since → invite_used, no membership',
    U.ownerA,
    async (s) => {
      await addRpcUsers(s)
      const tok = await invite(s, INVITEE_EMAIL, 'viewer')
      await callAs(s, RPC_USERS.invitee)
      await one(s, `select themis.accept_invite($1)`, [tok])
      await callAs(s, U.ownerA)
      await one(s, `select themis.remove_member($1, $2)`, [WA, RPC_USERS.invitee])
      await callAs(s, RPC_USERS.invitee)
      const o = await s.attempt(`select themis.accept_invite($1)`, [tok])
      const role = await roleOf(s, WA, RPC_USERS.invitee)
      return [erred(o, /invite_used/) && role === null, show({ o, role })]
    },
  )
  await rpc(
    'accept_invite: an unknown, malformed or null token, and a stored HASH used as the token → invite_invalid',
    RPC_USERS.invitee,
    async (s) => {
      await addRpcUsers(s)
      const outcomes = [
        await s.attempt(`select themis.accept_invite(repeat('e', 64))`),
        await s.attempt(`select themis.accept_invite(repeat('a', 64))`), // the fixture row's token_hash
        await s.attempt(`select themis.accept_invite(null)`),
      ]
      for (const t of ['', 'ABC', 'x'.repeat(64)])
        outcomes.push(await s.attempt(`select themis.accept_invite($1)`, [t]))
      return [outcomes.every((o) => erred(o, /invite_invalid/)), show(outcomes)]
    },
  )
  await rpc(
    'accept_invite: an existing member → already_member, role unchanged',
    U.ownerA,
    async (s) => {
      const tok = await invite(s, 'u2@example.com', 'owner') // u2 = A's editor
      await callAs(s, U.editorA)
      const o = await s.attempt(`select themis.accept_invite($1)`, [tok])
      const role = await roleOf(s, WA, U.editorA)
      return [erred(o, /already_member/) && role === 'editor', show({ o, role })]
    },
  )
  await rpc(
    'accept_invite: the inviter demoted since → invite_invalid, no membership',
    U.adminA,
    async (s) => {
      await addRpcUsers(s)
      const tok = await invite(s, INVITEE_EMAIL, 'admin')
      await s.sudo(() =>
        s.rows(
          `update themis.memberships set role = 'viewer' where workspace_id = $1 and user_id = $2`,
          [WA, U.adminA],
        ),
      )
      await callAs(s, RPC_USERS.invitee)
      const o = await s.attempt(`select themis.accept_invite($1)`, [tok])
      const role = await roleOf(s, WA, RPC_USERS.invitee)
      return [erred(o, /invite_invalid: the inviter/) && role === null, show({ o, role })]
    },
  )
  await rpc(
    'accept_invite: an owner invite whose inviter is now only admin → invite_invalid',
    U.ownerA,
    async (s) => {
      await addRpcUsers(s)
      const tok = await invite(s, INVITEE_EMAIL, 'owner')
      await s.sudo(() =>
        s.rows(
          `insert into themis.memberships (workspace_id, user_id, role) values ($1, $2, 'owner')`,
          [WA, RPC_USERS.owner2],
        ),
      )
      await s.sudo(() =>
        s.rows(
          `update themis.memberships set role = 'admin' where workspace_id = $1 and user_id = $2`,
          [WA, U.ownerA],
        ),
      )
      await callAs(s, RPC_USERS.invitee)
      const o = await s.attempt(`select themis.accept_invite($1)`, [tok])
      const role = await roleOf(s, WA, RPC_USERS.invitee)
      return [erred(o, /invite_invalid/) && role === null, show({ o, role })]
    },
  )
  await rpc(
    "accept_invite: an owner's owner invite → the invitee becomes owner",
    U.ownerA,
    async (s) => {
      await addRpcUsers(s)
      const tok = await invite(s, INVITEE_EMAIL, 'owner')
      await callAs(s, RPC_USERS.invitee)
      const ws = await one(s, `select themis.accept_invite($1)`, [tok])
      const role = await roleOf(s, WA, RPC_USERS.invitee)
      return [ws === WA && role === 'owner', show({ ws, role })]
    },
  )

  // --- P2.6 revoke_invite --------------------------------------------------------------------------
  console.log('\n--- client RPCs: revoke_invite ---')
  await rpc(
    "revoke_invite: an editor, and B's owner (cross-tenant), → invite_not_found; the invite is kept",
    U.ownerA,
    async (s) => {
      const id = await inviteId(s, await invite(s, 'r1@example.com', 'viewer'))
      const outcomes = []
      for (const u of [U.editorA, U.ownerB]) {
        await callAs(s, u)
        outcomes.push(await s.attempt(`select themis.revoke_invite($1)`, [id]))
      }
      const unknown = await s.attempt(`select themis.revoke_invite(gen_random_uuid())`)
      const kept = await s.sudo(() => s.count('invites', `id = '${id}'`))
      return [
        outcomes.every((o) => erred(o, /invite_not_found/)) &&
          erred(unknown, /invite_not_found/) &&
          kept === 1,
        show({ outcomes, unknown, kept }),
      ]
    },
  )
  await rpc(
    'revoke_invite: an admin cannot revoke an owner invite; the owner can',
    U.ownerA,
    async (s) => {
      const id = await inviteId(s, await invite(s, 'r2@example.com', 'owner'))
      await callAs(s, U.adminA)
      const a = await s.attempt(`select themis.revoke_invite($1)`, [id])
      await callAs(s, U.ownerA)
      const o = await s.attempt(`select themis.revoke_invite($1)`, [id])
      const left = await s.sudo(() => s.count('invites', `id = '${id}'`))
      return [erred(a, /not_authorized/) && o.ok && left === 0, show({ a, o, left })]
    },
  )
  await rpc(
    'revoke_invite: an admin revokes a pending invite (the row is gone, it cannot be accepted)',
    U.ownerA,
    async (s) => {
      await addRpcUsers(s)
      const tok = await invite(s, INVITEE_EMAIL, 'viewer')
      const id = await inviteId(s, tok)
      await callAs(s, U.adminA)
      const o = await s.attempt(`select themis.revoke_invite($1)`, [id])
      const left = await s.sudo(() => s.count('invites', `id = '${id}'`))
      await callAs(s, RPC_USERS.invitee)
      const acc = await s.attempt(`select themis.accept_invite($1)`, [tok])
      return [o.ok && left === 0 && erred(acc, /invite_invalid/), show({ o, left, acc })]
    },
  )
  await rpc(
    'revoke_invite: an accepted invite → invite_used (kept as history)',
    U.ownerA,
    async (s) => {
      await addRpcUsers(s)
      const tok = await invite(s, INVITEE_EMAIL, 'viewer')
      const id = await inviteId(s, tok)
      await callAs(s, RPC_USERS.invitee)
      await one(s, `select themis.accept_invite($1)`, [tok])
      await callAs(s, U.ownerA)
      const o = await s.attempt(`select themis.revoke_invite($1)`, [id])
      return [erred(o, /invite_used/), show(o)]
    },
  )

  // --- P2.6 set_member_role ------------------------------------------------------------------------
  console.log('\n--- client RPCs: set_member_role ---')
  await rpc(
    'set_member_role: an admin self-promoting to owner → not_authorized, still admin',
    U.adminA,
    async (s) => {
      const o = await s.attempt(`select themis.set_member_role($1, $2, 'owner')`, [WA, U.adminA])
      const role = await roleOf(s, WA, U.adminA)
      return [erred(o, /not_authorized/) && role === 'admin', show({ o, role })]
    },
  )
  await rpc(
    'set_member_role: an admin promoting an editor to owner, or demoting the owner → not_authorized',
    U.adminA,
    async (s) => {
      const p = await s.attempt(`select themis.set_member_role($1, $2, 'owner')`, [WA, U.editorA])
      const d = await s.attempt(`select themis.set_member_role($1, $2, 'admin')`, [WA, U.ownerA])
      const roles = [await roleOf(s, WA, U.editorA), await roleOf(s, WA, U.ownerA)]
      return [
        erred(p, /not_authorized/) &&
          erred(d, /not_authorized/) &&
          show(roles) === show(['editor', 'owner']),
        show({ p, d, roles }),
      ]
    },
  )
  await rpc(
    'set_member_role: an admin changes viewer → editor and demotes itself (takes effect), then has no authority left',
    U.adminA,
    async (s) => {
      const a = await s.attempt(`select themis.set_member_role($1, $2, 'editor')`, [WA, U.viewerA])
      const v = await roleOf(s, WA, U.viewerA)
      const self = await s.attempt(`select themis.set_member_role($1, $2, 'viewer')`, [
        WA,
        U.adminA,
      ])
      const after = await s.attempt(`select themis.set_member_role($1, $2, 'viewer')`, [
        WA,
        U.editorA,
      ])
      return [
        a.ok && v === 'editor' && self.ok && erred(after, /not_authorized/),
        show({ a, v, self, after }),
      ]
    },
  )
  await rpc(
    'set_member_role: the LAST owner demoting self → last_owner, still owner',
    U.ownerA,
    async (s) => {
      const o = await s.attempt(`select themis.set_member_role($1, $2, 'admin')`, [WA, U.ownerA])
      const role = await roleOf(s, WA, U.ownerA)
      return [erred(o, /last_owner/) && role === 'owner', show({ o, role })]
    },
  )
  await rpc(
    'set_member_role: with two owners one may step down; the remaining owner cannot (last_owner)',
    U.ownerA,
    async (s) => {
      const promote = await s.attempt(`select themis.set_member_role($1, $2, 'owner')`, [
        WA,
        U.adminA,
      ])
      const down = await s.attempt(`select themis.set_member_role($1, $2, 'viewer')`, [
        WA,
        U.ownerA,
      ])
      await callAs(s, U.adminA)
      const last = await s.attempt(`select themis.set_member_role($1, $2, 'editor')`, [
        WA,
        U.adminA,
      ])
      const role = await roleOf(s, WA, U.adminA)
      return [
        promote.ok && down.ok && erred(last, /last_owner/) && role === 'owner',
        show({ promote, down, last, role }),
      ]
    },
  )
  await rpc(
    'set_member_role: a bad role → invalid_argument; a non-member target → member_not_found; the same role is a no-op',
    U.ownerA,
    async (s) => {
      const b = await s.attempt(`select themis.set_member_role($1, $2, 'boss')`, [WA, U.viewerA])
      const m = await s.attempt(`select themis.set_member_role($1, $2, 'viewer')`, [WA, U.ownerB])
      const same = await s.attempt(`select themis.set_member_role($1, $2, 'owner')`, [WA, U.ownerA])
      return [
        erred(b, /invalid_argument/) && erred(m, /member_not_found/) && same.ok,
        show({ b, m, same }),
      ]
    },
  )
  await rpc(
    "set_member_role: an editor, a viewer, a non-member and A's owner on B are refused; a direct UPDATE of memberships.role too",
    U.editorA,
    async (s) => {
      const outcomes = []
      for (const u of [U.editorA, U.viewerA, U.loner]) {
        await callAs(s, u)
        outcomes.push(await s.attempt(`select themis.set_member_role($1, $2, 'owner')`, [WA, u]))
      }
      await callAs(s, U.ownerA)
      outcomes.push(
        await s.attempt(`select themis.set_member_role($1, $2, 'viewer')`, [WB, U.ownerB]),
      )
      const direct = await s.attempt(
        `update themis.memberships set role = 'owner' where user_id = $1`,
        [U.viewerA],
      )
      const roles = [
        await roleOf(s, WA, U.editorA),
        await roleOf(s, WA, U.viewerA),
        await roleOf(s, WB, U.ownerB),
      ]
      return [
        outcomes.every((o) => erred(o, /not_authorized/)) &&
          refused(direct) &&
          show(roles) === show(['editor', 'viewer', 'owner']),
        show({ outcomes, direct, roles }),
      ]
    },
  )

  // --- P2.6 remove_member --------------------------------------------------------------------------
  console.log('\n--- client RPCs: remove_member ---')
  await rpc('remove_member: an admin cannot remove the owner', U.adminA, async (s) => {
    const o = await s.attempt(`select themis.remove_member($1, $2)`, [WA, U.ownerA])
    const role = await roleOf(s, WA, U.ownerA)
    return [erred(o, /not_authorized/) && role === 'owner', show({ o, role })]
  })
  await rpc('remove_member: an admin removes an editor, then itself', U.adminA, async (s) => {
    const e = await s.attempt(`select themis.remove_member($1, $2)`, [WA, U.editorA])
    const self = await s.attempt(`select themis.remove_member($1, $2)`, [WA, U.adminA])
    const roles = [await roleOf(s, WA, U.editorA), await roleOf(s, WA, U.adminA)]
    return [e.ok && self.ok && show(roles) === show([null, null]), show({ e, self, roles })]
  })
  await rpc(
    'remove_member: the LAST owner cannot remove self → last_owner, still owner',
    U.ownerA,
    async (s) => {
      const o = await s.attempt(`select themis.remove_member($1, $2)`, [WA, U.ownerA])
      const role = await roleOf(s, WA, U.ownerA)
      return [erred(o, /last_owner/) && role === 'owner', show({ o, role })]
    },
  )
  await rpc(
    'remove_member: with two owners, an owner removes the other, and may leave',
    U.ownerA,
    async (s) => {
      await addRpcUsers(s)
      const add = () =>
        s.sudo(() =>
          s.rows(
            `insert into themis.memberships (workspace_id, user_id, role) values ($1, $2, 'owner')`,
            [WA, RPC_USERS.owner2],
          ),
        )
      await add()
      const other = await s.attempt(`select themis.remove_member($1, $2)`, [WA, RPC_USERS.owner2])
      await add()
      const leave = await s.attempt(`select themis.remove_member($1, $2)`, [WA, U.ownerA])
      const roles = [await roleOf(s, WA, U.ownerA), await roleOf(s, WA, RPC_USERS.owner2)]
      return [
        other.ok && leave.ok && show(roles) === show([null, 'owner']),
        show({ other, leave, roles }),
      ]
    },
  )
  await rpc(
    "remove_member: a non-member → member_not_found; A's owner on B → not_authorized, B's owner stays",
    U.ownerA,
    async (s) => {
      const m = await s.attempt(`select themis.remove_member($1, $2)`, [WA, U.loner])
      const b = await s.attempt(`select themis.remove_member($1, $2)`, [WB, U.ownerB])
      const role = await roleOf(s, WB, U.ownerB)
      return [
        erred(m, /member_not_found/) && erred(b, /not_authorized/) && role === 'owner',
        show({ m, b, role }),
      ]
    },
  )
  await rpc(
    "remove_member: an editor, a viewer and B's owner cannot remove a member of A",
    U.editorA,
    async (s) => {
      const outcomes = []
      for (const u of [U.editorA, U.viewerA, U.ownerB]) {
        await callAs(s, u)
        outcomes.push(await s.attempt(`select themis.remove_member($1, $2)`, [WA, U.viewerA]))
      }
      const role = await roleOf(s, WA, U.viewerA)
      return [
        outcomes.every((o) => erred(o, /not_authorized/)) && role === 'viewer',
        show({ outcomes, role }),
      ]
    },
  )

  // Every RPC check above ran in a rolled-back session: the committed fixture is exactly as seeded.
  await guarded(
    'client RPCs: the committed fixture is unchanged (every check rolled back)',
    async () => {
      const r = (
        await q(
          `select (select count(*) from themis.memberships)::int as m,
                      (select count(*) from themis.invites)::int as i,
                      (select count(*) from themis.workspaces)::int as w,
                      (select count(*) from themis.decisions)::int as d,
                      (select count(*) from auth.users where id = any ($1::uuid[]))::int as extra`,
          [Object.values(RPC_USERS)],
        )
      ).rows[0]
      return [show(r) === show({ m: 5, i: 2, w: 2, d: 3, extra: 0 }), show(r)]
    },
  )

  console.log('')
  if (failures > 0) {
    console.log(`GATE FAILED — ${failures} check(s) red.`)
    return 1
  }
  console.log(
    'GATE PASSED — migrations apply (twice) on a fresh copy of the shared project; structure, coverage and the A/B leak matrix are green.',
  )
  return 0
}
