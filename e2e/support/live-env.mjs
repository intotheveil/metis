// The environment the `live` Playwright project needs (PLAN P2.4, used from P2.14 on).
//
// The live specs sign in two dedicated e2e users against the REAL shared Supabase project and the
// deployed site. Nothing here has a default: without every name below, the live project is not
// registered at all (playwright.config.ts) and `npm run e2e:live` exits 0 with a message saying
// which names are missing (e2e/support/run-live.mjs). Names only; values come from the shell or
// the Zeus Vault, never from a tracked file.

/** Every name the live project requires. P2.9/P2.14 may add to this list; never give one a default. */
export const LIVE_ENV_NAMES = /** @type {const} */ ([
  'E2E_BASE_URL', // the site under test, e.g. https://themis.adeonanalytics.com
  'E2E_SUPABASE_URL', // the shared project's API URL
  'E2E_SUPABASE_ANON_KEY', // the public anon key (the same value the browser bundle gets)
  'E2E_USER_A_EMAIL', // dedicated e2e user A (provisioned in P2.9)
  'E2E_USER_B_EMAIL', // dedicated e2e user B (provisioned in P2.9)
])

/**
 * The required names that are unset or blank in `env`.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function missingLiveEnv(env) {
  return LIVE_ENV_NAMES.filter((name) => !(env[name] ?? '').trim())
}
