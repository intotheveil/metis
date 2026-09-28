// THE SNAPSHOT DIFF — `npm run db:snapshot:diff -- <before> <after>` (PLAN P1.12, ADR-0002)
//
// Compares two `db:snapshot` files and proves that a live apply touched NOTHING outside schema
// `themis`. Each argument is a path to a snapshot file, or a label (`pre`, `post`), which resolves to
// the NEWEST `ops-snapshots/*-<label>.json`.
//
// Rows are matched per section by the section's key (see SECTIONS in db-snapshot.mjs). A row that
// appears, disappears or changes is classified by its `schema` field: `themis` = allowed (reported
// for the record), anything else (including database-level rows, schema null) = a change outside
// themis. The `summary` block is derived and ignored.
//
// Exit: 0 nothing outside themis changed · 1 something outside themis changed · 2 usage / unreadable
// file / snapshots that cannot be compared (different format or project).
// Reads local files only: no network, no env.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_OUT_DIR, FORMAT, LABEL_RE, SECTIONS, THEMIS } from './db-snapshot.mjs'

/**
 * @typedef {Record<string, unknown>} Row
 * @typedef {{ format: string, label: string, takenAt: string, projectRef: string,
 *             sections: Record<string, Row[]> }} SnapshotFile
 * @typedef {{ section: string, key: string, kind: 'added' | 'removed' | 'changed', schema: string | null,
 *             before: Row | null, after: Row | null }} Change
 */

const KEYS = new Map(SECTIONS.map((s) => [s.name, s.key]))

/** @param {Row} row @param {string[]} fields */
const rowKey = (row, fields) => fields.map((f) => String(row[f] ?? '∅')).join(' | ')

/** Stable JSON: keys sorted. @param {unknown} v @returns {string} */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const o = /** @type {Record<string, unknown>} */ (v)
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

/**
 * Compare two snapshots. Pure.
 * @param {SnapshotFile} before
 * @param {SnapshotFile} after
 * @returns {{ changes: Change[], outside: Change[], inside: Change[], problems: string[] }}
 */
export function diffSnapshots(before, after) {
  /** @type {string[]} */
  const problems = []
  if (before.format !== FORMAT || after.format !== FORMAT) {
    problems.push(`unknown snapshot format (${before.format} / ${after.format}); expected ${FORMAT}`)
  }
  if (before.projectRef !== after.projectRef) {
    problems.push(`different projects: ${before.projectRef} vs ${after.projectRef}`)
  }
  const names = new Set([...Object.keys(before.sections ?? {}), ...Object.keys(after.sections ?? {})])
  for (const n of names) {
    if (!KEYS.has(n)) problems.push(`unknown section "${n}"`)
    if (!before.sections?.[n] || !after.sections?.[n]) problems.push(`section "${n}" is missing from one snapshot`)
  }
  for (const n of KEYS.keys()) {
    if (!names.has(n)) problems.push(`section "${n}" is missing from both snapshots`)
  }
  if (problems.length > 0) return { changes: [], outside: [], inside: [], problems }

  /** @type {Change[]} */
  const changes = []
  for (const [section, fields] of KEYS) {
    const index = (/** @type {Row[]} */ rows) => {
      /** @type {Map<string, Row>} */
      const m = new Map()
      for (const r of rows) {
        const k = rowKey(r, fields)
        if (m.has(k)) problems.push(`section "${section}": duplicate key ${k}`)
        m.set(k, r)
      }
      return m
    }
    const a = index(before.sections[section])
    const b = index(after.sections[section])
    for (const [k, row] of a) {
      const other = b.get(k)
      if (!other) {
        changes.push({ section, key: k, kind: 'removed', schema: schemaOf(row), before: row, after: null })
      } else if (stable(row) !== stable(other)) {
        // A row that moved between owners counts as outside unless BOTH sides are themis.
        const s = schemaOf(row) === THEMIS && schemaOf(other) === THEMIS ? THEMIS : (schemaOf(row) === THEMIS ? schemaOf(other) : schemaOf(row))
        changes.push({ section, key: k, kind: 'changed', schema: s, before: row, after: other })
      }
    }
    for (const [k, row] of b) {
      if (!a.has(k)) changes.push({ section, key: k, kind: 'added', schema: schemaOf(row), before: null, after: row })
    }
  }
  const outside = changes.filter((c) => c.schema !== THEMIS)
  const inside = changes.filter((c) => c.schema === THEMIS)
  return { changes, outside, inside, problems }
}

/** @param {Row} r @returns {string | null} */
const schemaOf = (r) => (typeof r.schema === 'string' ? r.schema : null)

/** The fields that differ between two rows. @param {Row} a @param {Row} b */
function changedFields(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => stable(a[k]) !== stable(b[k]))
}

/** @param {Change} c */
export function formatChange(c) {
  const sign = c.kind === 'added' ? '+' : c.kind === 'removed' ? '-' : '~'
  const detail =
    c.kind === 'changed' && c.before && c.after
      ? ` (${changedFields(c.before, c.after)
          .map((f) => `${f}: ${JSON.stringify(c.before?.[f] ?? null)} → ${JSON.stringify(c.after?.[f] ?? null)}`)
          .join('; ')})`
      : ''
  return `${sign} ${c.section}: ${c.key}${detail}`
}

/**
 * Resolve an argument: an existing file path, or a label → the newest `*-<label>.json` in dir.
 * @param {string} arg
 * @param {string} dir
 * @returns {string | null}
 */
export function resolveSnapshot(arg, dir) {
  if (existsSync(arg)) return arg
  if (!LABEL_RE.test(arg) || !existsSync(dir)) return null
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(`-${arg}.json`) && /^\d{4}-\d{2}-\d{2}T/.test(f))
    .sort()
  const last = hits.at(-1)
  return last ? path.join(dir, last) : null
}

/**
 * @typedef {object} RunOptions
 * @property {string[]} [argv]
 * @property {string} [dir]       where labels are looked up (default ops-snapshots/)
 * @property {(line: string) => void} [log]
 * @property {(line: string) => void} [error]
 */

/**
 * The CLI. Returns the exit code; never calls process.exit.
 * @param {RunOptions} [opts]
 * @returns {number}
 */
export function run(opts = {}) {
  const argv = opts.argv ?? []
  const log = opts.log ?? console.log
  const error = opts.error ?? console.error
  const dir = opts.dir ?? DEFAULT_OUT_DIR
  if (argv.length !== 2) {
    error('usage: npm run db:snapshot:diff -- <before> <after>   (a snapshot file, or a label such as pre / post)')
    return 2
  }
  /** @type {SnapshotFile[]} */
  const snaps = []
  for (const arg of argv) {
    const file = resolveSnapshot(arg, dir)
    if (!file) {
      error(`db:snapshot:diff: no snapshot "${arg}" (not a file, and no ${dir}/*-${arg}.json)`)
      return 2
    }
    try {
      snaps.push(/** @type {SnapshotFile} */ (JSON.parse(readFileSync(file, 'utf8'))))
    } catch (e) {
      error(`db:snapshot:diff: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`)
      return 2
    }
    log(`${snaps.length === 1 ? 'before' : 'after '}: ${file}`)
  }
  const [before, after] = snaps
  const { outside, inside, problems } = diffSnapshots(before, after)
  if (problems.length > 0) {
    for (const p of problems) error(`FAIL  ${p}`)
    error('db:snapshot:diff: the snapshots cannot be compared — NOT a pass.')
    return 2
  }
  log(`inside themis (allowed): ${inside.length} change(s)`)
  for (const c of inside) log(`  ${formatChange(c)}`)
  if (outside.length > 0) {
    log(`OUTSIDE themis: ${outside.length} change(s)`)
    for (const c of outside) log(`  ${formatChange(c)}  [schema ${c.schema ?? '(database)'}]`)
    error(`DIFF FAILED — ${outside.length} change(s) outside schema themis between "${before.label}" and "${after.label}".`)
    return 1
  }
  log(`DIFF PASSED — nothing outside schema themis changed between "${before.label}" and "${after.label}".`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(run({ argv: process.argv.slice(2) }))
}
