// THE READ-ONLY LIVE SNAPSHOT — `npm run db:snapshot -- <label>` (PLAN P1.12, ADR-0002)
//
// Records the catalogue state of Hephaestus's LIVE shared Supabase project around a Themis live
// apply, so `npm run db:snapshot:diff -- pre post` can prove that nothing outside schema `themis`
// changed. It goes through the ONE Management-API client (`scripts/lib/mgmt-api.mjs`, P1.11).
//
//   READ-ONLY BY CONSTRUCTION. Every request goes through `readOnlyClient`, which refuses (throws,
//   sends nothing) any statement that is not ONE plain SELECT over the system catalogues
//   (pg_catalog.*, information_schema.*) or Hephaestus's ledger supabase_migrations.schema_migrations,
//   calling only allow-listed pure functions. Every query is validated BEFORE the first request.
//
// Env (names only; no .env file is read): SUPABASE_ACCESS_TOKEN, THEMIS_SUPABASE_PROJECT_REF.
// Missing either → exit 2, nothing sent.
//
// Output: ops-snapshots/<iso>-<label>.json (gitignored). Definitions are stored as md5 hashes, never
// as text, and role-setting values are hashed too, so the file carries shape, not Hephaestus's code.
//
// What it captures (object-level detail for the five schemas ADR-0002 names; `schemas` lists ALL
// non-system schemas, so a brand-new schema anywhere shows up too):
//   schemas · relations (tables, views, indexes, sequences: RLS, owner, ACL, columns hash, definition
//   hash) · constraints · policies · functions · triggers (incl. every trigger on auth.users) · types ·
//   default_acl · extensions · roles (the API roles) · role_settings (pgrst.db_schemas split per
//   schema) · publication_tables · event_triggers · migrations_ledger (supabase_migrations versions).
// Each row carries `schema`: the schema that OWNS the fact (null for database-level facts). The diff
// allows a change only where `schema === 'themis'`.
//
// Exit: 0 written · 1 refused / API error · 2 usage (bad label, missing env).

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MgmtApiError, createMgmtClient, redact } from './lib/mgmt-api.mjs'

export const ENV_TOKEN = 'SUPABASE_ACCESS_TOKEN'
export const ENV_REF = 'THEMIS_SUPABASE_PROJECT_REF'
export const FORMAT = 'themis-db-snapshot/1'
export const THEMIS = 'themis'
export const DEFAULT_OUT_DIR = fileURLToPath(new URL('../ops-snapshots', import.meta.url))

/** The schemas ADR-0002 names: object-level detail is captured for these. */
export const SCOPED_SCHEMAS = ['public', 'auth', 'storage', 'supabase_migrations', THEMIS]
const IN_SCOPED = `(${SCOPED_SCHEMAS.map((s) => `'${s}'`).join(', ')})`

/** The only relations a snapshot query may read. */
export const ALLOWED_RELATION_PREFIXES = ['pg_catalog.', 'information_schema.']
export const ALLOWED_RELATIONS = ['supabase_migrations.schema_migrations']

/** The only functions a snapshot query may call: all pure catalogue readers / aggregates. */
export const ALLOWED_FUNCTIONS = new Set([
  'array_to_string',
  'coalesce',
  'count',
  'format_type',
  'left',
  'max',
  'md5',
  'pg_get_constraintdef',
  'pg_get_expr',
  'pg_get_function_identity_arguments',
  'pg_get_function_result',
  'pg_get_indexdef',
  'pg_get_triggerdef',
  'pg_get_userbyid',
  'pg_get_viewdef',
  'string_agg',
  'unnest',
])
/** SQL keywords that may legitimately be followed by "(". */
const PAREN_KEYWORDS = new Set([
  'and',
  'as',
  'else',
  'exists',
  'from',
  'in',
  'join',
  'not',
  'on',
  'or',
  'select',
  'then',
  'when',
  'where',
])
/** Words that never appear in a read-only snapshot query (defence in depth on top of the above). */
export const FORBIDDEN_WORDS = [
  'insert',
  'update',
  'delete',
  'merge',
  'upsert',
  'create',
  'alter',
  'drop',
  'truncate',
  'grant',
  'revoke',
  'comment',
  'copy',
  'call',
  'do',
  'execute',
  'set',
  'reset',
  'begin',
  'commit',
  'rollback',
  'abort',
  'savepoint',
  'release',
  'prepare',
  'deallocate',
  'discard',
  'vacuum',
  'analyze',
  'cluster',
  'reindex',
  'refresh',
  'checkpoint',
  'lock',
  'listen',
  'notify',
  'unlisten',
  'load',
  'import',
  'into',
  'share',
  'nowait',
  'returning',
  'security',
]
/** A FROM clause ends at these words (same paren depth). */
const FROM_ENDERS = new Set([
  'where',
  'group',
  'order',
  'having',
  'limit',
  'offset',
  'union',
  'intersect',
  'except',
  'window',
  'fetch',
  'for',
])

/** Thrown when a statement is not a plain catalogue SELECT. Nothing has been sent. */
export class ReadOnlyViolation extends Error {
  /** @param {string} reason @param {string} sql */
  constructor(reason, sql) {
    super(
      `REFUSED (read-only snapshot): ${reason} — in: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`,
    )
    this.name = 'ReadOnlyViolation'
  }
}

/**
 * Throw ReadOnlyViolation unless `sql` is ONE plain SELECT over the allowed relations that calls
 * only allow-listed functions. Conservative: anything it cannot reason about is refused.
 * @param {string} sql
 */
export function assertReadOnly(sql) {
  const fail = (/** @type {string} */ reason) => {
    throw new ReadOnlyViolation(reason, sql)
  }
  if (typeof sql !== 'string' || sql.trim() === '') fail('empty statement')
  // Characters that open constructs the checker would have to parse: dollar quoting, quoted
  // identifiers, escape strings, comments.
  if (sql.includes('$')) fail('dollar quoting / parameters are not allowed')
  if (sql.includes('"')) fail('quoted identifiers are not allowed')
  if (sql.includes('\\')) fail('backslashes are not allowed')
  if (sql.includes('--') || sql.includes('/*')) fail('comments are not allowed')

  // Blank string literals so their text can't hide or fake anything.
  const code = sql.replace(/'(?:[^']|'')*'/g, "''").toLowerCase()
  if (code.replace(/''/g, '').includes("'")) fail('unterminated string literal')

  const body = code.trim().replace(/;\s*$/, '')
  if (body.includes(';')) fail('more than one statement')
  if (!/^select\b/.test(body)) fail('not a SELECT')

  for (const w of FORBIDDEN_WORDS) {
    if (new RegExp(`\\b${w}\\b`).test(body)) fail(`forbidden word "${w}"`)
  }

  // Every call must be an allow-listed function (optionally pg_catalog-qualified) or a keyword.
  for (const m of body.matchAll(/([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\s*\(/g)) {
    const name = m[1].replace(/^pg_catalog\./, '')
    if (name.includes('.')) fail(`qualified call ${m[1]}() outside pg_catalog`)
    if (!ALLOWED_FUNCTIONS.has(name) && !PAREN_KEYWORDS.has(name)) {
      fail(`function ${m[1]}() is not on the read-only allow-list`)
    }
  }

  // Walk the tokens: every FROM/JOIN target is an allowed relation, a (subquery) or an allowed
  // function call; comma joins are refused (they would bypass the target check).
  const tokens = body.match(/[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*|''|::|[(),]|[^\s\w]/g) ?? []
  /** @type {boolean[]} inFrom per paren depth */
  const inFrom = [false]
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '(') inFrom.push(false)
    else if (t === ')') {
      inFrom.pop()
      if (inFrom.length === 0) fail('unbalanced parentheses')
    } else if (t === ',') {
      if (inFrom[inFrom.length - 1]) fail('comma join in FROM (use an explicit JOIN)')
    } else if (t === 'from' || t === 'join') {
      if (t === 'from') inFrom[inFrom.length - 1] = true
      const target = tokens[i + 1]
      if (target === undefined) fail(`${t} without a target`)
      if (target === '(' || tokens[i + 2] === '(') continue // subquery, or a call checked above
      const ok =
        ALLOWED_RELATION_PREFIXES.some((p) => target.startsWith(p)) ||
        ALLOWED_RELATIONS.includes(target)
      if (!ok) fail(`${t} ${target}: only pg_catalog.*, information_schema.* and ${ALLOWED_RELATIONS.join(', ')} may be read`)
    } else if (FROM_ENDERS.has(t)) {
      inFrom[inFrom.length - 1] = false
    }
  }
  if (inFrom.length !== 1) fail('unbalanced parentheses')
}

/**
 * Wrap a Management-API client so it can only ever send read-only catalogue SELECTs.
 * @param {import('./lib/mgmt-api.mjs').MgmtClient} client
 * @returns {import('./lib/mgmt-api.mjs').MgmtClient}
 */
export function readOnlyClient(client) {
  return {
    async query(sql) {
      assertReadOnly(sql)
      return client.query(sql)
    },
  }
}

/**
 * @typedef {Record<string, unknown>} Row
 * @typedef {{ name: string, key: string[], sql: string, post?: (rows: Row[]) => Row[] }} Section
 */

const md5 = (/** @type {string} */ s) => createHash('md5').update(s, 'utf8').digest('hex')

/**
 * One row per (role, database, setting). `pgrst.db_schemas` (the Data API's exposed schemas when it
 * is set as a role setting) is split into one row PER SCHEMA, owned by that schema, so exposing
 * `themis` is a themis-only change while dropping any other schema from the list is not. Every other
 * value is stored as an md5 only.
 * @param {Row[]} rows
 * @returns {Row[]}
 */
export function splitRoleSettings(rows) {
  /** @type {Row[]} */
  const out = []
  for (const r of rows) {
    const setting = String(r.setting ?? '')
    const eq = setting.indexOf('=')
    const name = eq < 0 ? setting : setting.slice(0, eq)
    const value = eq < 0 ? '' : setting.slice(eq + 1)
    const base = { role: String(r.role ?? '*'), database: String(r.database ?? ''), setting: name }
    if (name === 'pgrst.db_schemas') {
      for (const s of value.split(',').map((x) => x.trim().replace(/^"|"$/g, ''))) {
        if (s) out.push({ schema: s, ...base, value: s })
      }
    } else {
      out.push({ schema: null, ...base, value_md5: md5(value) })
    }
  }
  return out
}

/** @type {Section[]} */
export const SECTIONS = [
  {
    name: 'schemas',
    key: ['schema'],
    sql: `select n.nspname as schema, pg_catalog.pg_get_userbyid(n.nspowner) as owner,
  coalesce(n.nspacl::text, '') as acl
from pg_catalog.pg_namespace n
where left(n.nspname, 3) <> 'pg_' and n.nspname <> 'information_schema'
order by 1`,
  },
  {
    name: 'relations',
    key: ['schema', 'name'],
    sql: `select n.nspname as schema, c.relname as name, c.relkind::text as kind,
  c.relrowsecurity as rls, c.relforcerowsecurity as force_rls,
  pg_catalog.pg_get_userbyid(c.relowner) as owner, coalesce(c.relacl::text, '') as acl,
  coalesce(array_to_string(c.reloptions, ','), '') as options,
  coalesce((select md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':'
      || a.attnotnull::text || ':' || coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '') || ':'
      || coalesce(a.attacl::text, ''), ',' order by a.attnum))
    from pg_catalog.pg_attribute a
    left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '') as columns_md5,
  case when c.relkind in ('v', 'm') then md5(pg_catalog.pg_get_viewdef(c.oid))
       when c.relkind in ('i', 'I') then md5(pg_catalog.pg_get_indexdef(c.oid))
       else '' end as definition_md5
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname in ${IN_SCOPED}
order by 1, 2`,
  },
  {
    name: 'constraints',
    key: ['schema', 'tbl', 'name'],
    sql: `select n.nspname as schema, c.relname as tbl, con.conname as name, con.contype::text as type,
  con.convalidated as validated, md5(pg_catalog.pg_get_constraintdef(con.oid)) as definition_md5
from pg_catalog.pg_constraint con
join pg_catalog.pg_class c on c.oid = con.conrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname in ${IN_SCOPED}
order by 1, 2, 3`,
  },
  {
    name: 'policies',
    key: ['schema', 'tbl', 'name'],
    sql: `select p.schemaname as schema, p.tablename as tbl, p.policyname as name, p.permissive,
  array_to_string(p.roles, ',') as roles, p.cmd,
  md5(coalesce(p.qual, '')) as using_md5, md5(coalesce(p.with_check, '')) as check_md5
from pg_catalog.pg_policies p
where p.schemaname in ${IN_SCOPED}
order by 1, 2, 3`,
  },
  {
    name: 'functions',
    key: ['schema', 'name', 'args'],
    sql: `select n.nspname as schema, p.proname as name,
  pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
  coalesce(pg_catalog.pg_get_function_result(p.oid), '') as result, p.prokind::text as kind,
  l.lanname as language, p.prosecdef as security_definer, p.provolatile::text as volatility,
  coalesce(array_to_string(p.proconfig, ','), '') as config, coalesce(p.proacl::text, '') as acl,
  pg_catalog.pg_get_userbyid(p.proowner) as owner, md5(coalesce(p.prosrc, '')) as source_md5
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
join pg_catalog.pg_language l on l.oid = p.prolang
where n.nspname in ${IN_SCOPED}
order by 1, 2, 3`,
  },
  {
    // `schema` = the schema that OWNS the trigger: for an internal FK (RI) trigger that is the
    // schema of the constraint's table, so themis.profiles → auth.users adds RI triggers ON
    // auth.users that belong to themis. Any other trigger on auth.users is owned by `auth`.
    name: 'triggers',
    key: ['on_schema', 'on_table', 'name'],
    sql: `select coalesce(cn.nspname, n.nspname) as schema, n.nspname as on_schema, c.relname as on_table,
  t.tgname as name, t.tgenabled::text as enabled, t.tgisinternal as internal,
  coalesce(con.conname, '') as constraint_name, md5(pg_catalog.pg_get_triggerdef(t.oid)) as definition_md5
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid = t.tgrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
left join pg_catalog.pg_constraint con on con.oid = t.tgconstraint
left join pg_catalog.pg_class cc on cc.oid = con.conrelid
left join pg_catalog.pg_namespace cn on cn.oid = cc.relnamespace
where n.nspname in ${IN_SCOPED}
order by 2, 3, 4`,
  },
  {
    name: 'types',
    key: ['schema', 'name'],
    sql: `select n.nspname as schema, t.typname as name, t.typtype::text as type,
  coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder)
    from pg_catalog.pg_enum e where e.enumtypid = t.oid), '') as labels,
  coalesce(t.typacl::text, '') as acl, pg_catalog.pg_get_userbyid(t.typowner) as owner
from pg_catalog.pg_type t
join pg_catalog.pg_namespace n on n.oid = t.typnamespace
where n.nspname in ${IN_SCOPED} and t.typtype in ('e', 'd', 'r', 'm')
order by 1, 2`,
  },
  {
    name: 'default_acl',
    key: ['schema', 'role', 'objtype'],
    sql: `select n.nspname as schema, pg_catalog.pg_get_userbyid(d.defaclrole) as role,
  d.defaclobjtype::text as objtype, coalesce(d.defaclacl::text, '') as acl
from pg_catalog.pg_default_acl d
left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
order by 2, 3, 1`,
  },
  {
    name: 'extensions',
    key: ['name'],
    sql: `select null::text as schema, e.extname as name, e.extversion as version, n.nspname as ext_schema
from pg_catalog.pg_extension e
join pg_catalog.pg_namespace n on n.oid = e.extnamespace
order by 2`,
  },
  {
    name: 'roles',
    key: ['name'],
    sql: `select null::text as schema, r.rolname as name, r.rolsuper as super, r.rolinherit as inherit,
  r.rolcreaterole as createrole, r.rolcreatedb as createdb, r.rolcanlogin as login,
  r.rolreplication as replication, r.rolbypassrls as bypassrls
from pg_catalog.pg_roles r
where r.rolname in ('postgres', 'anon', 'authenticated', 'service_role', 'authenticator')
order by 2`,
  },
  {
    name: 'role_settings',
    key: ['role', 'database', 'setting', 'schema'],
    sql: `select coalesce(r.rolname, '*') as role, coalesce(db.datname, '') as database,
  unnest(s.setconfig) as setting
from pg_catalog.pg_db_role_setting s
left join pg_catalog.pg_roles r on r.oid = s.setrole
left join pg_catalog.pg_database db on db.oid = s.setdatabase
order by 1, 2`,
    post: splitRoleSettings,
  },
  {
    name: 'publication_tables',
    key: ['publication', 'schema', 'tbl'],
    sql: `select pt.schemaname as schema, pt.pubname as publication, pt.tablename as tbl
from pg_catalog.pg_publication_tables pt
where pt.schemaname in ${IN_SCOPED}
order by 2, 1, 3`,
  },
  {
    name: 'event_triggers',
    key: ['name'],
    sql: `select null::text as schema, e.evtname as name, e.evtevent as event, e.evtenabled::text as enabled,
  p.proname as fn, coalesce(array_to_string(e.evttags, ','), '') as tags
from pg_catalog.pg_event_trigger e
join pg_catalog.pg_proc p on p.oid = e.evtfoid
order by 2`,
  },
  {
    name: 'migrations_ledger',
    key: ['version'],
    sql: `select 'supabase_migrations' as schema, m.version
from supabase_migrations.schema_migrations m
order by 2`,
  },
]

/**
 * @typedef {object} Snapshot
 * @property {string} format
 * @property {string} label
 * @property {string} takenAt
 * @property {string} projectRef
 * @property {ReturnType<typeof summarise>} summary  human-readable, derived from `sections`; the diff ignores it
 * @property {Record<string, Row[]>} sections
 */

/** @param {Row[]} rows */
const normaliseRows = (rows) =>
  rows.map((r) => {
    /** @type {Row} */
    const o = {}
    for (const k of Object.keys(r).sort()) o[k] = r[k] === undefined ? null : r[k]
    return o
  })

/**
 * Take a snapshot. Validates EVERY query before sending the first one, so a bad query means zero
 * requests. All requests go through `readOnlyClient`.
 * @param {{ client: import('./lib/mgmt-api.mjs').MgmtClient, label: string, projectRef: string,
 *           now?: Date, sections?: Section[] }} opts
 * @returns {Promise<Snapshot>}
 */
export async function takeSnapshot({ client, label, projectRef, now = new Date(), sections = SECTIONS }) {
  for (const s of sections) assertReadOnly(s.sql)
  const ro = readOnlyClient(client)
  /** @type {Record<string, Row[]>} */
  const out = {}
  for (const s of sections) {
    const rows = await ro.query(s.sql)
    out[s.name] = normaliseRows(s.post ? s.post(rows) : rows)
  }
  return { format: FORMAT, label, takenAt: now.toISOString(), projectRef, summary: summarise(out), sections: out }
}

/**
 * @param {Record<string, Row[]>} sections
 */
export function summarise(sections) {
  const rows = (/** @type {string} */ n) => sections[n] ?? []
  const inSchema = (/** @type {string} */ n, /** @type {string} */ s) =>
    rows(n).filter((r) => r.schema === s).length
  const versions = rows('migrations_ledger').map((r) => String(r.version)).sort()
  return {
    themisSchemaExists: rows('schemas').some((r) => r.schema === THEMIS),
    themisObjects: rows('relations')
      .filter((r) => r.schema === THEMIS)
      .map((r) => `${String(r.kind)} ${String(r.name)}`)
      .concat(rows('functions').filter((r) => r.schema === THEMIS).map((r) => `fn ${String(r.name)}(${String(r.args)})`)),
    supabaseMigrations: { count: versions.length, maxVersion: versions.at(-1) ?? null },
    authUsersTriggers: rows('triggers')
      .filter((r) => r.on_schema === 'auth' && r.on_table === 'users')
      .map((r) => ({ name: r.name, owner: r.schema, internal: r.internal })),
    public: {
      tables: rows('relations').filter((r) => r.schema === 'public' && ['r', 'p'].includes(String(r.kind))).length,
      policies: inSchema('policies', 'public'),
      functions: inSchema('functions', 'public'),
      triggers: rows('triggers').filter((r) => r.on_schema === 'public').length,
    },
    extensions: rows('extensions').map((r) => `${String(r.name)} ${String(r.version)}`),
    exposedSchemaFacts: {
      pgrstDbSchemasRoleSettings: rows('role_settings')
        .filter((r) => r.setting === 'pgrst.db_schemas')
        .map((r) => `${String(r.role)}: ${String(r.value)}`),
      themisSchemaAcl: rows('schemas').find((r) => r.schema === THEMIS)?.acl ?? null,
    },
  }
}

/**
 * The file name for a snapshot: `<iso>-<label>.json`, with the ISO time made filename-safe
 * (Windows forbids ':').
 * @param {Date} now
 * @param {string} label
 */
export function snapshotFileName(now, label) {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${label}.json`
}

export const LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/

/**
 * @typedef {object} RunOptions
 * @property {string[]} [argv]
 * @property {Record<string, string | undefined>} [env]
 * @property {typeof fetch} [fetch]
 * @property {string} [outDir]
 * @property {Date} [now]
 * @property {(line: string) => void} [log]
 * @property {(line: string) => void} [error]
 */

/**
 * The CLI. Returns the exit code; never calls process.exit.
 * @param {RunOptions} [opts]
 * @returns {Promise<number>}
 */
export async function run(opts = {}) {
  const argv = opts.argv ?? []
  const env = opts.env ?? process.env
  const token = env[ENV_TOKEN] ?? ''
  const scrub = (/** @type {string} */ s) => redact(s, [token])
  const log = (/** @type {string} */ s) => (opts.log ?? console.log)(scrub(s))
  const error = (/** @type {string} */ s) => (opts.error ?? console.error)(scrub(s))

  if (argv.length !== 1 || !LABEL_RE.test(argv[0])) {
    error('usage: npm run db:snapshot -- <label>   (label: lower-case letters, digits, - or _; e.g. pre, post)')
    return 2
  }
  const label = argv[0]
  const missing = [ENV_TOKEN, ENV_REF].filter((k) => !env[k])
  if (missing.length > 0) {
    error(
      `db:snapshot: missing env ${missing.join(' and ')}. Export ${ENV_TOKEN} and ${ENV_REF} in the shell; no .env file is read and nothing is sent.`,
    )
    return 2
  }
  const ref = /** @type {string} */ (env[ENV_REF])
  let client
  try {
    client = createMgmtClient({ token, ref, fetch: opts.fetch })
  } catch (e) {
    error(`db:snapshot: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }

  const now = opts.now ?? new Date()
  log(`db:snapshot — READ-ONLY catalogue snapshot "${label}" · project ${ref} · ${SECTIONS.length} SELECTs`)
  let snap
  try {
    snap = await takeSnapshot({ client, label, projectRef: ref, now })
  } catch (e) {
    const msg = e instanceof MgmtApiError || e instanceof Error ? e.message : String(e)
    error(`db:snapshot: ${msg}`)
    error('db:snapshot: FAILED — no file written.')
    return 1
  }
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR
  mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, snapshotFileName(now, label))
  writeFileSync(file, JSON.stringify(snap, null, 2) + '\n')
  const s = snap.summary
  log(
    `themis schema: ${s.themisSchemaExists ? `present (${s.themisObjects.length} objects)` : 'absent'} · supabase_migrations: ${s.supabaseMigrations.count} versions, max ${s.supabaseMigrations.maxVersion ?? '-'} · auth.users triggers: ${s.authUsersTriggers.length} · public: ${s.public.tables} tables, ${s.public.policies} policies, ${s.public.functions} functions, ${s.public.triggers} triggers`,
  )
  log(`WROTE ${file}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(await run({ argv: process.argv.slice(2) }))
}
