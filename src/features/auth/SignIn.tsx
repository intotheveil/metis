import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AuthAlert,
  AuthCard,
  AuthStatus,
  COMING_SOON,
  LOCAL_ONLY_TEXT,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from './AuthCard'
import { describeAuthError, type AuthFailure } from './authClient'
import { useSession } from './useSession'

// /signin (PLAN P2.10): magic link or Google, both landing on ${origin}/auth/callback. Signed in
// already: continue to the workspace (bootstrap_me) or sign out. Local-only build: say so plainly.

export function SignIn() {
  const auth = useSession()
  const { state } = auth

  if (state.status === 'local-only') {
    return (
      <AuthCard title="Sign in" badge={COMING_SOON}>
        <p>{LOCAL_ONLY_TEXT}</p>
      </AuthCard>
    )
  }
  if (state.status === 'loading') {
    return (
      <AuthCard title="Sign in">
        <AuthStatus>Checking your session…</AuthStatus>
      </AuthCard>
    )
  }
  if (state.status === 'unavailable') {
    return (
      <AuthCard title="Sign in">
        <AuthAlert>{state.error.message}</AuthAlert>
      </AuthCard>
    )
  }
  if (state.status === 'signed-in') {
    return <SignedIn email={state.user.email} />
  }
  return <SignInForm />
}

function SignInForm() {
  const auth = useSession()
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [pending, setPending] = useState<'email' | 'google' | null>(null)
  const [error, setError] = useState<AuthFailure | null>(null)

  const onEmail = async (e: FormEvent) => {
    e.preventDefault()
    const address = email.trim()
    if (address === '') {
      setError({ message: 'Enter your email address.' })
      return
    }
    setPending('email')
    setError(null)
    const failure = await auth.sendMagicLink(address)
    setPending(null)
    if (failure) setError(failure)
    else setSentTo(address)
  }

  const onGoogle = async () => {
    setPending('google')
    setError(null)
    const failure = await auth.signInWithGoogle()
    // On success the page is already navigating to Google; keep the button disabled.
    if (failure) {
      setPending(null)
      setError(failure)
    }
  }

  if (sentTo) {
    return (
      <AuthCard title="Check your email">
        <p>
          We sent a sign-in link to <span className="font-medium text-stone-200">{sentTo}</span>.
          Open it in this browser to finish signing in.
        </p>
        <button
          type="button"
          className={SECONDARY_BUTTON}
          onClick={() => {
            setSentTo(null)
            setEmail('')
          }}
        >
          Use a different email
        </button>
      </AuthCard>
    )
  }

  return (
    <AuthCard title="Sign in">
      <p>Save decisions to a workspace and work on them with your team.</p>
      {error ? <AuthAlert>{describeAuthError(error)}</AuthAlert> : null}
      <button
        type="button"
        className={SECONDARY_BUTTON}
        onClick={() => void onGoogle()}
        disabled={pending !== null}
      >
        {pending === 'google' ? 'Opening Google…' : 'Continue with Google'}
      </button>
      <div className="flex items-center gap-3 text-xs uppercase tracking-[0.2em] text-stone-500">
        <span className="rule-gold h-px flex-1" aria-hidden="true" />
        or
        <span className="rule-gold h-px flex-1" aria-hidden="true" />
      </div>
      <form className="space-y-3" onSubmit={(e) => void onEmail(e)} noValidate>
        <label className="block">
          <span className="mb-1 block text-xs font-medium tracking-wide text-stone-300">
            Email address
          </span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-stone-100 placeholder:text-stone-600 focus:border-accent/60 focus:outline-none"
          />
        </label>
        <button type="submit" className={PRIMARY_BUTTON} disabled={pending !== null}>
          {pending === 'email' ? 'Sending…' : 'Email me a sign-in link'}
        </button>
      </form>
    </AuthCard>
  )
}

function SignedIn(props: { email: string | null }) {
  const auth = useSession()
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AuthFailure | null>(null)

  const onContinue = async () => {
    setPending(true)
    setError(null)
    const { workspaceId, error: failure } = await auth.bootstrap()
    setPending(false)
    if (workspaceId) navigate(`/w/${encodeURIComponent(workspaceId)}`)
    else setError(failure ?? { message: 'No workspace was returned.' })
  }

  return (
    <AuthCard title="You're signed in">
      <p>
        Signed in as{' '}
        <span className="font-medium text-stone-200">{props.email ?? 'your account'}</span>.
      </p>
      {error ? <AuthAlert>Could not open your workspace: {error.message}</AuthAlert> : null}
      <button
        type="button"
        className={PRIMARY_BUTTON}
        onClick={() => void onContinue()}
        disabled={pending}
      >
        {pending ? 'Opening your workspace…' : 'Continue to your workspace'}
      </button>
      <SignOutButton />
    </AuthCard>
  )
}

/** Signs out, clears the persisted session and returns to the matrix. */
export function SignOutButton() {
  const auth = useSession()
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AuthFailure | null>(null)

  const onSignOut = async () => {
    setPending(true)
    setError(null)
    const failure = await auth.signOut()
    setPending(false)
    if (failure) setError(failure)
    else navigate('/')
  }

  return (
    <>
      {error ? <AuthAlert>Could not sign out: {error.message}</AuthAlert> : null}
      <button
        type="button"
        className={SECONDARY_BUTTON}
        onClick={() => void onSignOut()}
        disabled={pending}
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
    </>
  )
}
