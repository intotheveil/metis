// THE AUTH SEAM (PLAN P2.10).
//
// The auth UI never talks to supabase-js directly. It talks to `AuthClient`, a small interface with
// exactly the calls sign-in needs. Two reasons:
//
// 1. Bundle size. supabase-js is ~55 kB gzip. The real implementation (./supabaseAuthClient.ts) is
//    reached only through the dynamic import in `loadDefaultAuthClient`, so Vite puts it and
//    supabase-js in a lazy chunk. A local-only build never calls the loader, so a local-only visitor
//    never downloads it, and a configured visitor downloads it only on a page that needs a session.
// 2. Tests. A fake `AuthClient` drives every state (signed in, expired link, provider error, …)
//    with no network and no `as any` casts of the supabase client.
//
// This file must stay free of runtime imports from supabase-js (type imports are erased).

import { isLocalOnly } from '../../lib/env'

/** The signed-in user, as much of it as the UI shows. */
export interface AuthUser {
  id: string
  email: string | null
}

/** An auth error in a UI-friendly shape: the provider's message plus its machine code if any. */
export interface AuthFailure {
  message: string
  code?: string
}

export interface AuthClient {
  /**
   * Resolves once the client has started, including the PKCE `?code=` exchange on /auth/callback
   * (detectSessionInUrl). A failed exchange (expired or reused link) is returned here: it is the
   * only place supabase-js reports it.
   */
  initialize(): Promise<{ error: AuthFailure | null }>
  /** The persisted user (localStorage), or null. This is what keeps a reload signed in. */
  getUser(): Promise<AuthUser | null>
  /** Subscribe to sign-in / sign-out / refresh. Returns the unsubscribe function. */
  onAuthStateChange(listener: (user: AuthUser | null) => void): () => void
  /** Email a magic link that lands on `redirectTo`. */
  sendMagicLink(email: string, redirectTo: string): Promise<{ error: AuthFailure | null }>
  /** The Google authorize URL (PKCE verifier already stored). The caller performs the redirect. */
  googleSignInUrl(redirectTo: string): Promise<{ url: string | null; error: AuthFailure | null }>
  /** Sign out and clear the persisted session. */
  signOut(): Promise<{ error: AuthFailure | null }>
  /** `themis.bootstrap_me()` (P2.5): idempotent; returns the personal workspace id. */
  bootstrapMe(): Promise<{ workspaceId: string | null; error: AuthFailure | null }>
}

/** Loads the client. Resolves null when the build has no Supabase configuration. */
export type AuthLoader = () => Promise<AuthClient | null>

/**
 * The app's loader: null in local-only mode (no client, nothing downloaded), otherwise a dynamic
 * import of the supabase-js implementation.
 */
export const loadDefaultAuthClient: AuthLoader | null = isLocalOnly
  ? null
  : () => import('./supabaseAuthClient').then((m) => m.loadSupabaseAuthClient())

/**
 * The OAuth / magic-link redirect target: `${origin}/auth/callback`, under Vite's base path so a
 * move back under a path (ADR-0003) needs no change here. It must be on the Supabase redirect
 * allow-list (docs/ops/AUTH_SETTINGS.md, P2.8).
 */
export function callbackUrl(
  origin: string = window.location.origin,
  base: string = import.meta.env.BASE_URL,
): string {
  const path = base.endsWith('/') ? base : `${base}/`
  return `${origin}${path}auth/callback`
}

/**
 * An error the auth server put in the redirect URL. PKCE puts it in the query, the implicit flow in
 * the hash; both are read. Supabase sends `error`, `error_code` and `error_description`.
 */
export function readUrlError(search: string, hash: string): AuthFailure | null {
  for (const raw of [search, hash]) {
    const params = new URLSearchParams(raw.replace(/^[?#]/, ''))
    const error = params.get('error')
    const code = params.get('error_code')
    const description = params.get('error_description')
    if (error || code || description) {
      return {
        message: description || error || code || 'Unknown error',
        code: code || error || undefined,
      }
    }
  }
  return null
}

/** True when the URL carries a PKCE authorization code. */
export function hasAuthCode(search: string): boolean {
  return new URLSearchParams(search.replace(/^\?/, '')).has('code')
}

/** A PKCE link can only be completed in the browser that requested it (the verifier lives there). */
export const SAME_BROWSER_TEXT =
  'This sign-in link was opened in a different browser from the one that requested it. Open it in the same browser, or request a new link.'

/** A sentence a person can act on, for any auth failure. Never empty. */
export function describeAuthError(failure: AuthFailure): string {
  const code = failure.code ?? ''
  const message = failure.message
  if (code === 'otp_expired' || /expired/i.test(message)) {
    return 'This sign-in link has expired or has already been used. Request a new one.'
  }
  if (
    /code verifier/i.test(message) ||
    code === 'bad_code_verifier' ||
    code === 'flow_state_not_found'
  ) {
    return SAME_BROWSER_TEXT
  }
  if (code === 'access_denied' || /access[_ ]denied|cancel/i.test(message)) {
    return 'Sign-in was cancelled or refused by the provider. You can try again.'
  }
  if (/rate limit/i.test(message) || code.includes('rate_limit')) {
    return 'Too many sign-in attempts. Wait a minute, then try again.'
  }
  const text = message.trim() || 'Unknown error'
  return `Sign-in failed: ${text}`
}
