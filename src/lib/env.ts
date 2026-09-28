// BROWSER ENV — the only place src/** reads the Supabase configuration (PLAN P2.2, constraint 6).
//
// Themis must keep working with NO backend configured: CI builds without env vars, and until the
// live `themis` schema exists (P1.14) the deployed site has none either. So a missing or malformed
// value never throws here. It selects LOCAL-ONLY mode, in which the app is exactly the P0
// client-side matrix and nothing is sent anywhere.
//
// Only the two constraint-6 names are read, each by its full literal name. Never pass
// `import.meta.env` around as a whole object: Vite then inlines EVERY `VITE_*` variable present at
// build time into the public bundle, which would bypass the lint allow-list in eslint.config.js.

// Vite types unknown `import.meta.env` keys as `any`; pin the two names this app reads.
declare global {
  interface ImportMetaEnv {
    readonly VITE_SUPABASE_URL?: string
    readonly VITE_SUPABASE_ANON_KEY?: string
  }
}

/** The raw values as Vite provides them (undefined when unset). */
export interface RawSupabaseEnv {
  VITE_SUPABASE_URL?: string
  VITE_SUPABASE_ANON_KEY?: string
}

/** A usable Supabase configuration: a parsed http(s) URL and a non-empty anon key. */
export interface SupabaseConfig {
  url: string
  anonKey: string
}

export type LocalOnlyReason = 'missing-url' | 'missing-anon-key' | 'invalid-url'

export type AppEnv =
  { mode: 'configured'; supabase: SupabaseConfig } | { mode: 'local'; reason: LocalOnlyReason }

/**
 * Decide the app mode from raw env values. Pure: never throws, never reads globals.
 * Both names must be present (non-blank) and the URL must be an absolute http(s) URL, otherwise
 * the result is local-only mode with the first reason found.
 */
export function resolveAppEnv(raw: RawSupabaseEnv): AppEnv {
  // `typeof` rather than `?.`: a non-string (number, boolean) must mean local-only, not a TypeError.
  const url = typeof raw.VITE_SUPABASE_URL === 'string' ? raw.VITE_SUPABASE_URL.trim() : ''
  const anonKey =
    typeof raw.VITE_SUPABASE_ANON_KEY === 'string' ? raw.VITE_SUPABASE_ANON_KEY.trim() : ''
  if (url === '') return { mode: 'local', reason: 'missing-url' }
  if (anonKey === '') return { mode: 'local', reason: 'missing-anon-key' }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { mode: 'local', reason: 'invalid-url' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { mode: 'local', reason: 'invalid-url' }
  }
  return { mode: 'configured', supabase: { url, anonKey } }
}

/** The mode this build runs in, resolved once from the two allowed names. */
export const appEnv: AppEnv = resolveAppEnv({
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
})

/** True when no Supabase backend is configured: the app is the P0 client-side matrix. */
export const isLocalOnly: boolean = appEnv.mode === 'local'
