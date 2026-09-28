import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import { AppRoutes } from './routes/AppRoutes'
import { basenameFrom } from './routes/routes'

// Client-side routing (PLAN P2.3). GitHub Pages has no rewrites, so every deep link is served
// dist/404.html, a byte copy of index.html made at build time (vite.config.ts `spaFallback`). The
// URL, including any `?code=` from a Supabase PKCE redirect, is left exactly as requested.
// Declarative BrowserRouter, not the data router: nothing needs loaders/actions, and it costs about
// half as much bundle (DECISIONS.md P2.3).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={basenameFrom(import.meta.env.BASE_URL)}>
      <AppRoutes />
    </BrowserRouter>
  </StrictMode>,
)
