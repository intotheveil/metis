import { resolveAppEnv, type RawSupabaseEnv } from './env'

// PLAN P2.2: missing or malformed env selects LOCAL-ONLY mode (never a throw); both names present
// with an absolute http(s) URL selects CONFIGURED mode.

const URL_OK = 'https://abcdefgh.supabase.co'
const KEY_OK = 'anon-key-placeholder'

describe('resolveAppEnv — local-only mode', () => {
  it('missing url (key present) → local, missing-url', () => {
    expect(resolveAppEnv({ VITE_SUPABASE_ANON_KEY: KEY_OK })).toEqual({
      mode: 'local',
      reason: 'missing-url',
    })
  })

  it('both missing → local, missing-url (url is checked first)', () => {
    expect(resolveAppEnv({})).toEqual({ mode: 'local', reason: 'missing-url' })
  })

  it.each(['', '   ', '\t\n'])('blank url %j → local, missing-url', (url) => {
    expect(resolveAppEnv({ VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: KEY_OK })).toEqual({
      mode: 'local',
      reason: 'missing-url',
    })
  })

  it('missing anon key (url valid) → local, missing-anon-key', () => {
    expect(resolveAppEnv({ VITE_SUPABASE_URL: URL_OK })).toEqual({
      mode: 'local',
      reason: 'missing-anon-key',
    })
  })

  it.each(['', ' ', '   \t '])('blank/whitespace anon key %j → local, missing-anon-key', (key) => {
    expect(resolveAppEnv({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: key })).toEqual({
      mode: 'local',
      reason: 'missing-anon-key',
    })
  })

  it.each([
    ['relative path', '/rest/v1'],
    ['host without scheme', 'abcdefgh.supabase.co'],
    ['garbage', 'not a url at all'],
    ['scheme only', 'https://'],
  ])('%s (%j) → local, invalid-url', (_label, url) => {
    expect(resolveAppEnv({ VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: KEY_OK })).toEqual({
      mode: 'local',
      reason: 'invalid-url',
    })
  })

  it.each([
    'ftp://abcdefgh.supabase.co',
    'ws://abcdefgh.supabase.co',
    'javascript:alert(1)',
    'file:///etc/passwd',
  ])('non-http(s) scheme %j → local, invalid-url', (url) => {
    expect(resolveAppEnv({ VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: KEY_OK })).toEqual({
      mode: 'local',
      reason: 'invalid-url',
    })
  })
})

describe('resolveAppEnv — configured mode', () => {
  it('valid https url + key → configured with those values', () => {
    expect(resolveAppEnv({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: KEY_OK })).toEqual({
      mode: 'configured',
      supabase: { url: URL_OK, anonKey: KEY_OK },
    })
  })

  it('valid http localhost url (local supabase) → configured', () => {
    expect(
      resolveAppEnv({
        VITE_SUPABASE_URL: 'http://localhost:54321',
        VITE_SUPABASE_ANON_KEY: KEY_OK,
      }),
    ).toEqual({
      mode: 'configured',
      supabase: { url: 'http://localhost:54321', anonKey: KEY_OK },
    })
  })

  it('trims surrounding whitespace from both values', () => {
    expect(
      resolveAppEnv({ VITE_SUPABASE_URL: `  ${URL_OK}\n`, VITE_SUPABASE_ANON_KEY: `\t${KEY_OK} ` }),
    ).toEqual({ mode: 'configured', supabase: { url: URL_OK, anonKey: KEY_OK } })
  })
})

describe('resolveAppEnv — never throws on odd input', () => {
  // The module-level `appEnv` is computed at import from whatever Vite provides, so a throw here
  // would break the whole app at load. Odd shapes must degrade to local mode, not throw.
  const odd: [string, unknown][] = [
    [
      'explicit undefined values',
      { VITE_SUPABASE_URL: undefined, VITE_SUPABASE_ANON_KEY: undefined },
    ],
    ['numeric url', { VITE_SUPABASE_URL: 42, VITE_SUPABASE_ANON_KEY: KEY_OK }],
    ['numeric key', { VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: 0 }],
    ['boolean values', { VITE_SUPABASE_URL: true, VITE_SUPABASE_ANON_KEY: false }],
    ['null values', { VITE_SUPABASE_URL: null, VITE_SUPABASE_ANON_KEY: null }],
  ]

  it.each(odd)('%s → does not throw and is local mode', (_label, raw) => {
    let result: ReturnType<typeof resolveAppEnv> | undefined
    expect(() => {
      result = resolveAppEnv(raw as RawSupabaseEnv)
    }).not.toThrow()
    expect(result?.mode).toBe('local')
  })
})
