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

## 2026-09-28 — P1.4 tests: `scripts/db-tenancy.test.ts` (test-writer)

- Added: 82 Vitest tests (node environment, one shared PGlite, `installShim` + the REAL archive
  applied twice, no SQL restated). This turns the builder's scratch 84-check script into committed
  coverage. Covered: column shapes/types/NOT NULL for all four tables, the memberships PK, every FK
  target and ON DELETE, and the CHECKs. Logo: 140000 accepted, 140001 refused, png/jpeg/webp pass,
  svg/gif/remote/non-base64 refused. Workspace name 1..120 non-blank. Role enum on memberships and
  invites. Duplicate membership. Lower-case and address-shaped email. token_hash 64 lower-hex and
  globally unique. Helpers: SECURITY DEFINER, STABLE, `search_path=""`, EXECUTE for authenticated
  only (anon and PUBLIC ACL both absent), they answer only for the caller, and anon cannot call
  them. RLS is on for all four tables. The exact policy set, all TO authenticated. No policy
  expression mentions memberships, and every workspace-scoped policy goes through
  is_member/has_role. anon holds no table or column privilege. Grantees are exactly
  authenticated + service_role, and authenticated's exact verbs and column-limited writes are
  checked. Behaviour: anon is refused on every table. Positive controls: owner A sees 1/4/1/4
  rows, and a loner sees 0 but can insert their own profile. A/B isolation (table-driven
  `TENANT_TABLES`): UB reads 0 of A in each table, and UB's UPDATE/DELETE have no effect (refused
  or 0 rows, plus an unchanged md5 snapshot). UB cannot insert a membership, invite or profile
  into A. UB's helpers return false for A. Role gating: viewer and editor cannot rename, cannot
  delete and see no invites. Admin can rename and sees invites but cannot delete. Owner can
  rename and set the logo, but not created_by or id. Nobody can INSERT a workspace directly.
  Profiles are self-edit only. Membership and invite insert/update/delete are refused even for
  the owner (6 cases). Lifecycle: an owner delete cascades memberships and invites while B stays
  intact. An auth.users delete cascades the profile and memberships and nulls created_by.
  updated_at bumps on all four tables. Hephaestus side: public/auth classes, policies, functions
  and triggers are identical before and after apply. No trigger on auth.users. The ledger still
  holds 25 rows. No stray schema.
- Harness for P1.5–P1.8: `actAs(uid | ANON | SUPERUSER, s => …)` runs in a transaction that is
  always rolled back. The session gives `count`, `rows`, `attempt` (savepoint-wrapped, returns
  ok/affected or the error) and `sudo`, plus `refused`/`noEffect`/`snapshot`. To cover a new
  tenant table, append it to `TENANT_TABLES`. `DB_GATE_MIGRATIONS` points the suite at a mutated
  archive copy.
- Mutation-checked against archive COPIES in the session scratchpad, never the committed file:
  - m1: workspaces_select `using (themis.is_member(id))` changed to `using (true)` → 4 RED,
    including "B reads zero rows of A in themis.workspaces" and "no policy expression … /
    helper".
  - m2: `grant select on themis.invites to anon` appended → 3 RED: anon privilege, the grantee
    set, and "anon cannot read themis.invites".
  - m3: is_member switched to `security invoker` → 56 RED, starting with the definer check. The
    recursion hit PGlite `ERRORDATA_STACK_SIZE exceeded` and poisoned the instance (BRAIN §5).
  - m4: `grant update on themis.memberships to authenticated` appended → 2 RED: the exact-verbs
    check and "promote via update is refused".
- Suite: lint clean, typecheck clean (the file is covered by `tsconfig.scripts.json`), `npm test`
  138 tests / 4 files green in about 2.1 s (the new file is about 1.7 s), db:check PASS, db:gate
  GATE PASSED. `git diff supabase/` is empty. No live project touched, not pushed.
- Next: P1.5 (decision core). Its test-writer should extend `TENANT_TABLES` in this file.

## 2026-09-28 — P1.5 decision core migration

- Did: migration added, `supabase/migrations/20260928220000_themis_decisions.sql`. It creates
  `themis.decisions` (lineage_id, revision ≥ 1, question, methodology, scale, status, frozen,
  approved_by/at, created_by, timestamps; `unique(id, workspace_id)`, `unique(lineage_id, revision)`,
  frozen ⇒ approved_at, approved ⇒ approved_at). It also creates `options` and `criteria` (weight
  smallint 0–5, `position`), and `scores` (value smallint 1–5, pk (option_id, criterion_id)). Every
  child has its own `workspace_id`, a composite FK `(decision_id, workspace_id)` → `decisions(id,
workspace_id)` on delete cascade, `created_by` defaulted from `auth.uid()`, and `updated_at` via
  `themis.touch_updated_at()`. Scores also have `(option_id, decision_id)` and `(criterion_id,
decision_id)` FKs, so both ends of a cell belong to the same decision. RLS goes through
  `is_member`/`has_role` only: members read, and editor|admin|owner write. On `decisions`, UPDATE and
  DELETE also require `not frozen`. Grants are column-limited: the client never writes ids, tenancy
  keys, `created_by` or the lifecycle columns (status, frozen, approved_*, lineage_id, revision). anon
  gets nothing, service_role gets full DML. No computed score is stored.
- Also touched: `scripts/db-tenancy.test.ts` (sanctioned by the lead where needed).
  - Three P1.4 exact-set assertions (FK list, policy set, authenticated column grants) queried
    the whole `themis` schema and went RED once any table was added. They are now scoped to the
    P1.4 `TABLES`, and their expected values are unchanged.
  - Added the P1.5 criterion "the enums match `decision.ts`": the CHECK values on
    `decisions.methodology`/`scale` are read from the catalog and compared to the keys of
    `METHODOLOGIES`/`SCALES`. Mutation proof: removing `'yolo'` from the SQL in an archive copy
    (`DB_GATE_MIGRATIONS`) turned it RED (1 failed).
  - `TENANT_TABLES` was NOT extended. Isolation coverage for the four new tables is the test-writer's job.
- Exercised: a scratch PGlite script (not committed) ran 50 checks, all PASS:
  - B reads 0 of A's rows and B's deletes have no effect in all 4 tables; viewer reads but cannot write; anon is refused on all 4;
  - an editor cannot set status, frozen, lineage/revision or created_by, and created_by defaults to the caller;
  - the score upsert works, weight 6 and score 0 are refused, and weight 0 is allowed;
  - B's child row with ws=B pointing at A's decision is refused by the composite FK, and with ws=A it is refused by RLS;
  - a score that mixes two decisions is refused;
  - a frozen decision cannot be updated or deleted, and frozen without approval is refused;
  - updated_at is bumped, and deletes cascade.
- Passed: `npm run lint && npm run typecheck && npm test && npm run db:check && npm run db:gate` exits 0.
  140 tests pass. The gate applies and re-applies all 3 files. Nothing was applied live, and nothing was pushed.
- Not done here (by plan): the frozen triggers on child tables and the lifecycle RPCs are P4.2. The db-gate.mjs
  enum/structural sweep is P1.8. The criterion says "the gate asserts" the enum match, but db-gate.mjs
  is outside P1.5's files, so the assertion lives in the Vitest harness until P1.8 adds the gate line.
- Next: test-writer for P1.5 (append decisions/options/criteria/scores to `TENANT_TABLES`, plus role gating,
  the composite-FK cross-tenant insert and column grants), then P1.6.
