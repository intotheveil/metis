import { test as base, expect } from '@playwright/test'

/**
 * `test` with a console watchdog (PLAN P2.4). Every console `error` and every uncaught page error
 * is recorded in `consoleErrors`, and the test FAILS after it finishes if any were recorded, so no
 * spec has to remember to check.
 *
 * One entry is expected and filtered: on GitHub Pages (and on e2e/support/pages-server.mjs) a deep
 * link is answered with 404.html and HTTP status 404, and Chromium logs that as "Failed to load
 * resource: … 404" for the DOCUMENT itself. That line is the fallback working, not an app error.
 * The filter matches only a 404 whose URL is the main-frame document; a 404 for a script, image or
 * any other resource is still an error.
 */
export type ConsoleEntry = { kind: 'console' | 'pageerror'; text: string; url: string }

export const test = base.extend<{ consoleErrors: ConsoleEntry[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const documentUrls = new Set<string>()
      page.on('response', (res) => {
        if (res.request().isNavigationRequest() && res.request().frame() === page.mainFrame()) {
          documentUrls.add(res.url())
        }
      })
      const errors: ConsoleEntry[] = []
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return
        const url = msg.location().url
        const isDocument404 =
          /Failed to load resource: .*status of 404/.test(msg.text()) && documentUrls.has(url)
        if (!isDocument404) errors.push({ kind: 'console', text: msg.text(), url })
      })
      page.on('pageerror', (err) => errors.push({ kind: 'pageerror', text: String(err), url: '' }))

      await use(errors)

      expect(errors, 'console errors / uncaught page errors during the test').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }
