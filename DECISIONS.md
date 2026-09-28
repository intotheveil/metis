# DECISIONS — Themis (`themis`)

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
answer) — that phase reopens this ADR. (2) Assets resolve under `/themis/`. (3) CLAUDE.md §9's P1
(data spine) and P2 (auth) are deferred, not skipped: they begin when persistence does.

## 2026-09-28 — NEW PRODUCT step 4: no `BRAIN_DISCIPLINE.md` append

The kit already installs that text as CORE §0 via `kit.mjs apply`; ZEUS.md step 4 says not to
append it (zeus BRAIN §4 B5). Recorded so the absence is not mistaken for a skipped step.

## ADR-0003 — 2026-09-28 — served at themis.adeonanalytics.com

**Decision.** Themis is served at the root of `themis.adeonanalytics.com`, a GitHub Pages custom
domain on this repo. The DNS is a CNAME `themis` → `intotheveil.github.io` in the adeonanalytics.com
zone (Google Cloud DNS, operator-managed). Vite `base` becomes `/`.

**Why.** The operator wanted Themis under the ADEON brand. A subdomain of the domain ADEON already owns
costs nothing, and it keeps the app on its own origin, apart from the marketing site's strict CSP; auth
and payments later want that separation anyway. `adeonanalytics.com/themis` was rejected because it
would force the ADEON site's CSP open. A separate `adeon-themis.com` was optional, and the operator
declined to buy it.

**Consequence.** Once the custom domain is set, `intotheveil.github.io/themis/` redirects to the
domain. The switch must therefore wait until the DNS record resolves, or the old URL redirects to
nowhere.

## ADR-0002 — 2026-09-28 — shared Supabase project, own schema `themis`

**Decision.** Themis persists to **Hephaestus's LIVE Supabase project** `lss-platform` (ref
`atopkqykdmrcfvvcistc`, eu-west-1), not a project of its own. Every Themis object lives ONLY in
schema **`themis`**; nothing is created, altered or granted in `public`, `auth`, `storage` or
`supabase_migrations`. Operator ruling 2026-09-28; the rulebook is `zeus/specs/THEMIS_SPEC.md` §5a.
This **supersedes ADR-0001's "no Supabase" clause** (the GitHub Pages hosting part stands).

**Rules that make sharing safe.**

1. **No `supabase db push`, `supabase link`, `supabase db reset` or `supabase migration *`** against
   this project. Hephaestus owns `supabase_migrations.schema_migrations`; a Themis version recorded
   there would break Hephaestus's next push.
2. **Tracking in `themis.schema_migrations`.** Migrations are plain timestamped files
   `supabase/migrations/YYYYMMDDHHMMSS_themis_<name>.sql`, forward-only, checksummed.
3. **Applied only by `npm run db:apply`**, a Management-API applier
   (`POST /v1/projects/{ref}/database/query`, the Pluto pattern). It reads `SUPABASE_ACCESS_TOKEN` and
   `THEMIS_SUPABASE_PROJECT_REF` from env; tracked files hold the names only. Dry-run (rollback) is the
   default; `--apply` commits, and only with the operator's go (spec §5a.6).
4. **Rehearsed first by `npm run db:gate`**: PGlite (real Postgres in wasm, throwaway, no credential)
   with a shim that mirrors the shared project, including a Hephaestus-shaped `public` stub.
   `npm run db:gate:prove-red` proves the gate catches sabotage.
5. **No trigger on `auth.users`** (it would fire for Hephaestus sign-ups). `auth.users` is shared;
   Themis keeps its own `themis.profiles` and creates profile + first workspace through an idempotent
   RPC the client calls after sign-in. It never reads or writes `public.profiles`.
6. **Edge Functions are named `themis-*`** (`themis-ai-analyst`, `themis-billing`,
   `themis-stripe-webhook`, and `themis-send-invite` / `themis-delete-account` if needed). Function
   secrets are project-wide, so they are namespaced **`THEMIS_*`** (`THEMIS_ANTHROPIC_API_KEY`,
   `THEMIS_STRIPE_SECRET_KEY`, `THEMIS_STRIPE_WEBHOOK_SECRET`); Supabase injects
   `SUPABASE_SERVICE_ROLE_KEY` itself. Values live only in the Zeus Vault and Edge Function secrets.
7. **Workspace logo lives in the table, not in Storage.** Storage policies sit on the shared
   `storage.objects` table, which would break rule "nothing in `storage`". The logo is a size-capped
   data URL (≤ 100 KB) on `themis.workspaces`.

**Why.** One EU project instead of two: less cost and surface, and shared Supabase Auth. The price is
a shared blast radius, which the rules above (schema isolation, own tracking table, rehearsal, operator
go) contain.

**Consequences.** Exposing schema `themis` to the Data API and adding Themis's URL to the shared auth
redirect list are project-settings changes on a live production project: operator checkpoints, recorded
in BOTH brains. Auth templates and providers are project-wide: changing them affects Hephaestus.
