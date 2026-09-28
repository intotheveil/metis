import type { RouteObject } from 'react-router-dom'
import App from '../App'
import { AuthCallbackRoute, InviteRoute, NotFoundRoute, SignInRoute, WorkspaceRoute } from './pages'

// The route table (PLAN P2.3). `/` is the P0 decision matrix, unchanged. The other paths are shells
// until P2.10–P2.12 fill them. Unknown paths render a not-found page inside the app: on GitHub
// Pages every unknown URL is served dist/404.html (= index.html), so without the `*` route a typo
// would render an empty page.
export const routes: RouteObject[] = [
  { path: '/', element: <App /> },
  { path: '/signin', element: <SignInRoute /> },
  { path: '/auth/callback', element: <AuthCallbackRoute /> },
  { path: '/w/:workspaceId/*', element: <WorkspaceRoute /> },
  { path: '/invite/:token', element: <InviteRoute /> },
  { path: '*', element: <NotFoundRoute /> },
]

/**
 * The router basename for Vite's BASE_URL: '/' on the custom domain (ADR-0003), '/themis' if the
 * app is ever served under a path again. React Router wants no trailing slash except for the root.
 */
export function basenameFrom(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}
