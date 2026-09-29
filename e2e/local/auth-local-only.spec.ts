import type { Page, Request } from '@playwright/test'
import { expect, test } from '../support/fixtures'

// P2.10 in LOCAL-ONLY mode, on the production build (the e2e build blanks VITE_SUPABASE_*, exactly
// like the deployed site until the `themis` schema is exposed and the auth redirect is allowed).
// Sign-in must be shown honestly as not available yet (no form that could only fail), the P0 matrix
// must stay fully usable, and supabase-js must never be downloaded: it lives in a lazy chunk that a
// local-only build never requests.

/** Every request the page makes, recorded from before the first navigation. */
function recordRequests(page: Page): Request[] {
  const requests: Request[] = []
  page.on('request', (r) => requests.push(r))
  return requests
}

const scripts = (requests: Request[]) =>
  requests.filter((r) => r.resourceType() === 'script').map((r) => new URL(r.url()).pathname)

test('/signin says sign-in is coming soon, with no form, and downloads no auth code', async ({
  page,
}) => {
  const requests = recordRequests(page)
  await page.goto('/signin')

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByText('Coming soon')).toBeVisible()
  await expect(page.getByText(/Sign-in is not available yet/)).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await expect(page.getByRole('button')).toHaveCount(0)

  // Only the entry chunk: the lazy supabase-js chunk is never requested.
  expect(scripts(requests)).toHaveLength(1)
  expect(scripts(requests).join(' ')).not.toMatch(/supabaseAuthClient/)
  // Nothing leaves the local server except the web fonts index.html has always loaded.
  const FONT_HOSTS = ['127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com']
  const foreign = requests
    .map((r) => new URL(r.url()))
    .filter((u) => !FONT_HOSTS.includes(u.hostname))
  expect(foreign.map((u) => u.href)).toEqual([])

  // The way back leads to a working matrix.
  await page.getByRole('link', { name: 'Open the decision matrix' }).click()
  await expect(page.getByRole('heading', { name: /Frame the decision/ })).toBeVisible()
})

test('/auth/callback with a code: unavailable, URL untouched, no auth code downloaded', async ({
  page,
}) => {
  const requests = recordRequests(page)
  const query = '?code=e2e-code&state=s'
  await page.goto(`/auth/callback${query}`)

  await expect(page.getByRole('heading', { name: 'Sign-in unavailable' })).toBeVisible()
  await expect(page.getByText(/Sign-in is not available yet/)).toBeVisible()
  expect(await page.evaluate(() => window.location.search)).toBe(query)
  expect(scripts(requests).join(' ')).not.toMatch(/supabaseAuthClient/)
})

test('a workspace link in a local-only build still says workspaces are not live', async ({
  page,
}) => {
  const requests = recordRequests(page)
  await page.goto('/w/ws-1')
  await expect(page.getByText('Workspaces are not live yet')).toContainText('(ws-1)')
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
  expect(scripts(requests).join(' ')).not.toMatch(/supabaseAuthClient/)
})
