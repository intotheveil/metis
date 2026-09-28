// @vitest-environment node
//
// P2.1 — the bundle secret scan (`npm run check:bundle`). Every rule gets a RED fixture (asserting
// the rule id and, for values, that the full secret never appears in the output) and every
// publishable look-alike gets a GREEN fixture. JWTs are minted here at runtime, unsigned, so no
// token-shaped literal lives in the source. Directory tests write into an OS temp dir, never dist/.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FORBIDDEN_NAMES, SECRET_PREFIXES, scanDir, scanText } from './check-bundle-secrets.mjs'

/** An unsigned JWT-shaped token. The signature segment is a placeholder: nothing here is a real key. */
const mintJwt = (payload: Record<string, unknown>) => {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.not-a-real-signature`
}

const rules = (text: string) => scanText(text).map((f) => f.rule)

describe('scanText: secret-value prefixes', () => {
  // Every prefix the scan exports, plus a body. Short, obviously fake bodies.
  it.each([
    'sk_live_',
    'sk_test_',
    'rk_live_',
    'rk_test_',
    'whsec_',
    'sk-ant-',
    'sb_secret_',
    'sbp_',
  ])('flags %s followed by key characters', (prefix) => {
    const secret = `${prefix}FAKEfake0123456789abcdefXYZ`
    const findings = scanText(`const k = "${secret}";`)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'secret-value', line: 1, column: 12 })
    // Masked: the excerpt locates it but is NOT the full value, and nothing in the finding leaks it.
    expect(findings[0].excerpt).not.toBe(secret)
    expect(findings[0].excerpt.startsWith(secret.slice(0, 12))).toBe(true)
    expect(JSON.stringify(findings)).not.toContain(secret)
  })

  it('covers every exported prefix (the list above is not stale)', () => {
    expect([...SECRET_PREFIXES].sort()).toEqual(
      [
        'sk_live_',
        'sk_test_',
        'rk_live_',
        'rk_test_',
        'whsec_',
        'sk-ant-',
        'sb_secret_',
        'sbp_',
      ].sort(),
    )
  })

  it('does NOT flag a bare prefix with no key characters after it', () => {
    expect(scanText('const doc = "keys start with sk_live_";')).toEqual([])
  })

  it('does NOT flag a prefix glued to a preceding identifier (task_test_ is not sk_test_)', () => {
    expect(scanText('const task_test_alpha = 1; const mask_live_x = 2')).toEqual([])
  })

  it.each(['pk_live_', 'pk_test_'])('does NOT flag a publishable Stripe key (%s)', (prefix) => {
    expect(scanText(`const pk = "${prefix}FAKEfake0123456789abcdef";`)).toEqual([])
  })

  it('reports line and column across lines', () => {
    const text = ['// header', 'const a = 1', '  x = "whsec_FAKEabc123"'].join('\n')
    expect(scanText(text)).toMatchObject([{ rule: 'secret-value', line: 3, column: 8 }])
  })

  it('reports every hit in one file, in order', () => {
    const text = 'a="sk_test_AAAA1111" b="sbp_BBBB2222"\nc="rk_live_CCCC3333"'
    expect(scanText(text).map(({ line, column }) => [line, column])).toEqual([
      [1, 4],
      [1, 25],
      [2, 4],
    ])
  })
})

describe('scanText: service_role', () => {
  it('flags the literal service_role', () => {
    expect(rules('fetch(u, { headers: { role: "service_role" } })')).toEqual(['service-role'])
  })

  it('flags a JWT whose decoded payload has role service_role (base64 hides the literal)', () => {
    const jwt = mintJwt({ iss: 'supabase', ref: 'fakeref', role: 'service_role', iat: 1, exp: 2 })
    // Precondition: the literal is NOT in the text, so only the decoding rule can catch it.
    expect(jwt).not.toContain('service_role')
    const findings = scanText(`const key = "${jwt}"`)
    expect(findings.map((f) => f.rule)).toEqual(['service-jwt'])
    expect(findings[0]).toMatchObject({ line: 1, column: 14 })
    expect(JSON.stringify(findings)).not.toContain(jwt)
    expect(JSON.stringify(findings)).not.toContain(jwt.split('.')[1])
  })

  it('does NOT flag an anon-role JWT (it is meant to be public)', () => {
    const jwt = mintJwt({ iss: 'supabase', ref: 'fakeref', role: 'anon', iat: 1, exp: 2 })
    expect(scanText(`const anon = "${jwt}"`)).toEqual([])
  })

  it('does NOT flag a JWT-shaped string whose payload is not JSON', () => {
    const junk = `${Buffer.from('{"alg":"x"}').toString('base64url')}.eyJnotjsonatall.sig`
    expect(scanText(junk)).toEqual([])
  })
})

describe('scanText: server-only env names', () => {
  it.each(FORBIDDEN_NAMES)('flags %s, reported once, excerpt is the name', (name) => {
    const findings = scanText(`console.log("${name}")`)
    expect(findings).toEqual([
      { file: '<text>', line: 1, column: 14, rule: 'forbidden-name', excerpt: name },
    ])
  })

  it('covers the bare and THEMIS_-prefixed names of the lint rule', () => {
    for (const n of ['ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) {
      expect(FORBIDDEN_NAMES).toContain(n)
      expect(FORBIDDEN_NAMES).toContain(`THEMIS_${n}`)
    }
    expect(FORBIDDEN_NAMES).toContain('SUPABASE_SERVICE_ROLE_KEY')
    expect(FORBIDDEN_NAMES).toContain('SUPABASE_ACCESS_TOKEN')
  })

  it.each(['VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL', 'VITE_STRIPE_PUBLISHABLE_KEY'])(
    'does NOT flag the allowed public name %s',
    (name) => {
      expect(scanText(`const v = "${name}"`)).toEqual([])
    },
  )

  it('matches whole words only (a longer identifier containing a name is not a hit)', () => {
    expect(scanText('THEMIS_ANTHROPIC_API_KEY_HINT MY_STRIPE_SECRET_KEY')).toEqual([])
  })
})

describe('scanDir', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'themis-bundle-scan-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const plantCleanBuild = () => {
    mkdirSync(path.join(dir, 'assets'))
    writeFileSync(
      path.join(dir, 'index.html'),
      '<!doctype html><script src="/assets/i.js"></script>',
    )
    writeFileSync(
      path.join(dir, 'assets', 'i.js'),
      `const u="VITE_SUPABASE_URL";const pk="pk_live_FAKE123";const a="${mintJwt({ role: 'anon' })}";`,
    )
  }

  it('a clean build is ok: files and bytes counted, no findings', () => {
    plantCleanBuild()
    const result = scanDir(dir)
    expect(result.files).toBe(2)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.findings).toEqual([])
  })

  it('one planted file yields a finding with its relative, forward-slash path', () => {
    plantCleanBuild()
    mkdirSync(path.join(dir, 'assets', 'chunks'))
    const secret = 'sk_live_PLANTEDfake9876543210'
    writeFileSync(path.join(dir, 'assets', 'chunks', 'leak.js'), `\nlet k="${secret}"`)
    const { findings } = scanDir(dir)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      file: 'assets/chunks/leak.js',
      line: 2,
      column: 8,
      rule: 'secret-value',
    })
    expect(JSON.stringify(findings)).not.toContain(secret)
  })

  it('scans non-text assets too (a secret in a .map or binary-ish file is still found)', () => {
    plantCleanBuild()
    writeFileSync(
      path.join(dir, 'assets', 'i.js.map'),
      Buffer.concat([Buffer.from([0xff, 0x00, 0xfe]), Buffer.from('SUPABASE_ACCESS_TOKEN')]),
    )
    expect(scanDir(dir).findings).toMatchObject([
      { file: 'assets/i.js.map', rule: 'forbidden-name' },
    ])
  })

  it('a missing dir throws (the CLI turns this into exit 2)', () => {
    expect(() => scanDir(path.join(dir, 'no-such-dist'))).toThrow(/does not exist/)
  })

  it('a path that is a file, not a dir, throws', () => {
    const f = path.join(dir, 'file.txt')
    writeFileSync(f, 'x')
    expect(() => scanDir(f)).toThrow(/does not exist/)
  })

  it('an empty dir (or one with only empty subdirs) throws: a scan of nothing must not pass', () => {
    expect(() => scanDir(dir)).toThrow(/is empty/)
    mkdirSync(path.join(dir, 'assets'))
    expect(() => scanDir(dir)).toThrow(/is empty/)
  })
})

describe('CLI exit codes (node scripts/check-bundle-secrets.mjs <dir>)', () => {
  const SCRIPT = fileURLToPath(new URL('./check-bundle-secrets.mjs', import.meta.url))
  const run = (dir: string) => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' })
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'themis-bundle-cli-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('exits 2 on a missing dir', () => {
    const r = run(path.join(dir, 'dist'))
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/does not exist/)
  })

  it('exits 2 on an empty dir', () => {
    const r = run(dir)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/is empty/)
  })

  it('exits 0 on a clean dir', () => {
    writeFileSync(path.join(dir, 'index.html'), '<p>pk_test_FAKE1 VITE_SUPABASE_ANON_KEY</p>')
    const r = run(dir)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/check:bundle: OK/)
  })

  it('exits 1 on a finding and prints file:line:col [rule] with the value masked', () => {
    const secret = 'whsec_PLANTEDfake0123456789'
    writeFileSync(path.join(dir, 'a.js'), `x="${secret}"`)
    const r = run(dir)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/a\.js:1:4\s+\[secret-value\]/)
    expect(r.stderr + r.stdout).not.toContain(secret)
  })
})
