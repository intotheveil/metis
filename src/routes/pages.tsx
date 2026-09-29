import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AccountStatus } from '../features/auth/AccountStatus'
import { AuthCallback } from '../features/auth/AuthCallback'
import { SignIn } from '../features/auth/SignIn'
import { useSession } from '../features/auth/useSession'

// Route pages for the P2 paths. P2.3 made them shells so a deep link on GitHub Pages (served through
// the dist/404.html fallback) renders the app instead of a dead end. P2.10 wires /signin and
// /auth/callback to the auth feature (src/features/auth); workspaces and invites arrive in
// P2.11–P2.12 and still say honestly that they are not live.
//
// /auth/callback must NOT navigate, rewrite or strip the URL before supabase-js has read it: the
// PKCE `?code=` (or an `?error_description=`) has to still be in window.location at that point.

const BRAND = `${import.meta.env.BASE_URL}brand/`

/** The page frame every non-matrix route uses: the round bust icon + gold wordmark header. */
function PageShell(props: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-ink-800/80 bg-ink-950/70">
        <div className="mx-auto flex h-16 max-w-7xl items-center px-4 sm:px-6 lg:px-8">
          <Link to="/" className="flex items-center gap-3">
            <img
              src={`${BRAND}themis-icon.png`}
              alt=""
              width={96}
              height={96}
              className="h-9 w-9 rounded-full ring-1 ring-accent/60"
            />
            <span className="text-gold font-display text-lg font-semibold tracking-[0.2em]">
              THEMIS
            </span>
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-20 sm:px-6">{props.children}</main>
    </div>
  )
}

function RoutePage(props: { title: string; children: ReactNode }) {
  return (
    <PageShell>
      <section className="rounded-2xl border border-ink-700 bg-ink-850/80 p-6 shadow-xl shadow-black/20">
        <h1 className="text-lg font-semibold text-white">{props.title}</h1>
        <div className="mt-3 space-y-3 text-sm text-stone-400">{props.children}</div>
        <Link
          to="/"
          className="mt-6 inline-block rounded-lg border border-accent/40 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/10"
        >
          Open the decision matrix
        </Link>
      </section>
    </PageShell>
  )
}

export function SignInRoute() {
  return (
    <PageShell>
      <SignIn />
    </PageShell>
  )
}

export function AuthCallbackRoute() {
  return (
    <PageShell>
      <AuthCallback />
    </PageShell>
  )
}

export function WorkspaceRoute() {
  const { workspaceId } = useParams()
  const { state } = useSession()
  const id = workspaceId ? <span className="font-mono text-stone-300">{workspaceId}</span> : null
  if (state.status === 'local-only') {
    return (
      <RoutePage title="Workspace">
        <p>
          Workspaces are not live yet{id ? <> ({id})</> : null}. Themis currently runs entirely in
          your browser.
        </p>
      </RoutePage>
    )
  }
  // Configured build: the account is real. The workspace screens (switcher, members) are P2.11.
  return (
    <RoutePage title="Workspace">
      {id ? <p>Workspace {id}. Decisions and members arrive in the next release.</p> : null}
      <AccountStatus />
    </RoutePage>
  )
}

export function InviteRoute() {
  return (
    <RoutePage title="Workspace invite">
      <p>Invites are not live yet. This link cannot be accepted until team workspaces launch.</p>
    </RoutePage>
  )
}

export function NotFoundRoute() {
  return (
    <RoutePage title="Page not found">
      <p>There is nothing at this address.</p>
    </RoutePage>
  )
}
