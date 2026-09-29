import { Link } from 'react-router-dom'
import { AuthStatus } from './AuthCard'
import { SignOutButton } from './SignIn'
import { useSession } from './useSession'

/**
 * Who is signed in, with a sign-out control (PLAN P2.10). Renders nothing in local-only mode, so a
 * page that shows it looks exactly as before in a build without Supabase.
 */
export function AccountStatus() {
  const { state } = useSession()
  switch (state.status) {
    case 'local-only':
      return null
    case 'loading':
      return <AuthStatus>Checking your session…</AuthStatus>
    case 'unavailable':
      return <p className="text-stone-400">{state.error.message}</p>
    case 'signed-out':
      return (
        <p>
          You are signed out.{' '}
          <Link to="/signin" className="font-medium text-accent hover:underline">
            Sign in
          </Link>{' '}
          to open a workspace.
        </p>
      )
    case 'signed-in':
      return (
        <div className="space-y-3">
          <p>
            Signed in as{' '}
            <span className="font-medium text-stone-200">{state.user.email ?? 'your account'}</span>
            .
          </p>
          <SignOutButton />
        </div>
      )
  }
}
