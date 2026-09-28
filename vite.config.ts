/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// GitHub Pages serves this repo at /metis/ — every asset URL must carry that base
// or the deployed page loads a blank shell (DECISIONS.md ADR-0001).
export default defineConfig({
  base: '/metis/',
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', '.claude/worktrees/**'],
  },
})
