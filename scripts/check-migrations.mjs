// THE STATIC MIGRATION GUARD — `npm run db:check` (also the first step of `npm run db:gate`)
//
// Themis shares Hephaestus's LIVE Supabase project (ADR-0002). A Themis migration may create,
// alter or grant things ONLY in schema `themis`. The PGlite gate proves a migration applies; this
// guard proves, before anything runs, that it does not reach into the tenant next door. It reads
// the SQL text only: no database, no credential, no network.
//
// Every violation is reported as `file:line  [rule]  message`, and the exit code is 1 if there is
// any. Rules (PLAN.md P1.3):
//
//   filename            the name must match ^\d{14}_themis_[a-z0-9_]+\.sql$
//   forbidden-schema    any reference into public / auth / storage / supabase_migrations
//                       (qualified `x.y`, `schema x`, or a search_path naming x). The only allowed
//                       auth references are `references auth.users` and `auth.uid()`.
//   target-outside-themis  a DDL/DML target (create/alter/drop table, view, function, type, …;
//                       insert into / update / delete from / truncate) that is not `themis.`-
//                       qualified. Unqualified names land in the search_path, i.e. in `public`.
//   auth-users-trigger  `create trigger … on auth.users` (it would fire on Hephaestus sign-ups)
//   create-extension, alter-system, drop-schema, alter-role
//                       project-wide commands a guest schema never runs
//   default-privileges  `alter default privileges` anywhere but `in schema themis`
//
// Comments are blanked before matching (so prose may name `public.profiles`), but string literals
// are kept: `execute 'insert into public.x'` is still caught. A false positive is fixed by
// rewording; a false negative ships to production.
//
// Usage: node scripts/check-migrations.mjs [dir]   (dir defaults to $DB_GATE_MIGRATIONS, then
// supabase/migrations). Import `checkMigrationsDir` / `checkMigrationSql` to use it in-process.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * @typedef {object} Violation
 * @property {string} file  migration file name (basename)
 * @property {number} line  1-based line number (0 for whole-file problems such as the name)
 * @property {string} rule  stable rule id, e.g. 'forbidden-schema'
 * @property {string} message
 */

export const FILENAME_RE = /^\d{14}_themis_[a-z0-9_]+\.sql$/
export const FORBIDDEN_SCHEMAS = ['public', 'auth', 'storage', 'supabase_migrations']
const SCHEMA_ALT = FORBIDDEN_SCHEMAS.join('|')
// An identifier, bare or double-quoted.
const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`

/**
 * Blank out `--` and (nested) `/* *\/` comments with spaces, keeping every newline and every
 * character offset, so an index into the result is an index into the original. String literals
 * and quoted identifiers are skipped over (a `--` inside a string is not a comment).
 * @param {string} sql
 * @returns {string}
 */
export function stripComments(sql) {
  const out = sql.split('')
  const blank = (/** @type {number} */ from, /** @type {number} */ to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
  }
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const d = sql[i + 1]
    if (c === '-' && d === '-') {
      let j = i
      while (j < n && sql[j] !== '\n') j++
      blank(i, j)
      i = j
    } else if (c === '/' && d === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      blank(i, j)
      i = j
    } else if (c === "'") {
      // E'…' strings allow backslash escapes; standard strings escape a quote by doubling it.
      const escapes = i > 0 && /[eE]/.test(sql[i - 1]) && !/[\w$]/.test(sql[i - 2] ?? '')
      let j = i + 1
      while (j < n) {
        if (escapes && sql[j] === '\\') j += 2
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2
        else if (sql[j] === "'") break
        else j++
      }
      i = j + 1
    } else if (c === '"') {
      let j = i + 1
      while (j < n && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1
      i = j + 1
    } else i++
  }
  return out.join('')
}

/** @param {string} s  @param {number} index */
const lineAt = (s, index) => s.slice(0, index).split('\n').length

/** @param {string} ident */
const unquote = (ident) => (ident.startsWith('"') ? ident.slice(1, -1) : ident.toLowerCase())

/**
 * Check one migration's name and SQL. Pure: no filesystem access.
 * @param {string} file  basename, e.g. 20260928200000_themis_schema.sql
 * @param {string} sql   file contents
 * @returns {Violation[]}
 */
export function checkMigrationSql(file, sql) {
  /** @type {Violation[]} */
  const v = []
  const code = stripComments(sql)
  const add = (
    /** @type {number} */ index,
    /** @type {string} */ rule,
    /** @type {string} */ message,
  ) => v.push({ file, line: index < 0 ? 0 : lineAt(code, index), rule, message })

  if (!FILENAME_RE.test(file)) {
    add(-1, 'filename', `name must match ${FILENAME_RE.source} (line 0 = the whole file)`)
  }

  // --- forbidden-schema: qualified references ------------------------------------------------
  const qualified = new RegExp(
    String.raw`(?<![\w$."])("?)(${SCHEMA_ALT})\1\s*\.\s*(${IDENT})`,
    'gi',
  )
  for (const m of code.matchAll(qualified)) {
    const schema = m[2].toLowerCase()
    const obj = unquote(m[3])
    const after = code.slice(m.index + m[0].length)
    const before = code.slice(0, m.index)
    if (schema === 'auth' && obj === 'uid' && /^\s*\(\s*\)/.test(after)) continue
    if (schema === 'auth' && obj === 'users' && /\breferences\s*$/i.test(before)) continue
    add(
      m.index,
      'forbidden-schema',
      `reference to ${schema}.${obj} — Themis may touch schema themis only (ADR-0002)` +
        (schema === 'auth' ? '; allowed: `references auth.users`, `auth.uid()`' : ''),
    )
  }

  // --- forbidden-schema: `schema public` (grant … on schema, in schema, create/alter schema) ---
  const schemaWord = new RegExp(
    String.raw`\bschema\s+(?:if\s+(?:not\s+)?exists\s+)?("?)(${SCHEMA_ALT})\1(?![\w$])`,
    'gi',
  )
  for (const m of code.matchAll(schemaWord)) {
    add(
      m.index,
      'forbidden-schema',
      `targets schema ${m[2].toLowerCase()} — themis only (ADR-0002)`,
    )
  }

  // --- forbidden-schema: a search_path that resolves names into a forbidden schema -----------
  const searchPath = /\bsearch_path\b\s*(?:=|\bto\b|'\s*,)\s*([^;\n]*)/gi
  for (const m of code.matchAll(searchPath)) {
    const hit = new RegExp(String.raw`(?<![\w$])"?(${SCHEMA_ALT})"?(?![\w$])`, 'i').exec(m[1])
    if (hit) {
      add(
        m.index,
        'forbidden-schema',
        `search_path includes ${hit[1].toLowerCase()} — pin it to '' and qualify names`,
      )
    }
  }

  // --- target-outside-themis: every DDL/DML target must be themis-qualified ------------------
  const TARGET = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`
  const IFX = String.raw`(?:if\s+(?:not\s+)?exists\s+)?`
  const KINDS = String.raw`(?:table|view|materialized\s+view|function|procedure|type|domain|sequence|aggregate)`
  const targetPatterns = [
    // create [or replace] [unlogged] <kind> …  (temp/temporary objects are session-local: allowed)
    new RegExp(
      String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:unlogged\s+)?(?:recursive\s+)?${KINDS}\s+${IFX}${TARGET}`,
      'gi',
    ),
    new RegExp(String.raw`\b(?:alter|drop)\s+${KINDS}\s+${IFX}(?:only\s+)?${TARGET}`, 'gi'),
    new RegExp(String.raw`\binsert\s+into\s+${TARGET}`, 'gi'),
    new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${TARGET}`, 'gi'),
    new RegExp(String.raw`\btruncate\s+(?:table\s+)?(?:only\s+)?${TARGET}`, 'gi'),
    new RegExp(
      String.raw`\bupdate\s+(?:only\s+)?${TARGET}\s+(?:(?:as\s+)?[A-Za-z_]\w*\s+)?set\b`,
      'gi',
    ),
  ]
  for (const re of targetPatterns) {
    for (const m of code.matchAll(re)) {
      const target = m[1]
      const parts = target.split('.').map((p) => unquote(p.trim()))
      if (parts.length === 2 && parts[0] === 'themis') continue
      // Forbidden schemas are already reported by the reference rule above; one line, one report.
      if (parts.length === 2 && FORBIDDEN_SCHEMAS.includes(parts[0])) continue
      const verb = m[0].trim().split(/\s+/).slice(0, 2).join(' ').toLowerCase()
      add(
        m.index,
        'target-outside-themis',
        parts.length === 1
          ? `${verb} ${parts[0]} is not schema-qualified — it would land in the search_path (public); write themis.${parts[0]}`
          : `${verb} ${parts.join('.')} targets schema ${parts[0]} — themis only (ADR-0002)`,
      )
    }
  }

  // --- auth-users-trigger ----------------------------------------------------------------------
  const trigger =
    /\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\b[^;]*?\bon\s+"?auth"?\s*\.\s*"?users"?(?![\w$])/gi
  for (const m of code.matchAll(trigger)) {
    add(
      m.index,
      'auth-users-trigger',
      'trigger on auth.users — it would fire on every Hephaestus sign-up (ADR-0002 rule 5)',
    )
  }

  // --- project-wide commands ---------------------------------------------------------------------
  /** @type {[RegExp, string, string][]} */
  const commands = [
    [
      /\bcreate\s+extension\b/gi,
      'create-extension',
      'create extension is project-wide — not a guest schema’s call',
    ],
    [/\balter\s+system\b/gi, 'alter-system', 'alter system changes the whole server'],
    [
      /\bdrop\s+schema\b/gi,
      'drop-schema',
      'drop schema is forbidden (forward-only, shared project)',
    ],
    [/\balter\s+(?:role|user)\b/gi, 'alter-role', 'alter role changes a project-wide role'],
  ]
  for (const [re, rule, message] of commands) {
    for (const m of code.matchAll(re)) add(m.index, rule, message)
  }

  // --- default-privileges: only `in schema themis` (optionally `for role x in schema themis`) --
  const adp = /\balter\s+default\s+privileges\b/gi
  const themisOnly = new RegExp(
    String.raw`^\s+(?:for\s+(?:role|user)\s+${IDENT}(?:\s*,\s*${IDENT})*\s+)?in\s+schema\s+("?)themis\1\s+(?:grant|revoke)\b`,
    'i',
  )
  for (const m of code.matchAll(adp)) {
    if (themisOnly.test(code.slice(m.index + m[0].length))) continue
    add(
      m.index,
      'default-privileges',
      'alter default privileges must be `in schema themis` (and only themis)',
    )
  }

  return v.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
}

/**
 * Check every file in a migrations directory. Dotfiles (e.g. .gitkeep) are ignored; any other
 * file must be a correctly named .sql migration.
 * @param {string} dir
 * @returns {{ files: string[], violations: Violation[], error?: string }}
 */
export function checkMigrationsDir(dir) {
  if (!existsSync(dir)) return { files: [], violations: [], error: `no such directory: ${dir}` }
  const files = readdirSync(dir)
    .filter((f) => !f.startsWith('.') && statSync(path.join(dir, f)).isFile())
    .sort()
  if (files.length === 0) return { files, violations: [], error: `no migrations found in ${dir}` }
  /** @type {Violation[]} */
  const violations = []
  for (const f of files) {
    violations.push(...checkMigrationSql(f, readFileSync(path.join(dir, f), 'utf8')))
  }
  return { files, violations }
}

/** @param {Violation} x */
export const formatViolation = (x) => `${x.file}:${x.line}  [${x.rule}]  ${x.message}`

/**
 * Run the guard and print its report. Returns true when the archive is clean.
 * @param {string} dir
 * @returns {boolean}
 */
export function runGuard(dir) {
  const { files, violations, error } = checkMigrationsDir(dir)
  if (error) {
    console.log(`FAIL  migration guard: ${error}`)
    return false
  }
  for (const x of violations) console.log(`FAIL  ${formatViolation(x)}`)
  if (violations.length > 0) {
    console.log(`\nMIGRATION GUARD FAILED — ${violations.length} violation(s) in ${dir}`)
    return false
  }
  console.log(`PASS  migration guard: ${files.length} migration(s) stay inside schema themis`)
  return true
}

export const DEFAULT_MIGRATIONS_DIR =
  process.env.DB_GATE_MIGRATIONS ??
  fileURLToPath(new URL('../supabase/migrations', import.meta.url))

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_MIGRATIONS_DIR
  process.exit(runGuard(dir) ? 0 : 1)
}
