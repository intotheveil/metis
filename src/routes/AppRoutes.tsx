import { useRoutes } from 'react-router-dom'
import { routes } from './routes'

/** Renders the route table. Wrapped by BrowserRouter in main.tsx and by MemoryRouter in tests. */
export function AppRoutes() {
  return useRoutes(routes)
}
