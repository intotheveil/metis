// A scriptable in-memory AuthClient for tests (PLAN P2.10). No network, no supabase-js: every call is
// a vi.fn whose result the test chooses, and `emit` plays the part of supabase-js's
// onAuthStateChange. `persisted` stands in for the localStorage session that survives a reload.
// Test-only: imported by *.test.tsx files, never by app code (so it never reaches the bundle).

import { vi, type Mock } from 'vitest'
import type { AuthClient, AuthFailure, AuthUser } from './authClient'

export interface FakeAuthOptions {
  /** The session found at start (a reload of a signed-in browser). */
  persisted?: AuthUser | null
  /** What initialize() reports, e.g. a failed PKCE exchange. */
  initError?: AuthFailure | null
  bootstrap?: { workspaceId: string | null; error: AuthFailure | null }
}

export type FakeAuthClient = {
  [K in keyof AuthClient]: Mock<AuthClient[K]>
} & {
  /** Fire an auth state change (SIGNED_IN / SIGNED_OUT) to every subscriber. */
  emit(user: AuthUser | null): void
  /** Listeners currently subscribed. */
  listenerCount(): number
}

export const USER_A: AuthUser = { id: 'user-a', email: 'a@example.com' }

export function fakeAuthClient(opts: FakeAuthOptions = {}): FakeAuthClient {
  let session: AuthUser | null = opts.persisted ?? null
  const listeners = new Set<(user: AuthUser | null) => void>()
  return {
    initialize: vi.fn<AuthClient['initialize']>(() =>
      Promise.resolve({ error: opts.initError ?? null }),
    ),
    getUser: vi.fn<AuthClient['getUser']>(() => Promise.resolve(session)),
    onAuthStateChange: vi.fn<AuthClient['onAuthStateChange']>((listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
    sendMagicLink: vi.fn<AuthClient['sendMagicLink']>(() => Promise.resolve({ error: null })),
    googleSignInUrl: vi.fn<AuthClient['googleSignInUrl']>(() =>
      Promise.resolve({ url: 'https://accounts.example/authorize?x=1', error: null }),
    ),
    signOut: vi.fn<AuthClient['signOut']>(() => {
      session = null
      return Promise.resolve({ error: null })
    }),
    bootstrapMe: vi.fn<AuthClient['bootstrapMe']>(() =>
      Promise.resolve(opts.bootstrap ?? { workspaceId: 'ws-personal', error: null }),
    ),
    emit(user: AuthUser | null) {
      session = user
      for (const l of [...listeners]) l(user)
    },
    listenerCount: () => listeners.size,
  }
}
