# DECISIONS — Metis (`metis`)

Dated, append-only. Any non-obvious choice lands here (CLAUDE.md §5).

## ADR-0001 — 2026-09-28 — GitHub Pages, no Supabase yet

**Decision.** Host on GitHub Pages (workflow `.github/workflows/deploy.yml`), not Netlify, and
create no Supabase project until a phase actually needs persistence or a server-side key.

**Why.** The operator asked for "a quick project hosted in GitHub Pages". P0 is a client-only
decision matrix: there is nothing to store and no secret to protect, so an empty EU Supabase
project would be cost and surface with no user. Pages serves the static build for free from the
repo itself.

**Consequences.** (1) Everything in the bundle is public, so the AI analyst CANNOT call a model
from the browser with a key; it needs a server-side proxy (Supabase Edge Function is the house
answer) — that phase reopens this ADR. (2) Assets resolve under `/metis/`. (3) CLAUDE.md §9's P1
(data spine) and P2 (auth) are deferred, not skipped: they begin when persistence does.

## 2026-09-28 — NEW PRODUCT step 4: no `BRAIN_DISCIPLINE.md` append

The kit already installs that text as CORE §0 via `kit.mjs apply`; ZEUS.md step 4 says not to
append it (zeus BRAIN §4 B5). Recorded so the absence is not mistaken for a skipped step.
