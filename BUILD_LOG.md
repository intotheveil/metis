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
