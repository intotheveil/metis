# PLAN — Themis (`themis`) commercial v1, P1 to P6

**Source spec:** `zeus/specs/THEMIS_SPEC.md` (approved). **Arc:** CLAUDE.md §9. Only P3 and P4 content comes
from the spec; the rest is the fixed fleet arc. **P0 is DONE**: live at https://themis.adeonanalytics.com
(ADR-0003), 16 tests, CI + Pages deploy.
**Planned:** 2026-09-28 by `planner`. Nothing here is built yet.

---

## How to read this plan

- **Task id** `P<n>.<k>`. Each task has an agent, the files in scope, what it depends on, and objective acceptance
  criteria. A task may write ONLY the files listed in its scope (CLAUDE.md §3.5). Every task also updates
  `BUILD_LOG.md` and `BRAIN.md` (§0, §5), and updates `DECISIONS.md` when it makes a non-obvious choice. These three
  files are always in scope, so they are not repeated per task.
- **Task loop (§4):** after each `builder` task, `test-writer` adds or extends coverage for it before the commit.
  A separate `test-writer` task appears only where the tests are a distinct deliverable, such as the leak suites,
  the e2e specs or the webhook proofs.
- **∥ = parallelizable** with the named sibling tasks, because their file sets are disjoint. Parallel builders each
  get their own git worktree (§4 "one writer per checkout"). Migrations are NEVER parallel: they are ordered files.
- **QA and REVIEW are the last two tasks of every phase.** They are never parallel, and neither may be done by the
  builder. A phase is claimed only when qa=VALIDATED, reviewer=PASS and the human approves the CHECKPOINT.
- **`CHECKPOINT`** lines are hard stops. Write the summary to `BUILD_LOG.md` and wait for the operator (§7).

## Standing constraints (every task inherits these; a task that breaks one fails review)

1. **Shared Supabase project** `lss-platform`, ref `atopkqykdmrcfvvcistc`, eu-west-1, is LIVE for **Hephaestus**
   (`lss-platform` repo). Every Themis object lives ONLY in schema **`themis`**. Nothing is created, altered or
   granted in `public`, `auth`, `storage` or `supabase_migrations`.
2. **Never `supabase db push`, `supabase link`, `supabase db reset` or `supabase migration *`** against this
   project. Hephaestus owns `supabase_migrations.schema_migrations`. Themis migrations are plain timestamped SQL
   files in `supabase/migrations/` (`YYYYMMDDHHMMSS_themis_<name>.sql`), tracked in **`themis.schema_migrations`**,
   and applied ONLY by `npm run db:apply`. That script calls the Management API `POST /v1/projects/{ref}/database/query`
   and reads `SUPABASE_ACCESS_TOKEN` and `THEMIS_SUPABASE_PROJECT_REF` from env. Tracked files hold names only.
3. **Rehearse first.** Every migration passes `npm run db:gate` (PGlite, real Postgres in wasm, throwaway,
   no credential) before any live apply. Every live apply needs the operator's go (spec §5a.6).
4. **No trigger on `auth.users`.** Profile and first-workspace creation happen through an idempotent RPC that the
   client calls after sign-in.
5. **Edge Functions are named `themis-*`.** Their secrets are project-wide, so they are namespaced too:
   `THEMIS_ANTHROPIC_API_KEY`, `THEMIS_STRIPE_SECRET_KEY`, `THEMIS_STRIPE_WEBHOOK_SECRET`. Supabase injects
   `SUPABASE_SERVICE_ROLE_KEY` itself. Values live only in the Zeus Vault and in Edge Function secrets.
6. **No secret in the bundle.** Browser code may read only `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
   `VITE_STRIPE_PUBLISHABLE_KEY` and the fleet-telemetry `VITE_FLEET_*` names. An ESLint rule (the argus-news
   pattern) and a scan of the built bundle enforce this.
7. **`src/lib/decision.ts` is the single source of the scoring math.** This covers scores, rank, verdict and, from
   P4, risk exposure and the risk-adjusted score. The UI, the report and the Edge Function import it. None of them
   re-implements it.
8. **Honest verdicts.** There is no winner while scoring is incomplete, and a margin under 5 points is "too close
   to call". AI output can never override either rule.
9. House stack: React + Vite + TS strict + Tailwind v4, **npm only**, Vitest, and **Playwright from P2**.
   Editing `.github/workflows/*` needs the gh `workflow` scope (BRAIN §5).

### Spec discrepancies resolved in this plan (confirm at the P1 checkpoint)

- **Domain.** Spec §0, §5 and §10.3 say `app.adeon-themis.com`. ADR-0003 (later, operator-ruled) serves Themis at
  **`themis.adeonanalytics.com`** and records that the operator declined to buy `adeon-themis.com`. This plan uses
  `themis.adeonanalytics.com`, so the P6 "custom domain" work is verification, not a purchase.
- **Function names.** Spec §5 says `ai-analyst`/`stripe-webhook`; §5a.5 says `themis-*`. This plan uses
  **`themis-ai-analyst`, `themis-billing`, `themis-stripe-webhook`** (and `themis-send-invite` /
  `themis-delete-account` where needed).
- **Secret names.** Spec §7.1 lists bare names such as `ANTHROPIC_API_KEY`. Edge secrets are project-wide in the
  shared project, so this plan prefixes them with `THEMIS_` (constraint 5). This is a naming refinement, and the
  lint rule blocks both forms.
- **Workspace logo.** Supabase Storage policies live on the shared `storage.objects` table, which would break
  §5a.1. The logo is therefore stored in `themis.workspaces` (a size-capped data URL, ≤ 100 KB), not in a bucket.

---

## Phase P1: Data spine

Delivers schema `themis` in the shared project with every §6 table, RLS on each one, the `plans` seed, a
self-contained `db:gate` that proves it on real Postgres, and a Management-API applier. These are applied to the
LIVE project only after the operator's go.

### P1.1 — ADR-0002 and the constitution for a shared database (agent: builder)

- **Files:** `DECISIONS.md`, `.claude/CLAUDE.project.md` (§2, §8, §11), `.claude/CLAUDE.md` (regenerated only by
  `node D:/projects/zeus/.zeus/kit/kit.mjs apply themis --fleet-root D:/projects`), `BRAIN.md` §2 and §7.
- **Depends on:** none.
- **Acceptance:**
  - `DECISIONS.md` has **ADR-0002 (shared Supabase, own schema)**. It records the ref, schema `themis`, no
    `db push`, tracking in `themis.schema_migrations`, the Management-API applier, the `db:gate` rehearsal, no
    trigger on `auth.users`, `themis-*` functions and `THEMIS_*` secrets, and the logo-in-table ruling. It
    supersedes ADR-0001's "no Supabase" clause.
  - §2 names Supabase (schema `themis`) under the stack, with ADR-0002 under Deviations. §8 names
    `db:gate`, `db:gate:prove-red` and `db:apply` (the migrate command) and says `e2e: arrives in P2`.
  - §11 adds the rule "never `supabase db push` / `link` against this project".
  - The composed CLAUDE.md matches after `kit.mjs apply` (BRAIN §5 prettier gotcha), and `kit.mjs check themis`
    exits 0.
- **Tenant data:** no. **Migration:** no.

### P1.2 — `db:gate` harness and bootstrap migration (agent: builder)

- **Files:** `package.json` (devDep `@electric-sql/pglite`; scripts `db:gate`), `package-lock.json`,
  `scripts/db-gate.mjs`, `scripts/db-gate/shim.mjs`,
  `supabase/migrations/<ts>_themis_schema.sql`.
- **Depends on:** P1.1.
- **Acceptance:**
  - The gate follows `argus-news/scripts/db-gate.mjs`: PGlite in memory, `DB_GATE_MIGRATIONS` override, exit 1 on
    any FAIL, and "no migrations found" counts as a FAIL.
  - **The shim mirrors the SHARED project.**
    - It creates roles `anon`, `authenticated` and `service_role`, plus `auth.uid()` and `auth.users`.
    - It creates a Hephaestus-shaped stub: `public.organizations`, `public.profiles`, `public.memberships`,
      `public.workspaces`, `public.tasks`, and `supabase_migrations.schema_migrations` with 25 rows.
    - It does **NOT** pre-grant anything on schema `themis`. A missing grant must show up as a failing positive-path
      check.
  - The bootstrap migration is idempotent-safe:
    - It creates schema `themis` if absent.
    - It creates `themis.schema_migrations(version text pk, name text, checksum text, applied_at timestamptz)` with
      RLS enabled, no policies, and no grants to `anon`/`authenticated`.
    - It creates `themis.touch_updated_at()` with `search_path` pinned.
    - It grants `usage on schema themis` to `anon, authenticated, service_role`.
  - `npm run db:gate` prints `applied <file>` and PASS lines, and exits 0.
- **Tenant data:** no. **Migration:** yes (bootstrap).

### P1.3 — Static migration guard (agent: builder)

- **Files:** `scripts/check-migrations.mjs`, `scripts/db-gate.mjs` (call it first), `package.json` (script
  `db:check`).
- **Depends on:** P1.2. **∥** none (touches db-gate.mjs).
- **Acceptance:** the guard fails with the file and line for any migration that contains any of the following:
  - a DDL/DML target in `public.`, `auth.` (except `references auth.users` and `auth.uid()`), `storage.` or
    `supabase_migrations.`;
  - `create trigger … on auth.users`;
  - `create extension`, `alter system`, `drop schema`, `alter role`, or `alter default privileges` outside
    `in schema themis`;
  - a filename that does not match `^\d{14}_themis_[a-z0-9_]+\.sql$`.
    It exits 0 on the current archive.
- **Tests (test-writer):** `scripts/check-migrations.test.ts`, one fixture per forbidden pattern (RED), plus a
  clean fixture (GREEN).
- **Tenant data:** no. **Migration:** no.

### P1.4 — Migration: tenancy (`workspaces`, `memberships`, `invites`, `profiles`) (agent: builder)

- **Files:** `supabase/migrations/<ts>_themis_tenancy.sql`.
- **Depends on:** P1.3.
- **Acceptance:**
  - **Tables.**
    - `themis.profiles(user_id pk → auth.users on delete cascade, display_name, created_at, updated_at)`.
    - `themis.workspaces(id, name, logo_data_url check length ≤ 140000, created_by, created_at, updated_at)`.
    - `themis.memberships(workspace_id, user_id, role check in ('owner','admin','editor','viewer'),
unique(workspace_id,user_id))`.
    - `themis.invites(workspace_id, email citext-or-lower(text), role, token_hash unique, expires_at, created_by,
accepted_at)`.
  - **Recursion-safe helpers.** `themis.is_member(ws uuid)` and `themis.has_role(ws uuid, roles text[])` are
    SECURITY DEFINER STABLE with `set search_path = ''`. EXECUTE is revoked from `public`/`anon` and granted to
    `authenticated`. This follows the Hephaestus `20260709000008_fix_rls_recursion` gotcha, so no policy subqueries
    `memberships` directly.
  - **RLS and grants.** RLS is enabled on all four tables. Every policy is scoped by `workspace_id` through the
    helpers, and `profiles` is scoped by `user_id = auth.uid()` or a shared workspace. Explicit table grants go to
    `authenticated` and `service_role` only. `anon` gets nothing.
  - `updated_at` triggers use `themis.touch_updated_at()`.
- **Tenant data:** YES. **Migration:** yes.

### P1.5 — Migration: decision core (`decisions`, `options`, `criteria`, `scores`) (agent: builder)

- **Files:** `supabase/migrations/<ts>_themis_decisions.sql`.
- **Depends on:** P1.4.
- **Acceptance:**
  - **`decisions`.** Columns are `id, workspace_id, lineage_id, revision int ≥1, question, methodology check
(waterfall|agile|yolo), scale check (small|mid|enterprise), status check
(draft|in_review|approved|rejected|archived), frozen bool, approved_by, approved_at, created_by, created_at,
updated_at`. The table has `unique(id, workspace_id)` and `unique(lineage_id, revision)`.
  - **Children carry `workspace_id`.** `options`, `criteria` (weight 0–5), and
    `scores(option_id, criterion_id, value check 1–5)` each have their own `workspace_id` and a **composite FK
    `(decision_id, workspace_id)`**. A child row can therefore never point into another workspace's decision.
  - Every table has `created_by` and `updated_at` (spec §2.1).
  - The enum values match `Methodology` and `Scale` in `src/lib/decision.ts` exactly. The gate asserts this, as in
    argus's topic-enum check.
  - RLS is enabled. Members can read. `editor|admin|owner` can write. `viewer` can only read.
- **Tenant data:** YES. **Migration:** yes.

### P1.6 — Migration: analysis and collaboration (`swot_items`, `risks`, `comments`, `approvals`) (agent: builder)

- **Files:** `supabase/migrations/<ts>_themis_analysis.sql`.
- **Depends on:** P1.5.
- **Acceptance:**
  - **Tables.**
    - `swot_items(decision_id, option_id null, quadrant check s|w|o|t, text)`.
    - `risks(option_id, title, likelihood 1–5, impact 1–5, owner, mitigation)`.
    - `comments(decision_id, body, author)`.
    - `approvals(decision_id, verdict check approved|rejected, reason not null, actor)`.
  - All four carry `workspace_id` with composite FKs to the parent, plus `created_by`/`updated_at`.
  - **RLS.** Comments can be written by any member (viewer included). Only the author may update or delete a
    comment. Approvals can be inserted only by `admin|owner`, and nobody can update or delete one.
- **Tenant data:** YES. **Migration:** yes.

### P1.7 — Migration: AI, billing, audit, plans and seed (agent: builder)

- **Files:** `supabase/migrations/<ts>_themis_ai_billing_audit.sql`.
- **Depends on:** P1.6.
- **Acceptance:**
  - **Tables.**
    - `ai_runs(workspace_id, decision_id, kind, model, status, input_snapshot jsonb, output jsonb, tokens_in,
tokens_out, cost_eur numeric(10,4), accepted jsonb, created_by)`.
    - `subscriptions(workspace_id unique, stripe_customer_id, stripe_subscription_id, plan, seats, status,
period_end)`.
    - `usage_monthly(workspace_id, month date, ai_runs, ai_cost_eur, pk(workspace_id, month))`.
    - `audit_log(workspace_id, actor, entity, entity_id, action, before jsonb, after jsonb, at)`.
    - `plans(key pk free|pro|team, active_decisions null=unlimited, ai_runs_month, ai_runs_per_seat,
ai_cost_ceiling_eur, members_max, pdf_footer bool, pdf_logo bool, min_seats)`.
  - **Seed.** `plans` is seeded with the §4 **proposal** values. The inserts use `on conflict do nothing`, so the
    migration is idempotent.
  - **Server-side writes only.** Members can read `ai_runs`, `subscriptions` and `usage_monthly`, but have **no**
    insert/update/delete policy on them: only `service_role` writes. `audit_log` can be read by `admin|owner` and
    has no client write policy. `plans` is `select` for `anon` and `authenticated`.
- **Tenant data:** YES (all except `plans`). **Migration:** yes.

### P1.8 — The leak suite: structural and functional gates (agent: test-writer)

- **Files:** `scripts/db-gate.mjs`, `scripts/db-gate/leak-matrix.mjs`.
- **Depends on:** P1.7.
- **Acceptance.** Each item below is a PASS/FAIL line.
  - **Structural checks.**
    - RLS is enabled on every `themis` table.
    - Every `themis` table has at least one policy. The only exceptions are `schema_migrations` and
      service-role-only tables, which must hold zero grants to `anon`/`authenticated`.
    - `search_path` is pinned on every `themis` function.
    - `anon` has EXECUTE on no `themis` function.
    - No write policy admits `anon` or PUBLIC.
    - **Zero objects in `public` changed.** The gate diffs `pg_class`/`pg_policy`/`pg_proc` in `public` before and
      after apply.
    - **No trigger on `auth.users`.**
    - `supabase_migrations.schema_migrations` still holds 25 rows.
    - **No orphaned FKs:** every FK constraint is `convalidated`, and an orphan scan over the seeded fixture finds
      zero dangling references.
    - The enums match `decision.ts`.
    - `plans` has 3 rows.
  - **Coverage check.** Every table in `themis` (except the listed service-only ones) appears in the leak matrix.
    **Adding a table without a leak entry turns the gate RED.**
  - **Per-table leak test (workspaces A and B, users UA and UB, plus a viewer and an editor in A).**
    - UB reads **zero** rows of A's data.
    - UB's INSERT (including a child row with `workspace_id = B` pointing at A's parent), UPDATE and DELETE on A's
      rows have **no effect**. This uses argus's `noEffect` pattern: affected rows = 0, and a before/after snapshot
      is identical.
    - `anon` reads nothing except `plans`.
  - **Positive path.** UA can read and write A's data, and a viewer can read it but not write it. Without this, a
    fully locked (broken) schema would pass.
  - The gate ends with `GATE PASSED` and exits 0.
- **Tenant data:** YES (tests). **Migration:** no.

### P1.9 — Prove the gate RED (agent: builder)

- **Files:** `scripts/db-gate-prove-red.mjs`, `package.json` (script `db:gate:prove-red`).
- **Depends on:** P1.8.
- **Acceptance:**
  - The script copies `supabase/migrations/` to a temp dir and appends ONE sabotage per run. The sabotages are:
    - (a) `create policy … on themis.decisions for select using (true)`;
    - (b) `alter table themis.scores disable row level security`;
    - (c) a new table `themis.leaky(id int)` with no leak entry;
    - (d) a `create table public.x`;
    - (e) a `create trigger … on auth.users`;
    - (f) dropping the composite FK on `themis.scores`.
  - For each sabotage it runs `db-gate.mjs` with `DB_GATE_MIGRATIONS`, and asserts **a non-zero exit AND the
    expected FAIL line**. For (d) and (e), the static guard catching it first counts.
  - It prints one line per sabotage and exits 0 only if all six went RED.
- **Tenant data:** no. **Migration:** no.

### P1.10 — CI runs the gates (agent: builder)

- **Files:** `.github/workflows/deploy.yml`.
- **Depends on:** P1.9. **∥** P1.11, P1.12.
- **Acceptance:** the `verify` job runs `npm run db:gate` and `npm run db:gate:prove-red` after `npm test` and before
  `build`. A PR run shows both steps green. The push needs the gh `workflow` scope (BRAIN §5).
- **Tenant data:** no. **Migration:** no.

### P1.11 — `db:apply`: the Management-API applier (agent: builder)

- **Files:** `scripts/db-apply.mjs`, `scripts/lib/mgmt-api.mjs`, `package.json` (script `db:apply`),
  `.env.example` (names `SUPABASE_ACCESS_TOKEN`, `THEMIS_SUPABASE_PROJECT_REF`, commented and without values).
- **Depends on:** P1.9. **∥** P1.10, P1.12.
- **Acceptance:**
  - **Credentials.** The script reads the token and ref from env only, and exits 2 with a clear message if either
    is missing. It never shells out to the `supabase` CLI.
  - **Pre-flight.** It runs `check-migrations` first. It reads applied versions from `themis.schema_migrations`;
    "relation does not exist" means nothing has been applied yet. **It aborts if an applied file's sha256
    checksum changed** (forward-only).
  - **Dry-run is the default.** Each pending file is sent as `begin; set local lock_timeout='5s'; set local
statement_timeout='60s'; <sql>; insert into themis.schema_migrations …; rollback;`.
  - **`--apply`** sends the same batch with `commit`, one file per request, and stops at the first error. It prints
    the plan (pending files) before sending anything.
  - The API response is checked for an error payload, and the script exits 1 on error.
- **Tenant data:** no. **Migration:** no (tooling).

### P1.12 — Read-only live snapshot and diff (agent: builder)

- **Files:** `scripts/db-snapshot.mjs`, `scripts/db-snapshot-diff.mjs`, `package.json` (scripts `db:snapshot`,
  `db:snapshot:diff`), `.gitignore` (`ops-snapshots/`).
- **Depends on:** P1.9. **∥** P1.10, P1.11.
- **Acceptance:**
  - The snapshot uses `select` statements only, and the script refuses any non-SELECT. It captures:
    - `public` tables, policies and functions (names and definitions hash);
    - `supabase_migrations.schema_migrations` versions;
    - triggers on `auth.users`;
    - installed extensions;
    - the `themis` object list.
  - It writes `ops-snapshots/<iso>-<label>.json`, which is gitignored.
  - The diff exits 1 if anything outside `themis` differs between two snapshots.
- **Tests (test-writer):** `scripts/db-apply.test.ts` and `scripts/db-snapshot.test.ts` with `fetch` mocked. They
  cover dry-run wrapping, checksum abort, error payload → exit 1, and the non-SELECT refusal. No network is used.
- **Tenant data:** no. **Migration:** no.

### P1.13 — Live-apply runbook and pre-apply evidence pack (agent: builder)

- **Files:** `docs/ops/LIVE_APPLY.md`.
- **Depends on:** P1.10, P1.11, P1.12.
- **Acceptance:** the runbook lists the exact commands in order:
  1. `db:snapshot pre`;
  2. `db:apply` (dry-run), with its output pasted in;
  3. exposing `themis` in the Data API. This is done in the Dashboard (API settings → Exposed schemas) or by
     Management API `PATCH /v1/projects/{ref}/postgrest`, and **keeps every currently exposed schema**. The current
     list is read first with GET, and its value is recorded in the doc;
  4. `db:apply --apply`;
  5. `db:snapshot post` and `db:snapshot:diff`;
  6. the Hephaestus regression: `npm test` in `D:\projects\lss-platform`, plus its `tenant-isolation` and
     `rls-isolation` e2e specs, read-only against live.

  It also records the **rollback** for each step. Un-exposing the schema is additive-safe. `drop schema themis
cascade` is destructive and needs its own operator approval. The evidence pack pastes in the latest `db:gate`,
  `db:gate:prove-red` and dry-run outputs.

- **Tenant data:** no. **Migration:** no.

**CHECKPOINT P1-LIVE — expose schema `themis` and first apply to the LIVE shared project `atopkqykdmrcfvvcistc`
(ADR-0002).** The operator reviews the P1.13 evidence pack and the spec discrepancies above, and says go or
no-go. Nothing touches the live project before this.

### P1.14 — Execute the live apply (agent: builder, operator-gated)

- **Files:** `BUILD_LOG.md`, `BRAIN.md`, **`D:\projects\lss-platform\BRAIN.md` §5/§6 only**. That last file is the
  one sanctioned cross-repo write, required by spec §5a.4.
- **Depends on:** CHECKPOINT P1-LIVE approved.
- **Acceptance:**
  - The runbook is executed step by step, with each output pasted into `BUILD_LOG.md`.
  - `themis.schema_migrations` lists every P1 file.
  - `db:snapshot:diff pre post` exits 0: nothing outside `themis` changed.
  - The Hephaestus suite is green.
  - `themis` appears in the exposed schemas, and `curl` of `…/rest/v1/plans` with `Accept-Profile: themis` and the
    anon key returns 3 rows.
  - Both brains record the date, the applied versions and the exposed-schema change.
- **Tenant data:** YES (live). **Migration:** applies P1.2 and P1.4 through P1.7 live.

### P1.QA — QA and validation (agent: qa)

- **QA exit gate** (all runnable; qa runs each command itself on a clean clone):
  1. `npm ci && npm run db:gate` → `GATE PASSED` with 0 FAIL. The migrations apply on a FRESH database with zero
     errors.
  2. `npm run db:gate:prove-red` → all 6 sabotages RED.
  3. The leak matrix covers every `themis` table. qa adds a throwaway table locally and confirms the gate goes red,
     then discards it.
  4. There are no orphaned FKs (gate line).
  5. Live: `db:snapshot` now vs the P1.14 `pre` snapshot → the diff shows no change outside `themis`. The
     `schema_migrations` rows in `themis` match the archive, file for file, with checksums equal.
  6. **Hephaestus's own suite is still green after apply.** `npm test` in `D:\projects\lss-platform` is green, and
     its RLS/tenant e2e is green. qa runs these read-only and writes nothing there.
  7. `npm run lint && npm run typecheck && npm test && npm run build` are green, and the CI run for HEAD is green.
- **Depends on:** all P1 build tasks (P1.1 through P1.14).

### P1.REVIEW — Quality review (agent: reviewer)

- **Depends on:** P1.QA = VALIDATED. **Rubric:** CLAUDE.md §6. Particular attention goes to the RLS/isolation
  line, the fresh-DB migration line, and the rule of no writes outside `themis`.

**CHECKPOINT P1 — phase gate.** The summary goes to `BUILD_LOG.md`. Wait for approval.

---

## Phase P2: Auth and tenancy

Delivers sign-in (magic link plus Google) on the shared Supabase Auth, personal and team workspaces, invites, role
gating, the anonymous P0 matrix imported as the user's first saved decision, and Playwright e2e.

### P2.1 — Secret boundary: lint rule and bundle scan (agent: builder)

- **Files:** `eslint.config.js`, `scripts/check-bundle-secrets.mjs`, `package.json` (script `check:bundle`),
  `.github/workflows/deploy.yml` (run `check:bundle` after `build`).
- **Depends on:** P1 claimed. **∥** P2.3.
- **Acceptance:**
  - `no-restricted-syntax` (the argus-news pattern) errors on `import.meta.env.X` or `process.env.X` in `src/**`,
    where X matches
    `/^(THEMIS_)?(ANTHROPIC_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)$|^SUPABASE_SERVICE_ROLE_KEY$|^SUPABASE_ACCESS_TOKEN$/`.
    The rule also errors on any `import.meta.env.VITE_*` outside an allow-list (the constraint 6 names).
  - `supabase/functions/**`, `scripts/**` and `e2e/**` are outside the rule's `files`.
  - The bundle scan greps `dist/**` for `sk_live_`, `sk_test_`, `whsec_`, `sk-ant-`, `service_role`, and exits 1
    on any hit.
  - A fixture file that uses a forbidden name makes `npm run lint` fail. The builder shows this, then removes the
    fixture.
- **Tenant data:** no. **Migration:** no.

### P2.2 — Supabase client and local-only fallback (agent: builder)

- **Files:** `package.json` (dep `@supabase/supabase-js`), `package-lock.json`, `src/lib/supabase.ts`,
  `src/lib/env.ts`, `.env.example`.
- **Depends on:** P2.1.
- **Acceptance:**
  - The client is created with `db: { schema: 'themis' }` and `auth: { persistSession: true, detectSessionInUrl:
true, flowType: 'pkce' }`.
  - If either `VITE_SUPABASE_*` is missing, the app runs in **local-only mode** (the P0 matrix still works) and does
    not throw at import.
  - `.env.example` lists the names only.
- **Tests (test-writer):** `src/lib/env.test.ts` covers the missing-env → local mode case and the present →
  configured case.
- **Tenant data:** no. **Migration:** no.

### P2.3 — Routing and SPA fallback on Pages (agent: builder)

- **Files:** `package.json` (dep `react-router-dom`), `src/main.tsx`, `src/routes/*`, `src/App.tsx` (moved to route
  `/`, behaviour unchanged), `vite.config.ts` or `scripts/spa-fallback.mjs` (copies `dist/index.html` →
  `dist/404.html`).
- **Depends on:** P1 claimed. **∥** P2.1.
- **Acceptance:**
  - The routes are `/` (matrix), `/signin`, `/auth/callback`, `/w/:workspaceId/*` and `/invite/:token`.
  - `npm run build && npx vite preview` serves `/auth/callback` directly: a hard load renders the app, not a 404.
  - The existing 16 tests are still green.
- **Tenant data:** no. **Migration:** no.

### P2.4 — Playwright wiring (agent: builder)

- **Files:** `package.json` (devDep `@playwright/test`; scripts `e2e`, `e2e:live`), `playwright.config.ts`,
  `e2e/local/*.spec.ts`, `e2e/support/*`, `.github/workflows/deploy.yml` (install chromium, run `npm run e2e`),
  `.claude/CLAUDE.project.md` §8 (plus kit apply), `.gitignore` (`test-results/`, `playwright-report/`).
- **Depends on:** P2.3.
- **Acceptance:**
  - `npm run e2e` runs the `local` project against `vite preview` of the built bundle with no backend. The specs
    cover two cases:
    - signed-out, the matrix scores two options and shows a verdict;
    - a deep link to `/auth/callback` loads the app.
  - `npm run e2e:live` runs the `live` project. It needs `E2E_*` env and is skipped with a clear message when the
    env is absent.
  - §8 names both commands, and BRAIN F3 is resolved.
  - CI runs `npm run e2e` green.
- **Tenant data:** no. **Migration:** no.

### P2.5 — Migration: onboarding RPCs (agent: builder)

- **Files:** `supabase/migrations/<ts>_themis_onboarding.sql`.
- **Depends on:** P1 claimed.
- **Acceptance:**
  - **`themis.bootstrap_me()`** is SECURITY DEFINER, `search_path=''`, with EXECUTE for `authenticated` only. It is
    idempotent: it creates `themis.profiles` for `auth.uid()` and a personal workspace with an `owner` membership
    only if they are absent, then returns the workspace id. It is the substitute for an `auth.users` trigger.
  - **`themis.import_local_decision(ws uuid, payload jsonb)`** requires `editor+` in `ws`. It inserts a decision
    with its options, criteria and scores atomically and validates ranges (weight 0–5, score 1–5). A
    `client_import_id` in the payload deduplicates, so a repeated call returns the same decision id.
- **Tenant data:** YES. **Migration:** yes.

### P2.6 — Migration: membership and invite RPCs (agent: builder)

- **Files:** `supabase/migrations/<ts>_themis_invites.sql`.
- **Depends on:** P2.5.
- **Acceptance:**
  - `create_invite(ws, email, role)` requires `admin|owner`. It stores `sha256(token)` and expires in 7 days. It
    returns the raw token **once**. An admin cannot invite as `owner`.
  - `accept_invite(token)` works only if the signed-in user's `auth.users.email` equals the invite email, the invite
    is not expired and not already accepted. It creates the membership.
  - `revoke_invite`, `set_member_role` and `remove_member` exist. An admin cannot promote to owner or demote an
    owner, and **the last owner cannot be removed or demoted**.
- **Tenant data:** YES. **Migration:** yes.

### P2.7 — Gate extension for P2 RPCs (agent: test-writer)

- **Files:** `scripts/db-gate.mjs`, `scripts/db-gate/leak-matrix.mjs`, `scripts/db-gate-prove-red.mjs` (new
  sabotage).
- **Depends on:** P2.6.
- **Acceptance:**
  - `bootstrap_me` twice → one profile, one workspace.
  - `import_local_decision` twice with the same id → one decision. Into B's workspace by UA → no effect.
  - An invite accepted by a user with the wrong email → rejected. An expired one → rejected. A reused one →
    rejected.
  - An editor calling `create_invite` → rejected. An admin self-promoting to owner → rejected. Removing the last
    owner → rejected.
  - `anon` cannot EXECUTE any of the RPCs.
  - New sabotage: `accept_invite` without the email check → gate RED.
- **Tenant data:** YES (tests). **Migration:** no.

### P2.8 — Shared-auth settings: read-only snapshot and proposed diff (agent: builder)

- **Files:** `docs/ops/AUTH_SETTINGS.md`, `scripts/auth-config-snapshot.mjs` (GET `/v1/projects/{ref}/config/auth`
  only, secrets redacted before writing).
- **Depends on:** P2.2.
- **Acceptance:** the doc records the current Site URL, redirect allow-list, enabled providers and magic-link
  template (redacted), and proposes an **additive** diff:
  - add `https://themis.adeonanalytics.com/auth/callback` and `http://localhost:5173/auth/callback` to the redirect
    allow-list;
  - enable Google, or confirm it is already on (a project-wide effect);
  - change the magic-link template to neutral ADEON wording (or a `{{ if }}` on `.RedirectTo`). It is currently
    shared with Hephaestus, so its wording reaches Hephaestus users;
  - create two dedicated e2e users in the shared `auth.users`.

  Every item is marked "affects Hephaestus: yes/no".

- **Tenant data:** no. **Migration:** no.

**CHECKPOINT P2-AUTH — auth change on the shared project.** The operator approves four things:

- the P2.8 diff, covering redirect URLs, Google, and the template wording, which Hephaestus shares;
- the live apply of the P2.5 and P2.6 migrations;
- creating the two e2e users in shared `auth.users`;
- an answer to spec §10 Q5 on the email provider for invites (Resend proposed).

### P2.9 — Execute P2 live ops (agent: builder, operator-gated)

- **Files:** `scripts/gen-db-types.mjs` (Management API `GET /v1/projects/{ref}/types/typescript?included_schemas=themis`),
  `src/lib/db.types.ts` (generated), `package.json` (script `db:types`), `e2e/support/provision-users.mjs`
  (idempotent, admin API, `SUPABASE_SERVICE_ROLE_KEY` from env, test harness only), `BUILD_LOG.md`, `BRAIN.md`,
  `D:\projects\lss-platform\BRAIN.md` §5/§6 (auth-settings change only).
- **Depends on:** CHECKPOINT P2-AUTH approved, P2.7.
- **Acceptance:**
  - The snapshot pre → `db:apply --apply` (P2 files) → snapshot post → diff exits 0 outside `themis`.
  - The auth diff is applied exactly as approved, and a re-run of `auth-config-snapshot` shows only the approved
    delta.
  - Both e2e users exist, and running provisioning twice has no further effect.
  - `db.types.ts` is generated and typechecks.
  - Both brains are updated.
- **Tenant data:** YES (live). **Migration:** applies P2.5 and P2.6 live.

### P2.10 — Auth UI and session (agent: builder)

- **Files:** `src/features/auth/*` (`AuthProvider.tsx`, `SignIn.tsx`, `AuthCallback.tsx`, `useSession.ts`),
  `src/routes/*` (wiring only).
- **Depends on:** P2.9.
- **Acceptance:**
  - Magic link and "Continue with Google" both redirect to `${origin}/auth/callback`.
  - After the session is established, the client calls `bootstrap_me()` and navigates to `/w/:ws`.
  - Sign-out clears the session.
  - Reloading keeps the user signed in.
  - Auth errors (expired link, provider error) render a message, not a blank screen.
- **Tests (test-writer):** `src/features/auth/*.test.tsx` with the supabase client mocked.
- **Tenant data:** no. **Migration:** no.

### P2.11 — Workspaces, members and role gating UI (agent: builder)

- **Files:** `src/features/workspace/*` (`WorkspaceSwitcher.tsx`, `CreateWorkspace.tsx`, `Members.tsx`,
  `useRole.ts`), `src/lib/repo/workspaces.ts`.
- **Depends on:** P2.10. **∥** P2.13 (disjoint files).
- **Acceptance:**
  - A user can create a workspace (and becomes its owner), switch between workspaces, and view the member list.
  - Role change and remove are shown only to `admin|owner`, and call the P2.6 RPCs.
  - `useRole(ws)` drives what is visible. The server still enforces every rule: the UI hides actions, it does not
    authorise them.
- **Tests (test-writer):** unit tests for `useRole` gating per role.
- **Tenant data:** YES. **Migration:** no.

### P2.12 — Invites UI (and email if Q5 was answered) (agent: builder)

- **Files:** `src/features/workspace/Invites.tsx`, `src/routes/invite.tsx`; if Q5 was answered:
  `supabase/functions/themis-send-invite/index.ts`, `supabase/functions/_shared/cors.ts`.
- **Depends on:** P2.11.
- **Acceptance:**
  - An admin creates an invite and sees a copyable link `…/invite/<token>`. The token is never stored client-side
    after display.
  - `/invite/:token` asks the user to sign in if needed, then calls `accept_invite` and lands in the workspace.
  - A wrong email or expired invite gives a clear error.
  - If Q5 was answered, `themis-send-invite` emails the link. It needs `admin|owner`, verified against the caller's
    JWT, and its provider key is a `THEMIS_*` secret. If Q5 is still open, `BRAIN.md` §4 records it and invites
    stay copy-link only.
- **Tenant data:** YES. **Migration:** no.

### P2.13 — The P0 matrix becomes the first decision (agent: builder)

- **Files:** `src/lib/localDraft.ts` (localStorage key `themis.local.v1`), `src/App.tsx` (persist on change),
  `src/features/onboarding/ImportLocal.tsx`.
- **Depends on:** P2.10. **∥** P2.11.
- **Acceptance:**
  - Signed out, matrix edits persist across reloads in localStorage. This is essential storage, not tracking
    (spec §7.7).
  - On first sign-in with a non-empty local draft, the user is offered "Save as your first decision". It calls
    `import_local_decision` with a stable `client_import_id`, and the local draft is cleared only after success.
  - A refresh mid-import creates no duplicate.
  - The mapping uses the `decision.ts` types and computes nothing.
- **Tests (test-writer):** `src/lib/localDraft.test.ts` covers the round trip, a corrupt JSON → ignored, and
  version-key handling.
- **Tenant data:** YES. **Migration:** no.

### P2.14 — Live e2e: session, leak and roles (agent: test-writer)

- **Files:** `e2e/live/auth.spec.ts`, `e2e/live/tenancy.spec.ts`, `e2e/support/magic-link.ts` (admin
  `generateLink`, test harness only).
- **Depends on:** P2.11, P2.12, P2.13.
- **Acceptance** (all against the live project with the two e2e users):
  - sign-in via a generated magic link → the session persists after reload and after closing and reopening the
    context (storage state);
  - **cross-workspace leak:** UB opening UA's `/w/<A>` and a decision URL sees nothing. UB's direct PostgREST
    calls with its own JWT (`Accept-Profile: themis`) to A's rows return `[]`, and its writes affect 0 rows;
  - **role gating:** a viewer has no edit controls and a direct write is rejected; an editor cannot invite; an admin
    can invite but cannot remove the last owner;
  - the import flow creates exactly one decision.

  Specs clean up their own rows in `afterAll`.

- **Tenant data:** YES (tests). **Migration:** no.

### P2.QA — QA and validation (agent: qa)

- **QA exit gate:**
  1. `npm run lint && npm run typecheck && npm test && npm run build && npm run check:bundle` are green, and the
     bundle scan has 0 hits.
  2. `npm run db:gate` PASSED and `db:gate:prove-red` shows all sabotages RED, including the P2 sabotage.
  3. `npm run e2e` (local) is green, and **`npm run e2e:live` is green**: the cross-workspace leak e2e passes,
     role gating is proven in the UI and the API, and the session persists across reloads.
  4. `db:snapshot:diff` against the P2.9 `pre` snapshot shows no change outside `themis`. The Hephaestus
     `npm test` and its RLS e2e are still green.
  5. The shared auth config equals the approved P2.8 diff and nothing more (`auth-config-snapshot`).
  6. The deployed site, signed out, still serves the working P0 matrix (the regression check).
- **Depends on:** all P2 build tasks.

### P2.REVIEW — Quality review (agent: reviewer)

- **Depends on:** P2.QA = VALIDATED. **Rubric:** CLAUDE.md §6.

**CHECKPOINT P2 — phase gate.**

---

## Phase P3: Core slice — persisted decisions and the AI analyst

Delivers decisions saved per workspace, edited with the P0 matrix, and the `themis-ai-analyst` Edge Function. The
function covers four kinds: challenge, missing criteria, stress-test and explain. It enforces quotas and the €
cost ceiling server-side, records every run in `ai_runs`, and accepts suggestions into the matrix with one click.

### P3.1 — Matrix components extracted (agent: builder)

- **Files:** `src/features/matrix/*` (`FrameStep.tsx`, `WeighStep.tsx`, `ScoreTable.tsx`, `Recommendation.tsx`,
  `useMatrix.ts`), `src/App.tsx` (composes them).
- **Depends on:** P2 claimed.
- **Acceptance:** this is a pure refactor.
  - The signed-out `/` looks and behaves as before, and the 16 original tests pass unchanged.
  - The components take `{criteria, options, scores, onChange}` so they can be driven by local or persisted state.
  - No component computes a score: every result comes from `decision.ts`.
- **Tenant data:** no. **Migration:** no.

### P3.2 — Migration: plan limits and the AI quota ledger (agent: builder)

- **Files:** `supabase/migrations/<ts>_themis_limits_quota.sql`.
- **Depends on:** P2 claimed. **∥** P3.1.
- **Acceptance:**
  - **`themis.effective_plan(ws)`** reads `subscriptions` for active or trialing status, and falls back to `free`.
  - **Active-decision limit.** A `before insert` trigger on `decisions` (for non-archived decisions) raises
    `plan_limit_decisions` once the plan's `active_decisions` limit is reached (3 on Free).
  - **`themis.consume_ai_run(ws, kind, est_cost_eur)`** has EXECUTE for **`service_role` only**.
    - It locks the `usage_monthly` row (`for update`) for the current UTC month.
    - It denies with `quota_runs` once `ai_runs ≥ ai_runs_month` (or `ai_runs_per_seat × seats` on Team), and
      denies with `cost_ceiling` once `ai_cost_eur + est ≥ ai_cost_ceiling_eur`.
    - Otherwise it reserves the run and returns a reservation id.
  - **`themis.settle_ai_run(reservation, actual_cost_eur, ok bool)`** is service_role only. It corrects the cost,
    and releases the run count when `ok=false`.
- **Tenant data:** YES. **Migration:** yes.

### P3.3 — Gate extension for limits and quota (agent: test-writer)

- **Files:** `scripts/db-gate.mjs`, `scripts/db-gate-prove-red.mjs`.
- **Depends on:** P3.2.
- **Acceptance:**
  - A 4th active decision on Free → rejected. Archiving one then allows another.
  - At quota, `consume_ai_run` denies with `quota_runs`. Just under quota but over the € ceiling, it denies with
    `cost_ceiling`.
  - A failed settle releases the run.
  - `authenticated` and `anon` cannot EXECUTE `consume_ai_run` or `settle_ai_run`.
  - The usage rows of workspace B are untouched by A's runs.
  - New sabotage: grant EXECUTE on `consume_ai_run` to authenticated → RED.
- **Tenant data:** YES (tests). **Migration:** no.

### P3.4 — Persisted decisions: repository and pages (agent: builder)

- **Files:** `src/lib/repo/decisions.ts`, `src/features/decisions/*` (`DecisionList.tsx`, `DecisionEditor.tsx`),
  `src/routes/*` (wiring).
- **Depends on:** P3.1, and P3.2 applied locally in the gate.
- **Acceptance:**
  - `/w/:ws/decisions` lists decisions and can create one from a method × scale preset (`presetCriteria`). The
    `plan_limit_decisions` error renders as an upgrade prompt, not a crash.
  - `/w/:ws/d/:id` loads the decision graph and edits it via the P3.1 components, with debounced saves.
    `created_by` and `updated_at` are displayed per row.
  - A viewer gets a read-only editor.
  - No scoring math appears outside `decision.ts`: `grep` finds no weighted-sum code in `src/features/**`.
- **Tests (test-writer):** repository mapping tests (DB rows ↔ `decision.ts` types) and editor tests with the
  client mocked.
- **Tenant data:** YES. **Migration:** no.

### P3.5 — Model configuration and ADR-0004 (agent: builder)

- **Files:** `supabase/functions/_shared/models.ts`, `DECISIONS.md` (ADR-0004), `eslint.config.js` (confirm the
  `supabase/functions/**` exemption; no rule change beyond that).
- **Depends on:** P2 claimed. **∥** P3.1, P3.2.
- **Acceptance:**
  - One file pins `DEFAULT_MODEL = 'claude-sonnet-5'` and `DEEP_MODEL = 'claude-opus-5-5'` (Team only), with the
    per-million-token input and output prices in EUR.
  - The ids and prices are **confirmed against the current Claude API reference at build time**. The URL and date
    go in ADR-0004, which also records the secret name `THEMIS_ANTHROPIC_API_KEY` and the rule that customer data
    goes to Anthropic only when the user runs the analyst.
- **Tenant data:** no. **Migration:** no.

### P3.6 — Analyst core: pure and unit-testable (agent: builder)

- **Files:** `supabase/functions/_shared/analyst/{snapshot,prompt,schema,cost,guard}.ts`. These are plain TS with
  no Deno or remote imports, so Vitest can import them.
- **Depends on:** P3.5.
- **Acceptance:**
  - **`snapshot.ts`** builds the input snapshot: question, method, scale, criteria, options, scores, plus
    `rank()`/`verdict()` **imported from `src/lib/decision.ts` by relative path**. It contains no copy of the math.
  - **`prompt.ts`** has one template per kind (`challenge`, `missing_criteria`, `stress_test`, `explain`).
  - **`schema.ts`** validates the model's structured JSON output. It rejects unknown fields and out-of-range values.
  - **`cost.ts`** computes € from tokens × the pinned prices.
  - **`guard.ts`** checks that the output does not name a winner when the verdict is `incomplete`/`close`, and
    strips and flags any such claim.
- **Tests (test-writer):** `supabase/functions/_shared/analyst/*.test.ts` in Vitest. They cover:
  - the prompt contains every criterion and option;
  - the schema rejects malformed output;
  - cost arithmetic;
  - the guard blocks a "winner" on a close call;
  - the snapshot's ranking equals `rank()` for the same fixture.
- **Tenant data:** no. **Migration:** no.

### P3.7 — `themis-ai-analyst` Edge Function (agent: builder)

- **Files:** `supabase/functions/themis-ai-analyst/index.ts`, `supabase/functions/themis-ai-analyst/handler.ts`
  (dependency-injected: `db`, `anthropicFetch`, `now`), `supabase/functions/_shared/cors.ts`,
  `supabase/config.toml` (`[functions.themis-ai-analyst] verify_jwt = true` only; there is **no** `[db]`
  migration use).
- **Depends on:** P3.6, P3.2.
- **Acceptance:** the request flow runs in this order.
  1. **Authorise.** A JWT is required. The decision is loaded through a **user-scoped client**, so RLS decides
     access. `editor+` is required. `deep` mode requires the Team plan.
  2. **Reserve BEFORE the model call.** The function calls `consume_ai_run` with the service role. A denial returns
     402 `{code:'quota_runs'|'cost_ceiling', remaining}`, **and the model is never called**.
  3. **Call Anthropic.** The key is `THEMIS_ANTHROPIC_API_KEY`, the timeout is 60 s and structured output is
     requested. A timeout, 5xx or 529 returns 503 `{code:'provider_down'}`, and `settle_ai_run(ok=false)` releases
     the run.
  4. **Record the run.** The function inserts `ai_runs` with `input_snapshot`, `model`, `output`, tokens, `cost_eur`
     and `status`, then settles with the actual cost.
  5. **CORS** allows only `https://themis.adeonanalytics.com` and `http://localhost:5173`.

  `deno check supabase/functions/themis-ai-analyst/index.ts` passes, and the relative import of
  `src/lib/decision.ts` resolves in the deploy bundle. This is verified with `supabase functions serve` locally. If
  bundling cannot reach `src/`, the builder records BLOCKED rather than copying the math.

- **Tenant data:** YES (`ai_runs`, `usage_monthly`). **Migration:** no.

### P3.8 — Analyst handler tests (agent: test-writer)

- **Files:** `supabase/functions/themis-ai-analyst/handler.test.ts`.
- **Depends on:** P3.7.
- **Acceptance** (Vitest with fakes):
  - **happy path:** a run is recorded with a snapshot and cost;
  - **quota exceeded:** 402, and `anthropicFetch` is called **0 times**;
  - **cost ceiling:** 402;
  - **provider down:** timeout or 529 → 503, the reservation is released, and `ai_runs.status='failed'` with cost 0;
  - **malformed model output:** 502, with no accepted suggestions stored;
  - **viewer:** 403;
  - **deep mode on Pro:** 403;
  - **decision in another workspace:** 404, via RLS.
- **Tenant data:** YES (tests). **Migration:** no.

### P3.9 — Analyst panel UI and one-click accept (agent: builder)

- **Files:** `src/features/analyst/*` (`AnalystPanel.tsx`, `SuggestionCard.tsx`, `useAnalyst.ts`),
  `src/lib/repo/aiRuns.ts`.
- **Depends on:** P3.4, P3.7.
- **Acceptance:**
  - The panel has four actions and shows the remaining quota. Output is labelled **"AI analyst — advisory"** and
    shows the inputs it cited.
  - "Accept" applies a suggestion (for example, adding a missing criterion with its proposed weight) through the
    normal repository write, and appends to `ai_runs.accepted`. "Dismiss" is recorded too. **Nothing is applied
    without a click.**
  - 402 shows an upgrade or quota message, and 503 shows "the analyst is unavailable, your decision is unaffected".
  - The replaced roadmap card on `/` stays accurate for signed-out users.
- **Tests (test-writer):** component tests for the accept/dismiss writes and the 402/503 rendering.
- **Tenant data:** YES. **Migration:** no.

### P3.10 — e2e for the core slice (agent: test-writer)

- **Files:** `e2e/local/analyst.spec.ts` (function mocked with `page.route`), `e2e/live/decisions.spec.ts`,
  `e2e/live/analyst.spec.ts`.
- **Depends on:** P3.9.
- **Acceptance:**
  - **Local:** the happy path accepts a suggestion into the matrix; quota-exceeded shows the message; provider-down
    shows the message; no console errors (a `page.on('console')` assertion).
  - **Live (runs after P3.11):** create, edit and reload a decision, and it persists. One real `explain` run is
    recorded in `ai_runs` with cost > 0. A 4th decision on Free is refused. Leak: UB cannot run the analyst on A's
    decision (404).
- **Tenant data:** YES (tests). **Migration:** no.

**CHECKPOINT P3-KEY — before the Anthropic key is used.** The operator:

- places the Anthropic API key in the Zeus Vault and sets it as the Edge secret `THEMIS_ANTHROPIC_API_KEY`
  (the operator does this; the crew never sees the value);
- approves deploying `themis-ai-analyst` to the shared project and applying P3.2 live;
- answers spec §10 Q6 (repo visibility before business logic lands), which is recommended here.

### P3.11 — Execute P3 live ops (agent: builder, operator-gated)

- **Files:** `BUILD_LOG.md`, `BRAIN.md`, `src/lib/db.types.ts` (regenerated).
- **Depends on:** CHECKPOINT P3-KEY approved, P3.3, P3.8.
- **Acceptance:**
  - The snapshot pre → `db:apply --apply` → snapshot post → diff is clean outside `themis`.
  - `supabase functions deploy themis-ai-analyst --project-ref $THEMIS_SUPABASE_PROJECT_REF` is run by explicit
    name only, never a bare `deploy`. Before it, `supabase functions list` is compared against the name, and the
    deploy is refused if the name exists as a non-Themis function.
  - An unauthenticated call → 401, and an OPTIONS call from a disallowed origin → no CORS allow.
- **Tenant data:** YES (live). **Migration:** applies P3.2 live.

### P3.12 — Measure the real per-run cost and propose revised quotas (agent: builder)

- **Files:** `scripts/measure-ai-cost.mjs`, `docs/pricing/ai-cost-p3.md`.
- **Depends on:** P3.11.
- **Acceptance:**
  - The script makes at least 24 real runs on a dedicated test workspace: 4 kinds × 2 decision sizes (3×5 and
    6×10) × default model, plus 4 kinds × 1 size × deep model.
  - It reads tokens and `cost_eur` back from `ai_runs`, and the doc reports the mean, p95 and max € per run per
    kind and model.
  - It proposes the Free/Pro/Team run quotas and the per-workspace € ceilings, with the gross margin at the §4
    proposal prices. If the margin does not hold, the doc says so plainly.
  - The proposal is **not** applied. It feeds CHECKPOINT P4-PRICING.
- **Tenant data:** YES (test workspace). **Migration:** no.

### P3.QA — QA and validation (agent: qa)

- **QA exit gate:**
  1. Lint, typecheck, `npm test` (including the analyst core and handler tests), build and `check:bundle` are green.
     The bundle scan finds no `sk-ant-` or `THEMIS_ANTHROPIC`.
  2. `db:gate` PASSED and `db:gate:prove-red` is all RED.
  3. The analyst is tested for the **happy path, quota exceeded (model called 0 times), cost ceiling, and provider
     down (reservation released)**. qa also re-runs the provider-down case live by temporarily pointing a test
     request at an unreachable model id through a test-only header that is disabled in production, **or** records
     why it relied on the fake.
  4. `npm run e2e` and `npm run e2e:live` are green, with **no console errors** on the decision and analyst pages.
  5. The recommendation shown in the UI and the snapshot's ranking both come from `decision.ts`. qa greps for any
     second implementation.
  6. The real per-run cost is measured (P3.12), and the doc exists with the raw numbers from `ai_runs`.
  7. The live snapshot diff is clean outside `themis`, and the Hephaestus suite is green.
- **Depends on:** all P3 build tasks.

### P3.REVIEW — Quality review (agent: reviewer)

- **Depends on:** P3.QA = VALIDATED. **Rubric:** CLAUDE.md §6.

**CHECKPOINT P3 — phase gate.** The summary includes the P3.12 cost report.

---

## Phase P4: Breadth — SWOT, Risk, report, approvals and billing

Delivers SWOT (with an AI draft), the risk register with a heat map and a risk-adjusted score, the executive PDF,
comments, approve/reject and frozen revisions with the audit log, and Stripe billing in **test mode**. All of it
follows the proven P3 pattern.

### P4.1 — Risk math in `decision.ts` (agent: builder)

- **Files:** `src/lib/decision.ts`, `src/lib/decision.test.ts`.
- **Depends on:** P3 claimed.
- **Acceptance:**
  - `riskExposure(likelihood, impact)` returns 1–25.
  - `optionRiskExposure(risks)` is defined.
  - `riskAdjustedScore(ranked, risks)` returns a value **alongside** the raw `score`, never replacing it.
  - The existing `verdict()` is unchanged, and all existing tests pass unchanged.
  - New tests cover boundaries (1×1, 5×5, no risks → equals raw).
- **Tenant data:** no. **Migration:** no.

### P4.2 — Migration: lifecycle, frozen revisions and audit (agent: builder)

- **Files:** `supabase/migrations/<ts>_themis_lifecycle_audit.sql`.
- **Depends on:** P3 claimed. **∥** P4.1.
- **Acceptance:**
  - **Status RPCs.** `submit_for_review` (editor+), `approve(decision, reason)` and `reject(decision, reason)`
    (admin|owner only), `archive` and `new_revision`.
  - **Transitions.** Only `draft→in_review→approved|rejected→archived` is allowed.
  - **Approve** sets `frozen=true`, `approved_by` and `approved_at`, and inserts into `approvals`.
  - **`new_revision`** copies the whole graph (options, criteria, scores, SWOT, risks) into a new row with the same
    `lineage_id`, `revision+1` and status `draft`.
  - **Frozen means immutable.** Triggers on `decisions` and every child table raise `decision_frozen` on
    insert/update/delete when the parent is frozen.
  - **Audit.** Triggers write `audit_log(before, after, actor=auth.uid())` for every status change, approval and
    revision, and for membership role changes.
- **Tenant data:** YES. **Migration:** yes.

### P4.3 — Gate extension for the lifecycle (agent: test-writer)

- **Files:** `scripts/db-gate.mjs`, `scripts/db-gate-prove-red.mjs`.
- **Depends on:** P4.2.
- **Acceptance:**
  - An editor cannot approve.
  - A frozen decision rejects score, option, criterion, SWOT and risk writes.
  - `new_revision` copies the graph exactly (row counts and values), and the old revision stays readable.
  - Audit rows exist with the correct actor.
  - An illegal transition is rejected.
  - Every RPC called on B's decision by UA has no effect.
  - New sabotage: drop the frozen trigger on `scores` → RED.
- **Tenant data:** YES (tests). **Migration:** no.

### P4.4 — SWOT module (agent: builder)

- **Files:** `src/features/swot/*`, `src/lib/repo/swot.ts`.
- **Depends on:** P4.2 (applied in the gate). **∥** P4.5, P4.7 (disjoint files).
- **Acceptance:**
  - There is a 2×2 editor per decision and per option. Items are stored as separate rows and show their author and
    time.
  - It is read-only when the decision is frozen or the user is a viewer.
- **Tests (test-writer):** component and repository tests.
- **Tenant data:** YES. **Migration:** no.

### P4.5 — Risk register and heat map (agent: builder)

- **Files:** `src/features/risk/*` (`RiskRegister.tsx`, `HeatMap.tsx`), `src/lib/repo/risks.ts`.
- **Depends on:** P4.1, P4.2. **∥** P4.4, P4.7.
- **Acceptance:**
  - Risks can be edited per option: likelihood and impact 1–5, owner, mitigation.
  - The 5×5 heat map shows counts **and** text labels, so it does not rely on colour alone (the P5 a11y
    groundwork).
  - The recommendation panel shows the risk-adjusted score **next to** the raw score, from `decision.ts`.
- **Tests (test-writer):** component tests, including "the raw score is still shown".
- **Tenant data:** YES. **Migration:** no.

### P4.6 — AI SWOT draft (agent: builder)

- **Files:** `supabase/functions/_shared/analyst/{prompt,schema}.ts` (new kind `swot_draft`),
  `src/features/swot/SwotDraft.tsx`.
- **Depends on:** P4.4.
- **Acceptance:**
  - `swot_draft` goes through the same quota and ledger as the P3 kinds.
  - Each drafted item is accepted or dismissed **individually**, and accepted items become ordinary `swot_items`
    recorded in `ai_runs.accepted`.
- **Tests (test-writer):** extend the analyst core and handler tests for the new kind.
- **Tenant data:** YES. **Migration:** no.

### P4.7 — Comments, approvals and revision history UI (agent: builder)

- **Files:** `src/features/review/*` (`Comments.tsx`, `ApprovalBar.tsx`, `RevisionHistory.tsx`),
  `src/lib/repo/review.ts`.
- **Depends on:** P4.2. **∥** P4.4, P4.5.
- **Acceptance:**
  - Any member can comment.
  - Submit, approve and reject with a mandatory reason. Approve and reject are shown to `admin|owner` only.
  - An approved decision shows a frozen badge and a "Start new revision" action.
  - Revision history lists every revision with its approver and time, and old revisions open read-only.
- **Tests (test-writer):** component tests per role.
- **Tenant data:** YES. **Migration:** no.

### P4.8 — Executive report PDF (agent: builder)

- **Files:** `package.json` (one client-side PDF library, with the choice recorded in `DECISIONS.md` together with
  its bundle-size impact), `src/features/report/*` (`reportModel.ts`, `ReportPdf.tsx`, `ExportButton.tsx`),
  `src/features/workspace/LogoUpload.tsx` (stores a data URL in `themis.workspaces.logo_data_url`, ≤ 100 KB, Team
  only).
- **Depends on:** P4.4, P4.5, P4.7.
- **Acceptance:**
  - The PDF is built entirely client-side from `reportModel.ts`, which is a pure function of the decision data plus
    `decision.ts` results.
  - **Contents:** question, recommendation, ranking, weights, SWOT, the top 5 risks by exposure, accepted AI
    points (from `ai_runs.accepted`, labelled AI), approvals with name and time, revision, and date.
  - **Honest verdict:** when the verdict is incomplete or close, the report says so and names no winner.
  - **By plan:** Free adds the footer "Made with Themis", Pro is clean, and Team is clean with the workspace logo.
- **Tests (test-writer):** `reportModel.test.ts` checks contents per plan, the honest verdict, and that accepted
  versus dismissed AI points are separated. A smoke test checks that the PDF generates non-empty bytes.
- **Tenant data:** YES (reads). **Migration:** no.

**CHECKPOINT P4-PRICING — pricing confirmed.** The operator confirms or changes spec §4 using the P3.12 cost
report: prices, run quotas, € ceilings, Team minimum seats, and the annual discount. This answers spec §10 Q2.
No Stripe product or price is created before this.

### P4.9 — Migration: confirmed plan values, Stripe event ledger and downgrade read-only (agent: builder)

- **Files:** `supabase/migrations/<ts>_themis_billing.sql`.
- **Depends on:** CHECKPOINT P4-PRICING approved.
- **Acceptance:**
  - `plans` is updated to the confirmed values in a new migration, with no edit to P1.7.
  - `themis.stripe_events(event_id pk, type, created_at_stripe, received_at, processed_at)` has RLS enabled,
    no policies and no client grants.
  - `apply_subscription(...)` has EXECUTE for service_role only. It ignores an event older than the one already
    applied, by comparing Stripe `created`.
  - **Downgrades never delete.** `themis.decision_writable(decision_id)` returns false for a decision beyond the
    plan's active-decision limit (ordered by `created_at`), and every write policy on decisions and their children
    includes it.
- **Tenant data:** YES. **Migration:** yes.

### P4.10 — Stripe test-mode catalogue (agent: builder)

- **Files:** `scripts/stripe-setup.mjs` (reads `THEMIS_STRIPE_SECRET_KEY` from env; refuses a `sk_live_` key unless
  `--live`), `docs/ops/STRIPE.md`.
- **Depends on:** CHECKPOINT P4-PRICING approved. **∥** P4.9.
- **Acceptance:**
  - The script idempotently creates Products and Prices with `lookup_key`s (`pro_monthly`, `pro_annual`,
    `team_monthly`, `team_annual`) and `tax_behavior` set, in TEST mode.
  - The Customer Portal configuration is created.
  - Stripe Tax is enabled for the seller ADEON Analytics I.K.E. (GR).
  - A second run creates nothing.
  - The code references prices only by lookup key, never by price id.
- **Tenant data:** no. **Migration:** no.

### P4.11 — `themis-billing` function: Checkout and Portal (agent: builder)

- **Files:** `supabase/functions/themis-billing/{index,handler}.ts`, `supabase/config.toml` (function entry).
- **Depends on:** P4.9, P4.10.
- **Acceptance:**
  - `admin|owner` only.
  - Each workspace gets or creates exactly one Stripe customer, with `metadata.workspace_id` set.
  - Checkout uses `automatic_tax`, seat `quantity ≥ min_seats` for Team, success and cancel URLs on the allowed
    origin, and `client_reference_id = workspace_id`.
  - A Portal session is available.
- **Tests (test-writer):** handler tests with a Stripe fake cover role enforcement, the Team seat minimum and
  customer reuse.
- **Tenant data:** YES. **Migration:** no.

### P4.12 — `themis-stripe-webhook`: verified and idempotent (agent: builder)

- **Files:** `supabase/functions/themis-stripe-webhook/{index,handler}.ts`, `supabase/config.toml`
  (`verify_jwt = false` for this function only).
- **Depends on:** P4.9.
- **Acceptance:**
  1. **Verify.** The raw body is verified with `THEMIS_STRIPE_WEBHOOK_SECRET` (`constructEventAsync`). An invalid
     signature returns 400 with **no DB write**.
  2. **Record the id first.** `event.id` is inserted into `stripe_events` **before anything else happens**. On
     conflict the function returns 200 and does nothing more.
  3. **Handle.** It handles `checkout.session.completed`, `customer.subscription.created|updated|deleted` and
     `invoice.payment_failed`, via `apply_subscription`, then sets `processed_at`.
- **Tenant data:** YES. **Migration:** no.

### P4.13 — Webhook idempotency and billing proofs (agent: test-writer)

- **Files:** `supabase/functions/themis-stripe-webhook/handler.test.ts`, `scripts/db-gate.mjs` (billing checks),
  `e2e/live/billing.spec.ts`.
- **Depends on:** P4.11, P4.12.
- **Acceptance:**
  - **Handler tests:**
    - a bad signature → 400 with 0 writes;
    - **the same event delivered twice → exactly one `subscriptions` change and one `stripe_events` row**;
    - out-of-order `updated` events → the newest wins;
    - `deleted` → the Free plan applies and the over-limit decisions become read-only with **0 rows deleted**.
  - **Gate:** `stripe_events` is invisible to UA, UB and anon, and `decision_writable` is enforced by RLS.
  - **Live e2e, test mode:** a checkout with test card 4242 → the webhook → Pro is active in the UI, and the analyst
    quota reflects Pro. A replay through `stripe events resend <id>` produces no second effect.
- **Tenant data:** YES (tests). **Migration:** no.

### P4.14 — Billing and plan UI (agent: builder)

- **Files:** `src/features/billing/*` (`PlanPage.tsx`, `UsageMeter.tsx`, `OverLimitBanner.tsx`),
  `.env.example` (`VITE_STRIPE_PUBLISHABLE_KEY` name).
- **Depends on:** P4.11.
- **Acceptance:**
  - The plan page shows plans from `themis.plans`, not hard-coded.
  - Upgrade goes to Checkout, and "Manage billing" goes to the Portal.
  - A usage meter shows runs and € ceiling headroom.
  - Over-limit decisions show a read-only banner explaining why.
- **Tests (test-writer):** component tests.
- **Tenant data:** YES (reads). **Migration:** no.

**CHECKPOINT P4-APPLY — live apply and deploy.** The operator approves four things:

- applying P4.2 and P4.9 to the shared project;
- deploying `themis-billing` and `themis-stripe-webhook`;
- setting the **test-mode** `THEMIS_STRIPE_SECRET_KEY` and `THEMIS_STRIPE_WEBHOOK_SECRET`;
- registering the test-mode webhook endpoint.

### P4.15 — Execute P4 live ops (agent: builder, operator-gated)

- **Files:** `BUILD_LOG.md`, `BRAIN.md`, `src/lib/db.types.ts`.
- **Depends on:** CHECKPOINT P4-APPLY approved, P4.3, P4.13 (unit and gate parts).
- **Acceptance:**
  - The snapshot pre → apply → post → diff is clean outside `themis`.
  - Functions are deployed by explicit name only.
  - `stripe-setup.mjs` is run in test mode.
  - `redeploy themis-ai-analyst` picks up the `swot_draft` kind.
  - Then the live e2e from P4.13 is run.
- **Tenant data:** YES (live). **Migration:** applies P4.2 and P4.9 live.

### P4.QA — QA and validation (agent: qa)

- **QA exit gate:**
  1. Every module (SWOT, Risk plus heat map, report, comments and approvals plus revisions, billing) has unit tests,
     and they are green.
  2. **Isolation is checked per module.** `db:gate` has leak entries for every table and RPC touched in P4, and
     `db:gate:prove-red` is all RED (including the frozen and billing sabotages).
  3. **The webhook idempotency test passes.** A duplicate delivery gives one effect, and a bad signature gives zero
     writes. This is proven both in unit tests and live in test mode with `stripe events resend`.
  4. **Regression:** all P1–P3 tests, the gates, `e2e` and `e2e:live` are green. The P0 signed-out matrix still
     works.
  5. The report for a close-call decision names no winner. A Free report has the footer, and a Team report has the
     logo.
  6. Lint, typecheck, build and `check:bundle` are green, with no `sk_test_` or `whsec_` in `dist`.
  7. The live snapshot diff is clean outside `themis`, and the Hephaestus suite is green.
- **Depends on:** all P4 build tasks.

### P4.REVIEW — Quality review (agent: reviewer)

- **Depends on:** P4.QA = VALIDATED. **Rubric:** CLAUDE.md §6.

**CHECKPOINT P4 — phase gate.**

---

## Phase P5: Hardening

Delivers product-grade states everywhere, fleet telemetry, self-serve export and deletion (GDPR), legal pages,
WCAG 2.2 AA, and full e2e coverage.

### P5.1 — Empty, loading and error states (agent: builder)

- **Files:** `src/components/states/*` (`Empty.tsx`, `Loading.tsx`, `ErrorState.tsx`), plus usage edits in
  `src/features/**`, limited to swapping in these components.
- **Depends on:** P4 claimed.
- **Acceptance:**
  - Every route and panel has an explicit empty state, a loading skeleton, and an error state with a retry. The
    routes and panels are: decision list, editor, analyst, SWOT, risk, review, billing, members, invites.
  - A checklist table in the PR description lists each one.
  - An error boundary sits at the route level.
  - When the session expires, the user is sent to `/signin` and returned afterwards.
- **Tests (test-writer):** a component test per state kind.
- **Tenant data:** no. **Migration:** no.

### P5.2 — Fleet telemetry (agent: builder)

- **Files:** `src/lib/telemetry.ts` (the fleet-telemetry TS port, copied from `lss-platform`), `src/main.tsx`
  (guarded init), `.env.example` (the `VITE_FLEET_*` names), `eslint.config.js` (add the `VITE_FLEET_*` names to
  the allow-list), `BRAIN.md` §8 header.
- **Depends on:** P4 claimed. **∥** P5.1, P5.3.
- **Acceptance:**
  - `window.onerror` and `onunhandledrejection` report errors, and **secrets and PII are scrubbed before send**
    (emails, JWTs, tokens).
  - With an empty product id, telemetry is a no-op.
  - Registering the Zeus `fleet_products` row is noted as a Zeus-side step for the operator.
- **Tests (test-writer):** scrubber tests.
- **Tenant data:** no. **Migration:** no.

### P5.3 — Self-serve export and account deletion (agent: builder)

- **Files:** `supabase/migrations/<ts>_themis_gdpr.sql` (`export_my_data()` for authenticated; the deletion
  function is service-role only), `supabase/functions/themis-delete-account/{index,handler}.ts`,
  `src/features/account/*`.
- **Depends on:** P4 claimed. **∥** P5.2.
- **Acceptance:**
  - **Export** downloads JSON with every Themis row the user authored, plus the workspaces they own, with all child
    data.
  - **Delete removes Themis data only.** It removes `themis.profiles`, the memberships, and the workspaces where the
    user is the sole owner, with their data. Ownership of shared workspaces must be transferred first, or the
    deletion is blocked.
  - **It does NOT delete `auth.users`.** That identity is shared with Hephaestus, and the UI explains this. Full
    identity deletion is a decision for CHECKPOINT P5-LEGAL.
  - Active subscriptions are cancelled through Stripe before deletion.
- **Tests (test-writer):** gate checks cover export returning only the caller's data and deletion leaving other
  workspaces and Hephaestus `public` untouched. Handler tests cover the sole-owner block and the Stripe cancel.
- **Tenant data:** YES. **Migration:** yes.

### P5.4 — Legal pages (drafts for counsel) (agent: builder)

- **Files:** `src/features/legal/*` (`Terms.tsx`, `Privacy.tsx`, `SubProcessors.tsx`, `Imprint.tsx`),
  `public/legal/themis-dpa.pdf` or a `Dpa.tsx` route, `src/routes/*`.
- **Depends on:** P5.3. **∥** P5.5.
- **Acceptance:**
  - The pages name the seller **ADEON Analytics I.K.E. (Greece)** and state:
    - EU data residency (Supabase eu-west-1);
    - Anthropic is used only when the user runs the analyst, and API data is not used for training;
    - no tracking cookies, only essential auth storage and the local draft;
    - the sub-processors: Supabase, Anthropic, Stripe, GitHub Pages and the email provider (if chosen);
    - the export and deletion paths, including the shared ADEON login.
  - A DPA is offered for Team.
  - Every page carries a visible **"Draft — pending legal review"** banner.
- **Tenant data:** no. **Migration:** no.

### P5.5 — Accessibility to WCAG 2.2 AA (agent: builder)

- **Files:** `package.json` (devDep `@axe-core/playwright`), a11y fixes in `src/**` (limited to ARIA, focus,
  contrast tokens in `src/index.css`, and keyboard handlers).
- **Depends on:** P5.1. **∥** P5.4.
- **Acceptance:**
  - Every flow can be completed by keyboard alone, with focus visible and managed on route change and in dialogs.
  - Contrast is ≥ 4.5:1 for text, with the gold-on-black tokens measured and recorded.
  - The heat map and verdict are not conveyed by colour only.
  - Form errors are announced.
  - The target size is ≥ 24×24 (WCAG 2.2).
- **Tenant data:** no. **Migration:** no.

**CHECKPOINT P5-LEGAL — legal text reviewed by the operator's counsel.** Counsel reviews Terms, Privacy, the DPA
and the sub-processor list. The operator also rules on the scope of account deletion, given the identity shared
with Hephaestus.

### P5.6 — Apply counsel's edits (agent: builder)

- **Files:** `src/features/legal/*`, `public/legal/*`.
- **Depends on:** CHECKPOINT P5-LEGAL approved.
- **Acceptance:**
  - The counsel-approved text is in place verbatim, and the draft banners are removed.
  - The approval date is recorded in `DECISIONS.md`.
  - If the operator ruled that auth identity is deleted too, a follow-up task is logged. It is not improvised here.
- **Tenant data:** no. **Migration:** no.

### P5.7 — Full e2e and a11y suite (agent: test-writer)

- **Files:** `e2e/local/*.spec.ts`, `e2e/live/*.spec.ts`, `e2e/support/axe.ts`.
- **Depends on:** P5.1–P5.6.
- **Acceptance:**
  - Every flow has an e2e spec: signed-out matrix → sign-in → import; workspace, invite and roles; decision CRUD;
    the analyst (success, 402, 503); SWOT and the AI draft; risk and the heat map; report download; submit,
    approve, freeze and new revision; checkout (test mode); export; delete.
  - **axe runs on every route** with 0 serious or critical violations.
  - **Error states are exercised, not just written.** `page.route` forces 500s, offline mode and an expired session
    on the list, editor, analyst and billing pages, and each spec asserts that the error UI and the retry recover.
  - No console errors across the suite.
- **Tenant data:** YES (tests). **Migration:** no.

**CHECKPOINT P5-APPLY — live apply of the P5.3 migration and the `themis-delete-account` deploy.** This combines
the §5a.6 operator go with the live ops below.

### P5.8 — Execute P5 live ops (agent: builder, operator-gated)

- **Files:** `BUILD_LOG.md`, `BRAIN.md`, `src/lib/db.types.ts`.
- **Depends on:** CHECKPOINT P5-APPLY approved.
- **Acceptance:**
  - The snapshot pre → apply → post → diff is clean outside `themis`.
  - `themis-delete-account` is deployed by name.
  - The telemetry `VITE_FLEET_*` values are set as GitHub Actions variables, and a deliberate test error from the
    deployed site lands on the Zeus dashboard and is then resolved.
- **Tenant data:** YES (live). **Migration:** applies P5.3 live.

### P5.QA — QA and validation (agent: qa)

- **QA exit gate:**
  1. **The full e2e suite is green** (`npm run e2e` and `npm run e2e:live`).
  2. **axe is clean**, with 0 serious or critical violations on every route. qa also does a manual keyboard-only
     pass through the core flow and records it.
  3. **Error states are exercised.** qa re-runs the forced-failure specs and additionally kills the network mid-save
     in a headed run, recording what it observed.
  4. Export returns only the caller's data. Delete leaves other workspaces and Hephaestus untouched: the snapshot
     diff is clean and the Hephaestus suite is green.
  5. A telemetry test error from the deployed site is visible on the Zeus dashboard.
  6. The legal pages carry the counsel-approved text, and there are no draft banners.
  7. There are no cookies other than essential ones: qa inspects storage on the deployed site.
  8. All gates, unit tests, lint, typecheck, build and `check:bundle` are green.
- **Depends on:** all P5 build tasks.

### P5.REVIEW — Quality review (agent: reviewer)

- **Depends on:** P5.QA = VALIDATED. **Rubric:** CLAUDE.md §6.

**CHECKPOINT P5 — phase gate.**

---

## Phase P6: Launch

Delivers the production configuration on `themis.adeonanalytics.com`, a public landing and pricing page with
support contact, Stripe **live**, and a real refunded purchase. There is no separate "production Supabase": the
shared `lss-platform` project IS production (ADR-0002).

### P6.1 — Production configuration audit (agent: builder)

- **Files:** `docs/ops/PRODUCTION.md`, `.github/workflows/deploy.yml` (build-time `VITE_*` from Actions
  _variables_, never secrets-in-code).
- **Depends on:** P5 claimed.
- **Acceptance:**
  - The doc records the live values, by name and source, for:
    - the domain `themis.adeonanalytics.com` (ADR-0003; HTTPS enforced);
    - the auth redirect list entry for the production callback;
    - the CORS allow-list in every `themis-*` function;
    - every `VITE_*` in the build;
    - every `THEMIS_*` Edge secret, by name.
  - The spec's `app.adeon-themis.com` is recorded as superseded by ADR-0003.
- **Tenant data:** no. **Migration:** no.

### P6.2 — Landing, pricing and support (agent: builder)

- **Files:** `src/features/marketing/*` (`Landing.tsx`, `Pricing.tsx`, `Support.tsx`), `src/routes/*`,
  `index.html` (meta and OG only).
- **Depends on:** P5 claimed. **∥** P6.1.
- **Acceptance:**
  - The landing page shows v1 features only. The spec §9 items appear under a clearly labelled **"Roadmap"** and
    never as features.
  - The pricing page reads from `themis.plans` and matches the confirmed P4-PRICING values, with prices including
    VAT.
  - There is a support email and a status contact.
  - Axe is clean and the e2e spec is added.
- **Tenant data:** no. **Migration:** no.

### P6.3 — Clean-checkout build check (agent: builder)

- **Files:** `scripts/clean-checkout.mjs`, `package.json` (script `verify:clean`).
- **Depends on:** P6.1.
- **Acceptance:** the script clones `origin/main` into a temp dir, then runs `npm ci`, lint, typecheck, `npm test`,
  `db:gate`, `db:gate:prove-red`, build, `check:bundle` and `e2e` (local). It exits 0 only if all pass, and prints
  the commit SHA.
- **Tenant data:** no. **Migration:** no.

### P6.4 — Stripe live runbook (agent: builder)

- **Files:** `docs/ops/STRIPE_LIVE.md`.
- **Depends on:** P6.1.
- **Acceptance:**
  - The runbook gives the exact steps: `stripe-setup.mjs --live`, the live webhook endpoint and its events, setting
    the live `THEMIS_STRIPE_*` secrets (the operator does this), `VITE_STRIPE_PUBLISHABLE_KEY` (live) as an Actions
    variable, Stripe Tax registrations (GR / EU OSS), and Portal branding.
  - It covers the purchase-and-refund test script and the rollback (switch back to test keys).
- **Tenant data:** no. **Migration:** no.

**CHECKPOINT P6-PAYMENTS-LIVE — payments going live.** The operator approves the live Stripe keys and the webhook.
The operator is also advised on spec §10 Q4: a trademark clearance for "Themis" before paid launch.

### P6.5 — Go live and run the real € purchase (agent: builder, operator-gated)

- **Files:** `BUILD_LOG.md`, `BRAIN.md`, `DECISIONS.md`.
- **Depends on:** CHECKPOINT P6-PAYMENTS-LIVE approved, P6.2, P6.3, P6.4.
- **Acceptance:**
  - The runbook is executed.
  - **A real €-charged Pro purchase is made with the operator's card.** The webhook mirrors it (`subscriptions.plan
= pro`, and `stripe_events` has the ids), and the UI shows Pro.
  - The purchase is **refunded**, the refund webhook is received and recorded, and the Stripe dashboard shows the
    refund.
  - The Stripe ids (not secrets) and the timestamps are recorded.
- **Tenant data:** YES (live). **Migration:** no.

### P6.6 — Production smoke (agent: builder)

- **Files:** `scripts/smoke-prod.mjs`, `package.json` (script `smoke:prod`).
- **Depends on:** P6.5.
- **Acceptance:** the script is read-only and makes no writes. It checks that:
  - `https://themis.adeonanalytics.com/` and every asset return 200, and http → https redirects;
  - the served JS has no secret patterns;
  - anon `GET /rest/v1/plans` with `Accept-Profile: themis` returns 3 rows;
  - anon reads of `decisions` return `[]`;
  - every `themis-*` function returns 401 without a JWT, and the webhook returns 400 unsigned;
  - the Hephaestus site `https://lss-platform.netlify.app` returns 200.
- **Tenant data:** no. **Migration:** no.

### P6.QA — QA and validation (agent: qa)

- **QA exit gate:**
  1. **A clean-checkout build succeeds.** qa runs `npm run verify:clean` itself, and it exits 0 at the release SHA.
  2. **A real €-charged test purchase was made and refunded.** qa verifies this independently through the Stripe API
     (read-only, restricted key) and `themis.subscriptions`/`stripe_events`, not from the builder's log.
  3. **The smoke test against production passes** (`npm run smoke:prod`). qa also completes one full signed-in flow
     by hand on the live site: sign in, create a decision, run the analyst, export the PDF. It records the
     observables (§5 "running the real thing").
  4. The full e2e (live) is green against production, and axe is clean on the landing and pricing pages.
  5. The live snapshot diff is clean outside `themis` for the whole build (P1.14 `pre` vs now, excluding the
     `themis` schema), and the Hephaestus suite is green.
- **Depends on:** all P6 build tasks.

### P6.REVIEW — Quality review (agent: reviewer)

- **Depends on:** P6.QA = VALIDATED. **Rubric:** CLAUDE.md §6.

**CHECKPOINT P6 — launch gate.** The summary goes to `BUILD_LOG.md`, and the fleet row in `zeus/FLEET.md` is
updated by Zeus, not by this repo.

---

## Checkpoint index

| checkpoint           | where               | what the operator decides                                                                                                                     |
| -------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1-LIVE**          | before P1.14        | expose schema `themis` and first apply to the LIVE shared project `atopkqykdmrcfvvcistc` (ADR-0002); confirm the spec discrepancies           |
| **P1**               | end of P1           | phase gate                                                                                                                                    |
| **P2-AUTH**          | before P2.9         | shared-auth changes (redirects, Google, the shared template wording), P2 migrations live, e2e users in shared `auth.users`, Q5 email provider |
| **P2**               | end of P2           | phase gate                                                                                                                                    |
| **P3-KEY**           | before P3.11        | Anthropic key into the Vault and Edge secret, function deploy, P3 migration live, Q6 repo visibility                                          |
| **P3**               | end of P3           | phase gate, with the cost report                                                                                                              |
| **P4-PRICING**       | before P4.9 / P4.10 | prices, quotas and € ceilings confirmed (Q2)                                                                                                  |
| **P4-APPLY**         | before P4.15        | P4 migrations live, billing functions deployed, test-mode Stripe secrets                                                                      |
| **P4**               | end of P4           | phase gate                                                                                                                                    |
| **P5-LEGAL**         | before P5.6         | counsel reviews the legal text; scope of account deletion given the shared identity                                                           |
| **P5-APPLY**         | before P5.8         | the GDPR migration and delete function go live                                                                                                |
| **P5**               | end of P5           | phase gate                                                                                                                                    |
| **P6-PAYMENTS-LIVE** | before P6.5         | Stripe live keys and webhook; trademark advice (Q4)                                                                                           |
| **P6**               | end of P6           | launch gate                                                                                                                                   |
