import { THEMIS_CLIENT_OPTIONS, THEMIS_SCHEMA, clientFor, type ThemisClient } from './supabase'

// PLAN P2.2 / ADR-0002: Themis shares Hephaestus's Supabase project, so the client MUST be pinned
// to schema `themis` (never `public`) and use PKCE auth. In local-only mode there is no client.
// Every test here runs with a stubbed global fetch and asserts it was never called: creating a
// client and building queries must not touch the network.

const CONFIGURED = {
  mode: 'configured',
  supabase: { url: 'https://example.invalid', anonKey: 'anon-key-placeholder' },
} as const

// reason: the schema / auth settings live on protected fields of supabase-js internals; reading
// them through a narrow structural view is the only way to observe them without a request.
interface BuilderView {
  schema?: string
  url: URL
}
interface AuthView {
  flowType: string
  persistSession: boolean
  detectSessionInUrl: unknown
}

const builderView = (b: unknown) => b as BuilderView
const authView = (c: ThemisClient) => c.auth as unknown as AuthView

/** Let the auth client's async initialize() settle so any request it would make has been made. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error('network is forbidden in unit tests')))
  vi.stubGlobal('fetch', fetchSpy)
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('THEMIS_CLIENT_OPTIONS', () => {
  it('has exactly the P2.2 shape', () => {
    expect(THEMIS_SCHEMA).toBe('themis')
    expect(THEMIS_CLIENT_OPTIONS).toStrictEqual({
      db: { schema: 'themis' },
      auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' },
    })
  })
})

describe('clientFor', () => {
  it.each(['missing-url', 'missing-anon-key', 'invalid-url'] as const)(
    'local mode (%s) → null, no request',
    async (reason) => {
      expect(clientFor({ mode: 'local', reason })).toBeNull()
      await settle()
      expect(fetchSpy).not.toHaveBeenCalled()
    },
  )

  it('configured → .from() targets schema themis on the configured REST url, no request', async () => {
    const client = clientFor(CONFIGURED)
    expect(client).not.toBeNull()
    const q = builderView(client!.from('decisions').select('*'))
    expect(q.schema).toBe('themis')
    expect(q.url.origin).toBe('https://example.invalid')
    expect(q.url.pathname).toBe('/rest/v1/decisions')
    await settle()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('configured → .rpc() targets schema themis, not public, no request', async () => {
    const client = clientFor(CONFIGURED)!
    const r = builderView(client.rpc('x'))
    expect(r.schema).toBe('themis')
    expect(r.schema).not.toBe('public')
    expect(r.url.pathname).toBe('/rest/v1/rpc/x')
    await settle()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('configured → auth uses pkce with persistSession and detectSessionInUrl on', async () => {
    const client = clientFor(CONFIGURED)!
    const auth = authView(client)
    expect(auth.flowType).toBe('pkce')
    expect(auth.persistSession).toBe(true)
    expect(auth.detectSessionInUrl).toBe(true)
    await settle()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('module-level `supabase` export', () => {
  it('with both VITE_SUPABASE_* unset → supabase is null, import does not throw, no request', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', undefined)
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', undefined)
    vi.resetModules()
    const envMod = await import('./env')
    const mod = await import('./supabase')
    expect(envMod.appEnv).toEqual({ mode: 'local', reason: 'missing-url' })
    expect(envMod.isLocalOnly).toBe(true)
    expect(mod.supabase).toBeNull()
    await settle()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('with only the url set → supabase is null (missing-anon-key)', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.invalid')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', undefined)
    vi.resetModules()
    const envMod = await import('./env')
    const mod = await import('./supabase')
    expect(envMod.appEnv).toEqual({ mode: 'local', reason: 'missing-anon-key' })
    expect(mod.supabase).toBeNull()
  })

  it('with a malformed url → supabase is null (invalid-url), import does not throw', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'example.invalid')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key-placeholder')
    vi.resetModules()
    const envMod = await import('./env')
    const mod = await import('./supabase')
    expect(envMod.appEnv).toEqual({ mode: 'local', reason: 'invalid-url' })
    expect(mod.supabase).toBeNull()
  })

  it('with both set → supabase is a themis-pinned client, no request', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.invalid')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key-placeholder')
    vi.resetModules()
    const envMod = await import('./env')
    const mod = await import('./supabase')
    expect(envMod.isLocalOnly).toBe(false)
    expect(mod.supabase).not.toBeNull()
    const q = builderView(mod.supabase!.from('decisions'))
    expect(q.schema).toBe('themis')
    expect(q.url.origin).toBe('https://example.invalid')
    await settle()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
