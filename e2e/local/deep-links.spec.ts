import { expect, test } from '../support/fixtures'

// Deep links through the GitHub Pages SPA fallback (PLAN P2.3/P2.4), on the PRODUCTION build served
// by e2e/support/pages-server.mjs, which answers any path without a file with dist/404.html and
// HTTP status 404, exactly as Pages does. A deep link is therefore EXPECTED to be status 404: the
// assertions are on the rendered app, never on response.ok() (BRAIN §5). If dist/404.html is
// missing, the server returns a plain-text 404, the app never boots, and these tests go red.

test('a hard load of /w/x/decisions/1 renders the workspace page', async ({ page }) => {
  const response = await page.goto('/w/x/decisions/1')
  // The fallback path, not a rewrite: the document itself is the 404.html copy of the app.
  expect(response?.status()).toBe(404)

  await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible()
  await expect(page.getByText('Workspaces are not live yet')).toContainText('(x)')
  await expect(page).toHaveURL(/\/w\/x\/decisions\/1$/)
})

test('/auth/callback?code=… renders the callback page and keeps the query', async ({ page }) => {
  const query = '?code=e2e-pkce-code_123&state=abc%2Fdef'
  const response = await page.goto(`/auth/callback${query}`)
  expect(response?.status()).toBe(404)

  await expect(page.getByRole('heading', { name: 'Signing you in' })).toBeVisible()
  // The PKCE code must still be in the URL when P2.10's Supabase client reads it: no redirect,
  // no rewrite, no stripping, byte for byte.
  expect(new URL(page.url()).pathname).toBe('/auth/callback')
  expect(await page.evaluate(() => window.location.search)).toBe(query)
})

test('an unknown path renders the in-app "not found" page', async ({ page }) => {
  const response = await page.goto('/no/such/page')
  expect(response?.status()).toBe(404)

  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  await expect(page.getByText('There is nothing at this address.')).toBeVisible()
  // The app shell booted (header brand + a way back to the matrix), not a bare server error page.
  await page.getByRole('link', { name: 'Open the decision matrix' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: /Frame the decision/ })).toBeVisible()
})
