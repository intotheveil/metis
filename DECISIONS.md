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

## 2026-09-28 — P1.2 gate choices

- **The gate applies the whole archive TWICE.** CLAUDE.md §3.3 says every migration is
  idempotent-safe; the second pass is what proves it. It binds every later migration: use
  `if not exists`, `create or replace`, `drop policy if exists` before `create policy`, and
  `do $$ … exception when duplicate_object` for enums.
- **`alter default privileges in schema themis revoke execute on functions from public`** in the
  bootstrap. Postgres grants EXECUTE to PUBLIC on every new function, which would hand anon every
  Themis RPC; an RPC now grants EXECUTE to `authenticated` explicitly. (Default privileges are
  per creating role: `postgres` in both PGlite and the Management API.)
- **The shim's `service_role` has BYPASSRLS**, as on the real platform, so service-only tables
  behave in the gate as they do live.

## 2026-09-28 — P1.3 static migration guard: stricter than the four PLAN bullets

- **Any reference into public/auth/storage/supabase_migrations is flagged, not only a DDL/DML
  target.** That includes a `select` in a function body, `schema public` in a grant or in default
  privileges, and a `search_path` that names one of those schemas. Telling a "target" from a "read"
  in regex is fragile, and the only reads Themis needs are the two allowed ones (`references
auth.users`, `auth.uid()`). If a later migration truly needs another (for example `auth.jwt()`),
  add it to the allow-list in `check-migrations.mjs` in that migration's task. Do not loosen the
  regex.
- **An unqualified DDL/DML target is flagged (`target-outside-themis`).** `create table
workspaces` resolves through the search_path and would land in Hephaestus's `public`. Every
  target must be written `themis.x`. `create temp table` stays allowed because it is session-local.
- **Comments are blanked, but string literals are kept.** Prose may name `public.profiles`, but
  `execute 'delete from public.tasks'` is still caught. A false positive costs a rewording; a false
  negative reaches the live shared project.
- **`alter user` counts as `alter role`** (Postgres treats them as the same command). **Every
  non-dot file in the migrations dir** must match the name pattern, so a mis-cased `.SQL` cannot be
  silently skipped by the gate's `.sql` filter. Name violations report line 0 (the whole file).
- **An empty or missing dir is red**, which matches db:gate's "nothing to prove" rule.

## 2026-09-28 — P1.4 tenancy choices

- **Membership, invite and workspace-creation writes are RPC-only.** `memberships` and `invites`
  have a SELECT policy only, and `workspaces` has no INSERT policy. A direct admin UPDATE on
  `memberships.role` would bypass P2.6's rules ("an admin cannot promote to owner", "the last owner
  cannot be removed or demoted"). The first owner membership of a new workspace cannot pass an
  "is admin" check. P2.5 `bootstrap_me()` and the P2.6 RPCs (SECURITY DEFINER) do these writes.
- **Table grants match the policies.** authenticated gets SELECT on all four, INSERT
  (user_id, display_name) and UPDATE (display_name) on profiles, UPDATE (name, logo_data_url) and
  DELETE on workspaces, and nothing else. Column grants stop an allowed updater from rewriting
  `created_by` or a key. service_role gets full DML.
- **Third helper `themis.shares_workspace(other)`** backs the profiles policy "own row or a shared
  workspace", so that policy never subqueries memberships either.
- **No citext.** `create extension` is forbidden in the shared project. `invites.email` is text with
  `check (email = lower(email))`, and callers lower-case it. `token_hash` is a 64-char lower-hex
  sha256 (`encode(sha256(...), 'hex')` in P2.6).
- **Logo = png/jpeg/webp data URL only, ≤ 140000 chars** (≈ 100 KB of image once base64-encoded).
  SVG is refused because it can carry script.
- **`create or replace trigger`** (PG14+) keeps the triggers idempotent without a DROP.
- **memberships' unique(workspace_id, user_id) is its primary key.**

## 2026-09-28 — P1.5 decision core choices

- **Lifecycle columns are not client-writable.** authenticated may INSERT (workspace_id, question,
  methodology, scale) and UPDATE (question, methodology, scale) on `decisions`. Status, frozen,
  approved_by/at, lineage_id and revision change only through the P4.2 SECURITY DEFINER RPCs.
  Without this an editor could self-approve, unfreeze, or insert `(someone's lineage_id, n)`
  and block another workspace's next revision through the global `unique(lineage_id, revision)`.
- **Frozen is enforced by RLS on `decisions` now** (`not frozen` in UPDATE/DELETE) and by CHECKs:
  frozen requires approved_at, and approved requires approved_at. The child-table `decision_frozen`
  triggers stay in P4.2 as planned. Until then nothing client-side can set `frozen`.
- **Scores pin both ends to one decision.** Besides the planned `(decision_id, workspace_id)` FK,
  scores have `(option_id, decision_id)` → `options(id, decision_id)` and `(criterion_id,
decision_id)` → `criteria(id, decision_id)`. The PK is `(option_id, criterion_id)`, one row per cell,
  and it is the upsert target. An unscored cell has no row, which is what `decision.ts` expects.
- **Children have no direct FK to `workspaces`.** The composite FK to `decisions` carries tenancy,
  and cascades come through it.
- **`position smallint` on options and criteria.** Rows created in one statement share
  `created_at`, so order would otherwise be lost. The spec does not require it. It is a display
  input, never math.
- **`question` may be empty (≤ 1000 chars), and option and criterion names may be empty (≤ 200).** A draft
  is saved before it is written (P0 import, debounced saves).
- **Weights and scores are `smallint`,** matching the integer inputs of the UI range and score
  controls. The DB stores inputs only, never a computed score.
- **The enum-match assertion lives in `scripts/db-tenancy.test.ts`** until P1.8 adds it to db-gate.mjs,
  which is outside P1.5's files.
