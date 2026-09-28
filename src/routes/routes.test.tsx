// P2.3 — the route table. Every path is rendered through the real `routes` array (via AppRoutes) in
// a MemoryRouter, so a route removed, renamed or reordered in routes.tsx turns a test here RED.
// The PKCE case matters most: /auth/callback must leave `?code=` in the location untouched, because
// P2.10's Supabase client (detectSessionInUrl, flowType 'pkce') reads it from there.

import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { AppRoutes } from './AppRoutes'
import { basenameFrom, routes } from './routes'

/** Renders the current router location into the DOM so a test can read it after the route mounts. */
function LocationProbe() {
  const loc = useLocation()
  return (
    <output data-testid="location">
      {JSON.stringify({ pathname: loc.pathname, search: loc.search, hash: loc.hash })}
    </output>
  )
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AppRoutes />
      <LocationProbe />
    </MemoryRouter>,
  )
}

function probedLocation(): { pathname: string; search: string; hash: string } {
  return JSON.parse(screen.getByTestId('location').textContent ?? '{}') as {
    pathname: string
    search: string
    hash: string
  }
}

const pageTitle = () => screen.getByRole('heading', { level: 1 })

describe('route table: /', () => {
  it('renders the P0 decision matrix, unchanged', () => {
    renderAt('/')
    expect(pageTitle()).toHaveTextContent('THEMIS')
    expect(screen.getByRole('radio', { name: 'Agile' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getAllByDisplayValue('Customer value').length).toBe(1)
    expect(
      within(screen.getByRole('list', { name: 'Planned modules' })).getByText('SWOT analysis'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Page not found')).toBeNull()
  })
})

describe('route table: P2 shells', () => {
  it('/signin renders the sign-in page, which says accounts are not live', () => {
    renderAt('/signin')
    expect(pageTitle()).toHaveTextContent('Sign in')
    expect(screen.getByText(/Accounts are not live yet/)).toBeInTheDocument()
    // The shell links back to the matrix rather than stranding the visitor.
    expect(screen.getByRole('link', { name: 'Open the decision matrix' })).toHaveAttribute(
      'href',
      '/',
    )
  })

  it('/auth/callback renders the callback page', () => {
    renderAt('/auth/callback')
    expect(pageTitle()).toHaveTextContent('Signing you in')
  })

  it('/w/:workspaceId shows the workspace id', () => {
    renderAt('/w/ws-123')
    expect(pageTitle()).toHaveTextContent('Workspace')
    expect(screen.getByText('ws-123')).toBeInTheDocument()
  })

  it('/w/:workspaceId/* matches nested paths and still resolves the id', () => {
    renderAt('/w/ws-1/decisions/9')
    expect(pageTitle()).toHaveTextContent('Workspace')
    expect(screen.getByText('ws-1')).toBeInTheDocument()
    expect(screen.queryByText('Page not found')).toBeNull()
    expect(probedLocation().pathname).toBe('/w/ws-1/decisions/9')
  })

  it('/invite/:token renders the invite page', () => {
    renderAt('/invite/tok-abc')
    expect(pageTitle()).toHaveTextContent('Workspace invite')
    expect(screen.getByText(/Invites are not live yet/)).toBeInTheDocument()
  })

  it('/invite without a token is not an invite (falls through to not found)', () => {
    renderAt('/invite')
    expect(pageTitle()).toHaveTextContent('Page not found')
  })
})

describe('route table: unknown paths', () => {
  it.each(['/no/such/page', '/signin/extra', '/auth', '/w'])(
    '%s renders the in-app not-found page, not an empty shell',
    (path) => {
      renderAt(path)
      expect(pageTitle()).toHaveTextContent('Page not found')
      expect(screen.getByText('There is nothing at this address.')).toBeInTheDocument()
    },
  )

  it('the catch-all is the last route, so it never shadows a real path', () => {
    expect(routes.at(-1)?.path).toBe('*')
    expect(routes.filter((r) => r.path === '*')).toHaveLength(1)
  })
})

describe('/auth/callback keeps the PKCE query intact', () => {
  it('?code=&state= survive the render untouched (no redirect, no strip)', () => {
    renderAt('/auth/callback?code=abc&state=x')
    expect(pageTitle()).toHaveTextContent('Signing you in')
    expect(probedLocation()).toEqual({
      pathname: '/auth/callback',
      search: '?code=abc&state=x',
      hash: '',
    })
  })

  it('an error redirect keeps its encoded error_description byte for byte', () => {
    const search = '?error=access_denied&error_description=User%20cancelled%20%26%20left'
    renderAt(`/auth/callback${search}`)
    expect(pageTitle()).toHaveTextContent('Signing you in')
    expect(probedLocation().search).toBe(search)
  })
})

describe('basenameFrom', () => {
  it.each([
    ['/', '/'],
    ['/themis/', '/themis'],
    ['/themis', '/themis'],
    ['//', '/'],
    ['/a/b/', '/a/b'],
  ])('basenameFrom(%j) === %j', (input, expected) => {
    expect(basenameFrom(input)).toBe(expected)
  })

  it('the basename it produces lets a router under /themis match /themis/signin', () => {
    render(
      <MemoryRouter basename={basenameFrom('/themis/')} initialEntries={['/themis/signin']}>
        <AppRoutes />
      </MemoryRouter>,
    )
    expect(pageTitle()).toHaveTextContent('Sign in')
  })
})
