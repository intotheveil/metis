// The supabase-js implementation of AuthClient (PLAN P2.10). LAZY: only ever reached through the
// dynamic import in ./authClient.ts, so this module, src/lib/supabase.ts and supabase-js itself are
// a separate chunk that a local-only visitor never downloads. Do not import this file statically.

import type { AuthError, Session } from '@supabase/supabase-js'
import { supabase, type ThemisClient } from '../../lib/supabase'
import type { AuthClient, AuthFailure, AuthUser } from './authClient'

function toUser(session: Session | null): AuthUser | null {
  if (!session) return null
  return { id: session.user.id, email: session.user.email ?? null }
}

/** AuthError → AuthFailure. The redirect error class keeps the server's code in `details.code`. */
function toFailure(error: AuthError | null): AuthFailure | null {
  if (!error) return null
  const details: unknown = (error as { details?: unknown }).details
  const detailCode =
    typeof details === 'object' && details !== null && 'code' in details
      ? String((details as { code: unknown }).code)
      : undefined
  const code = error.code ?? detailCode
  return code ? { message: error.message, code } : { message: error.message }
}

export function toAuthClient(client: ThemisClient): AuthClient {
  return {
    async initialize() {
      const { error } = await client.auth.initialize()
      return { error: toFailure(error) }
    },
    async getUser() {
      const { data } = await client.auth.getSession()
      return toUser(data.session)
    },
    onAuthStateChange(listener) {
      const { data } = client.auth.onAuthStateChange((_event, session) => listener(toUser(session)))
      return () => data.subscription.unsubscribe()
    },
    async sendMagicLink(email, redirectTo) {
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
      })
      return { error: toFailure(error) }
    },
    async googleSignInUrl(redirectTo) {
      // skipBrowserRedirect: the provider performs the redirect itself, so it stays testable.
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: true },
      })
      return { url: data.url ?? null, error: toFailure(error) }
    },
    async signOut() {
      const { error } = await client.auth.signOut()
      return { error: toFailure(error) }
    },
    async bootstrapMe() {
      // The client is pinned to schema `themis` (src/lib/supabase.ts), so this is themis.bootstrap_me().
      const { data, error } = await client.rpc('bootstrap_me')
      if (error) return { workspaceId: null, error: { message: error.message, code: error.code } }
      if (typeof data !== 'string' || data === '') {
        return { workspaceId: null, error: { message: 'bootstrap_me returned no workspace id' } }
      }
      return { workspaceId: data, error: null }
    },
  }
}

/** The app's AuthClient, or null when the build has no Supabase configuration. */
export function loadSupabaseAuthClient(): AuthClient | null {
  return supabase ? toAuthClient(supabase) : null
}
