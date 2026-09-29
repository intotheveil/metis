// P2.10 — the supabase-js adapter (toAuthClient) against a REAL supabase-js client built with the
// app's options (schema themis, PKCE, persistSession). Global fetch is a stub that records every
// request and answers from a script, so nothing leaves the process. This is what proves the fake
// in auth.test.tsx describes supabase-js truthfully: PKCE parameters, the callback redirect, the
// persisted session that survives a reload, sign-out clearing it, and bootstrap_me in schema themis.

import { createThemisClient, type ThemisClient } from '../../lib/supabase'
import { toAuthClient } from './supabaseAuthClient'

const URL_BASE = 'https://test-ref.supabase.co'
const STORAGE_KEY = 'sb-test-ref-auth-token' // supabase-js: sb-<first host label>-auth-token
const CALLBACK = 'https://themis.adeonanalytics.com/auth/callback'

interface Call {
  url: URL
  method: string
  headers: Headers
  body: unknown
}

let calls: Call[]
let respond: (call: Call) => Response

function stubFetch() {
  calls = []
  respond = () => new Response('{"message":"unexpected request"}', { status: 500 })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      const text = await req.text()
      const call: Call = {
        url: new URL(req.url),
        method: req.method,
        headers: req.headers,
        body: text ? (JSON.parse(text) as unknown) : null,
      }
      calls.push(call)
      return respond(call)
    }),
  )
}

// GoTrue answers with x-supabase-api-version; auth-js reads an error's `code` only when it is there.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' },
  })

/** A session as supabase-js persists it, valid for an hour. */
function persistedSession(email = 'a@example.com') {
  const now = Math.floor(Date.now() / 1000)
  return {
    access_token: 'header.payload.signature',
    refresh_token: 'refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    user: {
      id: 'user-a',
      aud: 'authenticated',
      role: 'authenticated',
      email,
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  }
}

let raw: ThemisClient

beforeEach(() => {
  localStorage.clear()
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function client() {
  raw = createThemisClient({ url: URL_BASE, anonKey: 'anon-key-placeholder' })
  return toAuthClient(raw)
}

describe('toAuthClient over real supabase-js', () => {
  it('reload: a persisted session is read from storage with no request', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedSession()))
    const auth = client()
    expect(await auth.initialize()).toEqual({ error: null })
    expect(await auth.getUser()).toEqual({ id: 'user-a', email: 'a@example.com' })
    expect(calls).toEqual([])
  })

  it('no persisted session → getUser() is null, no request', async () => {
    const auth = client()
    await auth.initialize()
    expect(await auth.getUser()).toBeNull()
    expect(calls).toEqual([])
  })

  it('Google: a PKCE authorize URL for provider google that returns to /auth/callback, no request', async () => {
    const auth = client()
    await auth.initialize()
    const { url, error } = await auth.googleSignInUrl(CALLBACK)
    expect(error).toBeNull()
    const u = new URL(url!)
    expect(u.origin + u.pathname).toBe(`${URL_BASE}/auth/v1/authorize`)
    expect(u.searchParams.get('provider')).toBe('google')
    expect(u.searchParams.get('redirect_to')).toBe(CALLBACK)
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(u.searchParams.get('code_challenge_method')).toBe('s256')
    // The verifier is kept in this browser for the exchange on /auth/callback.
    expect(localStorage.getItem(`${STORAGE_KEY}-code-verifier`)).not.toBeNull()
    expect(calls).toEqual([])
  })

  it('magic link: POST /auth/v1/otp with a PKCE challenge and redirect_to /auth/callback', async () => {
    respond = () => json({})
    const auth = client()
    await auth.initialize()
    expect(await auth.sendMagicLink('a@example.com', CALLBACK)).toEqual({ error: null })
    expect(calls).toHaveLength(1)
    const [otp] = calls
    expect(otp.method).toBe('POST')
    expect(otp.url.pathname).toBe('/auth/v1/otp')
    expect(otp.url.searchParams.get('redirect_to')).toBe(CALLBACK)
    expect(otp.body).toMatchObject({
      email: 'a@example.com',
      create_user: true,
      code_challenge_method: 's256',
    })
    expect((otp.body as { code_challenge: string }).code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('magic link: a server error keeps its code (rate limit)', async () => {
    respond = () =>
      json({ code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }, 429)
    const auth = client()
    await auth.initialize()
    const { error } = await auth.sendMagicLink('a@example.com', CALLBACK)
    expect(error).toEqual({
      message: 'email rate limit exceeded',
      code: 'over_email_send_rate_limit',
    })
  })

  it('sign-out: calls /auth/v1/logout and clears the persisted session', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedSession()))
    respond = () => new Response(null, { status: 204 })
    const auth = client()
    await auth.initialize()
    const seen: (string | null)[] = []
    const unsubscribe = auth.onAuthStateChange((u) => seen.push(u?.id ?? null))
    expect(await auth.signOut()).toEqual({ error: null })
    expect(calls.map((c) => c.url.pathname)).toEqual(['/auth/v1/logout'])
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(await auth.getUser()).toBeNull()
    await vi.waitFor(() => expect(seen.at(-1)).toBeNull())
    unsubscribe()
  })

  it('bootstrap_me: POST /rest/v1/rpc/bootstrap_me in schema themis with the user token', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedSession()))
    respond = () => json('0b7e1c1e-0000-4000-8000-000000000001')
    const auth = client()
    await auth.initialize()
    expect(await auth.bootstrapMe()).toEqual({
      workspaceId: '0b7e1c1e-0000-4000-8000-000000000001',
      error: null,
    })
    const [rpc] = calls
    expect(rpc.method).toBe('POST')
    expect(rpc.url.pathname).toBe('/rest/v1/rpc/bootstrap_me')
    expect(rpc.headers.get('content-profile')).toBe('themis')
    expect(rpc.headers.get('authorization')).toBe('Bearer header.payload.signature')
  })

  it('bootstrap_me: a PostgREST error is returned with its code', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedSession()))
    respond = () =>
      json({ code: '42501', message: 'not_authenticated', details: null, hint: null }, 403)
    const auth = client()
    await auth.initialize()
    expect(await auth.bootstrapMe()).toEqual({
      workspaceId: null,
      error: { message: 'not_authenticated', code: '42501' },
    })
  })

  it('bootstrap_me: an empty result is an error, never a navigation to /w/null', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedSession()))
    respond = () => json(null)
    const auth = client()
    await auth.initialize()
    const r = await auth.bootstrapMe()
    expect(r.workspaceId).toBeNull()
    expect(r.error?.message).toMatch(/no workspace id/)
  })
})
