// @vitest-environment node
//
// P2.1 — the server/client secret boundary, exercised through the REAL eslint.config.js via ESLint's
// Node API. Nothing here re-implements the selectors: if eslint.config.js stops catching a form,
// these tests go red. The same source is linted as if it lived in src/ (browser: must error) and in
// scripts/, e2e/ and supabase/functions/ (server side: must be clean).
//
// Regression guard: argus-news's selector `MemberExpression[object.type='MetaProperty'] > Identifier`
// never fires on `import.meta.env.X` (BRAIN.md §5). The explicit test below is the one that catches a
// copy of it.

import { ESLint } from 'eslint'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONFIG = fileURLToPath(new URL('../eslint.config.js', import.meta.url))

let eslint: ESLint
beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT, overrideConfigFile: CONFIG })
})

const SECRET_MSG = /Server-only secret in browser code/
const VITE_MSG = /VITE_ name outside the allow-list/

/** Lint `code` as the file `filePath` (relative to the repo root); return only the boundary hits. */
async function boundary(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${filePath}` })
  // A parse error would make "no hits" meaningless, so fail loudly on one.
  const fatal = result.messages.filter((m) => m.fatal)
  expect(fatal, `parse error in fixture for ${filePath}`).toEqual([])
  return result.messages
    .filter((m) => m.ruleId === 'no-restricted-syntax')
    .map(({ line, message, severity }) => ({ line, message, severity }))
}

const SERVER_NAMES = [
  'ANTHROPIC_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'THEMIS_ANTHROPIC_API_KEY',
  'THEMIS_STRIPE_SECRET_KEY',
  'THEMIS_STRIPE_WEBHOOK_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ACCESS_TOKEN',
]

/** The four access forms, each for import.meta.env and process.env. */
const FORMS: Array<[string, (n: string) => string]> = [
  ['import.meta.env.X', (n) => `export const v = import.meta.env.${n}`],
  ['process.env.X', (n) => `export const v = process.env.${n}`],
  ["import.meta.env['X']", (n) => `export const v = import.meta.env['${n}']`],
  ["process.env['X']", (n) => `export const v = process.env['${n}']`],
  ['const { X } = import.meta.env', (n) => `export const { ${n} } = import.meta.env`],
  ['const { X } = process.env', (n) => `export const { ${n} } = process.env`],
]

const CASES = FORMS.flatMap(([form, make]) =>
  SERVER_NAMES.map((name) => ({ form, name, code: make(name) })),
)

describe('regression: the argus-news false negative', () => {
  it('import.meta.env.ANTHROPIC_API_KEY in src/ MUST error', async () => {
    expect(
      await boundary('export const k = import.meta.env.ANTHROPIC_API_KEY', 'src/leak.ts'),
    ).toEqual([{ line: 1, message: expect.stringMatching(SECRET_MSG), severity: 2 }])
  })

  it('import.meta.env.THEMIS_ANTHROPIC_API_KEY in src/ MUST error', async () => {
    expect(
      await boundary('export const k = import.meta.env.THEMIS_ANTHROPIC_API_KEY', 'src/leak.tsx'),
    ).toHaveLength(1)
  })
})

describe('src/**: every forbidden access form errors, bare and THEMIS_ names', () => {
  it.each(CASES)('$form with $name', async ({ code }) => {
    expect(await boundary(code, 'src/lib/leak.ts')).toEqual([
      { line: 1, message: expect.stringMatching(SECRET_MSG), severity: 2 },
    ])
  })

  it('applies to every JS/TS extension under src/', async () => {
    for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs']) {
      const hits = await boundary(
        'export const k = import.meta.env.STRIPE_SECRET_KEY',
        `src/deep/nested/leak.${ext}`,
      )
      expect(hits, `.${ext}`).toHaveLength(1)
    }
    // CommonJS cannot use import.meta or export; process.env is its form.
    const cjs = await boundary(
      'module.exports = process.env.STRIPE_SECRET_KEY',
      'src/deep/nested/leak.cjs',
    )
    expect(cjs, '.cjs').toHaveLength(1)
  })

  it('reports each read on its own line in a multi-read file', async () => {
    const code = [
      'const ok = import.meta.env.VITE_SUPABASE_URL',
      'const a = import.meta.env.SUPABASE_SERVICE_ROLE_KEY',
      'const b = process.env.THEMIS_STRIPE_WEBHOOK_SECRET',
      'const c = import.meta.env.VITE_SECRET_THING',
      'export { ok, a, b, c }',
    ].join('\n')
    expect((await boundary(code, 'src/App.tsx')).map((h) => h.line)).toEqual([2, 3, 4])
  })

  it('does not flag names that only contain a forbidden name', async () => {
    const code = [
      'export const a = import.meta.env.THEMIS_ANTHROPIC_API_KEY_HINT',
      'export const b = import.meta.env.MY_STRIPE_SECRET_KEY',
      'export const c = import.meta.env.THEMIS_SUPABASE_SERVICE_ROLE_KEY',
    ].join('\n')
    expect(await boundary(code, 'src/lib/names.ts')).toEqual([])
  })
})

describe('src/**: the VITE_ allow-list', () => {
  it.each([
    'export const v = import.meta.env.VITE_FOO',
    'export const v = import.meta.env.VITE_STRIPE_SECRET_KEY',
    'export const v = import.meta.env.VITE_SUPABASE_URL_OVERRIDE',
    "export const v = import.meta.env['VITE_FOO']",
    'export const { VITE_FOO } = import.meta.env',
    'export const v = process.env.VITE_FOO',
    'export const v = import.meta.env.VITE_FLEET_',
  ])('unlisted VITE_ name errors: %s', async (code) => {
    expect(await boundary(code, 'src/lib/env.ts')).toEqual([
      { line: 1, message: expect.stringMatching(VITE_MSG), severity: 2 },
    ])
  })

  it.each([
    'VITE_SUPABASE_URL',
    'VITE_SUPABASE_ANON_KEY',
    'VITE_STRIPE_PUBLISHABLE_KEY',
    'VITE_FLEET_TELEMETRY_URL',
    'VITE_FLEET_PRODUCT',
    'BASE_URL',
    'MODE',
    'DEV',
    'PROD',
  ])('allowed name %s is clean in every form', async (name) => {
    const code = [
      `export const a = import.meta.env.${name}`,
      `export const b = import.meta.env['${name}']`,
      `export const { ${name} } = import.meta.env`,
    ].join('\n')
    expect(await boundary(code, 'src/lib/env.ts')).toEqual([])
  })
})

describe('server-side paths are outside the rule', () => {
  // Every forbidden case plus an unlisted VITE_ name, one per line, each in its own block scope.
  const ALL_FORBIDDEN = [...CASES.map((c) => c.code), 'export const v = import.meta.env.VITE_FOO']
    .map((line) => `{ ${line.replace('export ', '')} }`)
    .join('\n')

  it('precondition: the combined fixture is fully RED under src/', async () => {
    expect(await boundary(ALL_FORBIDDEN, 'src/combined.ts')).toHaveLength(CASES.length + 1)
  })

  it.each([
    'scripts/ops.ts',
    'scripts/lib/ops.mjs',
    'e2e/live/auth.spec.ts',
    'supabase/functions/stripe-webhook/index.ts',
  ])('the same code in %s is clean', async (file) => {
    expect(await boundary(ALL_FORBIDDEN, file)).toEqual([])
  })
})
