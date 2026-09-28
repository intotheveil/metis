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

import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installShim, HEPHAESTUS_MIGRATION_ROWS } from './db-gate/shim.mjs'
import { runGuard } from './check-migrations.mjs'
import {
  ACTORS,
  ANON,
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

// --- static guard first (P1.3): nothing outside schema `themis`, well-formed names ----------------
// A migration that reaches into Hephaestus's schemas must never even be executed, not even in wasm.
if (!runGuard(MIG)) {
  console.log(
    '\nGATE FAILED — the static migration guard is red (npm run db:check); nothing was applied.',
  )
  process.exit(1)
}
console.log('')

const db = new PGlite()
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
  process.exit(1)
}
for (const f of files) {
  try {
    await db.exec(readFileSync(path.join(MIG, f), 'utf8'))
    console.log(`applied  ${f}`)
  } catch (e) {
    check(`apply ${f}`, false, e instanceof Error ? e.message : String(e))
    console.log('\nAPPLY FAILED — stopping.')
    process.exit(1)
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
  process.exit(1)
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
      const got = (await relPrivs('authenticated', T)).filter((p) => CLIENT_WRITE_PRIVS.includes(p))
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

console.log('')
if (failures > 0) {
  console.log(`GATE FAILED — ${failures} check(s) red.`)
  process.exit(1)
}
console.log(
  'GATE PASSED — migrations apply (twice) on a fresh copy of the shared project; structure, coverage and the A/B leak matrix are green.',
)
