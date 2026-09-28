/// <reference types="vitest/config" />
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * SPA fallback for GitHub Pages (PLAN P2.3). Pages has no server rewrites: a hard load of a deep
 * link such as /auth/callback finds no file and Pages serves the site's 404.html instead (with HTTP
 * status 404, which browsers render normally). Making 404.html a byte copy of index.html means every
 * deep link boots the app and the client router picks the route from the URL.
 *
 * A COPY, not the "redirect to /?p=…" trick: the requested URL is never rewritten, so a Supabase
 * PKCE callback keeps its `?code=` intact. Asset URLs in index.html are absolute (base '/'), so they
 * resolve at any depth.
 */
export function spaFallback(): Plugin {
  let outDir = 'dist'
  return {
    name: 'themis-spa-fallback',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    writeBundle() {
      copyFileSync(resolve(outDir, 'index.html'), resolve(outDir, '404.html'))
    },
  }
}

// Served at the root of themis.adeonanalytics.com (GitHub Pages custom domain, ADR-0003).
// If it ever moves back under a path (e.g. github.io/themis/), this base must carry that path
// or the deployed page loads a blank shell.
export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss(), spaFallback()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', '.claude/worktrees/**'],
  },
})
