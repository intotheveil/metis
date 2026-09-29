import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  callbackUrl,
  loadDefaultAuthClient,
  type AuthClient,
  type AuthFailure,
  type AuthLoader,
  type AuthUser,
} from './authClient'
import {
  AuthContext,
  type AuthContextValue,
  type AuthState,
  type BootstrapResult,
} from './useSession'

// Session state for the whole app (PLAN P2.10). The client is loaded on first use (see useSession),
// not at mount, so `/` — the P0 matrix — never pulls in supabase-js. In local-only mode (no Supabase
// env at build) the loader is null and nothing is ever loaded or sent.

const LOAD_FAILED: AuthFailure = {
  message: 'The sign-in service could not be loaded. Check your connection and reload the page.',
}
const NOT_READY: AuthFailure = { message: 'Sign-in is not available right now.' }

export interface AuthProviderProps {
  children: ReactNode
  /** Injected in tests. Default: the lazy supabase-js loader, or null in local-only mode. */
  loader?: AuthLoader | null
  /** Performs the OAuth redirect. Injected in tests. */
  redirect?: (url: string) => void
}

const signedInOrOut = (user: AuthUser | null, initError: AuthFailure | null): AuthState =>
  user ? { status: 'signed-in', user } : { status: 'signed-out', initError }

export function AuthProvider({
  children,
  loader = loadDefaultAuthClient,
  redirect = (url) => window.location.assign(url),
}: AuthProviderProps) {
  const [state, setState] = useState<AuthState>(
    loader ? { status: 'loading' } : { status: 'local-only' },
  )
  const clientRef = useRef<AuthClient | null>(null)
  const startedRef = useRef(false)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const bootstrapRef = useRef<{ userId: string; promise: Promise<BootstrapResult> } | null>(null)
  const userRef = useRef<AuthUser | null>(null)

  const apply = useCallback((next: AuthState) => {
    userRef.current = next.status === 'signed-in' ? next.user : null
    if (next.status !== 'signed-in') bootstrapRef.current = null
    setState(next)
  }, [])

  // Set on unmount. A client that finishes loading after that must not subscribe (a leak).
  const disposedRef = useRef(false)

  const start = useCallback(() => {
    if (!loader || startedRef.current) return
    startedRef.current = true
    void (async () => {
      let client: AuthClient | null
      try {
        client = await loader()
      } catch {
        client = null
      }
      if (disposedRef.current) return
      if (!client) {
        apply({ status: 'unavailable', error: LOAD_FAILED })
        return
      }
      clientRef.current = client
      let initError: AuthFailure | null
      let user: AuthUser | null = null
      try {
        initError = (await client.initialize()).error
        user = await client.getUser()
      } catch (e) {
        initError = { message: e instanceof Error ? e.message : String(e) }
      }
      if (disposedRef.current) return
      apply(signedInOrOut(user, initError))
      unsubscribeRef.current = client.onAuthStateChange((u) => {
        // Keep an init error visible until a real sign-in replaces it.
        if (u) apply({ status: 'signed-in', user: u })
        else if (userRef.current) apply({ status: 'signed-out', initError: null })
      })
    })()
  }, [loader, apply])

  useEffect(() => {
    // StrictMode unmounts and re-mounts synchronously, before any load resolves: clear the flag.
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
    }
  }, [])

  const sendMagicLink = useCallback(async (email: string) => {
    const client = clientRef.current
    if (!client) return NOT_READY
    try {
      return (await client.sendMagicLink(email.trim(), callbackUrl())).error
    } catch (e) {
      return { message: e instanceof Error ? e.message : String(e) }
    }
  }, [])

  const signInWithGoogle = useCallback(async () => {
    const client = clientRef.current
    if (!client) return NOT_READY
    try {
      const { url, error } = await client.googleSignInUrl(callbackUrl())
      if (error) return error
      if (!url) return { message: 'Google sign-in did not return a redirect address.' }
      redirect(url)
      return null
    } catch (e) {
      return { message: e instanceof Error ? e.message : String(e) }
    }
  }, [redirect])

  const signOut = useCallback(async () => {
    const client = clientRef.current
    if (!client) return null
    try {
      const { error } = await client.signOut()
      if (error) return error
    } catch (e) {
      return { message: e instanceof Error ? e.message : String(e) }
    }
    apply({ status: 'signed-out', initError: null })
    return null
  }, [apply])

  const bootstrap = useCallback((): Promise<BootstrapResult> => {
    const client = clientRef.current
    const user = userRef.current
    if (!client || !user) {
      return Promise.resolve({ workspaceId: null, error: { message: 'You are not signed in.' } })
    }
    // One call in flight per user (StrictMode runs effects twice). bootstrap_me is idempotent
    // server-side too; this just avoids a duplicate request. A failure is not cached: retry works.
    if (bootstrapRef.current?.userId === user.id) return bootstrapRef.current.promise
    const promise = client.bootstrapMe().then(
      (r) => r,
      (e: unknown) => ({
        workspaceId: null,
        error: { message: e instanceof Error ? e.message : String(e) },
      }),
    )
    const entry = { userId: user.id, promise }
    bootstrapRef.current = entry
    void promise.then((r) => {
      if (r.error && bootstrapRef.current === entry) bootstrapRef.current = null
    })
    return promise
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ state, start, sendMagicLink, signInWithGoogle, signOut, bootstrap }),
    [state, start, sendMagicLink, signInWithGoogle, signOut, bootstrap],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
