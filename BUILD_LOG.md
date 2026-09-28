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

## 2026-09-28 — P1.5 tests: decision core (test-writer)

- Did: extended `scripts/db-tenancy.test.ts`, keeping one PGlite per file. The `actAs` harness is module-local, so no sibling
  file was created. It went from 82 to 170 tests, and the suite from 140 to 228.
  - Fixture: workspace A has draft decision DA (2 options, 2 criteria, 2 scored cells, 2 free cells) and frozen+approved DAF
    (1×1 scored). Workspace B has draft DB (1×1 scored). Every row is at `updated_at = OLD`.
  - `TENANT_TABLES` now also has decisions/options/criteria/scores. B reads 0 of A, and B's UPDATE/DELETE of A's rows
    has no effect: the snapshot is unchanged.
  - Cross-tenant child inserts by B, for options, criteria and scores:
    - `workspace_id = B` pointing at A's decision is refused by `*_decision_fkey` (the composite FK).
    - `workspace_id = A` is refused by RLS.
    - A score on B's own decision that points at A's option is refused by `scores_option_fkey`.
    - B cannot re-point its rows via `decision_id`/`workspace_id` updates (permission denied).
  - Mixing decisions: a score whose option or criterion belongs to another decision is refused by
    `scores_option_fkey`/`scores_criterion_fkey`.
  - Role gating:
    - viewer reads everything; every insert is refused, and every update/delete affects 0 rows.
    - editor/admin/owner create decisions, options, criteria and scores (including the `on conflict` upsert).
      They edit and delete a draft and its children.
    - Nobody can UPDATE status, frozen, approved_by/at, lineage_id, revision, created_by, id, workspace_id,
      created_at or updated_at on a decision. Nobody can INSERT one with any lifecycle column preset. Child ids,
      tenancy keys and created_by are also locked.
    - A frozen decision cannot be updated or deleted (0 rows) by editor/admin/owner, but stays visible.
  - Constraints (as superuser):
    - weight -1/6 are refused and 0/5 accepted; score 0/6 are refused and 1/5 accepted (an update to 6 is refused too).
    - one score per cell; revision ≥ 1.
    - frozen ⇒ approved_at (also on nulling approved_at); approved ⇒ approved_at.
    - status/methodology/scale enums.
    - `unique(lineage_id, revision)` is global across workspaces, and the next revision is free.
    - length limits and position ≥ 0.
  - Structure and grants:
    - exact column lists, exact PK/unique keys, and an exact FK list including composite columns and ON DELETE
      (no child has a direct FK to workspaces).
    - RLS on, exactly 16 policies, all TO authenticated.
    - anon has no privilege; grantees are authenticated and service_role only.
    - authenticated has SELECT/DELETE at table level, and INSERT/UPDATE only on the exact planned column set
      (no table-wide INSERT/UPDATE).
  - Defaults, triggers and cascades:
    - created_by = auth.uid() on all 4 tables. A new decision is a draft with revision 1, not frozen, a fresh lineage,
      and weight defaults to 3.
    - updated_at bumps on all 4 tables.
    - Cascades: decision → children; option/criterion → their scores only; workspace → all 4 tables (frozen
      included, B intact); an auth user delete nulls created_by/approved_by.
- Mutation evidence: `DB_GATE_MIGRATIONS` pointed at mutated COPIES of the archive. `git diff supabase/` is empty.
  - m1: removed `and not frozen` from `decisions_update`. 3 failed: "editor/admin/owner cannot update or delete a frozen decision".
  - m2: appended `grant update (status) on themis.decisions to authenticated`. 4 failed: the exact column-grant test, plus
    "editor/admin/owner cannot UPDATE any lifecycle column".
  - m3: turned `options_decision_fkey` into a single-column FK `(decision_id) → decisions(id)`. 2 failed: the FK-list test,
    plus "an options row claiming workspace B but pointing at A's decision is refused by the composite FK". That single-column
    FK is the real cross-tenant hole the composite FK closes.
- Passed: `npm run lint && npm run typecheck && npm test && npm run db:check && npm run db:gate` exits 0. 228 tests pass,
  and the gate applies 3 files twice. No live Supabase; not pushed.
- Bugs found: none. The migration behaves as DECISIONS.md "P1.5 decision core choices" describes. Noted, by plan: until the
  P4.2 `decision_frozen` triggers, editors can still write options, criteria and scores of a frozen decision.
- Next: P1.6 (analysis and collaboration).

## 2026-09-28 — P1.6 analysis and collaboration migration

- Did: migration added, `supabase/migrations/20260928230000_themis_analysis.sql`. It creates:
  - `themis.swot_items` (decision_id, option_id null = decision-level, quadrant `s|w|o|t`, text ≤ 1000, position).
  - `themis.risks` (decision_id, option_id NOT NULL, title ≤ 200, likelihood 1–5, impact 1–5, owner free text ≤ 200,
    mitigation ≤ 2000, position). No exposure/score column: likelihood × impact belongs to `decision.ts` (P4.1).
  - `themis.comments` (decision_id, body 1–4000 non-blank, author).
  - `themis.approvals` (decision_id, verdict `approved|rejected`, reason NOT NULL and non-blank ≤ 2000, actor).
  - All four: own `workspace_id`, composite FK `(decision_id, workspace_id)` → `decisions(id, workspace_id)` on delete
    cascade, `created_by` defaulted from `auth.uid()`, `created_at`, `updated_at` + `touch_updated_at` trigger. swot_items
    and risks also have `(option_id, decision_id)` → `options(id, decision_id)`, so an option of another decision (and so
    of another workspace) can never be named. `author`/`actor` are defaulted from `auth.uid()` as well.
  - RLS via `is_member`/`has_role` only: swot_items and risks read by members, written by editor|admin|owner. Comments
    read and posted by any member (viewer included, `author = auth.uid()`); only the author, while a member, updates or
    deletes. Approvals read by members, INSERT by admin|owner only (`actor = auth.uid()`), no UPDATE/DELETE policy or grant.
  - Grants: column-limited INSERT/UPDATE; the client never writes ids, workspace_id/decision_id/option_id on update,
    created_by, author or actor. anon nothing; service_role full DML.
- Existing tests: none went RED. The P1.4 and P1.5 exact-set assertions were already scoped to their own table groups,
  so `scripts/db-tenancy.test.ts` was NOT touched. New coverage is left to the test-writer.
- Exercised: a scratch PGlite script (not committed, real archive applied twice) ran 82 checks, all PASS:
  - B reads 0 of A in all 4 tables, B's UPDATE/DELETE of A's rows has no effect; anon is refused on all 4.
  - B's child row with ws=B pointing at A's decision is refused by the composite FK in all 4 tables, with ws=A by RLS;
    a swot/risk on B's own decision naming A's option is refused by `*_option_fkey`; a swot/risk naming an option of
    another decision in the same workspace is refused.
  - viewer reads all 4, cannot write swot/risks/approvals, CAN post a comment (author = self); editor writes swot/risks
    but cannot approve; owner and admin can approve (actor = self); owner cannot update or delete an approval
    (permission denied), and cannot edit or delete an editor's comment (0 rows); the author can.
  - Column grants: option_id/decision_id/workspace_id/created_by/author not updatable; created_by/author/actor not
    insertable.
  - CHECKs: likelihood 6, impact 0, risk without option, quadrant `x`, blank/null reason, verdict `maybe`, empty
    comment all refused. updated_at bumps. Option delete cascades its risks and option-level SWOT (decision-level SWOT
    kept); workspace delete cascades all 4.
- Passed: `npm run lint && npm run typecheck && npm test && npm run db:check && npm run db:gate` exits 0. 228 tests
  pass; the guard passes 4 files; the gate applies and re-applies 4 files. Nothing applied live, nothing pushed.
- Not done here (by plan): `decision_frozen` triggers on these tables and the approve()/reject() RPCs are P4.2; the
  leak-matrix coverage check is P1.8.
- Next: test-writer for P1.6 (add the four tables to `TENANT_TABLES`, plus role gating, comment-author rule,
  approval append-only, composite/option FKs, column grants), then P1.7.

## 2026-09-28 — P1.6 tests: analysis and collaboration (test-writer)

- Did: extended `scripts/db-tenancy.test.ts` (same file, same `actAs` harness, one PGlite). File 172 -> 271 tests
  (+99); suite 228 -> 327.
  - Fixture: A has SWOT SA1 (decision-level, DA) and SA2 (OA1), risks RA1 (OA1) and RA2 (OA2), comment CMA on DA
    written by the EDITOR, approvals APA (DA, rejected, admin) and APAF (DAF, approved, owner). B has one of each.
  - `TENANT_TABLES` now also has swot_items/risks/comments/approvals: B reads 0 of A; B's UPDATE/DELETE of A's
    rows has no effect (snapshot unchanged). The non-vacuous check asserts B's own row in each.
  - Cross-tenant, all 4 tables: ws=B pointing at A's decision is refused by `<table>_decision_fkey` (risks use
    the VALID pair OA1/DA, so only the decision FK can refuse); ws=A is refused by RLS; positive control that B
    writes on its own decision. swot/risk on B's own decision naming A's option -> `<table>_option_fkey`; on DA
    naming DAF's option -> same FK. B cannot re-point decision_id/workspace_id/option_id (permission denied).
  - Roles: viewer reads all 4, inserts into swot/risks/approvals refused, updates/deletes 0 rows; viewer CAN
    comment (author = created_by = self) and edit/delete it. editor/admin/owner write, edit, delete swot and risks.
    owner/admin/viewer editing or deleting the editor's comment -> 0 rows; the author can; an author removed
    from the workspace -> 0 rows. admin/owner approve (actor = created_by = self); editor/viewer refused by RLS.
    Approvals append-only: update (verdict, reason, actor) and delete refused for owner/admin/editor/viewer.
    Presetting author/actor/created_by/id or updating created_by/author/option_id/updated_at refused.
  - Constraints (superuser): likelihood/impact 0/6 refused, 1/5 accepted, update to 6 refused, null refused;
    risk without option (NOT NULL); quadrant s/w/o/t only (x, S, strength, '' refused); verdict approved|rejected
    only; reason null/''/blank refused, 2000 ok, 2001 refused; comment null/''/blank refused, 4000 ok, 4001
    refused, update to blank refused; text limits and position >= 0.
  - Structure: exact columns (no exposure/score/generated column), PK id only, exact FK list (composite columns
    - ON DELETE), one touch trigger each, RLS on, exactly 14 policies all TO authenticated (approvals
      select+insert only), anon nothing, grantees authenticated+service_role only, approvals SELECT+INSERT only,
      no table-wide INSERT/UPDATE, exact INSERT/UPDATE column grant list, service_role full DML.
  - Defaults/cascades: created_by/author default to the caller, text fields default ''; updated_at bumps on all 4.
    Option delete removes its risks and option-level SWOT (decision-level SWOT, comments, approvals kept);
    decision delete removes DA's analysis rows only (APAF, B intact); workspace delete removes all of A's, B
    intact; auth user delete nulls author/actor/created_by.
- Mutation evidence (`DB_GATE_MIGRATIONS` -> mutated COPIES in the session scratchpad; `git diff supabase/` empty):
  - m1a: added `approvals_update` policy only. 1 failed: "the policy set is exactly 14 ... select/insert ONLY".
  - m1: that policy + `grant update (reason) on approvals`. 7 failed: policy set, approvals privs, exact column
    grants, and "approvals are append-only" x4 roles.
  - m2: `swot_items_option_fkey` made single-column `(option_id) -> options(id)`. 3 failed: FK list, "a swot_items
    row on B's OWN decision naming A's option ...", "a SWOT item on DA naming DAF's option ...".
  - m3: dropped `author = auth.uid()` from `comments_update` USING. 3 failed: owner/admin/viewer "cannot edit or
    delete the editor's comment".
  - m4: `approvals_insert` opened to editor. 1 failed: "editor cannot record an approval".
- Passed: `npm run lint && npm run typecheck && npm test && npm run db:check && npm run db:gate` exit 0; 327 tests.
  No live Supabase; not pushed.
- Bugs found: none. The migration behaves as DECISIONS.md "P1.6 analysis and collaboration choices" describes.
- Next: P1.7 (AI, billing, audit, plans and seed).

## 2026-09-28 — P1.7 AI, billing, audit, plans and seed migration

- Did: migration added, `supabase/migrations/20260928235000_themis_ai_billing_audit.sql`. It creates:
  - `themis.plans` (key pk `free|pro|team`, active_decisions null = unlimited, ai_runs_month, ai_runs_per_seat,
    ai_cost_ceiling_eur numeric(10,4), members_max null = unlimited, pdf_footer, pdf_logo, min_seats, created_at,
    updated_at). CHECK: exactly one of ai_runs_month / ai_runs_per_seat is set. Seeded `on conflict (key) do nothing`
    with the spec §4 PROPOSAL: free (3 decisions, 10 runs, 1 member, footer), pro (unlimited, 200 runs, 1 member,
    clean), team (unlimited, 500 runs per seat, unlimited members, logo, min 3 seats). Ceilings €1 / €10 / €60 are
    builder PLACEHOLDERS (not in the spec). `comment on table themis.plans` marks the seed UNCONFIRMED until
    CHECKPOINT P4-PRICING; P4.9 changes them in a new migration.
  - `themis.ai_runs` (workspace_id, decision_id, kind `challenge|missing_criteria|stress_test|explain|swot_draft`,
    model, status `reserved|succeeded|failed`, input_snapshot jsonb object, output jsonb, tokens_in/out ≥ 0,
    cost_eur numeric(10,4) ≥ 0, accepted jsonb array default `[]`, created_by, created_at, updated_at). Composite FK
    `(decision_id, workspace_id)` → decisions, on delete cascade.
  - `themis.subscriptions` (workspace_id unique → workspaces cascade, stripe_customer_id `cus_…` unique,
    stripe_subscription_id `sub_…` unique, plan → plans(key) default free, seats ≥ 1, status = Stripe's 8 statuses,
    period_end).
  - `themis.usage_monthly` (pk (workspace_id, month), month must be day 1, ai_runs ≥ 0, ai_cost_eur ≥ 0).
  - `themis.audit_log` (workspace_id → workspaces cascade, actor default auth.uid(), entity, entity_id uuid, action,
    before/after jsonb, at). `themis.audit_log_append_only()` (search_path pinned, no anon/authenticated EXECUTE)
    fires BEFORE UPDATE and raises `audit_log_append_only` for every role, the owner included.
  - updated_at triggers on plans, ai_runs, subscriptions, usage_monthly (audit_log has none: it never updates).
  - RLS on all five. plans: SELECT to anon, authenticated `using (true)`. ai_runs/subscriptions/usage_monthly: SELECT
    by `is_member`. audit_log: SELECT by `has_role(owner|admin)`. No INSERT/UPDATE/DELETE policy on any of them.
  - Grants: anon SELECT on plans only. authenticated SELECT only on all five (no write grant, table or column).
    service_role: SELECT on plans; full DML on ai_runs/subscriptions/usage_monthly; SELECT + INSERT on audit_log.
- Existing tests: ONE went RED. `db-tenancy.test.ts` "no policy expression references memberships directly
  (recursion rule)" swept EVERY themis policy and required a helper call; `plans_select` is `true` by design (non-tenant
  reference data, PLAN P1.7). Scoped it: the helper requirement now skips `plans.` as it already skipped `profiles.`.
  No expected value changed; the "no policy mentions memberships" half still covers every table, plans included.
- Exercised: a scratch PGlite script (not committed, real archive applied twice) ran 79 checks, all PASS:
  - plans has 3 rows with the proposal values; the table comment says UNCONFIRMED; anon reads 3 plans.
  - anon: permission denied on ai_runs/subscriptions/usage_monthly/audit_log; cannot write plans.
  - UA reads exactly its own row of ai_runs/subscriptions/usage_monthly and 0 of B; the viewer reads A's; UB reads 0
    of A. audit_log: owner reads A's, editor and viewer read none, UB none of A.
  - Owner AND editor in their own workspace: 15 writes (insert/update/delete on ai_runs, subscriptions, usage_monthly,
    audit_log; update/insert on plans), each refused with permission denied.
  - service_role inserts an ai_run, updates usage and a subscription, inserts audit; its UPDATE/DELETE on audit_log
    and any write to plans are refused; the superuser's UPDATE on audit_log raises `audit_log_append_only`.
  - ai_run with ws=B pointing at A's decision → composite FK refuses. Bad kind, negative cost, non-array accepted,
    month not day 1, a second subscription per workspace, unknown plan/status, seats 0, a plan with two quota bases,
    key `gold` → all refused. updated_at bumps. Workspace delete cascades all four tenant tables.
  - Catalogue: anon holds exactly SELECT on plans; authenticated holds no table or column write on the five.
- Passed: `npm run lint && npm run typecheck && npm test && npm run db:check && npm run db:gate` exits 0. 327 tests;
  the guard passes 5 files; the gate applies and re-applies 5 files. Nothing applied live, nothing pushed.
- Open for later tasks (not solved here, recorded in DECISIONS.md P1.7): P3.9 "appends to `ai_runs.accepted`" from the
  client needs a server-side path (an editor+ SECURITY DEFINER RPC or the Edge Function), because ai_runs has no
  client write. The flat per-workspace € ceiling does not scale with Team seats; P3.12/P4-PRICING decides.
- Next: test-writer for P1.7 (add ai_runs/subscriptions/usage_monthly/audit_log to `TENANT_TABLES`; server-only
  writes for every role, audit append-only, plans anon read + seed values, exact policy/grant sets scoped to the
  P1.7 tables), then P1.8.

## 2026-09-28 — P1.7 tests: AI, billing, audit and plans (test-writer)

- Did: extended `scripts/db-tenancy.test.ts` (same `actAs` harness, one PGlite). 100 new tests (327 → 427).
  - Harness: a `SERVICE` identity (`set local role service_role`, no JWT sub) next to `ANON`/`SUPERUSER`.
  - Fixture: ai_runs ARA (DA), ARAF (DAF), ARB; a Pro subscription for A and a free one for B; usage 2026-09 for both;
    audit rows A1 (actor = viewer), A2 (no actor), B1. No audit row names ownerA/adminA/editorA, because the P1.4–P1.6
    user-deletion tests delete them and would hit the bug below.
  - `TENANT_TABLES` += ai_runs, subscriptions, usage_monthly, audit_log (B reads 0 of A; B's UPDATE/DELETE has no effect).
  - Structure: columns/types/NOT NULLs of all five; exact PK/unique set; exact FK set (composite ai_runs →
    decisions, plan → plans(key) no action); exact trigger set (4 × touch_updated_at, audit_log_no_update BEFORE UPDATE
    ROW); audit_log_append_only() search_path pinned, no anon/authenticated EXECUTE; the plans comment says UNCONFIRMED.
  - RLS/grants: RLS on all five; exact policy set (one SELECT policy each, plans `{anon,authenticated}`, no WITH
    CHECK); predicates is_member / has_role(owner, admin) / true; exact privileges per role (anon SELECT plans only;
    authenticated SELECT only; service_role SELECT plans, full DML on the three billing tables, SELECT+INSERT
    audit_log); exact grantee sets; anon holds exactly `plans SELECT` across every themis table, sequence and function.
  - Server-side writes only: owner/admin/editor/viewer × {ai_runs, subscriptions, usage_monthly, audit_log, plans} ×
    INSERT/UPDATE/DELETE, each refused with permission denied and the rows unchanged; the same for anon. service_role
    inserts/settles/deletes ai_runs, writes subscriptions and usage, INSERTs audit_log, is refused UPDATE/DELETE on
    audit_log and any write to plans. The superuser's UPDATE on audit_log raises `audit_log_append_only`.
  - Reads: each A role reads A's runs, subscription and usage and nothing of B; audit_log owner/admin 2 rows,
    editor/viewer 0 (even the viewer's own actor row); B reads its own; the loner reads nothing but 3 plans; anon reads
    3 plans and is refused on the four tenant tables.
  - Seed: exactly the 3 proposal rows (as superuser and as anon). Re-applying the P1.7 file keeps a changed `pro`
    row, does not duplicate, and restores a deleted `team`. plans_one_quota_basis (both / neither refused), key, min_seats,
    ceiling, members_max, ai_runs_month checks.
  - Constraints: ai_runs kind (5) / status (3, default reserved) / accepted array on insert and update / input_snapshot
    object / non-negative tokens and cost / model length; the composite FK refuses cross-workspace runs and a re-point
    FROM THE SERVICE KEY (the only barrier once RLS is bypassed). subscriptions one per workspace, plan FK (plan
    'gold' refused, default free, an in-use plan cannot be deleted), cus_/sub_ formats and cross-workspace uniqueness,
    Stripe's 8 statuses, seats >= 1. usage_monthly day-1 month, PK (workspace_id, month), non-negative counters.
    audit_log entity/action 1..64.
  - updated_at bumps on ai_runs, subscriptions, usage_monthly, plans. Cascades: workspace delete removes all four
    tenant tables' A rows (B intact, plans intact); a draft decision delete removes only its runs; a user delete nulls
    ai_runs.created_by.
- BUG FOUND (P1.7 migration, not fixed here, product code untouched): `audit_log.actor ... on delete set null` is
  an UPDATE of audit_log, and the BEFORE UPDATE `audit_log_no_update` trigger refuses it. Deleting ANY auth user who
  is an actor in any audit row fails with `audit_log_append_only`. That blocks account deletion (spec §7.6) and a user
  delete on Hephaestus's side of the shared auth.users. Recorded as `it.fails('BUG: deleting an auth user who is an
audit actor keeps the audit row, actor nulled')`: the assertion is intact, and the test goes RED as soon as the
  migration is fixed (then flip it to `it`). Mutation m2 (trigger removed) made this test pass, which shows the trigger
  is the cause. Suggested fix (builder, NEW migration): let the trigger allow an UPDATE that only nulls `actor`, or
  make the actor FK `on delete no action` and handle deletion another way.
- Mutation evidence (mutated COPIES in the scratchpad via DB_GATE_MIGRATIONS, deleted afterwards):
  - m1 insert policy + grant on ai_runs for authenticated: 7 RED (the policy set, the predicates, the privileges, and
    owner/admin/editor/viewer "refused INSERT, UPDATE and DELETE on A's themis.ai_runs").
  - m2 no audit_log_no_update trigger: 3 RED (the trigger set, "UPDATE raises audit_log_append_only", and the BUG
    it.fails, which now passes).
  - m3 audit_log_select opened to is_member: 4 RED (the predicates, editor/viewer read 0 audit rows, the viewer's own row).
  - m4 grant UPDATE, DELETE on audit_log to service_role: 2 RED (the privileges, and "service_role may INSERT
    audit_log but never UPDATE or DELETE it").
  - m5 seed `on conflict do update`: 1 RED ("re-applying the migration neither duplicates nor overwrites").
  - `git diff supabase/` is empty.
- Passed: `npm run lint && npm run typecheck && npm test && npm run db:check && npm run db:gate` exit 0; 426 passed +
  1 expected fail (the bug). No live Supabase; not pushed.
- Next: builder fixes the audit actor bug in a NEW migration and flips the it.fails; then P1.8.

## 2026-09-28 — FIX: audit_log actor erasure (bug found by the P1.7 tests)

- Did: NEW migration `supabase/migrations/20260928235500_themis_audit_actor_erasure.sql`. It does
  `create or replace function themis.audit_log_append_only()` (same name, so the P1.7 trigger `audit_log_no_update` now
  uses the new body). It returns NEW only when `old.actor is not null and new.actor is null and (to_jsonb(new) - 'actor') =
(to_jsonb(old) - 'actor')`. Every other UPDATE still raises `audit_log_append_only` (42501) for every role.
  `search_path = ''` is kept, and EXECUTE is revoked from public/anon/authenticated again. The file has no grant and no
  other DDL, stays in schema themis only, and is idempotent. The P1.7 file is untouched.
- Tests (`scripts/db-tenancy.test.ts`, 371 → 376 in the file, 432 total): the `it.fails` BUG test is now `it`, with its
  assertion unchanged. New describe "actor-erasure fix":
  - (a) superuser `actor = null` + action/after/at/workspace_id changed: each raises audit_log_append_only, and the table
    is unchanged. service_role does the same and is refused with permission denied (no UPDATE grant).
  - (b) superuser re-points actor to another user and is refused. Filling a null actor is refused. A no-op
    `actor = null` on a null-actor row is refused.
  - (c) a throwaway role `themis_test_auth_admin` (DELETE+SELECT on auth.users, no USAGE on themis, no UPDATE on
    audit_log; anon/authenticated/service_role also hold no UPDATE) deletes the viewer. The delete succeeds, A1 survives
    with actor NULL, every other column of A1 is byte-identical, and the other rows are unchanged. **This proves the FK
    action needs no grant.** Also covered: deleting ownerB nulls only B1's actor, and A's audit rows are unchanged.
  - The trigger-set and function-config assertions needed no change (same function name, same config).
- Mutation evidence (archive COPIES in the scratchpad via DB_GATE_MIGRATIONS):
  - no fix file: 3 RED (the flipped test, the auth-admin delete, the ownerB delete).
  - fix without the column comparison: 1 RED ((a)).
  - fix without the `old.actor not null / new.actor null` guard: 1 RED ((b)).
- Passed: `npm run lint && npm run typecheck && npm test && npm run db:check && npm run db:gate` exit 0. 432 passed, 0
  expected-fail. The guard passes 6 files, and the gate applies and re-applies 6 files. No live Supabase; not pushed.
- Next: P1.8.

## 2026-09-28 — P1.8 the leak suite: structural and functional gates in `npm run db:gate`

- Did: NEW `scripts/db-gate/leak-matrix.mjs`, shared by the gate AND `scripts/db-tenancy.test.ts`. It holds the fixture
  ids and rows (`seedFixture`), the `createHarness(db).actAs` harness, `refused`/`noEffect`/`snapshot`, `foreignSnapshot`,
  `checkValues` (the enum reader) and `LEAK_MATRIX`: one entry per themis table (16 tenant + `plans` reference;
  `SERVICE_ONLY_TABLES = ['schema_migrations']`). The test file now imports all of these instead of defining them, so
  `TENANT_TABLES` is derived from the matrix. No assertion was changed or removed: 432 tests before and after.
  `scripts/db-gate.mjs` gained 3 sections after the P1.2 bootstrap checks:
  - **Structural (18 lines):** RLS on every table; no view without security_invoker and no matview; a policy on every
    table except the service-only ones, which hold zero anon/authenticated grants; search_path pinned on every function;
    no SECURITY DEFINER function with public/$user/pg_temp on its path; no anon EXECUTE; no PUBLIC EXECUTE (the default
    acl counts); no write policy for anon/PUBLIC; every policy TO authenticated except `plans.plans_select` (anon+auth,
    SELECT only); the memberships recursion rule; workspace-scoped policies go through is_member/has_role; anon holds
    exactly `plans.SELECT` (tables, columns, sequences); public/auth/supabase_migrations unchanged (pg_class, pg_policy,
    pg_proc, triggers diffed before/after apply); no trigger on auth.users; every FK convalidated; methodology and scale
    CHECKs equal `decision.ts` (imported as .ts, which works through node 24 type stripping).
  - **Coverage (3):** every catalogue table except service-only has an entry, which **makes a new table without an
    entry RED**; no stale entry; no duplicate entry.
  - **Fixture + orphan scan (2):** seeds the shared fixture, then anti-joins every themis FK (36) and finds zero orphans.
  - **Leak matrix (244 lines):** anon reads nothing in any catalogue table except exactly 3 plans rows. For each tenant
    table: the fixture is non-vacuous; UB reads zero of A and all of B; UB's UPDATE, DELETE and INSERT into A have no
    effect (the snapshot is identical, the INSERT is refused by privilege/RLS and leaves no row, and the same INSERT
    succeeds as a legitimate actor as a control); for decision children, a child row with workspace_id=B pointing at A's
    parent is refused and leaves no row (control: the same row with B's parent succeeds as service); anon's
    UPDATE/DELETE has no effect. Positive path: UA reads all of A; the viewer reads all of A, or none where role-gated
    (invites, audit_log); the declared writer's write takes effect (UA, the editor for comments, or service for
    server-written tables); the viewer's UPDATE, DELETE and write have no effect; for server-written tables,
    authenticated holds no write privilege and UA's writes have no effect. plans: 3 rows, UA and UB read 3, UA/anon
    writes have no effect, no client write privilege.
- Gate: 290 PASS, `GATE PASSED`, exit 0 (23 P1.2/P1.3 lines + 267 new).
- RED evidence. Each run appended ONE sabotage file to a COPY of the archive in the scratchpad and ran the gate with
  DB_GATE_MIGRATIONS. All exited 1:
  - 01 `create table themis.leaky(id int)`: RLS, policy, coverage ("NO ENTRY: leaky").
  - 02 a table with RLS, a helper policy and no matrix entry: ONLY the coverage line.
  - 03 `create policy … on decisions for select using (true)` (TO public): TO-authenticated, helper, "UB reads ZERO rows
    of A — 2 rows".
  - 04 an update policy `to public`: no-write-policy-admits-anon/PUBLIC, TO-authenticated, "viewer cannot write" (3 rows
    changed).
  - 05 a definer function without search_path: search_path pinned, anon EXECUTE, PUBLIC EXECUTE.
  - 06 a definer with `search_path = public`: caught first by the static guard. 06b `pg_temp, themis`: the definer-path
    line.
  - 07 `grant execute on has_role to public`: anon + PUBLIC EXECUTE. 08 `grant execute on is_member to anon`: anon
    EXECUTE.
  - 09 `grant select on decisions to anon`: "anon holds exactly SELECT on plans" (decisions.SELECT). 20 `grant insert on
    plans to anon`: that line plus "plans: no client role holds a write privilege".
  - 10 a policy with an inline memberships subquery: the recursion rule and the helper line.
  - 11 methodology CHECK + 'kanban': the enum line ("db agile|kanban|waterfall|yolo vs ts …").
  - 12 NOT VALID FK plans → workspaces with dangling defaults: convalidated, and "orphan scan … plans_orphan_fk: 3".
  - 13 `is_member` returns true (structurally perfect): 14 functional lines ("UB reads ZERO rows of A" on 13 tables, and
    UB's comment INSERT into A).
  - 14 revoke the decisions UPDATE column grant: "UA writes A's data".
  - 15 `grant insert on usage_monthly to authenticated`: "server-written — authenticated holds no write privilege".
  - 16 drop `scores_decision_fkey`: "UB's child row (workspace B) pointing at A's parent is refused" (affected 1).
  - 17 `create view themis.v_decisions` (owner rights): the view line.
  - 18 `create table public.x` via EXECUTE: caught by the static guard. 18b `format(...)` evasion creating
    public.themis_fn(): "zero objects … changed — changed: functions".
  - 19 a trigger on auth.users via EXECUTE with string concatenation (the static guard does NOT catch it): the diff line
    (triggers), "no trigger on auth.users", and the fixture seed.
  - 21 `grant select on schema_migrations to authenticated`: the P1.2 line and the service-only line.
  - 22 an update policy `using (true)`: helper, viewer-cannot-write. 24 a delete policy `using (true)`: the same.
  - 23 a select policy + grant to anon: TO-authenticated, helper, anon-privileges, "anon reads nothing in
    themis.decisions — 3 rows".
  - 25 audit_log readable by any member: "viewer reads none of A's rows (role-gated) — 2/2".
  - 26 the archive without the P1.7 files: "every leak-matrix entry names an existing themis table" (5 stale), then the
    fixture.
  - 27 select+update+delete `using (true)` on risks: UB reads, UB UPDATE and UB DELETE lines, and the viewer line.
  - 28 options_select locked to `false`: "UB reads all of B's own rows", "UA reads all", "viewer reads all", "UA writes".
  - `git diff supabase/` is empty.
- FINDINGS for the lead (product code NOT changed):
  - **BUG (latent): the bootstrap's `alter default privileges in schema themis revoke execute on functions from public`
    is a no-op.** Postgres cannot revoke a GLOBAL default (PUBLIC EXECUTE) per schema. Verified in PGlite: no
    `pg_default_acl` row is created, and a new `themis.probe()` has proacl NULL and anon EXECUTE = true. Every existing
    function is safe only because its migration revokes explicitly. The new gate line "PUBLIC has EXECUTE on no themis
    function" now catches any function that forgets to. The fix needs a builder decision: the global form without
    `in schema` would also change Hephaestus's future functions in the shared project, so the likely fix is to correct
    the bootstrap comment and BRAIN, and keep the explicit per-function revokes.
  - **Static guard gap:** DDL assembled from concatenated strings inside `do $$ … execute … $$` (mutations 18b and 19)
    passes `db:check`. The gate's public/auth diff and auth.users trigger checks catch it after apply.
- Passed: `npm run lint && npm run typecheck && npm test && npm run db:check && npm run db:gate`, all exit 0. 432 tests;
  the guard passes 6 files; the gate reports 290 PASS. No live Supabase; not pushed.
- Next: builder decides the default-privileges finding, then P1.9 (`db:gate:prove-red`). Mutation 13's lines and the FAIL
  names above are what P1.9 can grep for. Sabotage (f), dropping the scores composite FK, is caught by the scores
  cross-child line.

## 2026-09-28 — P1.9 prove the gate RED: `npm run db:gate:prove-red`

- Did: NEW `scripts/db-gate-prove-red.mjs` and the `db:gate:prove-red` script in `package.json`. No other file changed.
  `supabase/` and the gate are untouched.
  - **Sabotages are data.** `SABOTAGES` is an array in the script. Each entry has an `id`, the PLAN letter (a)–(f)
    where one applies, a description, the SQL, and `expect`: the gate red line(s) it MUST produce (substring or RegExp).
    There are 34: PLAN (a)–(f), the 28 P1.8 mutations rewritten (P1.8's SQL was never committed), and two P1.2 contract
    sabotages (non-idempotent DDL, and an apply error).
  - **Runner.** For each sabotage it copies `supabase/migrations/*.sql` into a fresh dir under
    `os.tmpdir()/themis-prove-red-*` and adds ONE file, `29991231235959_themis_zz_sabotage.sql`, which sorts last and
    passes the filename rule. It then runs `db-gate.mjs` with `DB_GATE_MIGRATIONS` as a child process. A sabotage
    counts as RED only if the exit code is exactly 1, every `expect` item matches a red line (`FAIL…`, `GATE FAILED`,
    `APPLY FAILED`, `MIGRATION GUARD FAILED`), and `GATE PASSED` is absent. A **control** run on the untouched copy must
    exit 0 with `GATE PASSED` and no FAIL line. Runs are parallel (default `min(8, cores)`; `--jobs N` or env
    `PROVE_RED_JOBS`), and `--only id,…` runs a subset for debugging. The temp root is removed in `finally`, on exit and on
    SIGINT/SIGTERM (0 leftover dirs after the runs). Output is one line per sabotage, then a PASSED/FAILED summary with
    the wall time. It exits 0 only if the control is green and all sabotages are red on their lines.
  - (d) `create table public.x` and (e) `create trigger … on auth.users` expect the static guard (`[forbidden-schema]`,
    `[auth-users-trigger]`) plus `GATE FAILED — the static migration guard is red`, which PLAN allows. Their string-built
    evasions (`public-function-evading-guard`, `auth-users-trigger-evading-guard`) expect the post-apply diff and
    auth.users trigger lines.
- Observed output (`npm run db:gate:prove-red`, 8 jobs, 24-core desktop):
  - `GREEN  control — the untouched archive copy: exit 0, GATE PASSED, 290 PASS`
  - (a) decisions-select-true: 3 FAIL, 3 expected; (b) scores-rls-disabled: 6 FAIL, 2 expected (RLS line "— scores" and
    "themis.scores: UB reads ZERO rows of A"); (c) table-without-leak-entry: "NO ENTRY: leaky" + RLS; (d) public-table:
    guard; (e) auth-users-trigger: guard; (f) scores-composite-fk-dropped: "themis.scores: UB's child row (workspace B)
    pointing at A's parent is refused".
  - The other 28 are all RED on their expected lines, including helper-returns-true (14 FAIL lines) and the two
    guard-blind evasions.
  - `PROVE-RED PASSED — 34/34 sabotages went RED on the expected FAIL line (PLAN P1.9 a, b, c, d, e, f included); control
    GREEN. Wall 45.1s.` Runs took 36–45 s (one gate run takes about 12 s alone, about 10 s each in parallel, about 0.2 s
    for guard-caught ones).
- The prover was proven too. My first run went `PROVE-RED FAILED — 31/34`, because three expectations named verdict
  lines that do not start with `FAIL`. The runner reported them as "red for the WRONG reason" and showed the lines it
  saw. That is why red lines now include the verdict lines. A scratch copy (in the scratchpad, not committed) replaced
  (f)'s SQL with a benign `comment on table`. It printed `WRONG (f) … the gate PASSED — the sabotage was not caught` and
  exited 1.
- Passed: `npm run lint && npm run typecheck && npm test && npm run db:check && npm run db:gate && npm run
  db:gate:prove-red`, all exit 0. 432 tests; the guard passes 6 files; the gate reports 290 PASS; prove-red 34/34 +
  control. No live Supabase; not pushed.
- Next: test-writer (if any: the script is its own proof), then P1.10 (CI runs `db:check`, `db:gate` and
  `db:gate:prove-red`), ∥ P1.11, P1.12. **A new gate check should come with a new `SABOTAGES` entry** that proves it
  red.

## 2026-09-28 — P1.10 CI runs the gates

- Did: edited only `.github/workflows/deploy.yml`. After `npm test` and before `npm run build`, the `verify` job runs three
  named steps: `Migration guard (db:check)`, then `Database gate (db:gate)` (timeout 5 min), then `Prove the gate RED
  (db:gate:prove-red)` (env `PROVE_RED_JOBS: '4'`, timeout 10 min). The job has `timeout-minutes: 20` and its name is
  now "Lint + typecheck + tests + db gates + build". Checked first: `main` has no branch protection and no rulesets, so
  no required check depends on the old name. `deploy` keeps `needs: verify`, so a red gate step fails `verify` and blocks
  the Pages deploy. No secret and no live-Supabase step (PGlite only).
- YAML: `npx --yes yaml-lint` → "YAML Lint successful". A parse with the `yaml` package shows the verify steps in order
  checkout, setup-node, npm ci, lint, typecheck, npm test, db:check, db:gate, prove-red, build, upload-pages-artifact.
  It also shows `deploy.needs = verify`.
- Timing (desktop, 4 jobs, the same as CI): db:check 1 s, db:gate 15 s, prove-red wall 52.5–53.1 s. On the 4-vCPU
  public runner I expect about 2–3 min in total for the gate steps, and the whole verify job should take about 4–5 min.
- Passed locally: `npm run lint && npm run typecheck && npm test && npm run db:check && npm run db:gate &&
  PROVE_RED_JOBS=4 npm run db:gate:prove-red`, all green. 432 tests; guard 6 files; GATE PASSED; `PROVE-RED PASSED —
  34/34 … control GREEN`.
- NOT pushed. The lead pushes this commit (the push needs the gh `workflow` scope, BRAIN §5) and watches the real CI
  run. The acceptance item "a PR run shows both steps green" can only be closed by that observed run.
- Next: the lead's push and the observed CI run, then P1.11 ∥ P1.12.

## 2026-09-28 — P1.11 `db:apply`: the Management-API applier

- Did: NEW `scripts/db-apply.mjs` (the applier, `run()` returns the exit code, every dependency injectable), NEW
  `scripts/lib/mgmt-api.mjs` (the only HTTP code: `POST https://api.supabase.com/v1/projects/{ref}/database/query`
  with `{query}` and a Bearer token; `fetch` injectable; every error redacted), `package.json` script `db:apply`,
  `.env.example` (the names `SUPABASE_ACCESS_TOKEN`, `THEMIS_SUPABASE_PROJECT_REF`, commented, no values). Tests:
  NEW `scripts/db-apply.test.ts` (35 tests, typechecked via `tsconfig.scripts.json`, which includes `scripts/**/*.test.ts`).
- Behaviour, in order:
  1. Flags: only `--apply`; anything else exits 2. Env: token or ref missing/empty exits 2 with the names and sends
     nothing. No .env file is read, no `supabase` CLI is spawned.
  2. The static guard (`checkMigrationsDir`, i.e. `db:check`) runs in-process; red → `REFUSED`, exit 1, zero requests.
  3. Ledger read: `select to_regclass('themis.schema_migrations') is not null` then `select version, name, checksum …`.
     Absent = nothing applied (no error-text parsing). Never reads or writes `supabase_migrations.*`.
  4. Refusals (exit 1, no migration sent): an applied file's sha256 changed; an applied version with no file; a pending
     file older than the newest applied one; a pending file with top-level transaction control (begin/commit/end/
     rollback/…, plpgsql bodies, strings and comments ignored); a PAIRED group with a member missing.
  5. Prints the PLAN (pending files, sha256 prefix, the pair marked), then sends. Dry-run (default): for unit k, ONE
     batch holding units 1..k ending in `rollback;`. `--apply`: ONE batch per unit ending in `commit;`, stop at the first
     error ("N committed before it; M later not attempted").
  6. Batch = `begin; set local lock_timeout = '5s'; set local statement_timeout = '60s'; <file>; insert into
     themis.schema_migrations (version, name, checksum) values (…); [next file of the pair + its insert]; commit|rollback;`.
  7. The response is an error if the status is not 2xx OR the body is not a JSON array (`{message}`/`{error}` payload,
     even on 200). Exit 1.
- The pair `20260928235000` + `20260928235500` is ONE unit = one transaction, so the audit_log trigger can never be live
  without its actor-erasure fix, even if the second file fails (proven on PGlite). Missing second file → refused.
- Checksum = sha256 of the text with CRLF normalised to LF (this desktop has core.autocrlf=true).
- Dry-run output shape (fake fetch, real archive, empty ledger):
  ```
  db:apply — DRY-RUN (every batch ends in ROLLBACK; nothing is committed) · project <ref> · ledger themis.schema_migrations
  PASS  migration guard: 6 migration(s) stay inside schema themis
  ledger: themis.schema_migrations does not exist — nothing applied yet
  PLAN  6 pending file(s) in 5 transaction(s):
     1. 20260928200000_themis_schema.sql  sha256 cf85be6e40d6…
     …
     5. 20260928235000_themis_ai_billing_audit.sql  sha256 b4bc915f3477…  [paired: one transaction]
        20260928235500_themis_audit_actor_erasure.sql  sha256 7cb7f63eb009…
  OK    dry-run 20260928200000_themis_schema.sql — rolled back
  OK    dry-run 20260928210000_themis_tenancy.sql (on top of 1 earlier pending unit(s)) — rolled back
  …
  DRY-RUN PASSED — 6 pending file(s) apply cleanly; everything was rolled back. Commit with: npm run db:apply -- --apply (operator's go only).
  ```
- Tests cover: missing env (both, each, empty) → exit 2 and zero requests; unknown flag; URL/method/Bearer header and the
  token nowhere else; dry-run plan + all batches `rollback;` + ledger untouched; cumulative dry-run; dry-run failure
  stops; batch shape (begin, both `set local`, file, then insert, then end; one `begin`); `--apply` one commit per unit
  and the ledger rows; PLAN printed before the first batch; no-op when all applied; pending detection (3 applied → 2
  units); checksum drift, missing file, out of order, guard red (zero requests), transaction control; the pair (one
  unit, one transaction, both inserts; missing B refused; B failing leaves A uncommitted; A pending after B refused);
  stop on first failure (2 committed, 3 not attempted); error payload on 200; token redaction in API errors, network
  errors, `MgmtApiError`, `redact()`, bad ref. Two tests run the real batches through PGlite + the `db:gate` shim:
  dry-run leaves no `themis` schema, `--apply` records all 6 with matching checksums while Hephaestus's 25 ledger rows
  stay, a re-run is a no-op; and a SQL error appended to 20260928235500 rolls back 20260928235000 too (no audit_log).
- Mutation check (scratch copies, restored): no redaction → 4 red; no pairing → 9 red; drift check off → 1 red; dry-run
  commits → 2 red; no stop on failure → 4 red.
- NOT run against any live project (no read either). No token was used; the fakes use a made-up marker.
- Passed: `npm run lint && npm run typecheck && npm test && npm run db:check && npm run db:gate`, exit 0. 467 tests
  (432 + 35); guard 6 files; GATE PASSED. `npm run db:apply` with no env → exit 2 (observed).
- Scope note: PLAN lists `scripts/db-apply.test.ts` under P1.12's test-writer; the lead asked for it here, so it landed
  with P1.11. P1.12's test-writer still owns `db-snapshot.test.ts`.
- Next: P1.12 (snapshot/diff), then P1.13 runbook. The live dry-run is an operator step (P1.13), not this task.

## 2026-09-28 — P1.12 read-only live snapshot and diff: `npm run db:snapshot` / `db:snapshot:diff`

- **Files:** NEW `scripts/db-snapshot.mjs`, NEW `scripts/db-snapshot-diff.mjs`, NEW `scripts/db-snapshot.test.ts` (84 tests).
  Also `package.json` (scripts `db:snapshot`, `db:snapshot:diff`) and `.gitignore` (`ops-snapshots/`). No migration.
- **`npm run db:snapshot -- <label>`:**
  - Env: `SUPABASE_ACCESS_TOKEN` and `THEMIS_SUPABASE_PROJECT_REF`. If either is missing, or the label is bad, it exits 2
    and sends nothing.
  - It sends 14 catalogue SELECTs through `scripts/lib/mgmt-api.mjs`, the P1.11 client. It does not have an HTTP client
    of its own.
  - It writes `ops-snapshots/<iso with : and . as ->-<label>.json`. An API error exits 1 and writes no file. The token
    is redacted everywhere.
- **Read-only by construction:**
  - `readOnlyClient` → `assertReadOnly` accepts only ONE plain `select`, with no `$`, `"`, `\` or comments and no
    write/lock/session words.
  - Only allow-listed pure functions may be called.
  - FROM/JOIN targets are only `pg_catalog.*`, `information_schema.*` and `supabase_migrations.schema_migrations`
    (version only). Comma joins are refused.
  - `takeSnapshot` validates every query before it sends the first one.
- **Sections:** schemas (all non-system), relations, constraints, policies, functions, triggers, types, default_acl,
  extensions, roles, role_settings, publication_tables, event_triggers, migrations_ledger. Object-level detail covers
  public/auth/storage/supabase_migrations/themis. Every row carries `schema`, the schema that owns it (null =
  database-level). Internal FK triggers belong to the schema of their constraint. `pgrst.db_schemas` is split into one
  row per schema.
- **Summary block (human-readable):**
  - `themisSchemaExists` and `themisObjects`;
  - `supabaseMigrations {count, maxVersion}`;
  - `authUsersTriggers [{name, owner, internal}]`;
  - `public {tables, policies, functions, triggers}`;
  - `extensions`;
  - `exposedSchemaFacts`.
- **`npm run db:snapshot:diff -- <before> <after>`** (a file, or a label → the newest `ops-snapshots/*-<label>.json`):
  - Rows are matched per section key.
  - Output: `+`/`-`/`~` lines, split into "inside themis (allowed)" and "OUTSIDE themis".
  - Exit 0 when nothing outside themis changed and 1 when something did. Exit 2 on usage errors, an unreadable file, a
    different project or format, or a missing section.
- **Tests (84), all without network:**
  - Every section passes the checker, and 36 hostile statements are refused, among them DML, DDL, `select into`,
    `for update/share`, a data-modifying CTE, `set_config`, `pg_sleep`, `nextval`, user functions, public/auth reads,
    reads through a join, a subquery or a comma join, dollar quoting, comments, E-strings and unbalanced parens.
  - A refused statement sends zero requests, and a bad LAST section also means zero requests.
  - On a fake fetch: usage, env, the URL and Bearer header, the file name and JSON shape, API errors (exit 1, no file,
    token redacted), and a non-array payload.
  - The diff, as a pure function and through the CLI: label resolution picks the newest file, and it exits 0, 1 or 2.
  - **On PGlite + the db:gate shim**, every SELECT parses and returns the expected shape. The real archive is applied by
    the real `db:apply --apply`, and adding `themis` to `pgrst.db_schemas` puts ALL 500+ changes under themis, with 0
    outside. The RI triggers on auth.users from themis FKs are attributed to themis.
  - 10 RED cases: a public table, a trigger on auth.users, a changed public policy, RLS turned off on a public table, a
    Hephaestus ledger row, a global default privilege, a new schema, an exposed schema removed, a new extension (bloom
    contrib), and a changed auth.users column.
- **Mutation check** (on scratch backups, then restored):
  - RI attribution off → 1 red;
  - readOnlyClient without the check → 1 red;
  - no pre-validation → 1 red;
  - relation allow-list off → 6 red;
  - diff counting null-schema changes as inside → 3 red;
  - no pgrst split → 2 red.
- **Exercised (§5):** a scratch script wrote pre/post/sabotaged snapshots from PGlite into `ops-snapshots/`.
  - `node scripts/db-snapshot-diff.mjs pre post` → `inside themis (allowed): 518 change(s)` … `DIFF PASSED`, exit 0.
  - `pre sabotaged` (plus `create table public.leak`) → `OUTSIDE themis: 1 change(s)  + relations: public | leak`,
    `DIFF FAILED`, exit 1.
  - `git check-ignore` confirms that `ops-snapshots/` is ignored. The scratch files were then removed.
  - `npm run db:snapshot` with no label → usage, exit 2. With empty env → "missing env … nothing is sent".
- **NOT run against any live project.** No token was used.
- **Passed:** `npm run lint && npm run typecheck && npm test && npm run db:check && npm run db:gate`, chain exit 0. That
  is 551 tests (467 + 84), the guard on 6 files, and GATE PASSED.
- **Note for P1.13:** the exposed-schema list itself is PostgREST config. Read it with `GET /v1/projects/{ref}/postgrest`
  in the runbook, because the SQL snapshot only sees schema ACLs and any `pgrst.db_schemas` role setting.
- **Next:** P1.13, the runbook and the pre-apply evidence pack.

## 2026-09-28 — P1.13 live-apply runbook and pre-apply evidence pack (`docs/ops/LIVE_APPLY.md`)

- **Attempted:** the runbook for the first live apply to Hephaestus's shared project `atopkqykdmrcfvvcistc`, with a
  rollback for every step, and the pre-apply evidence pack. The only new file is `docs/ops/LIVE_APPLY.md`. No script,
  migration or test changed.
- **No live contact.** No token exists on the desktop and none was used. The connector was not called. Every output in
  the doc comes from PGlite or from a local fake HTTP server.
- **What the runbook covers:**
  - Two transports:
    - **A:** the repo scripts, with a short-lived PAT that is exported for the session and revoked after it.
    - **B:** the operator's Supabase connector, using `execute_sql` only and NEVER `apply_migration`, which writes
      Hephaestus's `supabase_migrations` ledger. Three helper heredocs print the exact batch and snapshot SQL to
      gitignored files, using the scripts' own exports (`plan`, `buildBatch`, `SECTIONS`, `takeSnapshot`). In B, the
      exposed-schema steps are done in the Dashboard.
  - 8 steps:
    1. `db:snapshot pre`;
    2. read the exposed list (`GET /v1/projects/{ref}/postgrest`, printing only `db_schema` / `db_extra_search_path` /
       `max_rows`, because the body carries the JWT secret);
    3. `db:apply` dry-run, plus a proof that nothing survived;
    4. `db:apply --apply`, plus a ledger/checksum re-check;
    5. `db:snapshot post` + diff, the gate for step 6;
    6. expose `themis`: an idempotent snippet that refuses unless the live list still equals the recorded one, and
       appends `themis` LAST, because the first schema is the default profile. It is flagged project-wide, shared with
       Hephaestus;
    7. `db:snapshot exposed` + a second diff;
    8. the Hephaestus regression.
  - The paired-migration rule (unit 5 = one transaction, never split).
  - A rollback table covering each step, the apply failing midway (units 1..k-1 committed, unit k rolled back whole,
    the partial schema inert and unexposed), and the destructive last resort. That last resort needs its own
    approval; it comes with a PGlite-tested "nothing outside themis depends on it" query.
  - Follow-ups for the lead: `db:apply --print`, `db:snapshot --from-raw`, `db:postgrest`. They are out of P1.13's
    file scope, so they were not built.
- **Evidence (§7 of the doc, all at `0dc46ae`):**
  - `db:check` PASS on 6 files.
  - `db:gate`: 290 PASS, 0 FAIL, `GATE PASSED` (the full output is in the doc).
  - `db:gate:prove-red`: 34/34 RED plus a GREEN control, wall 50.1 s.
  - A local rehearsal of the REAL `db:apply run()` on PGlite + the shim through a fake fetch:
    - the dry-run made 6 requests and left no schema `themis`;
    - `--apply` made 6 requests and recorded all 6 versions with checksums, leaving Hephaestus's ledger at 25 rows;
    - a re-run printed `PLAN  nothing pending`.
  - Transport-B helpers: all 10 batch files are byte-identical to `db:apply`'s request bodies, and running them in order
    gives the same ledger. The assembled snapshots are deep-equal to `takeSnapshot()` (106 and 624 rows), and
    `db:snapshot:diff` exits 0.
  - The PostgREST snippets against a fake `/postgrest` (whose body contained a fake `jwt_secret`, never printed):
    - get; a refused wrong or placeholder `RECORDED`; expose; an idempotent re-expose; unexpose; an idempotent
      re-unexpose; a bad MODE (exit 2); a 401 (exit 1);
    - the PATCH bodies were only `{"db_schema": …}`.
  - Finally, the five heredoc blocks were extracted from the doc itself and re-run, with the same results.
  - Hephaestus baseline: `D:/projects/lss-platform` at `4573d80`, `npm test` 721/721 in 57 files. Nothing written there.
  - Reference post-apply object list: 18 tables, 43 indexes, 5 functions, 43 policies.
- **Found:**
  - (1) PLAN's step order exposed `themis` before it existed. The runbook now exposes it after the apply and after a
    clean diff (DECISIONS.md P1.13).
  - (2) Hephaestus's `e2e/tenant-isolation.spec.ts` is NOT read-only: it signs up 2 users and creates orgs in whatever
    project `.env` names, which is the shared `auth.users` on live. There is no `rls-isolation` e2e; that is a static
    Vitest suite that never touches a DB. So `npm test` in lss-platform cannot see the live DB, and the live proof is
    the two diffs, `deploy-smoke` against the live URL, Data API probes and an operator sign-in.
  - (3) Node on Windows crashes with a libuv assertion (exit 127) on `process.exit()` right after `fetch`, even when
    the PATCH succeeded. The snippets use `process.exitCode`.
  - (4) The exposed-schema value cannot be recorded before P1.14, because reading it is live contact. Step 2 records
    it in this log at P1.14.
- **Passed:** `npm run lint && npm run typecheck && npm test && npm run db:check && npm run db:gate`, chain exit 0: 551
  tests, the guard on 6 files, GATE PASSED. `prettier --check docs/ops/LIVE_APPLY.md` is clean.
- **Blocked:** nothing.
- **Next:** CHECKPOINT P1-LIVE (below). Nothing touches the live project before the operator's go.

## CHECKPOINT P1-LIVE — 2026-09-28 — awaiting the operator's go / no-go (CLAUDE.md §7)

**The ask.** Go or no-go for P1.14, which does two things to Hephaestus's LIVE Supabase project `lss-platform`
(`atopkqykdmrcfvvcistc`, eu-west-1):

1. Apply the 6 Themis migrations (5 transactions) into a new schema `themis`, tracked in `themis.schema_migrations`.
2. Append `themis` to the Data API's exposed schemas. This is a project-wide setting that Hephaestus shares.

**What would change.** Nothing outside `themis` except the exposed-schema list. The procedure is
`docs/ops/LIVE_APPLY.md`: 8 steps, two snapshot diffs, a rollback for every step.

**Evidence on hand:**

- The gates are green:
  - `db:check`;
  - `db:gate` (290 PASS);
  - `db:gate:prove-red` (34/34 RED);
  - 551 tests.
- A PGlite rehearsal of the real applier: the dry-run leaves nothing, the apply records 6 versions, and Hephaestus's
  ledger is untouched.
- The transport-B helpers are proven byte-identical to the applier.
- The PostgREST snippets were exercised against a fake API.

**Not available until go:** the live dry-run output and the current exposed-schema value. Both need live contact.

**Decisions needed from the operator:**

1. **Transport.**
   - A (recommended): mint a short-lived personal access token for the session, and revoke it after.
   - B: the Supabase connector with `execute_sql` only, and the Dashboard for the exposed list.
2. **The reordered steps.** Expose AFTER the apply and a clean diff, plus a second diff after exposing. PLAN P1.13
   listed the exposure before the apply.
3. **A window and a Hephaestus freeze.** Hephaestus has production migrations pending (`…019`–`…025`, its BRAIN).
   Push them before step 1, or not before step 8. No Hephaestus deploy runs in between. Each batch briefly locks
   `auth.users` (about a second; 5 s lock timeout).
4. **The Hephaestus regression set.** PLAN named the `tenant-isolation` and `rls-isolation` e2e "read-only against
   live". `tenant-isolation` WRITES (it signs up users into the shared `auth.users`), and `rls-isolation` is a static
   unit suite. The runbook uses instead: Hephaestus `npm test` (a baseline of 721/721), `deploy-smoke` against
   https://lss-platform.netlify.app, Data API probes pre and post, and an operator sign-in. Running `tenant-isolation`
   live needs a separate yes and a cleanup plan.
5. **The PLAN's spec discrepancies:**
   - the domain `themis.adeonanalytics.com`;
   - the `themis-*` function names;
   - the `THEMIS_*` secret names;
   - the logo stored in the table.

   Also: `plans` goes live seeded with the §4 PROPOSAL values (marked UNCONFIRMED; P4.9 changes them).

6. **Push P1.13 first.** P1.10–P1.12 are on `origin/main`, and CI (lint, typecheck, tests, db:check, db:gate,
   db:gate:prove-red, build, deploy) is green on them: runs 36468009365, 36469834636 and 36472021027. P1.13 (this doc)
   is a local commit. The recommendation is to push it and apply from a commit whose CI run is green.

**The crew waits here. P1.14 does not start without the operator's go.**

## 2026-09-28 — P2.1 secret boundary: lint rule and bundle scan (`npm run check:bundle`)

Dispatched by the lead while CHECKPOINT P1-LIVE is still open. PLAN lists "P1 claimed" as a dependency, but P2.1 touches
no schema and no live service, so it runs in parallel with the checkpoint. Nothing live, nothing pushed.

**Files:** `eslint.config.js`, `scripts/check-bundle-secrets.mjs` (NEW), `package.json` (script `check:bundle`),
`.github/workflows/deploy.yml` (a `check:bundle` step right after `build`, before the Pages artifact upload).

**Lint rule** (`no-restricted-syntax`, files `src/**/*.{ts,tsx,js,jsx,mjs,cjs}`, so `supabase/functions/**`,
`scripts/**` and `e2e/**` are outside it). It errors on reads of
`/^(THEMIS_)?(ANTHROPIC_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)$|^SUPABASE_SERVICE_ROLE_KEY$|^SUPABASE_ACCESS_TOKEN$/`
and of any `VITE_*` name outside the allow-list (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`VITE_STRIPE_PUBLISHABLE_KEY`, `VITE_FLEET_*`). It covers `import.meta.env.X`, `process.env.X`, the bracket forms
`['X']`, and destructuring `const { X } = import.meta.env`. Vite built-ins (`BASE_URL`, `MODE`, ...) are unaffected.

**Bundle scan** (`npm run check:bundle` = `node scripts/check-bundle-secrets.mjs [dir]`, default `dist/`). It reads
every file in the dir and fails (exit 1) on: `sk_live_`, `sk_test_`, `rk_live_`, `rk_test_`, `whsec_`, `sk-ant-`,
`sb_secret_`, `sbp_`, the literal `service_role`, a JWT whose decoded payload has `"role":"service_role"`, and any
server-only env name (bare or `THEMIS_`). Values print masked. A missing or empty dir exits 2, so a scan of nothing
cannot pass. `pk_live_`/`pk_test_` and an anon JWT are not findings.

**RED evidence (all fixtures removed afterwards; `git status` shows only the 4 scoped files):**
- Lint: a fixture `src/secret-fixture.ts` with 17 violations (all 8 names via `import.meta.env`, 2 via `process.env`,
  2 bracket reads, 1 destructure, 4 `VITE_*` outside the list) and 7 allowed reads (`VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`, `VITE_STRIPE_PUBLISHABLE_KEY`, `VITE_FLEET_TELEMETRY_URL`, `BASE_URL`, `MODE`,
  `THEMIS_ANTHROPIC_API_KEY_HINT`). `npm run lint` gave **17 errors, exit 1**, exactly lines 3–19; the 7 allowed lines
  were clean. The same file copied into `scripts/`, `supabase/functions/themis-fixture/` and `e2e/` gave no error.
- Scan on a REAL build: `src/main.tsx` temporarily logged three ALLOWED names (so lint stayed clean), and the build
  ran with fake values: `VITE_STRIPE_PUBLISHABLE_KEY=sk_live_FAKE...`, `VITE_SUPABASE_ANON_KEY=<locally minted
  unsigned JWT with role service_role>`, `VITE_FLEET_NOTE=THEMIS_ANTHROPIC_API_KEY`. `npm run check:bundle` gave
  **3 findings (secret-value, service-jwt, forbidden-name), exit 1**. `main.tsx` was restored and rebuilt → OK.
- Per-rule: a string injected into `dist/assets/` exits 1 for each of `sk_test_`, `whsec_`, `sk-ant-`,
  `"service_role"`, `sb_secret_`, `sbp_`, `rk_live_`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ACCESS_TOKEN` and
  `STRIPE_WEBHOOK_SECRET`; it exits 0 for `pk_live_`, `pk_test_`, `task_test_` and `VITE_SUPABASE_ANON_KEY`. A missing dir
  and an empty dir each exit 2.

**Green:** `npm run lint && npm run typecheck && npm test` (551) `&& npm run db:check && npm run db:gate && npm run build
&& npm run check:bundle` → all pass (the scan covers 10 files, 593,703 bytes).

**Notable:** the argus-news reference selector `MemberExpression[object.type='MetaProperty'] > Identifier[...]` never
matches `import.meta.env.X`. The outer MemberExpression's object is another MemberExpression (`import.meta.env`), not
the MetaProperty. Proven with the ESLint Linter API: only its `process.env` form fired. The Themis rule matches on
`object.object.type='MetaProperty'` and `object.property.name='env'`. argus-news is out of scope here; this is
reported to the lead.

**CI:** the workflow edit needs the gh `workflow` scope to push (BRAIN §5). The step is untested on Actions until then.

**Next:** test-writer (unit tests for `scanText`/`scanDir`, and a lint-rule test through the ESLint API), then P2.2/P2.3.


## 2026-09-28 — P2.1 tests (test-writer): permanent coverage for the secret boundary

**Added (116 tests, both `// @vitest-environment node`, typechecked via `tsconfig.scripts.json`):**

- `scripts/check-bundle-secrets.test.ts` (42). `scanText` flags each of the 8 secret prefixes (`sk_live_`, `sk_test_`,
  `rk_live_`, `rk_test_`, `whsec_`, `sk-ant-`, `sb_secret_`, `sbp_`) with rule, line and column, and the full value never
  appears in the findings (masked excerpt). It also flags the literal `service_role`, a runtime-minted unsigned JWT with
  `role: service_role` (the literal is asserted absent first, so only the decoder can catch it), and each of the 8 server-only
  NAMES (`forbidden-name`, reported once). NOT flagged: `pk_live_`/`pk_test_`, an anon-role JWT, a non-JSON JWT shape,
  `VITE_SUPABASE_ANON_KEY`/`_URL`/`VITE_STRIPE_PUBLISHABLE_KEY`, `task_test_`, a bare prefix with no body, and longer
  identifiers that contain a name. `scanDir` on temp dirs: a clean build is ok; a planted nested file gives a finding with
  path `assets/chunks/leak.js`; a secret behind non-UTF-8 bytes in a `.map` is found; a missing dir, a file path, an empty dir
  and a dir of empty subdirs each throw. The CLI is spawned for real: exit 2 on missing and on empty, 0 on clean, 1 on a
  finding (stderr `a.js:1:4 [secret-value]`, value absent from output).
- `scripts/eslint-secret-boundary.test.ts` (74). Runs the REAL `eslint.config.js` through `new ESLint({ cwd, overrideConfigFile })`
  + `lintText`, and keeps only `no-restricted-syntax` hits. Any fatal parse error fails the test, so "no hits" cannot pass
  vacuously. In `src/`, all 8 names error in all 6 forms (`import.meta.env.X`, `process.env.X`, both bracket forms, both
  destructures). The rule applies to `.ts/.tsx/.js/.jsx/.mjs/.cjs`, and a multi-read file reports the right lines. Unlisted
  `VITE_*` errors, including `VITE_FLEET_` with an empty suffix and `VITE_SUPABASE_URL_OVERRIDE`. The allowed names, `VITE_FLEET_*`,
  `BASE_URL`, `MODE`, `DEV` and `PROD` are clean in every form. The combined all-forbidden fixture has 49 errors in `src/`
  and 0 in `scripts/ops.ts`, `scripts/lib/ops.mjs`, `e2e/live/auth.spec.ts` and `supabase/functions/stripe-webhook/index.ts`.
  There is an explicit argus-news regression test: `import.meta.env.ANTHROPIC_API_KEY` in `src/` MUST error.

**Mutation evidence (each restored; `git diff eslint.config.js scripts/check-bundle-secrets.mjs` empty afterwards):**
- `META_ENV` weakened to argus-news's `[object.type='MetaProperty']` gave **26 failed / 48 passed**. Every `import.meta.env`
  dot and bracket test failed, including both regression tests, the `.ext` test, the multi-line test, the 5 VITE dot/bracket
  tests and the combined precondition. The `process.env` and destructure tests stayed green, as they should, because those
  selectors do not use `META_ENV`.
- The rule's `files` widened to `**/*` gave **4 failed**: the 4 server-side-path tests.
- The scan's `(?<![A-Za-z0-9])` lookbehind removed gave **1 failed**: the `task_test_` test.

**Green:** `npm run lint && npm run typecheck && npm test` (**667**, was 551) `&& npm run db:check && npm run db:gate &&
npm run build && npm run check:bundle` → all pass (10 files, 593,703 bytes scanned).

**Not a product bug:** a `.cjs` fixture using `export` is a parse error (sourceType commonjs), so the `.cjs` case uses
`module.exports = process.env.X`.

**Next:** P2.2 / P2.3.


## 2026-09-28 — P2.2 (builder): Supabase client and local-only fallback

**Files:** `package.json` + `package-lock.json` (dep `@supabase/supabase-js` ^2.117.2, via `npm install`), NEW
`src/lib/env.ts`, NEW `src/lib/supabase.ts`, `.env.example`. No migration, no tenant data, and nothing else in `src/`
changed. `App.tsx` and `main.tsx` are untouched, so the P0 matrix is literally the same code.

- `src/lib/env.ts`: `resolveAppEnv(raw)` is pure and never throws. It returns `{ mode: 'configured', supabase: { url,
  anonKey } }` only when BOTH `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are non-blank and the URL is an absolute
  http(s) URL. Otherwise it returns `{ mode: 'local', reason: 'missing-url' | 'missing-anon-key' | 'invalid-url' }`.
  `appEnv` and `isLocalOnly` are resolved once, from the two names read by their full literal names. It never passes
  `import.meta.env` as a whole object, because Vite would then inline every `VITE_*` var into the bundle. A
  `declare global` types the two names as `string | undefined` instead of Vite's `any`.
- `src/lib/supabase.ts`: `THEMIS_CLIENT_OPTIONS = { db: { schema: 'themis' }, auth: { persistSession: true,
  detectSessionInUrl: true, flowType: 'pkce' } }`, `createThemisClient(config)`, `clientFor(env)` (null in local mode)
  and `supabase` (`ThemisClient | null`). In local-only mode createClient is never called, so there is no throw
  (createClient throws on an empty URL) and no request.
- `.env.example`: names only. It now documents that both unset = local-only mode and that the value is the ANON key.

**Exercised (a scratch probe, not committed, in the session scratchpad):** Vite built `src/lib/supabase.ts` as an ES lib
twice. (a) With no env, `node` imports it OK and `supabase = null (local-only)`. (b) With
`VITE_SUPABASE_URL=https://example.invalid` and a fake anon key, it imports OK. It gives `from('decisions')` schema =
`themis` and `rpc('x')` schema = `themis`, rest URL `https://example.invalid/rest/v1/...`, `auth.flowType = pkce`, and
persistSession and detectSessionInUrl true. No request was sent (a query builder was never awaited).

**`service_role` in supabase-js (the BRAIN §5 watch item): no hit, and no exception added.** The literal appears in
`@supabase/auth-js` `GoTrueAdminApi` (17×) and `@supabase/storage-js` (4×), ONLY inside JSDoc comments ("Never expose
your `service_role` key in the browser"). The build strips comments. A minified app-mode probe build of the client
(214.97 kB, 55.30 kB gzip) has **0** occurrences, and `check:bundle` on it, on the local probe and on the configured probe
exits **0**. The scan is unchanged.

**Bundle-size delta: 0 bytes today.** Nothing imports `supabase.ts` yet (P2.10 wires the UI), so Rollup tree-shakes it.
The build emits the byte-identical `dist/assets/index-DhFmrpjC.js` (234.29 kB, 73.46 kB gzip) as before the install.
Expect roughly +215 kB raw and +55 kB gzip when P2.10 imports it (from the probe; the shared runtime makes the real number
a little lower).

**Green:** `npm run lint && npm run typecheck && npm test` (667) `&& npm run db:check && npm run db:gate && npm run build
&& npm run check:bundle` → all pass (10 files, 593,703 bytes scanned). No live Supabase call, and not pushed.

**Next:** test-writer writes `src/lib/env.test.ts` (missing → local for each reason, present → configured; a
`supabase.ts` test can use `vi.stubEnv` plus `vi.resetModules` to assert `supabase === null` with no env). Then P2.3.
For P2.10: re-run `check:bundle` after the first real import. If a future supabase-js ever ships `service_role` outside a
comment, add a narrow exception keyed to that exact occurrence, with a test. Never widen the rule.

### P2.2 tests (test-writer) — 2026-09-28 — RED on a real env.ts bug, NOT committed

**Added (uncommitted, in the working tree):**
- `src/lib/env.test.ts` (25 tests): every resolveAppEnv branch. Covers missing url, blank or whitespace url, both
  missing (url is checked first), missing key, blank or whitespace key, relative path, host without a scheme, garbage,
  `https://` alone, ftp/ws/javascript/file schemes, valid https, valid `http://localhost:54321`, and trimming. An
  odd-input block feeds explicit undefined, numeric url, numeric key, booleans and nulls, and asserts no throw and local mode.
- `src/lib/supabase.test.ts` (11 tests): the exact THEMIS_CLIENT_OPTIONS shape (toStrictEqual). clientFor(local) → null
  for all 3 reasons. clientFor(configured): `.from('decisions')` has schema `themis` and path `/rest/v1/decisions`, and
  `.rpc('x')` has schema `themis` and path `/rest/v1/rpc/x`. Auth is flowType pkce with persistSession and
  detectSessionInUrl true. Module-level (vi.stubEnv + vi.resetModules): unset → `supabase === null`, and import does not
  throw. Url only → null. Malformed url → null. Both set → a themis-pinned client. Global fetch is stubbed in every
  test, and each test asserts zero calls after the auth initialize settles.

**Mutation evidence (each restored; `git diff src/lib/*.ts` empty):** THEMIS_SCHEMA → 'public' gives 4 red. The http(s)
protocol check removed (ftp etc. → configured) gives 4 red. flowType → 'implicit' gives 2 red. clientFor always creates a
client gives 8 red. createThemisClient fires a `.select()` on creation gives 4 red (the fetch-spy assertions work).

**BUG (builder to fix, src/lib/env.ts):** `resolveAppEnv` is documented "Pure: never throws", but it throws
`TypeError: raw.VITE_SUPABASE_URL?.trim is not a function` on a non-string value (number/boolean). `?.` only guards
null/undefined. 3 tests are red: numeric url, numeric key, boolean values. Suggested fix: coerce with
`typeof v === 'string' ? v.trim() : ''`. The tests were NOT weakened.

**Suite:** lint OK, typecheck OK, `npm test` 700/703 (only the 3 bug tests red), db:check PASS, db:gate PASSED, build OK
(bundle unchanged, `index-DhFmrpjC.js`), check:bundle OK. Flake noted: one full run had `scripts/eslint-secret-boundary.test.ts`
"import.meta.env.ANTHROPIC_API_KEY in src/ MUST error" fail once. It passed 74/74 alone and on the next full run, so it is
likely timing under load. Watch it.

**Next:** builder fixes env.ts. Re-run the suite, then commit these two test files as `test: ...` (P2.2).

## 2026-09-28 — P2.2 fix: resolveAppEnv never throws on non-string input; eslint test warm-up

- The test-writer found `resolveAppEnv` threw `TypeError ... trim is not a function` on a number or boolean, which breaks its "never throws" contract. Fixed with a `typeof` check, so a non-string now means local-only. The 3 red tests are green, and the suite is 703/703.
- The flaky first test in `eslint-secret-boundary.test.ts` came from a cold ESLint load under a parallel run. `beforeAll` now warms up with one `lintText` (60 s hook budget). 3 consecutive full runs were green.

## 2026-09-28 — P2.3 (builder): routing and SPA fallback on Pages

**Files:** `package.json` + `package-lock.json` (dep `react-router-dom` ^7.18.4), `src/main.tsx`, NEW
`src/routes/routes.tsx` (route table + `basenameFrom`), NEW `src/routes/AppRoutes.tsx` (`useRoutes`), NEW
`src/routes/pages.tsx` (route shells), `vite.config.ts` (`spaFallback()` plugin). `src/App.tsx` is UNCHANGED: it is
mounted as the `/` element as-is. No migration, no live service, nothing pushed.

**What it does:**
- Routes: `/` (the P0 matrix), `/signin`, `/auth/callback`, `/w/:workspaceId/*`, `/invite/:token`, plus `*` (an in-app
  "Page not found"). The non-`/` routes are honest shells ("Accounts are not live yet…") that P2.10–P2.12 replace.
  `AuthCallbackRoute` never navigates or rewrites the URL, so `?code=` is left for P2.10's `detectSessionInUrl`.
- `BrowserRouter` with `basename = basenameFrom(import.meta.env.BASE_URL)` ('/' today, '/themis' if the app moves back
  under a path, so the ADR-0003 one-line rule still holds).
- `spaFallback()` (Vite plugin, build only, `writeBundle`) copies `dist/index.html` to `dist/404.html`. GitHub Pages
  serves `404.html` for any path without a file, so every deep link boots the app. It is a COPY, not the
  `404.html → /?p=…` redirect trick, so the requested URL (with a PKCE `?code=&state=`) is never rewritten. Asset URLs
  in index.html are absolute (`/assets/…`, base '/'), so they resolve at any depth. No CI or build-script change needed:
  the plugin runs inside `npm run build`.

**PKCE check (the lead's question):** the plan requires `/auth/callback` to survive a hard load (P2.3) and P2.2 set
`flowType: 'pkce'` + `detectSessionInUrl`. With the copy approach there is NO redirect at all: the browser stays on
`/auth/callback?code=…`, and nothing in the route consumes or strips the query. Proven in a scratch MemoryRouter probe
(location after render = `/auth/callback?code=abc&state=x`) and by headless Edge rendering `/auth/callback?code=abc123`.

**Bundle:** `index-*.js` 234.29 kB → **274.79 kB** (87.14 kB gzip, +40 kB raw / +14 kB gzip). The data router
(`createBrowserRouter` + `RouterProvider`) measured 329.29 kB (103.95 kB gzip, +95 / +30), so the declarative
`BrowserRouter` was chosen (DECISIONS.md P2.3).

**Exercised (§5, observables):**
- `cmp dist/index.html dist/404.html` → identical after `npm run build`.
- `npx vite preview --port 4173` (PID 16952, killed with `taskkill //PID 16952 //T //F`, port confirmed free): curl with
  `Accept: text/html` on `/`, `/auth/callback`, `/auth/callback?code=abc123&state=xyz`, `/signin`, `/w/ws-1/decisions/9`,
  `/invite/tok123`, `/no/such/page` → every one **200** with `<title>Themis — Decision Intelligence Platform</title>`,
  `<div id="root"></div>` and `/assets/index-CoergQmW.js`; that asset → 200. Headless Edge `--dump-dom`:
  `/auth/callback?code=abc123&state=xyz` → `<h1>Signing you in</h1>`; `/w/ws-1/x` → `<h1>Workspace</h1>` + `ws-1`;
  `/` → the matrix's `<h1><span class="sr-only">THEMIS`.
- **vite preview has its own SPA fallback** (appType 'spa'), so it proves the router, not `404.html`. A scratch
  Pages emulator (static files only, else `404.html` with status 404, no rewrites; PID 6792, killed, port free):
  `/` → 200 shell; `/auth/callback?code=abc123&state=xyz` → **404 + the app shell**; `/invite/tok` → 404 + shell;
  headless Edge on `/auth/callback?code=abc123` renders `Signing you in`. Control: with `dist/404.html` moved away the
  same URL gives `PAGES DEFAULT 404: File not found` — so the fallback file is what makes the deep link work.
- Scratch route probe (7 tests via MemoryRouter, deleted after; permanent coverage is the test-writer's): `/` shows the
  matrix, each shell renders, `/w/ws-1/decisions/9` shows `ws-1`, unknown → not found, `basenameFrom('/')='/'`,
  `basenameFrom('/themis/')='/themis'`.

**Green:** `npm run lint && npm run typecheck && npm test` (**703/703**, the 16 P0 App/model tests included, unchanged)
`&& npm run db:check && npm run db:gate` (GATE PASSED) `&& npm run build && npm run check:bundle` (OK, 11 files — 404.html
is now scanned too). No live Supabase; local-only mode is still the default (no env → no client).

**Next:** test-writer for P2.3 — `src/routes/*.test.tsx` (each route via MemoryRouter; `/auth/callback?code=` keeps its
query; `*` → not found; `basenameFrom`), and a build-level check that `dist/404.html` equals `dist/index.html` (e.g. call
`spaFallback()`'s hooks on a temp dir, or assert after a build). Then P2.4: note that Pages answers deep links with
HTTP **404** (body = app), so a Playwright deep-link spec must assert the rendered app, not `response.ok()`.


## 2026-09-28 — P2.3 tests (test-writer): routing + Pages SPA fallback

**Added (no product code changed):**
- `src/routes/routes.test.tsx` (jsdom, 20 tests). Each case renders the real route table (`AppRoutes`) in a `MemoryRouter`
  with `initialEntries`, plus a `LocationProbe` that prints `useLocation()`.
  - `/` renders the P0 matrix (THEMIS h1, Agile preset selected, Customer value criterion, Planned modules list).
  - `/signin`, `/auth/callback` and `/invite/:token` each render their shell. `/w/ws-123` shows the id.
    `/w/ws-1/decisions/9` (nested) shows `ws-1` and is not "not found". `/invite` with no token → not found.
  - Unknown paths (`/no/such/page`, `/signin/extra`, `/auth`, `/w`) render "Page not found". The `*` route is last and
    appears exactly once.
  - **PKCE:** `/auth/callback?code=abc&state=x` → the location after render is exactly
    `{pathname:'/auth/callback', search:'?code=abc&state=x', hash:''}`. An encoded `error_description` query survives
    byte for byte.
  - `basenameFrom`: `'/'→'/'`, `'/themis/'→'/themis'`, `'/themis'`, `'//'→'/'`, `'/a/b/'`. A MemoryRouter with
    `basenameFrom('/themis/')` matches `/themis/signin`.
- `scripts/spa-fallback.test.ts` (node env, 5 tests). It drives the real exported `spaFallback()` through Vite's `build()`
  API (`configFile:false`) into an OS temp dir, never dist/. Checks:
  - `404.html` `Buffer.equals` the built `index.html` (built, with a hashed asset URL, not the source file).
  - A custom `build.outDir` is honoured.
  - `apply === 'build'`.
  - The real `vite.config.ts` registers `themis-spa-fallback` and has `base: '/'`.
  - No refactor was needed: `spaFallback` was already exported.

**Mutation evidence** (each applied to product code, run, then reverted with `git checkout --`; the final `git diff` of
product files is empty):
1. Removed the `*` catch-all route → 6 RED (the 4 unknown paths, `/invite` without a token, and the catch-all-last check).
2. `spaFallback` writes `fallback.html` instead of `404.html` → 2 RED (byte-identical, custom outDir).
3. Removed `spaFallback()` from `plugins` in vite.config.ts → 1 RED (registers spaFallback).
4. `AuthCallbackRoute` does `navigate('/auth/callback', {replace:true})` on mount → 2 RED (search `''` instead of
   `?code=abc&state=x`).

**Hiccup:** the first version flattened the plugin list with `.flat(Infinity)`. Vitest ran it green, but typecheck failed
with TS2589. I replaced it with a recursive `pluginNames()` that awaits each entry, and recorded this in BRAIN §5.

**Green:** `npm run lint && npm run typecheck && npm test` (**728/728**, 12 files; 703 + 25)
`&& npm run db:check && npm run db:gate` (GATE PASSED) `&& npm run build && npm run check:bundle` (OK, 11 files).
`cmp dist/index.html dist/404.html` → identical. No live Supabase. Committed locally, not pushed.

**Next:** P2.4 (Playwright). A deep-link spec must assert the rendered app, not `response.ok()`, because Pages returns 404
with the app as the body.

## 2026-09-29 — P2.4 (builder): Playwright wiring, e2e against the production build

**Files:**
- `package.json` / `package-lock.json`: devDep `@playwright/test` ^1.63.0; scripts
  `e2e` = `tsc -p e2e/support/tsconfig.json && playwright test --project=local`, `e2e:live` = `node e2e/support/run-live.mjs`.
- NEW `playwright.config.ts`: projects `local` (testDir `e2e/local`, baseURL `http://127.0.0.1:4173`) and `live` (testDir
  `e2e/live`, baseURL `E2E_BASE_URL`, registered ONLY when every E2E_* name is set). webServer =
  `npm run build && node e2e/support/pages-server.mjs` (just the server when `E2E_PREBUILT=1`), `reuseExistingServer:
  false`, and `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` blanked so the build is always local-only.
- NEW `e2e/support/pages-server.mjs`: a static server with GitHub Pages semantics (a file → 200; `dir/` → its index.html;
  `dir` → 301 to `dir/`; anything else → `dist/404.html` WITH status 404; no 404.html → plain-text 404, so the app does not
  boot). 127.0.0.1 only, path traversal refused, a busy port is a hard error.
- NEW `e2e/support/fixtures.ts`: `test` with an auto console watchdog. Any console `error` or `pageerror` fails the test
  after it runs. The only filtered line is Chromium's "Failed to load resource … 404" whose URL is the main-frame
  document (the Pages fallback itself). A 404 on any other resource is still an error.
- NEW `e2e/support/live-env.mjs` (`LIVE_ENV_NAMES`: E2E_BASE_URL, E2E_SUPABASE_URL, E2E_SUPABASE_ANON_KEY,
  E2E_USER_A_EMAIL, E2E_USER_B_EMAIL; `missingLiveEnv`) and `e2e/support/run-live.mjs` (skip message + exit 0 without the
  env; otherwise runs the Playwright CLI via `process.execPath`, no shell, `--project=live --pass-with-no-tests`, with
  `E2E_LIVE_ONLY=1` so no local server is started).
- NEW `e2e/support/tsconfig.json`: typechecks `e2e/**` and `playwright.config.ts` (strict, checkJs). The root `tsc -b`
  does not reference it (tsconfig*.json is outside P2.4's scope), so `npm run e2e` runs it first.
- NEW `e2e/local/matrix.spec.ts` (3): home renders the matrix (200, THEMIS h1, Agile preset, score grid, brand art) with
  zero console errors; signed out, YOLO, a partial score shows no winner, then A=5s/B=2s → "Option A leads by 75 points."
  with ranking 100.0 / 25.0; equal scores → "Too close to call."
- NEW `e2e/local/deep-links.spec.ts` (3): `/w/x/decisions/1` → status 404 + the Workspace page showing `(x)`, URL
  unchanged; `/auth/callback?code=e2e-pkce-code_123&state=abc%2Fdef` → 404 + "Signing you in", `location.search` byte
  for byte; `/no/such/page` → 404 + "Page not found", and its link returns to the matrix. Assertions are on the rendered
  app; the 404 status is asserted to prove the FALLBACK path was taken, never `response.ok()`.
- `.github/workflows/deploy.yml` (verify job, after check:bundle, before the Pages upload): Playwright version → cache
  `~/.cache/ms-playwright` keyed on it → `npx playwright install --with-deps --only-shell chromium` → `npm run e2e` with
  `E2E_PREBUILT=1` (tests the exact dist/ that is uploaded; no second build; 5 min timeout) → upload `test-results/` on
  failure. Job name gains "+ e2e".
- `.gitignore`: `test-results/`, `playwright-report/`, `blob-report/`.
- `.claude/CLAUDE.project.md` §8: `e2e: npm run e2e` and `e2e live: npm run e2e:live`; recomposed with `kit.mjs apply
  themis`, `kit.mjs check themis` → "core is canonical" (exit 0); `.claude/CLAUDE.md.bak` deleted.
- Vitest already excluded `e2e/**` (vite.config.ts `test.exclude`, since P0): `npm test` still runs 12 files / 728.

**Exercised (the runnable artifact, §5):**
- `npm run e2e` (build + serve + 6 specs): 6 passed, Playwright 5.2 s, wall 6.9 s (first cold run 9.7 s).
  CI-shaped `CI=1 E2E_PREBUILT=1 npm run e2e`: 6 passed in 2.6 s, wall 4.2 s, with the `github` reporter summary.
- Mutations, each reverted (final `git status` shows no product file changed):
  1. `dist/404.html` deleted → the 3 deep-link specs RED (the app never boots), the 3 `/` specs green.
  2. Document-404 filter disabled → the 3 deep-link specs RED on "Failed to load resource … 404" for the document URL.
     So Chromium really logs it and the filter is load-bearing and narrow.
  3. `dist/brand/themis-icon.png` removed → all 6 RED on the icon's 404 (a sub-resource 404 is NOT filtered).
  4. `console.error('e2e mutation')` appended to `src/main.tsx` → all 6 RED.
  5. A stray pages-server left on 4173 → the run refuses ("already used", exit 1). That server was killed by PID.
- `npm run e2e:live` without env → the SKIPPED message listing the 5 MISSING names, exit 0, nothing run. With dummy
  env → the live project is registered, 0 tests (`--pass-with-no-tests`), no local build/server, exit 0. A bare
  `npx playwright test --project=live` without env → "project not found" (the live project cannot be reached by accident).
- After every run, `netstat` shows no LISTENING socket on 4173.

**Green:** `npm run lint && npm run typecheck && npm test` (728/728) `&& npm run db:check && npm run db:gate` (GATE PASSED)
`&& npm run build && npm run check:bundle` (OK, 11 files) `&& npm run e2e` (6/6). No live Supabase, no secret. Committed
locally, NOT pushed. **The push edits `.github/workflows/deploy.yml`, so it needs the gh `workflow` scope (BRAIN §5)**;
the CI e2e step is not yet observed green on GitHub.

**Notes for the lead:**
- The canonical home for the e2e tsconfig is a root `tsconfig.e2e.json` referenced from `tsconfig.json` (argus-news
  does that), so `npm run typecheck` covers e2e too. Both files are outside P2.4's scope, so it lives at
  `e2e/support/tsconfig.json` and runs inside `npm run e2e`. A follow-up with that scope can move it.
- The composed CLAUDE.md §2 still says "Playwright e2e arrives in P2" (true, and §2 is outside P2.4's scope).
- BRAIN F3 is resolved.

**Next:** test-writer for P2.4 (e.g. unit tests for `resolveRequest` in pages-server and `missingLiveEnv`), then P2.5.

## 2026-09-29 — P2.5 (builder): onboarding RPCs — migration written and verified, NOT committed (BLOCKED on scope)

**Status: BLOCKED on two out-of-scope files. The migration is correct and gate-green. It sits UNTRACKED in the working
tree, and nothing is committed, because `npm test` and `db:gate:prove-red` are red for reasons outside P2.5's one file.**

**Built:** NEW `supabase/migrations/20260929000000_themis_onboarding.sql`, the only file in P2.5's scope.

- `themis.bootstrap_me() returns uuid`: SECURITY DEFINER, `search_path = ''`, plpgsql. The caller is `auth.uid()` only,
  and a null uid raises `not_authenticated` (28000). It takes an advisory xact lock in the two-int4 keyspace (class =
  hashtext('themis.bootstrap_me'), key = hashtext(uid)), so two tabs serialize. It inserts `themis.profiles(user_id)`
  `on conflict do nothing`. It then returns the oldest workspace the caller CREATED and still OWNS. If there is none, it
  creates `workspaces('Personal', created_by = uid)` plus an `owner` membership and returns that id.
- `themis.import_local_decision(ws uuid, payload jsonb) returns uuid`: SECURITY DEFINER, `search_path = ''`. It
  requires `themis.has_role(ws, owner|admin|editor)`, else raises 42501 (this covers a foreign workspace, a viewer and
  an unknown or null ws). The payload uses the decision.ts shapes: `client_import_id` (a required uuid string),
  `question`, `methodology`, `scale`, `criteria[{id,name,weight}]`, `options[{id,name}]` and
  `scores{optId:{critId:value}}`. Weights must be integral 0..5 and scores integral 1..5 (3.5 is refused, not
  rounded). Client ids are 1..64-char strings, unique per list. A score naming an unknown id is refused. The limit is
  100 criteria and 100 options. The enums and text lengths are left to the table CHECKs. One call inserts the whole
  graph or raises and leaves nothing. Dedupe: a lock on (ws, client_import_id), then a lookup of the
  `audit_log(entity 'decision', action 'import_local', after.client_import_id)` row whose decision still exists in
  `ws`. The import writes exactly one such audit row.
- EXECUTE is revoked from public, anon and service_role explicitly (B2) and granted to authenticated only.

**Verified (all on PGlite, no live contact):**

- `npm run lint` ✔ · `npm run typecheck` ✔ · `npm run db:check` ✔ (7 files) · `npm run db:gate` ✔ GATE PASSED, 291 PASS
  (the archive applies twice, so the functions are idempotent).
- Scratch probe (the gate shim + the real archive + `seedFixture`; not committed): **70/70 PASS**. bootstrap_me twice
  gives one profile and one workspace (same id), an owner membership, created_by = caller, and RLS shows the new
  workspace. An invited-only viewer gets their own workspace and keeps viewer in A. anon and service_role cannot
  execute it, and no sub gives not_authenticated. For import: editor imports, a repeat by the same or another editor+
  returns the same id with nothing new, fields/positions/scores are mapped, there is one audit row with actor =
  caller, and a viewer reads the import through RLS. UB→A, UA→B, viewer, anon, service_role, an unknown ws and a null ws
  are all refused, and B is unchanged. The same key in B makes a separate decision (the key is per workspace). 28
  bad payloads are refused, and a before/after count of decisions/options/criteria/scores/audit_log is identical
  (atomic). A minimal payload and `scores: null` are accepted, an upper-case uuid dedupes, and a deleted import
  re-imports. Catalogue: both functions are prosecdef, `search_path=""`, and acl `{postgres=X, authenticated=X}`.
- Gate coverage is catalogue-derived, so no gate edit is needed. On temp archive copies: dropping the import revoke →
  `FAIL anon has EXECUTE…` + `FAIL PUBLIC has EXECUTE…` (GATE FAILED); `search_path = public` → the guard's
  `[forbidden-schema]` (MIGRATION GUARD FAILED). No new gate check was added, so no new prove-red sabotage is needed.

**BLOCKER 1: `scripts/db-apply.test.ts` hard-codes the size of the REAL archive (P1.11).** 6 tests go red with ANY 7th
migration: `'6 migration(s)'`, `'DRY-RUN PASSED — 6 pending'`, `toHaveLength(5)` batches (×3), `'APPLY PASSED — 6
file(s)'`, `'PLAN  3 pending file(s) in 2 transaction(s)'` with an explicit sent-list, and `'3 later file(s) not
attempted'`. npm test: 722/728. Proposed fix (test-writer, scope `scripts/db-apply.test.ts`): derive the counts from
`loadMigrations(ARCHIVE)` and `plan()`, or pin those tests to a frozen copy of the first 6 files. Every later migration
(P2.6, P3.2, P4.2, P4.9) will hit the same wall.

**BLOCKER 2: `db:gate:prove-red` 33/34. The `apply-error` sabotage crashes node on THIS Windows desktop** (exit
3221226505 = 0xC0000409, `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`, the BRAIN §5
libuv gotcha), instead of exiting 1. It is deterministic (4/4 with the new file, 4/4 RED without it). Bisected: it is
NOT a SQL problem. The gate prints the right `FAIL apply …` and `APPLY FAILED` lines, then crashes inside
`db-gate.mjs`'s immediate `process.exit(1)` after PGlite work. A trivial function, a 12 KB function body and each
construct of import_local_decision in isolation all exit 1 cleanly; only the full import function triggers it, so it
is timing- or heap-dependent. Deferring the exit makes it exit 1. Proposed fix (scope `scripts/db-gate.mjs`): on the
APPLY FAILED / guard-failed / no-migrations paths, `await db.close()` and set `process.exitCode = 1` instead of
`process.exit(1)`, as §5 already prescribes for db:snapshot. CI (Linux) is probably unaffected, but that is unobserved.

**Not done, by design:** no audit row in bootstrap_me (PLAN's audit list is P4.2: status, approvals, revisions, role
changes); no schema change (the P1.4/P1.5 exact-set tests pin workspaces' FKs and decisions' columns/unique keys, so
a `personal_of` or `client_import_id` column would turn them red, and those tests are out of scope too).

**Next:** the lead authorizes (or dispatches) the two fixes above. Then re-run the full chain and commit P2.5 as
`feat: onboarding RPCs bootstrap_me and import_local_decision (P2.5)`. P2.7 turns the scratch probe's cases into gate
lines.

## 2026-09-29 — B3 fixed (builder), P2.5 UNBLOCKED and committed

**Status: P2.5 is unblocked and committed. B3 closed.** Lead-authorised scope: `scripts/db-apply.test.ts`,
`scripts/db-gate.mjs`, then land P2.5 (the migration itself was NOT modified).

- **`a05da98` fix(test):** db-apply tests about the real archive derive their counts from `loadMigrations(ARCHIVE)`
  and `plan()`, and now also assert units = files − pairs and that dry-run batch k carries exactly units 1..k. The
  partial-ledger and stop-at-first-failure tests run on `frozenP1Archive()` (a copy of the six P1 files), so their
  exact "3 pending in 2 transactions" and "3 later file(s) not attempted" keep their meaning. db-gate: the body is
  `runGate(db)` returning 0/1; `main()` handles the guard, closes PGlite in a `finally`; `process.exitCode` is set once.
  No `process.exit()` remains (guard-failed, no-migrations, APPLY FAILED, fixture-failed, GATE FAILED all return 1).
- **Evidence:** before the fix `--only apply-error` crashed (`UV_HANDLE_CLOSING`) 2/2; after it passed 4/4. Full
  `db:gate:prove-red` 34/34 on 3 consecutive runs (~21 s each) with 7 migrations. A static-guard-red archive and an
  empty archive dir both exit 1. db-apply tests: 35/35 with 7 files and with a temporary 8th probe migration (removed);
  an applier mutation (summary counts off by one, reverted via git checkout) turned 3 tests red.
- **Chain (P2.5 file present):** lint ✔ · typecheck ✔ · test 728/728 · db:check (7 migrations) ✔ · db:gate GATE PASSED ·
  prove-red 34/34, control 291 PASS · build ✔ · check:bundle OK (11 files) · e2e 6/6. No live Supabase. Not pushed.
- Then P2.5 committed as `feat: onboarding RPCs bootstrap_me and import_local_decision (P2.5)`.

**Next:** P2.6; P2.7 turns the P2.5 scratch probe's cases into gate lines.

## 2026-09-29 — P2.6 membership and invite RPCs (builder): written and proven, BLOCKED on scope, NOT committed

**Status: BLOCKED (B4). The migration is written and behaves correctly, but the chain is red for a reason outside
P2.6's declared file, so nothing is committed.** The file sits UNTRACKED in the working tree:
`supabase/migrations/20260929010000_themis_invites.sql`. While it is there, `db:check`, `db:gate` and 18 Vitest tests
are red for every agent in this checkout; move it aside if another task must run first.

**What the file does** (5 functions, SECURITY DEFINER, `search_path = ''`, fully-qualified, the caller only from
`auth.uid()`, EXECUTE revoked from public/anon/service_role and granted to authenticated):

- `create_invite(ws, email, role) → text`: owner|admin only; an admin cannot invite as owner. The email is trimmed and
  lower-cased. The raw token is 64 lower-hex characters (two `gen_random_uuid()`, 244 random bits) and is returned
  ONCE; the row stores only `encode(sha256(token), 'hex')`. It expires in 7 days.
- `accept_invite(token) → uuid` (the workspace): the invite must exist, the caller's `auth.users.email` must equal the
  invite email AND be confirmed (`email_confirmed_at`), the invite must be unaccepted and unexpired, and its creator
  must still hold the authority it grants (owner for an owner invite, else owner|admin). Refuses an existing member.
  Creates the membership and sets `accepted_at`. The invite row is locked `for update`.
- `revoke_invite(invite_id)`: owner|admin; only an owner revokes an owner invite; deletes a PENDING invite. "Unknown"
  and "not in a workspace you manage" give the same error.
- `set_member_role(ws, member_id, role)` / `remove_member(ws, member_id)`: owner|admin; an admin cannot grant owner
  (itself included) or change/remove an owner; the last owner can be neither demoted nor removed. Serialised per
  workspace by `pg_advisory_xact_lock(hashtext('themis.memberships'), hashtext(ws))`, and the caller's role is read
  after the lock.
- No audit rows (PLAN P4.2 audits role changes by trigger; writing them here would double them). No schema change.

**BLOCKER B4: the P1.3 static guard forbids reading `auth.users`, which the P2.6 acceptance criterion requires.**
`scripts/check-migrations.mjs:141` allows only `references auth.users` and `auth.uid()`. `accept_invite` must compare
"the signed-in user's `auth.users.email`", so line 137 of the migration (`from auth.users u`) is flagged
`forbidden-schema`. There is no honest in-scope alternative: `auth.jwt()` is flagged too, the JWT `email` claim is not
`auth.users.email` (stale after an email change, no confirmation state, and the gate shim does not set it), and
building the name from strings to slip past the guard is exactly what BRAIN §5 forbids. DECISIONS P1.3 already says
the allow-list is extended "in that migration's task", but P2.6's declared file list is the migration only, so the
builder stopped instead of widening scope.

- **Proposed fix (scope `scripts/check-migrations.mjs` + `scripts/check-migrations.test.ts`),** one line after line
  141: `if (schema === 'auth' && obj === 'users' && /\b(?:join|(?<!\bdelete\s+)from)\s*$/i.test(before)) continue`
  (a READ of auth.users via `from`/`join`; `delete from` stays red). Proven in a scratch copy of the scripts: `select
… from auth.users` and `join auth.users` pass; `delete from`, `update`, `insert into`, `alter table` on auth.users and
  `auth.jwt()` stay RED (9/9). With that line, on the real 8-file archive: db:check green, **GATE PASSED (292 PASS,
  12 functions pinned, anon/PUBLIC EXECUTE on none)**, prove-red **34/34** + control green.
- **Also needed for P2.7 (scope `scripts/db-gate/shim.mjs`):** the shim's `auth.users` has no `email_confirmed_at`
  (real Supabase has it). Add `email_confirmed_at timestamptz` to the shim and set it in `seedFixture` for the users
  that accept invites; the probe does this with an `alter table` after `installShim`. Without it `accept_invite`
  errors "column does not exist" in PGlite. P2.7's declared files do not include the shim either.

**Evidence (no live Supabase):**

- Scratch probe `probe-p26.mjs` (the real archive applied twice with the guard bypassed, the real shim + `email_confirmed_at`,
  the real `seedFixture` and harness): **100/100 PASS**. Covers the catalogue (definer, pinned path, EXECUTE only for
  authenticated) for all 5, anon refused on all 5, service_role refused; create (token format, sha256 == token_hash,
  the raw token stored nowhere, lower-casing, expiry 7 d ± 0.001, admin/owner/editor/viewer/other-tenant/loner, bad
  role/email/null); accept (wrong email, unconfirmed email, expired, reused, unknown, malformed, null, the fixture's
  hash used as a token, already a member, inviter demoted since, an owner invite whose inviter is now only admin, the
  happy path to editor and to owner); revoke (editor, other tenant, unknown, admin vs owner invite, accepted, revoked
  then accepted); set_member_role and remove_member (admin self-promotion, admin promotes to owner, admin demotes or
  removes owner, last owner demote/remove, two owners, no-op, bad role, non-member, other tenant, editor/viewer/loner);
  the direct INSERT/UPDATE paths are still refused; fixture untouched afterwards.
- Mutations on archive copies, each RED: email check removed (2 FAIL, then the probe crashed on the consumed invite),
  last-owner check removed (5 FAIL), admin-owner rule removed (4 FAIL), expiry check removed (2 FAIL), anon granted
  accept_invite (2 FAIL).
- Chain in the repo with the file present: lint ✔ · typecheck ✔ · build ✔ · check:bundle OK (11 files) · e2e 6/6 ·
  **db:check RED** (the one `auth.users` read) · **db:gate RED** (guard first, nothing applied) · **npm test 18 red**
  (`check-migrations.test.ts` "passes the real archive", plus db-apply and db-snapshot tests that run the guard in-process
  on the real archive). prove-red was run on the scratch copy only (it needs the gate green).

**Next:** the lead authorises the guard line + a test for it (and the shim column for P2.7), or rules otherwise
(e.g. drop the confirmed-email requirement — it does not remove the guard problem, only the shim one). Then re-run the
full chain and commit as `feat: membership and invite RPCs (P2.6)`. The probe for the test-writer is
`C:\Users\Master\AppData\Local\Temp\claude\D--projects-zeus\69c65100-75a6-4bac-9e50-e8d2b0a63b94\scratchpad\p26\probe-p26.mjs`
(with `node_modules` junctioned to the repo's; note `s.sudo()` restores the actAs identity, so re-set the caller after it).

## 2026-09-29 — B4 closed + P2.6 committed (builder, lead-authorised guard scope)

**Status: DONE. B4 closed by `325f029`; P2.6 committed as `feat: membership and invite RPCs (P2.6)`. Not pushed; no live
Supabase.**

- `325f029` fix(guard): allow reads of auth.users (B4). `scripts/check-migrations.mjs`: new `maskLiterals` and
  `isAuthUsersRead`. The one new allowed form is a READ `from auth.users` / `join auth.users` written as code. It is
  stricter than the proposed one-liner: string/dynamic-SQL splices, `$q$from` glue, `for update|share`, `create view/
table … as` and `copy` are all red (DECISIONS.md "P1.3 allow-list extension"). `scripts/check-migrations.test.ts`
  39 → 80 tests. `scripts/db-gate/shim.mjs`: `auth.users.email_confirmed_at timestamptz default now()`.
  `scripts/db-gate-prove-red.mjs`: the new sabotage `auth-users-write-in-function` goes RED on
  `29991231235959_themis_zz_sabotage.sql:5  [forbidden-schema]` (the UPDATE line, 1 FAIL line, so the read on line 4
  was not flagged), and the gate stops at the guard.
- Fooling attempts pinned as RED tests: delete from (upper case/newline/comment/only/quoted/CTE), `using`, update (with
  alias + from), insert…select, merge into, alter, truncate (± table), lock, grant, comma join, for update/share/no key
  update, create table as, materialized view, view, copy, auth.identities, join auth.sessions, an UPDATE in a PL/pgSQL body,
  six dynamic-SQL splices (single-quoted, `'delete ' || 'from …'`, split with the space inside, nested `$q$`, built across
  statements, E'' with an escaped quote), and `$q$from` glued. Found and pinned rather than fixed (both pre-existing,
  BRAIN §5): `execute format('delete from %I.%I', 'au' || 'th', 'users')` passes the guard; a body on the same line as
  `set search_path = ''` trips the search_path rule.
- Mutations of the new code, each RED in the test file: no masking (1 red), no `delete` lookbehind (5), no
  create/copy rule (5), no row-lock rule (3), no keyword boundary (1).
- The migration `20260929010000_themis_invites.sql` is unchanged from the P2.6 builder's version.

**Chain (the P2.6 file present, after `325f029`):** lint ✔ · typecheck ✔ · `npm test` 769/769 (12 files) · db:check PASS
(8 migrations) · db:gate GATE PASSED (292 PASS, search_path pinned on 12 functions) · prove-red **35/35** RED + control
GREEN (21 s) · build ✔ · check:bundle OK (11 files) · e2e 6/6. The committed archive alone (7 files, `git show HEAD:`
copies in a scratch dir) also passes db:check and db:gate with the new guard/shim, so `325f029` is green on its own.

**Next:** P2.7: the P2.5 and P2.6 probe cases become db:gate lines (the probe path is in the P2.6 entry above; set
`email_confirmed_at = null` for the unconfirmed case). CHECKPOINT P1-LIVE is still open.
