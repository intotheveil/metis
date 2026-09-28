// `npm run e2e:live` (PLAN P2.4). Runs the `live` Playwright project, which talks to the REAL
// shared Supabase project and the deployed site. Without the E2E_* env it does not run anything:
// it says which names are missing and exits 0 (a skip, not a pass), so a machine without
// credentials, such as CI, never reaches the live project by accident.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { LIVE_ENV_NAMES, missingLiveEnv } from './live-env.mjs'

const missing = missingLiveEnv(process.env)
if (missing.length > 0) {
  console.log(
    [
      'e2e:live SKIPPED: the live project needs every one of these env names:',
      ...LIVE_ENV_NAMES.map((n) => `  ${missing.includes(n) ? 'MISSING' : 'set    '}  ${n}`),
      'Set them in the shell (values from the Zeus Vault) and re-run. Nothing was run.',
    ].join('\n'),
  )
} else {
  // --pass-with-no-tests: e2e/live/ is empty until P2.14 adds the specs.
  // The Playwright CLI through this node binary: no shell, so no argument is ever re-parsed.
  const cli = createRequire(import.meta.url).resolve('@playwright/test/cli')
  const result = spawnSync(
    process.execPath,
    [cli, 'test', '--project=live', '--pass-with-no-tests', ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, E2E_LIVE_ONLY: '1' } },
  )
  process.exitCode = result.status ?? 1
}
