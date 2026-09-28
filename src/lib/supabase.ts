// THE SUPABASE CLIENT (PLAN P2.2, ADR-0002).
//
// Themis shares Hephaestus's live project `lss-platform`. Every Themis object lives in schema
// `themis`, so the client is pinned to it with `db: { schema: 'themis' }`: a `.from('x')` or
// `.rpc('x')` can never read or write Hephaestus's `public` tables by accident.
//
// With no configuration (see ./env.ts) there is NO client: `supabase` is null and the app runs in
// local-only mode. Importing this module never throws and, in local-only mode, makes no request.

import { createClient } from '@supabase/supabase-js'
import { appEnv, type AppEnv, type SupabaseConfig } from './env'

/** The one schema Themis may touch in the shared project (ADR-0002). */
export const THEMIS_SCHEMA = 'themis'

/** Client options, exported so they are asserted rather than re-typed in tests. */
export const THEMIS_CLIENT_OPTIONS = {
  db: { schema: THEMIS_SCHEMA },
  auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' },
} as const

/** Create a Themis client for a resolved configuration. */
export function createThemisClient(config: SupabaseConfig) {
  return createClient(config.url, config.anonKey, THEMIS_CLIENT_OPTIONS)
}

export type ThemisClient = ReturnType<typeof createThemisClient>

/** The client for an app mode, or null in local-only mode. Never throws. */
export function clientFor(env: AppEnv): ThemisClient | null {
  return env.mode === 'configured' ? createThemisClient(env.supabase) : null
}

/** The app's client: null when Supabase is not configured (local-only mode). */
export const supabase: ThemisClient | null = clientFor(appEnv)
