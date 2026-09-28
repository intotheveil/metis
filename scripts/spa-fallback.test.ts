// @vitest-environment node
//
// P2.3 — the GitHub Pages SPA fallback. Pages has no rewrites: a hard load of /auth/callback is
// answered with dist/404.html, so that file must be a byte copy of dist/index.html or every deep link
// (including a Supabase PKCE callback) is a dead end. These tests drive the real `spaFallback()`
// plugin through Vite's build API into an OS temp dir (never dist/), and check that the project's
// real config actually registers it.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build, type PluginOption } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import projectConfig, { spaFallback } from '../vite.config.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'themis-spa-fallback-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function buildFixture(outDir: string) {
  // A deliberately distinctive index.html: a stub or a different file would not match it byte for byte.
  writeFileSync(
    path.join(root, 'index.html'),
    '<!doctype html>\n<html lang="en">\n<head><title>Fixture — ünïcödé</title></head>\n' +
      '<body><div id="root"></div><script type="module" src="/main.js"></script></body>\n</html>\n',
  )
  writeFileSync(path.join(root, 'main.js'), 'document.getElementById("root").textContent = "hi"\n')
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    base: '/',
    plugins: [spaFallback()],
    build: { outDir, emptyOutDir: true },
  })
}

describe('spaFallback()', () => {
  it('writes 404.html as a byte-identical copy of the built index.html', async () => {
    await buildFixture('dist')
    const out = path.join(root, 'dist')
    const index = readFileSync(path.join(out, 'index.html'))
    const fallback = readFileSync(path.join(out, '404.html'))
    // The built index, not the source: Vite rewrote the script tag to a hashed asset.
    expect(index.toString('utf8')).toMatch(/\/assets\/index-[\w-]+\.js/)
    expect(fallback.equals(index)).toBe(true)
  })

  it('honours a custom build.outDir (resolved against root)', async () => {
    await buildFixture('custom-out')
    const out = path.join(root, 'custom-out')
    expect(readdirSync(out)).toContain('404.html')
    expect(
      readFileSync(path.join(out, '404.html')).equals(readFileSync(path.join(out, 'index.html'))),
    ).toBe(true)
  })

  it('only runs at build time (never in the dev server)', () => {
    expect(spaFallback().apply).toBe('build')
  })
})

/** Names of every plugin in a Vite `plugins` option (nested arrays and promises flattened). */
async function pluginNames(option: PluginOption): Promise<string[]> {
  const resolved: unknown = await option
  if (Array.isArray(resolved)) {
    const nested = await Promise.all(resolved.map((p) => pluginNames(p as PluginOption)))
    return nested.flat()
  }
  if (typeof resolved === 'object' && resolved !== null && 'name' in resolved) {
    return [String(resolved.name)]
  }
  return []
}

describe('vite.config.ts', () => {
  it('registers spaFallback in the real project config', async () => {
    expect(await pluginNames(projectConfig.plugins ?? [])).toContain('themis-spa-fallback')
  })

  it('serves at the domain root, so index.html asset URLs resolve from any deep link', () => {
    expect(projectConfig.base).toBe('/')
  })
})
