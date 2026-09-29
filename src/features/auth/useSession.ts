import { createContext, useContext, useEffect } from 'react'
import type { AuthFailure, AuthUser } from './authClient'

/**
 * Where auth stands. `local-only`: this build has no Supabase configuration, sign-in does not exist
 * and the P0 matrix is the whole app. `unavailable`: configured, but the client could not load.
 */
export type AuthState =
  | { status: 'local-only' }
  | { status: 'loading' }
  | { status: 'unavailable'; error: AuthFailure }
  | { status: 'signed-out'; initError: AuthFailure | null }
  | { status: 'signed-in'; user: AuthUser }

export interface BootstrapResult {
  workspaceId: string | null
  error: AuthFailure | null
}

export interface AuthContextValue {
  state: AuthState
  /** Load the client and read the session. Idempotent; `useSession` calls it. */
  start(): void
  sendMagicLink(email: string): Promise<AuthFailure | null>
  /** Redirects the page to Google on success; resolves with the error otherwise. */
  signInWithGoogle(): Promise<AuthFailure | null>
  signOut(): Promise<AuthFailure | null>
  /** `themis.bootstrap_me()`, at most one call in flight. */
  bootstrap(): Promise<BootstrapResult>
}

const LOCAL_ONLY: AuthFailure = { message: 'Sign-in is not available in this build.' }

/** Used when no AuthProvider is mounted: behaves exactly like local-only mode. */
const LOCAL_ONLY_CONTEXT: AuthContextValue = {
  state: { status: 'local-only' },
  start: () => {},
  sendMagicLink: () => Promise.resolve(LOCAL_ONLY),
  signInWithGoogle: () => Promise.resolve(LOCAL_ONLY),
  signOut: () => Promise.resolve(null),
  bootstrap: () => Promise.resolve({ workspaceId: null, error: LOCAL_ONLY }),
}

export const AuthContext = createContext<AuthContextValue>(LOCAL_ONLY_CONTEXT)

/**
 * The session and the auth actions. Mounting a component that calls this is what loads the
 * Supabase client (lazily, configured builds only); routes that never call it never load it.
 */
export function useSession(): AuthContextValue {
  const ctx = useContext(AuthContext)
  const { start } = ctx
  useEffect(() => {
    start()
  }, [start])
  return ctx
}
