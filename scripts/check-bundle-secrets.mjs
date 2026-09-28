// THE BUNDLE SECRET SCAN — `npm run check:bundle` (run AFTER `npm run build`; PLAN P2.1, constraint 6)
//
// Themis is a static site: every byte in dist/ is public the moment Pages serves it. The ESLint
// rule in eslint.config.js stops src/** from READING a server-only env name, but it cannot see a
// secret VALUE that arrives another way: a Stripe secret key pasted into VITE_STRIPE_PUBLISHABLE_KEY,
// a service-role JWT pasted into VITE_SUPABASE_ANON_KEY, a key hardcoded in a string, or a
// dependency that inlines one. This scan reads the real build output and fails on:
//
//   secret-value   a secret-looking prefix: sk_live_ / sk_test_ / rk_live_ / rk_test_ (Stripe secret
//                  and restricted keys), whsec_ (Stripe webhook secret), sk-ant- (Anthropic key),
//                  sb_secret_ (Supabase secret API key), sbp_ (Supabase personal access token)
//   service-role   the literal `service_role`
//   service-jwt    a JWT whose decoded payload has "role":"service_role" (base64 hides the literal,
//                  so the plain grep above would miss exactly the key that bypasses RLS)
//   forbidden-name a server-only env NAME, bare or THEMIS_-prefixed (the same list as the lint rule):
//                  a name in the bundle means server-side code or config leaked into browser code
//
// Publishable values are NOT findings: pk_live_/pk_test_ Stripe keys and the anon JWT are meant to
// be public. Findings print a masked excerpt only (never the full value), as `file:line:col [rule]`.
//
// Exit codes: 0 clean · 1 one or more findings · 2 nothing to scan (dist/ missing or empty — run
// `npm run build` first; a scan of nothing must not pass).
//
// Usage: node scripts/check-bundle-secrets.mjs [dir]   (dir defaults to dist/). Import `scanText` /
// `scanDir` to use it in-process.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * @typedef {object} Finding
 * @property {string} file    path relative to the scanned dir, forward slashes
 * @property {number} line    1-based
 * @property {number} column  1-based
 * @property {string} rule    'secret-value' | 'service-role' | 'service-jwt' | 'forbidden-name'
 * @property {string} excerpt masked: enough to locate it, never the full secret
 */

export const DEFAULT_DIR = fileURLToPath(new URL('../dist', import.meta.url))

/** Secret-looking value prefixes. A prefix followed by at least one key character is a finding. */
export const SECRET_PREFIXES = [
  'sk_live_',
  'sk_test_',
  'rk_live_',
  'rk_test_',
  'whsec_',
  'sk-ant-',
  'sb_secret_',
  'sbp_',
]

/** Server-only env names (bare and ADR-0002 THEMIS_-prefixed). Mirrors eslint.config.js SERVER_SECRET. */
export const FORBIDDEN_NAMES = [
  'ANTHROPIC_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'THEMIS_ANTHROPIC_API_KEY',
  'THEMIS_STRIPE_SECRET_KEY',
  'THEMIS_STRIPE_WEBHOOK_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ACCESS_TOKEN',
]

const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

// A prefix must not be glued to a preceding identifier character (so `task_test_x` is not `sk_test_`)
// and must be followed by at least one key character.
const PREFIX_RE = new RegExp(
  `(?<![A-Za-z0-9])(?:${SECRET_PREFIXES.map(escape).join('|')})[A-Za-z0-9_-]+`,
  'g',
)
const SERVICE_ROLE_RE = /service_role/g
// The shortest names are suffixes of the prefixed ones, so match whole words and report once.
const NAME_RE = new RegExp(
  `(?<![A-Za-z0-9_])(?:${FORBIDDEN_NAMES.map(escape).join('|')})(?![A-Za-z0-9_])`,
  'g',
)
const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g

/** @param {string} s */
function mask(s) {
  return s.length <= 12 ? s : `${s.slice(0, 12)}…(${s.length} chars)`
}

/** @param {string} text @param {number} index */
function position(text, index) {
  let line = 1
  let lineStart = 0
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) {
    line++
    lineStart = i + 1
  }
  return { line, column: index - lineStart + 1 }
}

/** @param {string} segment base64url JWT segment @returns {unknown} */
function decodeJwtPart(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Scan one file's text.
 * @param {string} text
 * @param {string} [file]
 * @returns {Finding[]}
 */
export function scanText(text, file = '<text>') {
  /** @type {Finding[]} */
  const out = []
  // A forbidden NAME is not a secret, so it is shown in full; every value is masked.
  /** @param {RegExp} re @param {string} rule @param {(m: RegExpExecArray) => boolean} [keep] */
  const run = (re, rule, keep) => {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (keep && !keep(m)) continue
      const excerpt = rule === 'forbidden-name' ? m[0] : mask(m[0])
      out.push({ file, ...position(text, m.index), rule, excerpt })
    }
  }
  run(PREFIX_RE, 'secret-value')
  run(SERVICE_ROLE_RE, 'service-role')
  run(NAME_RE, 'forbidden-name')
  run(JWT_RE, 'service-jwt', (m) => {
    const payload = decodeJwtPart(m[0].split('.')[1])
    return (
      typeof payload === 'object' &&
      payload !== null &&
      /** @type {{role?: unknown}} */ (payload).role === 'service_role'
    )
  })
  return out.sort((a, b) => a.line - b.line || a.column - b.column)
}

/** @param {string} dir @returns {string[]} absolute file paths, sorted */
function walk(dir) {
  /** @type {string[]} */
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.isFile()) files.push(full)
  }
  return files.sort()
}

/**
 * Scan every file under `dir` (binary files included, read as latin1 so no byte is dropped).
 * @param {string} dir
 * @returns {{ files: number, bytes: number, findings: Finding[] }}
 */
export function scanDir(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`${dir} does not exist. Run \`npm run build\` first.`)
  }
  const paths = walk(dir)
  if (paths.length === 0) throw new Error(`${dir} is empty. Run \`npm run build\` first.`)
  let bytes = 0
  /** @type {Finding[]} */
  const findings = []
  for (const p of paths) {
    const buf = readFileSync(p)
    bytes += buf.length
    const rel = path.relative(dir, p).split(path.sep).join('/')
    findings.push(...scanText(buf.toString('latin1'), rel))
  }
  return { files: paths.length, bytes, findings }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dir = path.resolve(process.argv[2] ?? DEFAULT_DIR)
  /** @type {ReturnType<typeof scanDir>} */
  let result
  try {
    result = scanDir(dir)
  } catch (err) {
    console.error(`check:bundle: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
  for (const f of result.findings) {
    console.error(`${f.file}:${f.line}:${f.column}  [${f.rule}]  ${f.excerpt}`)
  }
  const summary = `${result.files} files, ${result.bytes} bytes scanned in ${path.relative(process.cwd(), dir) || '.'}`
  if (result.findings.length > 0) {
    console.error(
      `check:bundle: FAIL: ${result.findings.length} finding(s) in the public bundle (${summary}).`,
    )
    console.error(
      'Every byte in dist/ is public. Move the secret server-side (Edge Function secret) and rebuild.',
    )
    process.exit(1)
  }
  console.log(`check:bundle: OK, no secret-looking value or server-only name (${summary}).`)
}
