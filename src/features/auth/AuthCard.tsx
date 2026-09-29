import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/** The black-and-gold panel every auth page renders in (same look as the P2.3 route shells). */
export function AuthCard(props: {
  title: string
  children: ReactNode
  backToMatrix?: boolean
  /** A small gold pill beside the title, e.g. "Coming soon" in a local-only build. */
  badge?: string
}) {
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-850/80 p-6 shadow-xl shadow-black/20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-white">{props.title}</h1>
        {props.badge ? (
          <span className="rounded-full border border-accent/30 px-3 py-1 font-mono text-[11px] tracking-wider text-accent/80 uppercase">
            {props.badge}
          </span>
        ) : null}
      </div>
      <div className="mt-3 space-y-4 text-sm text-stone-400">{props.children}</div>
      {props.backToMatrix === false ? null : (
        <Link
          to="/"
          className="mt-6 inline-block text-sm font-medium text-accent underline-offset-4 hover:underline"
        >
          Open the decision matrix
        </Link>
      )}
    </section>
  )
}

/** An error the user can read: never a blank screen. */
export function AuthAlert(props: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200"
    >
      {props.children}
    </p>
  )
}

/** A polite progress line for screen readers and sighted users alike. */
export function AuthStatus(props: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-2 text-stone-300">
      <span
        aria-hidden="true"
        className="h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent"
      />
      {props.children}
    </p>
  )
}

export const PRIMARY_BUTTON =
  'w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60'

export const SECONDARY_BUTTON =
  'w-full rounded-lg border border-accent/40 px-4 py-2.5 text-sm font-medium text-accent transition hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60'

/** Honest local-only copy: the feature does not exist in this build; the matrix still works. */
export const COMING_SOON = 'Coming soon'

export const LOCAL_ONLY_TEXT =
  'Sign-in is not available yet. Themis currently runs entirely in your browser: the decision matrix works in full, and nothing you enter leaves the page.'
