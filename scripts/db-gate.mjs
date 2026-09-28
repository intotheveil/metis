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
// P1.8 adds the structural sweep over every themis table and the per-table leak matrix.

import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installShim, HEPHAESTUS_MIGRATION_ROWS } from './db-gate/shim.mjs'

// Overridable so the gate can be pointed at a MUTATED copy of the archive and proven to go red
// (P1.9). A gate nobody has ever seen fail is not a gate.
const MIG =
  process.env.DB_GATE_MIGRATIONS ??
  fileURLToPath(new URL('../supabase/migrations', import.meta.url))

const db = new PGlite()
const q = (sql, params) => db.query(sql, params)
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

// --- the shared project, as Themis finds it ----------------------------------------------------
await installShim(db)
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

console.log('')
if (failures > 0) {
  console.log(`GATE FAILED — ${failures} check(s) red.`)
  process.exit(1)
}
console.log('GATE PASSED — migrations apply (twice) on a fresh copy of the shared project.')
