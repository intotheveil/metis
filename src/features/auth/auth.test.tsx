// P2.10 — the auth UI and session, end to end through the REAL route table, with a fake AuthClient
// (./fakeAuthClient.ts) in place of supabase-js. Zero network: global fetch is stubbed to throw and
// asserted untouched. The supabase-js adapter itself is covered in supabaseAuthClient.test.ts.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Link, MemoryRouter, useLocation, useRoutes } from 'react-router-dom'
import { AppRoutes } from '../../routes/AppRoutes'
import { routes } from '../../routes/routes'
import { AuthProvider } from './AuthProvider'
import type { AuthLoader } from './authClient'
import { USER_A, fakeAuthClient, type FakeAuthClient } from './fakeAuthClient'

const CALLBACK = `${window.location.origin}/auth/callback`

function LocationProbe() {
  const loc = useLocation()
  return (
    <>
      <output data-testid="location">{loc.pathname + loc.search}</output>
      {/* An in-app navigation (no reload), so a test can see the provider's in-memory state. */}
      <Link to="/signin">test: go to sign-in</Link>
    </>
  )
}
const currentPath = () => screen.getByTestId('location').textContent

function RouteTable() {
  return useRoutes(routes)
}

interface Rendered {
  loader: ReturnType<typeof vi.fn<AuthLoader>>
  redirect: ReturnType<typeof vi.fn<(url: string) => void>>
}

/** The real route table under an AuthProvider whose loader resolves the given fake. */
function renderAt(entry: string, client: FakeAuthClient | null): Rendered {
  const loader = vi.fn<AuthLoader>(() => Promise.resolve(client))
  const redirect = vi.fn<(url: string) => void>()
  render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider loader={loader} redirect={redirect}>
        <RouteTable />
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>,
  )
  return { loader, redirect }
}

const heading = () => screen.getByRole('heading', { level: 1 })

/** Click and let the async handler (a fake client call) settle inside act(). */
async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el)
  })
}
const typeInto = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } })

let fetchSpy: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error('network is forbidden in unit tests')))
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

describe('local-only mode (no Supabase configuration in the build)', () => {
  it.each([['/signin'], ['/auth/callback?code=abc']])(
    '%s says sign-in is coming soon, offers no form, and loads nothing',
    (path) => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes authLoader={null} />
          <LocationProbe />
        </MemoryRouter>,
      )
      expect(screen.getByText('Coming soon')).toBeInTheDocument()
      expect(screen.getByText(/Sign-in is not available yet/)).toBeInTheDocument()
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.getByRole('link', { name: 'Open the decision matrix' })).toHaveAttribute(
        'href',
        '/',
      )
      // The callback page never rewrites the URL.
      expect(currentPath()).toBe(path)
    },
  )

  it('the default loader is null in a build without VITE_SUPABASE_*', async () => {
    const { loadDefaultAuthClient } = await import('./authClient')
    expect(loadDefaultAuthClient).toBeNull()
  })
})

describe('lazy loading', () => {
  it('the matrix at / never loads the auth client', async () => {
    const { loader } = renderAt('/', fakeAuthClient())
    expect(heading()).toHaveTextContent('THEMIS')
    await act(() => new Promise((r) => setTimeout(r, 10)))
    expect(loader).not.toHaveBeenCalled()
  })

  it('/signin loads it exactly once', async () => {
    const { loader } = renderAt('/signin', fakeAuthClient())
    await screen.findByRole('button', { name: 'Continue with Google' })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('a loader that fails (chunk download error) renders a message, not a blank page', async () => {
    const loader = vi.fn<AuthLoader>(() => Promise.reject(new Error('Failed to fetch module')))
    render(
      <MemoryRouter initialEntries={['/signin']}>
        <AppRoutes authLoader={loader} />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The sign-in service could not be loaded',
    )
  })
})

describe('/signin (configured)', () => {
  it('magic link: sends to the trimmed address with redirect ${origin}/auth/callback', async () => {
    const client = fakeAuthClient()
    renderAt('/signin', client)
    typeInto(await screen.findByLabelText('Email address'), '  a@example.com ')
    await click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    expect(client.sendMagicLink).toHaveBeenCalledWith('a@example.com', CALLBACK)
    expect(heading()).toHaveTextContent('Check your email')
    expect(screen.getByText('a@example.com')).toBeInTheDocument()
  })

  it('magic link: an empty address is refused without a request', async () => {
    const client = fakeAuthClient()
    renderAt('/signin', client)
    await click(await screen.findByRole('button', { name: 'Email me a sign-in link' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your email address.')
    expect(client.sendMagicLink).not.toHaveBeenCalled()
  })

  it('magic link: a server error (rate limit) renders a readable message', async () => {
    const client = fakeAuthClient()
    client.sendMagicLink.mockResolvedValueOnce({
      error: { message: 'email rate limit exceeded', code: 'over_email_send_rate_limit' },
    })
    renderAt('/signin', client)
    typeInto(await screen.findByLabelText('Email address'), 'a@example.com')
    await click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many sign-in attempts')
    expect(heading()).toHaveTextContent('Sign in')
  })

  it('Google: asks for the authorize URL with redirect ${origin}/auth/callback, then redirects', async () => {
    const client = fakeAuthClient()
    const { redirect } = renderAt('/signin', client)
    await click(await screen.findByRole('button', { name: 'Continue with Google' }))
    expect(client.googleSignInUrl).toHaveBeenCalledWith(CALLBACK)
    expect(redirect).toHaveBeenCalledWith('https://accounts.example/authorize?x=1')
  })

  it('Google: a provider error renders a message and does not redirect', async () => {
    const client = fakeAuthClient()
    client.googleSignInUrl.mockResolvedValueOnce({
      url: null,
      error: {
        message: 'Unsupported provider: provider is not enabled',
        code: 'validation_failed',
      },
    })
    const { redirect } = renderAt('/signin', client)
    await click(await screen.findByRole('button', { name: 'Continue with Google' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('provider is not enabled')
    expect(redirect).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled()
  })
})

describe('/auth/callback (configured)', () => {
  it('after the session is established: bootstrap_me() once, then /w/<workspace>', async () => {
    // initialize() is where supabase-js exchanges the ?code=; afterwards the session exists.
    const client = fakeAuthClient()
    client.initialize.mockImplementationOnce(() => {
      client.emit(USER_A)
      return Promise.resolve({ error: null })
    })
    renderAt('/auth/callback?code=pkce-code', client)
    await waitFor(() => expect(currentPath()).toBe('/w/ws-personal'))
    expect(client.bootstrapMe).toHaveBeenCalledTimes(1)
    expect(heading()).toHaveTextContent('Workspace')
    expect(screen.getByText('ws-personal')).toBeInTheDocument()
    expect(screen.getByText('a@example.com')).toBeInTheDocument()
  })

  it('the query stays in the URL while the exchange is pending', async () => {
    const client = fakeAuthClient()
    let finish: (v: { error: null }) => void = () => {}
    client.initialize.mockImplementationOnce(() => new Promise((r) => (finish = r)))
    renderAt('/auth/callback?code=pkce-code&state=s', client)
    expect(await screen.findByText('Completing sign-in…')).toBeInTheDocument()
    expect(currentPath()).toBe('/auth/callback?code=pkce-code&state=s')
    await act(async () => finish({ error: null }))
  })

  it('an expired magic link (error in the URL) renders a message and a way back', async () => {
    const client = fakeAuthClient()
    renderAt(
      '/auth/callback?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
      client,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This sign-in link has expired or has already been used',
    )
    expect(heading()).toHaveTextContent('Sign-in failed')
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/signin')
    expect(client.bootstrapMe).not.toHaveBeenCalled()
  })

  it('a provider error in the hash (implicit-style) renders a message too', async () => {
    renderAt(
      '/auth/callback#error=access_denied&error_description=User+denied+access',
      fakeAuthClient(),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'cancelled or refused by the provider',
    )
  })

  it('a failed code exchange (reported by initialize) renders its message', async () => {
    const client = fakeAuthClient({
      initError: {
        message: 'invalid flow state, no valid flow state found',
        code: 'flow_state_not_found',
      },
    })
    renderAt('/auth/callback?code=stale', client)
    expect(await screen.findByRole('alert')).toHaveTextContent('different browser')
  })

  it('a code with no session and no error (no PKCE verifier here) says "same browser"', async () => {
    renderAt('/auth/callback?code=from-another-browser', fakeAuthClient())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'opened in a different browser from the one that requested it',
    )
  })

  it('no code, no session: says no sign-in is in progress', async () => {
    renderAt('/auth/callback', fakeAuthClient())
    expect(await screen.findByRole('alert')).toHaveTextContent('no sign-in is in progress')
  })

  it('bootstrap_me failing renders a message and a retry that recovers', async () => {
    const client = fakeAuthClient({ persisted: USER_A })
    client.bootstrapMe.mockResolvedValueOnce({
      workspaceId: null,
      error: { message: 'permission denied for function bootstrap_me', code: '42501' },
    })
    renderAt('/auth/callback', client)
    expect(await screen.findByRole('alert')).toHaveTextContent('permission denied')
    expect(heading()).toHaveTextContent('Could not open your workspace')
    await click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(currentPath()).toBe('/w/ws-personal'))
    expect(client.bootstrapMe).toHaveBeenCalledTimes(2)
  })
})

describe('session persistence and sign-out', () => {
  it('reloading keeps the user signed in (the persisted session is read at start)', async () => {
    const client = fakeAuthClient({ persisted: USER_A })
    renderAt('/signin', client)
    expect(await screen.findByRole('heading', { name: "You're signed in" })).toBeInTheDocument()
    cleanup()
    // A "reload": a brand-new provider and router over the same persisted session.
    renderAt('/w/ws-personal', client)
    expect(await screen.findByText('a@example.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('signed in on /signin: "Continue" calls bootstrap_me and opens /w/<ws>', async () => {
    const client = fakeAuthClient({ persisted: USER_A })
    renderAt('/signin', client)
    await click(await screen.findByRole('button', { name: 'Continue to your workspace' }))
    await waitFor(() => expect(currentPath()).toBe('/w/ws-personal'))
    expect(client.bootstrapMe).toHaveBeenCalledTimes(1)
  })

  it('sign-out clears the session and returns to the matrix; /signin then shows the form', async () => {
    const client = fakeAuthClient({ persisted: USER_A })
    renderAt('/w/ws-personal', client)
    await click(await screen.findByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(currentPath()).toBe('/'))
    expect(client.signOut).toHaveBeenCalledTimes(1)
    // Without a reload (and without any SIGNED_OUT event from the client) the session is gone.
    await click(screen.getByRole('link', { name: 'test: go to sign-in' }))
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
    cleanup()
    // After a reload the session is gone too (the fake's persisted session was cleared).
    renderAt('/signin', client)
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
  })

  it('a sign-out error is shown and the user stays signed in', async () => {
    const client = fakeAuthClient({ persisted: USER_A })
    client.signOut.mockResolvedValueOnce({ error: { message: 'network down' } })
    renderAt('/w/ws-personal', client)
    await click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign out: network down')
    expect(currentPath()).toBe('/w/ws-personal')
  })

  it('a sign-out in another tab (SIGNED_OUT event) flips the page to signed out', async () => {
    const client = fakeAuthClient({ persisted: USER_A })
    renderAt('/w/ws-personal', client)
    await screen.findByText('a@example.com')
    act(() => client.emit(null))
    expect(await screen.findByText(/You are signed out/)).toBeInTheDocument()
  })

  it('unmounting before the client loads never subscribes (no leaked listener)', async () => {
    const client = fakeAuthClient()
    let resolve: (c: FakeAuthClient) => void = () => {}
    const loader = vi.fn<AuthLoader>(() => new Promise((r) => (resolve = r)))
    const { unmount } = render(
      <MemoryRouter initialEntries={['/signin']}>
        <AppRoutes authLoader={loader} />
      </MemoryRouter>,
    )
    unmount()
    await act(async () => resolve(client))
    expect(client.onAuthStateChange).not.toHaveBeenCalled()
    expect(client.listenerCount()).toBe(0)
  })

  it('unmounting while the session is being read never subscribes either', async () => {
    const client = fakeAuthClient()
    let finish: (v: { error: null }) => void = () => {}
    client.initialize.mockImplementationOnce(() => new Promise((r) => (finish = r)))
    const loader = vi.fn<AuthLoader>(() => Promise.resolve(client))
    const { unmount } = render(
      <MemoryRouter initialEntries={['/signin']}>
        <AppRoutes authLoader={loader} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(client.initialize).toHaveBeenCalled())
    unmount()
    await act(async () => finish({ error: null }))
    expect(client.onAuthStateChange).not.toHaveBeenCalled()
    expect(client.listenerCount()).toBe(0)
  })
})
