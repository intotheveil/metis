import { defineConfig, devices } from '@playwright/test'
import { missingLiveEnv } from './e2e/support/live-env.mjs'

/**
 * Playwright e2e (PLAN P2.4). Two projects:
 *
 * - `local` (`npm run e2e`): the PRODUCTION build (`dist/`) served by e2e/support/pages-server.mjs, a
 *   static server with GitHub Pages semantics (a file, else dist/404.html WITH status 404). Not
 *   `vite preview`: its SPA rewrite answers every deep link with index.html + 200, which would hide
 *   a missing 404.html (BRAIN §5). No backend: the build has no Supabase env, so the app runs in
 *   local-only mode and no request leaves the machine.
 * - `live` (`npm run e2e:live`): the deployed site + the shared Supabase project. Registered ONLY
 *   when every E2E_* name in e2e/support/live-env.mjs is set, so a bare `npx playwright test`
 *   without credentials can never reach it. The specs arrive in P2.14.
 *
 * The web server builds first (`npm run build`) so a local run never tests a stale dist/. CI has
 * just built and scanned dist/ and sets E2E_PREBUILT=1, so the suite tests the exact artifact that
 * is uploaded to Pages, without a second build.
 *
 * `reuseExistingServer: false`, and pages-server fails if the port is taken: a stray server from an
 * earlier run would otherwise answer for code that is not under test (the argus-news lesson).
 */
const PORT = Number(process.env.E2E_PORT ?? 4173)
const LOCAL_URL = `http://127.0.0.1:${PORT}`
const SERVE = `node e2e/support/pages-server.mjs --port ${PORT} --root dist`
const liveReady = missingLiveEnv(process.env).length === 0
// Set by e2e/support/run-live.mjs: the live run needs neither the local project nor its server.
const liveOnly = process.env.E2E_LIVE_ONLY === '1'

export default defineConfig({
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    ...(liveOnly
      ? []
      : [
          {
            name: 'local',
            testDir: './e2e/local',
            use: { ...devices['Desktop Chrome'], baseURL: LOCAL_URL },
          },
        ]),
    ...(liveReady
      ? [
          {
            name: 'live',
            testDir: './e2e/live',
            use: { ...devices['Desktop Chrome'], baseURL: process.env.E2E_BASE_URL },
          },
        ]
      : []),
  ],
  // Only the local project needs a server; the live project targets E2E_BASE_URL.
  webServer: liveOnly
    ? undefined
    : {
        command: process.env.E2E_PREBUILT === '1' ? SERVE : `npm run build && ${SERVE}`,
        url: `${LOCAL_URL}/`,
        reuseExistingServer: false,
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
        // Blank the Supabase names so the build is local-only even when a developer's .env sets them
        // (Vite never lets a .env file override a variable that already exists in the environment).
        env: {
          VITE_SUPABASE_URL: '',
          VITE_SUPABASE_ANON_KEY: '',
        },
      },
})
