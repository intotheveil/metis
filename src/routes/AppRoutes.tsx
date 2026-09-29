import { useRoutes } from 'react-router-dom'
import { AuthProvider } from '../features/auth/AuthProvider'
import type { AuthLoader } from '../features/auth/authClient'
import { routes } from './routes'

/**
 * Renders the route table inside the session provider (PLAN P2.10). Wrapped by BrowserRouter in
 * main.tsx and by MemoryRouter in tests. `authLoader` is for tests: omitted (undefined), the
 * provider uses the app's lazy supabase-js loader, which is null in a local-only build.
 */
export function AppRoutes(props: { authLoader?: AuthLoader | null }) {
  const element = useRoutes(routes)
  return <AuthProvider loader={props.authLoader}>{element}</AuthProvider>
}
