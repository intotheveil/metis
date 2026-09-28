import type { Page } from '@playwright/test'
import { expect, test } from '../support/fixtures'

// The signed-out P0 matrix on the PRODUCTION build (PLAN P2.4). No backend: the build has no
// Supabase env, so the app runs local-only. The console watchdog (support/fixtures.ts) fails any
// test that logs a console error.

async function score(page: Page, option: string, criterion: string, n: number) {
  await page
    .getByRole('group', { name: `${option} on ${criterion}` })
    .getByRole('button', { name: String(n), exact: true })
    .click()
}

test('home renders the decision matrix with no console errors', async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('THEMIS')
  await expect(page.getByRole('heading', { name: /Frame the decision/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Score the options/ })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Agile' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('group', { name: 'Option A on Customer value' })).toBeVisible()
  await expect(page.getByText(/still need scoring/)).toBeVisible()
  // The brand art is served from dist/ (a missing asset would also log a console error).
  await expect(page.getByAltText(/marble bust/)).toBeVisible()
})

test('signed out, the matrix scores two options and shows a verdict', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('radio', { name: 'YOLO' }).click()
  const criteria = [
    'Upside if it works',
    'Speed to ship',
    'Survivable if wrong',
    'Momentum / morale',
  ]

  // Partially scored: no winner is named (honest verdicts, constraint 8).
  await score(page, 'Option A', criteria[0], 5)
  await expect(page.getByText(/still need scoring/)).toBeVisible()
  await expect(page.getByText(/leads by/)).toHaveCount(0)

  // criteria[0] is already 5 (clicking a selected score again would clear it).
  for (const c of criteria.slice(1)) await score(page, 'Option A', c, 5)
  for (const c of criteria) await score(page, 'Option B', c, 2)

  await expect(page.getByText(/leads by/)).toHaveText('Option A leads by 75 points.')
  const ranking = page.getByRole('list', { name: 'Ranking' }).getByRole('listitem')
  await expect(ranking.nth(0)).toContainText('Option A')
  await expect(ranking.nth(0)).toContainText('100.0')
  await expect(ranking.nth(1)).toContainText('Option B')
  await expect(ranking.nth(1)).toContainText('25.0')
})

test('a margin under 5 points is "too close to call"', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('radio', { name: 'YOLO' }).click()
  const criteria = [
    'Upside if it works',
    'Speed to ship',
    'Survivable if wrong',
    'Momentum / morale',
  ]
  for (const c of criteria) await score(page, 'Option A', c, 4)
  for (const c of criteria) await score(page, 'Option B', c, 4)

  await expect(page.getByText('Too close to call.')).toBeVisible()
  await expect(page.getByText(/leads by/)).toHaveCount(0)
})
