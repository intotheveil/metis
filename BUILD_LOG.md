# BUILD LOG — Themis (`themis`)

## 2026-09-28 — P0 scaffold (Zeus NEW PRODUCT)

- Attempted: house front-end stack, working decision matrix, CI + Pages deploy, crew kit, brain.
- Passed: lint, typecheck, 15 tests (close-call boundary test mutation-verified RED), `vite build`.
- Blocked: nothing.
- Next: operator answers BRAIN Q1 → spec F1 (AI analyst) → P1 when persistence is needed.

## 2026-09-28 (later) — rename to Themis + brand

- Passed: lint, typecheck, 16 tests, build; page rendered and inspected at 1440px and at a true
  390px width (iframe). A phone overflow was found that way and fixed.
- BLOCKED: push/deploy. The gh token lacks the `workflow` scope (BRAIN §4 B1); waiting on the operator.

## 2026-09-28 (deploy)

- LIVE: https://intotheveil.github.io/themis/ (run 36448167598: verify + deploy success; assets 200).

## 2026-09-28 — P1.1 ADR-0002 + constitution for a shared database

- Did: ADR-0002 in DECISIONS.md; CLAUDE.project.md §2/§8/§11 (Supabase schema `themis`, `db:gate`,
  `db:gate:prove-red`, `db:apply`, e2e in P2, never `supabase db push`/`link`); BRAIN §2/§3/§6/§7.
  CLAUDE.md recomposed via `kit.mjs apply`, `kit.mjs check` canonical. No migration, no live DB touched.
- Next: P1.2.

## 2026-09-28 — P1.2 `db:gate` harness and bootstrap migration

- Did: `npm run db:gate` (`scripts/db-gate.mjs`, PGlite 0.5.8 devDep) on the argus-news pattern —
  in-memory, `DB_GATE_MIGRATIONS` override, exit 1 on any FAIL, "no migrations found" is a FAIL.
  `scripts/db-gate/shim.mjs` dresses the db as the SHARED project: roles anon/authenticated/
  service_role (bypassrls), `auth.uid()`/`auth.users`, Supabase default privileges in `public`,
  a Hephaestus-shaped `public` (organizations, profiles, memberships, workspaces, tasks; RLS on)
  and `supabase_migrations.schema_migrations` with 25 rows. Nothing is pre-granted on `themis`.
  Migration added: `supabase/migrations/20260928200000_themis_schema.sql` (schema, `schema_migrations`
  with RLS/no policies/no API grants, `touch_updated_at()` with `search_path=''`, USAGE to the
  three API roles, default-privileges revoke of EXECUTE from PUBLIC in `themis`).
- Passed: `npm run db:gate` → 17 PASS, `GATE PASSED`, exit 0. Proven RED (exit 1) on: empty dir,
  missing dir, the USAGE grant removed (3 FAIL lines), a non-idempotent migration, a SQL error.
  lint, typecheck, 17 tests green. No live project touched.
- Next: P1.3 (static migration guard).

## 2026-09-28 — P1.3 static migration guard

- Did: `scripts/check-migrations.mjs` (`npm run db:check [dir]`, default `$DB_GATE_MIGRATIONS` then
  `supabase/migrations`). `scripts/db-gate.mjs` runs it FIRST and exits 1 with nothing applied if
  it is red. Rules: filename, forbidden-schema, target-outside-themis, auth-users-trigger,
  create-extension, alter-system, drop-schema, alter-role, default-privileges (DECISIONS.md P1.3).
  No migration was added.
- Passed: `db:check` on the archive → PASS, exit 0. `db:gate` → guard PASS + 17 PASS, exit 0.
  Proven RED (exit 1, `file:line [rule]` printed) on 19 scratch fixtures: public DDL, public DML,
  auth write, storage policy, supabase_migrations insert, `grant … on schema public`,
  `search_path = public`, unqualified `create table`, a string-literal `execute`, a trigger on
  auth.users, create extension, alter system, drop schema, alter role, default privileges in
  public, default privileges with no schema, and three bad filenames. GREEN on
  `references auth.users` + `auth.uid()` and on `alter default privileges for role … in schema
themis`. `db:gate` pointed at a red fixture prints "nothing was applied" and exits 1. lint,
  typecheck and 17 tests are green.
- Next: test-writer writes `scripts/check-migrations.test.ts`. Note: it is outside every tsconfig
  `include`, so vitest runs it and eslint lints it, but `tsc -b` does not typecheck it. Then P1.4.

## 2026-09-28 — P1.3 tests: `scripts/check-migrations.test.ts` (test-writer)

- Added: 39 Vitest tests (node environment), fixture SQL inline as string literals. Each asserts the
  rule id AND the line number: forbidden-schema (public DDL, auth write, storage policy,
  supabase_migrations insert, upper-case and quoted identifiers, `execute '...'` string literal,
  `schema public` grant, `search_path` naming public), comments NOT flagged (line + nested block),
  `search_path = ''` GREEN, the two allowed auth forms GREEN, other auth refs (`auth.jwt()`, bare
  `auth.uid`, a read of auth.users) RED, auth-users-trigger, create-extension, alter-system,
  drop-schema, alter-role + alter user, default-privileges (public RED, no schema RED, `in schema
themis` with/without `for role` GREEN), target-outside-themis (unqualified create/insert/update
  and another schema RED; temp/temporary table and themis-qualified GREEN), filename (3 bad names
  RED at line 0, good name GREEN), stripComments offset/line preservation, formatViolation,
  checkMigrationsDir/runGuard on missing dir, empty dir (.gitkeep only), a mixed dir, a clean dir,
  and the real `supabase/migrations` archive (PASS).
- Mutation-checked (source restored after each, `git diff scripts/check-migrations.mjs` empty):
  trigger regex `auth` -> `authx` (1 RED); default-privileges always skipped (2 RED); FILENAME_RE
  `\d{14}` -> `\d{13,14}` (1 RED); `auth.uid` allowed without `()` (1 RED); comment stripping
  disabled (3 RED).
- Typecheck coverage: new `tsconfig.scripts.json` (allowJs, strict, node types, include
  `scripts/**/*.test.ts`) referenced from `tsconfig.json`, so `tsc -b` now checks the test file and
  the JSDoc-typed `check-migrations.mjs` import. Proven: a probe `scripts/*.test.ts` with a type
  error made `npm run typecheck` fail (removed).
- Suite: lint clean, typecheck clean, 56 tests / 3 files green, db:gate GATE PASSED. No live
  project touched, not pushed.
- Next: P1.4.

## 2026-09-28 — P1.4 tenancy migration

- Did: `supabase/migrations/20260928210000_themis_tenancy.sql`. Tables `themis.profiles`
  (user_id pk → auth.users cascade), `themis.workspaces` (logo_data_url ≤ 140000 chars and a
  png/jpeg/webp data URL; created_by → auth.users set null, default auth.uid()),
  `themis.memberships` (pk (workspace_id, user_id) = the unique pair; role check
  owner|admin|editor|viewer), `themis.invites` (email stored lower-case by check; token_hash a
  unique 64-hex sha256; expires_at, created_by, accepted_at). All four have created_at/updated_at
  with a `themis.touch_updated_at()` BEFORE UPDATE trigger. Helpers `themis.is_member(ws)`,
  `themis.has_role(ws, roles[])` and `themis.shares_workspace(other)` (for profiles) are SECURITY
  DEFINER STABLE, `search_path=''`, EXECUTE revoked from public/anon and granted to authenticated.
  No policy subqueries memberships. RLS on all four. Policies (authenticated only): profiles
  select self or shared workspace, insert/update self; workspaces select member, update
  owner|admin, delete owner; memberships select member; invites select owner|admin. Grants:
  nothing to anon/PUBLIC; authenticated gets select plus only the column-limited writes the
  policies admit; service_role gets full DML.
- Migration added: `20260928210000_themis_tenancy.sql` (forward-only, idempotent-safe).
- Passed: `npm run lint`, `typecheck`, `npm test` (56), `db:check` (2 migrations PASS), `db:gate`
  (both files applied and re-applied, GATE PASSED, exit 0). A scratch PGlite script (not committed,
  P1.8 owns the gate's leak suite) ran 84 checks, all PASS: column shapes, RLS, triggers, grantees
  exactly authenticated+service_role, anon holds nothing, helper definer/stable/search_path/EXECUTE,
  CHECK constraints (logo size + svg refused, role enum, duplicate membership, mixed-case email,
  duplicate token_hash), and a functional A/B fixture with no recursion error. UB reads zero rows of
  A in all four tables. UB's update and delete on A affect 0 rows. Direct membership and invite
  writes are refused. A viewer or editor cannot rename or delete A, and the owner can. anon
  cannot read any table or call a helper. Deleting A cascades its memberships and invites.
  `public` is unchanged.
- Not done here (by scope): no new gate checks in `scripts/db-gate.mjs`. The file is outside
  P1.4's declared scope, and the tenancy checks belong to the test-writer pass and the P1.8
  leak matrix.
- Next: test-writer for P1.4, then P1.5 (decision core).
