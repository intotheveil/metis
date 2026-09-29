import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  AuthAlert,
  AuthCard,
  AuthStatus,
  COMING_SOON,
  LOCAL_ONLY_TEXT,
  PRIMARY_BUTTON,
} from './AuthCard'
import {
  SAME_BROWSER_TEXT,
  describeAuthError,
  hasAuthCode,
  readUrlError,
  type AuthFailure,
} from './authClient'
import { useSession } from './useSession'

// /auth/callback (PLAN P2.10). supabase-js (detectSessionInUrl, flowType 'pkce') exchanges the
// `?code=` itself when the client starts; this page only waits for the result. Once a session
// exists it calls themis.bootstrap_me() (P2.5, the substitute for an auth.users trigger) and
// replaces the URL with /w/<workspace>. Every failure renders a message and a way forward: never a
// blank screen, never a silent redirect.
//
// Never rewrite the URL before the client has read it: the code must still be in window.location.

const TRY_AGAIN = (
  <Link
    to="/signin"
    className="inline-block rounded-lg border border-accent/40 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/10"
  >
    Back to sign in
  </Link>
)

export function AuthCallback() {
  const auth = useSession()
  const { state, bootstrap } = auth
  const location = useLocation()
  const navigate = useNavigate()
  // Read once, on arrival: supabase-js strips `code` from the URL after a successful exchange.
  const [arrival] = useState(() => ({
    urlError: readUrlError(location.search, location.hash),
    hadCode: hasAuthCode(location.search),
  }))
  const [bootstrapError, setBootstrapError] = useState<AuthFailure | null>(null)
  const [attempt, setAttempt] = useState(0)

  const userId = state.status === 'signed-in' ? state.user.id : null

  useEffect(() => {
    if (!userId) return
    let active = true
    void bootstrap().then(({ workspaceId, error }) => {
      if (!active) return
      if (workspaceId) navigate(`/w/${encodeURIComponent(workspaceId)}`, { replace: true })
      else setBootstrapError(error ?? { message: 'No workspace was returned.' })
    })
    return () => {
      active = false
    }
  }, [userId, bootstrap, navigate, attempt])

  if (state.status === 'local-only') {
    return (
      <AuthCard title="Sign-in unavailable" badge={COMING_SOON}>
        <p>{LOCAL_ONLY_TEXT}</p>
      </AuthCard>
    )
  }

  // A provider or link error in the URL wins: it is the most specific explanation available.
  if (arrival.urlError && state.status !== 'signed-in') {
    return (
      <AuthCard title="Sign-in failed">
        <AuthAlert>{describeAuthError(arrival.urlError)}</AuthAlert>
        {TRY_AGAIN}
      </AuthCard>
    )
  }

  switch (state.status) {
    case 'loading':
      return (
        <AuthCard title="Signing you in" backToMatrix={false}>
          <AuthStatus>Completing sign-in…</AuthStatus>
        </AuthCard>
      )
    case 'unavailable':
      return (
        <AuthCard title="Sign-in failed">
          <AuthAlert>{state.error.message}</AuthAlert>
          {TRY_AGAIN}
        </AuthCard>
      )
    case 'signed-out': {
      // No error and no session. With a `?code=` that means supabase-js found no PKCE verifier in
      // this browser's storage (it then skips the exchange silently): the link was opened elsewhere.
      const message = state.initError
        ? describeAuthError(state.initError)
        : arrival.hadCode
          ? SAME_BROWSER_TEXT
          : 'This page finishes a sign-in, but no sign-in is in progress.'
      return (
        <AuthCard title="Sign-in failed">
          <AuthAlert>{message}</AuthAlert>
          {TRY_AGAIN}
        </AuthCard>
      )
    }
    case 'signed-in':
      if (bootstrapError) {
        return (
          <AuthCard title="Could not open your workspace">
            <p>
              You are signed in as{' '}
              <span className="font-medium text-stone-200">
                {state.user.email ?? 'your account'}
              </span>
              , but your workspace could not be set up.
            </p>
            <AuthAlert>{bootstrapError.message}</AuthAlert>
            <button
              type="button"
              className={PRIMARY_BUTTON}
              onClick={() => {
                setBootstrapError(null)
                setAttempt((n) => n + 1)
              }}
            >
              Try again
            </button>
          </AuthCard>
        )
      }
      return (
        <AuthCard title="Signing you in" backToMatrix={false}>
          <AuthStatus>Opening your workspace…</AuthStatus>
        </AuthCard>
      )
  }
}
