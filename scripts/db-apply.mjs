// THE LIVE APPLIER — `npm run db:apply` (PLAN P1.11, ADR-0002 rule 3)
//
// Applies pending `supabase/migrations/*.sql` files to Hephaestus's LIVE shared Supabase project
// through the Management API (`POST /v1/projects/{ref}/database/query`), and records each one in
// Themis's own ledger `themis.schema_migrations` (version, name, checksum sha256, applied_at).
// It NEVER touches `supabase_migrations.*` (Hephaestus owns it) and never shells out to the CLI.
//
//   DRY-RUN IS THE DEFAULT. Every batch it sends ends in ROLLBACK, so nothing is committed.
//   `--apply` commits, and is run only with the operator's go (spec §5a.6).
//
// Env (names only; values never printed, logged or committed; no .env file is read):
//   SUPABASE_ACCESS_TOKEN        a Supabase personal access token
//   THEMIS_SUPABASE_PROJECT_REF  the project ref
// Missing either → exit 2.
//
// Order of work (nothing but reads is sent until every refusal check passed):
//   1. the static guard (`db:check`) on the archive; red → exit 1, no request at all
//   2. read the ledger (to_regclass first: an absent table = nothing applied yet)
//   3. refuse (exit 1) if: an applied file's sha256 changed, an applied version has no file,
//      a pending file is older than the newest applied one, a pending file carries its own
//      transaction control (it would end our transaction early and COMMIT a dry-run), or a
//      PAIRED group is incomplete
//   4. print the plan (pending files), then send:
//      dry-run: for each unit k, ONE rolled-back batch holding units 1..k, so every file is
//               tried on top of the pending files before it (the tenancy file needs the schema
//               the bootstrap creates, which a per-file rollback would have thrown away)
//      --apply: ONE committed batch per unit, stop at the first error
//   Each batch: begin; set local lock_timeout='5s'; set local statement_timeout='60s';
//               <file sql>; insert into themis.schema_migrations …; [<next file of a pair> …;]
//               commit | rollback;
//
// A UNIT is one file, except a PAIRED group, which is one unit = one transaction. 20260928235000
// (audit_log + its append-only trigger) must never be live without 20260928235500 (the trigger fix
// that lets the actor FK's SET NULL through): alone it would break user deletion on the shared
// auth.users, i.e. on Hephaestus's side (DECISIONS.md "audit_log actor erasure").
//
// Exit: 0 ok · 1 refused / guard red / API error · 2 usage (bad flag, missing env).

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkMigrationsDir, formatViolation, stripComments } from './check-migrations.mjs'
import { MgmtApiError, createMgmtClient, redact } from './lib/mgmt-api.mjs'

export const ENV_TOKEN = 'SUPABASE_ACCESS_TOKEN'
export const ENV_REF = 'THEMIS_SUPABASE_PROJECT_REF'
export const LEDGER = 'themis.schema_migrations'
export const LOCK_TIMEOUT = '5s'
export const STATEMENT_TIMEOUT = '60s'

/**
 * Versions that must be applied together, in ONE transaction, or not at all.
 * @type {ReadonlyArray<ReadonlyArray<string>>}
 */
export const PAIRED = [['20260928235000', '20260928235500']]

export const DEFAULT_DIR = fileURLToPath(new URL('../supabase/migrations', import.meta.url))

/**
 * @typedef {object} Migration
 * @property {string} file      basename
 * @property {string} version   the 14-digit prefix
 * @property {string} name      the part after `_themis_`, without `.sql`
 * @property {string} sql
 * @property {string} checksum  sha256 hex of the LF-normalised text
 *
 * @typedef {{ version: string, name: string, checksum: string }} AppliedRow
 * @typedef {Migration[]} Unit
 */

/**
 * sha256 of a migration's text with CRLF normalised to LF. A Windows checkout with
 * core.autocrlf=true and a Linux CI checkout must agree on the checksum of the same commit,
 * or every file would look "changed" depending on who ran the last apply.
 * @param {string} sql
 * @returns {string}
 */
export function checksum(sql) {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

/**
 * Read the archive: every `.sql` file, sorted by name (= by version).
 * @param {string} dir
 * @returns {Migration[]}
 */
export function loadMigrations(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && statSync(path.join(dir, f)).isFile())
    .sort()
    .map((file) => {
      const m = /^(\d{14})_themis_([a-z0-9_]+)\.sql$/.exec(file)
      if (!m) throw new Error(`bad migration file name: ${file}`)
      const sql = readFileSync(path.join(dir, file), 'utf8')
      return { file, version: m[1], name: m[2], sql, checksum: checksum(sql) }
    })
}

/** @param {string} s */
const sqlLiteral = (s) => `'${s.replace(/'/g, "''")}'`

/**
 * Blank out dollar-quoted bodies and single-quoted strings (comments must already be blanked),
 * so only top-level statement text is left.
 * @param {string} code
 * @returns {string}
 */
function blankLiterals(code) {
  const blank = (/** @type {string} */ s) => s.replace(/[^\n]/g, ' ')
  return code
    .replace(/\$([A-Za-z_][\w]*)?\$[\s\S]*?\$\1\$/g, blank)
    .replace(/'(?:[^']|'')*'/g, blank)
}

/**
 * Top-level transaction-control statements in a migration. The applier owns the transaction; a
 * file that says COMMIT (or END, its synonym) would commit a dry-run on the live project.
 * @param {string} sql
 * @returns {string[]}  the offending keywords, lower-case
 */
export function findTransactionControl(sql) {
  const code = blankLiterals(stripComments(sql))
  const re =
    /(?:^|;)\s*(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction)\b/gi
  return [...code.matchAll(re)].map((m) => m[1].toLowerCase().replace(/\s+/g, ' '))
}

/**
 * Build one transaction batch for a unit of migrations.
 * @param {Unit} unit
 * @param {'commit' | 'rollback'} end
 * @returns {string}
 */
export function buildBatch(unit, end) {
  const parts = [
    'begin;',
    `set local lock_timeout = '${LOCK_TIMEOUT}';`,
    `set local statement_timeout = '${STATEMENT_TIMEOUT}';`,
  ]
  for (const m of unit) {
    parts.push(
      `-- >>> ${m.file}`,
      m.sql.replace(/\r\n/g, '\n').trimEnd(),
      ';',
      `insert into ${LEDGER} (version, name, checksum) values (${sqlLiteral(m.version)}, ${sqlLiteral(m.name)}, ${sqlLiteral(m.checksum)});`,
      `-- <<< ${m.file}`,
    )
  }
  parts.push(`${end};`)
  return parts.join('\n')
}

/**
 * Decide what to apply. Pure.
 * @param {Migration[]} local
 * @param {AppliedRow[]} applied
 * @returns {{ pending: Migration[], units: Unit[], problems: string[] }}
 */
export function plan(local, applied) {
  /** @type {string[]} */
  const problems = []
  const byVersion = new Map(local.map((m) => [m.version, m]))
  const appliedVersions = new Set(applied.map((r) => r.version))

  for (const row of applied) {
    const m = byVersion.get(row.version)
    if (!m) {
      problems.push(
        `applied version ${row.version} (${row.name}) has no file in the archive — refusing to run from an archive that does not match the live ledger`,
      )
    } else if (m.checksum !== row.checksum) {
      problems.push(
        `CHECKSUM CHANGED: ${m.file} was applied with sha256 ${row.checksum} but the file now hashes to ${m.checksum} — applied migrations are forward-only; add a NEW migration instead`,
      )
    }
  }

  const pending = local.filter((m) => !appliedVersions.has(m.version))
  const newestApplied = applied
    .map((r) => r.version)
    .sort()
    .at(-1)
  for (const m of pending) {
    if (newestApplied && m.version < newestApplied) {
      problems.push(
        `OUT OF ORDER: ${m.file} is pending but older than the newest applied version ${newestApplied}`,
      )
    }
    const ctl = findTransactionControl(m.sql)
    if (ctl.length > 0) {
      problems.push(
        `TRANSACTION CONTROL in ${m.file} (${[...new Set(ctl)].join(', ')}) — the applier owns the transaction; a file must not begin/commit/rollback itself`,
      )
    }
  }

  const pendingVersions = new Set(pending.map((m) => m.version))
  for (const group of PAIRED) {
    if (!group.some((v) => pendingVersions.has(v))) continue
    const missing = group.filter((v) => !pendingVersions.has(v) && !appliedVersions.has(v))
    if (missing.length > 0) {
      problems.push(
        `PAIRED: ${group.join(' + ')} must be applied together in one run and one transaction; ${missing.join(', ')} is not in the archive`,
      )
    }
  }

  /** @type {Unit[]} */
  const units = []
  /** @type {Set<string>} */
  const placed = new Set()
  for (const m of pending) {
    if (placed.has(m.version)) continue
    const group = PAIRED.find((g) => g.includes(m.version))
    const unit = group ? pending.filter((p) => group.includes(p.version)) : [m]
    for (const u of unit) placed.add(u.version)
    units.push(unit)
  }
  return { pending, units, problems }
}

/**
 * Read the ledger. An absent `themis.schema_migrations` (or an absent schema) means nothing has
 * been applied yet; `to_regclass` answers that without relying on error text.
 * @param {import('./lib/mgmt-api.mjs').MgmtClient} client
 * @returns {Promise<AppliedRow[] | null>}  null when the ledger does not exist yet
 */
export async function readApplied(client) {
  const probe = await client.query(`select to_regclass('${LEDGER}') is not null as present;`)
  if (!probe[0] || probe[0].present !== true) return null
  const rows = await client.query(`select version, name, checksum from ${LEDGER} order by version;`)
  return rows.map((r) => ({
    version: String(r.version),
    name: String(r.name),
    checksum: String(r.checksum),
  }))
}

/** @param {Unit} unit */
const unitLabel = (unit) => unit.map((m) => m.file).join(' + ')

/**
 * @typedef {object} RunOptions
 * @property {string[]} [argv]                     CLI args after the script name
 * @property {Record<string, string | undefined>} [env]
 * @property {typeof fetch} [fetch]
 * @property {string} [dir]                         migrations dir (default supabase/migrations)
 * @property {(line: string) => void} [log]         stdout
 * @property {(line: string) => void} [error]       stderr
 */

/**
 * The whole applier. Returns the exit code; never calls process.exit.
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

  const unknown = argv.filter((a) => a !== '--apply')
  if (unknown.length > 0) {
    error(
      `db:apply: unknown argument(s): ${unknown.join(' ')} — usage: npm run db:apply [-- --apply]`,
    )
    return 2
  }
  const apply = argv.includes('--apply')

  const missing = [ENV_TOKEN, ENV_REF].filter((k) => !env[k])
  if (missing.length > 0) {
    error(
      `db:apply: missing env ${missing.join(' and ')}. Export ${ENV_TOKEN} (a Supabase personal access token) and ${ENV_REF} in the shell; no .env file is read and nothing is sent.`,
    )
    return 2
  }
  const ref = /** @type {string} */ (env[ENV_REF])
  const dir = opts.dir ?? DEFAULT_DIR
  if (!existsSync(dir)) {
    error(`db:apply: no such migrations directory: ${dir}`)
    return 1
  }

  log(
    `db:apply — ${apply ? 'APPLY (each batch COMMITs)' : 'DRY-RUN (every batch ends in ROLLBACK; nothing is committed)'} · project ${ref} · ledger ${LEDGER}`,
  )

  // 1. static guard, before any request
  const guard = checkMigrationsDir(dir)
  if (guard.error || guard.violations.length > 0) {
    if (guard.error) log(`FAIL  migration guard: ${guard.error}`)
    for (const v of guard.violations) log(`FAIL  ${formatViolation(v)}`)
    error('REFUSED — the static migration guard (db:check) is red; nothing was sent.')
    return 1
  }
  log(`PASS  migration guard: ${guard.files.length} migration(s) stay inside schema themis`)

  let client
  try {
    client = createMgmtClient({ token, ref, fetch: opts.fetch })
  } catch (e) {
    error(`db:apply: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }

  try {
    // 2. ledger
    const local = loadMigrations(dir)
    const appliedOrNull = await readApplied(client)
    const applied = appliedOrNull ?? []
    log(
      appliedOrNull === null
        ? `ledger: ${LEDGER} does not exist — nothing applied yet`
        : `ledger: ${applied.length} version(s) applied`,
    )

    // 3. refusals
    const { pending, units, problems } = plan(local, applied)
    if (problems.length > 0) {
      for (const p of problems) log(`FAIL  ${p}`)
      error(`REFUSED — ${problems.length} problem(s); no migration was sent.`)
      return 1
    }

    // 4. plan, then send
    if (pending.length === 0) {
      log(`PLAN  nothing pending — the live ledger matches all ${local.length} file(s).`)
      return 0
    }
    log(`PLAN  ${pending.length} pending file(s) in ${units.length} transaction(s):`)
    units.forEach((unit, i) => {
      unit.forEach((m, j) => {
        const tag = j === 0 ? `${String(i + 1).padStart(2)}.` : '   '
        const note = unit.length > 1 && j === 0 ? `  [paired: one transaction]` : ''
        log(`  ${tag} ${m.file}  sha256 ${m.checksum.slice(0, 12)}…${note}`)
      })
    })

    if (!apply) {
      for (let k = 0; k < units.length; k++) {
        const upTo = units.slice(0, k + 1).flat()
        try {
          await client.query(buildBatch(upTo, 'rollback'))
        } catch (e) {
          log(`FAIL  dry-run ${unitLabel(units[k])}: ${e instanceof Error ? e.message : String(e)}`)
          error(
            `DRY-RUN FAILED at ${unitLabel(units[k])} (${k} earlier unit(s) rolled back cleanly). Nothing was committed.`,
          )
          return 1
        }
        log(
          `OK    dry-run ${unitLabel(units[k])}${k > 0 ? ` (on top of ${k} earlier pending unit(s))` : ''} — rolled back`,
        )
      }
      log(
        `DRY-RUN PASSED — ${pending.length} pending file(s) apply cleanly; everything was rolled back. Commit with: npm run db:apply -- --apply (operator's go only).`,
      )
      return 0
    }

    let committed = 0
    for (let k = 0; k < units.length; k++) {
      try {
        await client.query(buildBatch(units[k], 'commit'))
      } catch (e) {
        log(`FAIL  apply ${unitLabel(units[k])}: ${e instanceof Error ? e.message : String(e)}`)
        const notTried = units.slice(k + 1).flat().length
        error(
          `APPLY FAILED at ${unitLabel(units[k])} — its transaction was not committed. ${committed} file(s) committed before it; ${notTried} later file(s) not attempted.`,
        )
        return 1
      }
      committed += units[k].length
      log(`APPLIED ${unitLabel(units[k])} — committed with its ledger row(s)`)
    }
    log(`APPLY PASSED — ${committed} file(s) committed and recorded in ${LEDGER}.`)
    return 0
  } catch (e) {
    const msg = e instanceof MgmtApiError || e instanceof Error ? e.message : String(e)
    error(`db:apply: ${msg}`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(await run({ argv: process.argv.slice(2) }))
}
