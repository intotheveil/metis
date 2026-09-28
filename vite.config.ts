/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Served at the root of themis.adeonanalytics.com (GitHub Pages custom domain, ADR-0003).
// If it ever moves back under a path (e.g. github.io/themis/), this base must carry that path
// or the deployed page loads a blank shell.
export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', '.claude/worktrees/**'],
  },
})
