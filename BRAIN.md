# 🧠 BRAIN — Themis (`themis`)

> This is the single source of truth for this product. It is read BEFORE any work and
> written AFTER any work (CLAUDE.md §0). Knowledge lives here, not in conversation history.
> Seeded 2026-09-28 from the operator's intent at NEW PRODUCT time; genuine unknowns are
> marked **❓ needs human input** rather than invented.

**Last updated:** 2026-09-28 (P1.9 db:gate:prove-red) by Claude Code (Opus 5.5, Windows desktop, dispatched from zeus)
**Status:** in-development
**Repo:** `intotheveil/themis` (public) · local `D:\projects\themis` · **Deployed:** https://themis.adeonanalytics.com/ (GitHub Pages custom domain, CI deploys on every push to main; the old github.io/themis/ URL 301s here)

---

## 1. WHAT THIS IS (never-changes context — read first, every time)

Themis is an AI-powered decision-making tool for projects run **Waterfall, Agile, or "YOLO"**
(ship-first), for companies from small to large. The operator's intent, verbatim: _"A tool which
is AI powered for decision making using all best models and practices for Waterfall and Agile and
even yolo projects. But also for Companies from small and large scale."_ Named for the Titaness of
divine law and order, who holds the scales. "Working" means a user can frame a decision, weigh criteria for their delivery
method and org scale, score options, and get an honest recommendation — including "too close to
call".

---

## 2. ARCHITECTURE (the canonical technical truth — investigate ONCE, record here)

- **Stack:** React 19 + Vite 8 + TypeScript (strict) + Tailwind v4 (`@tailwindcss/vite`,
  theme tokens in `src/index.css` `@theme`). Vitest 5 + Testing Library (jsdom). ESLint 10 +
  typescript-eslint, Prettier (`.prettierrc.json`, so the kit's `format.sh` is ACTIVE here).
- **Data model:** none persisted. In-memory: `Criterion{id,name,weight 0–5}`, `Option{id,name}`,
  `Scores[optionId][criterionId] = 1–5`. All in `src/lib/decision.ts`.
- **Key modules:**
  - `src/lib/decision.ts` — pure model: presets (`presetCriteria(method, scale)`), `scoreOption`
    (weighted, normalised 0–100 where 1→0 and 5→100), `rank`, `verdict`
    (`empty | incomplete | close (<5 pts) | clear`).
  - `src/App.tsx` — the single-page UI: frame → weigh → score → recommendation panel; the
    "AI analyst" card is explicitly marked roadmap.
- **Database (ADR-0002, P1 in progress, nothing applied live yet):** Hephaestus's LIVE Supabase
  project `lss-platform` (ref `atopkqykdmrcfvvcistc`, eu-west-1), schema **`themis` only**. Never
  `supabase db push`/`link`/`db reset`/`migration *` (Hephaestus owns
  `supabase_migrations.schema_migrations`). Migrations: `supabase/migrations/YYYYMMDDHHMMSS_themis_NAME.sql`,
  tracked in `themis.schema_migrations`, rehearsed by `npm run db:gate` (PGlite), proven by
  `npm run db:gate:prove-red`, applied only by `npm run db:apply` (Management API, env
  `SUPABASE_ACCESS_TOKEN` + `THEMIS_SUPABASE_PROJECT_REF`, dry-run default). No trigger on
  `auth.users`; Edge Functions `themis-*`, secrets `THEMIS_*`; workspace logo stored in
  `themis.workspaces`, not Storage. Rulebook: `zeus/specs/THEMIS_SPEC.md` §5a.
  **Gate (P1.2):** `scripts/db-gate.mjs` + `scripts/db-gate/shim.mjs` (PGlite). The shim = API roles
  (service_role BYPASSRLS), `auth.uid()`/`auth.users`, Supabase default privileges in `public`, a
  Hephaestus-shaped `public` (organizations/profiles/memberships/workspaces/tasks) and
  `supabase_migrations.schema_migrations` with 25 rows; NOTHING pre-granted on `themis`. The gate
  applies the archive twice (idempotency). Bootstrap `20260928200000_themis_schema.sql`: schema,
  `themis.schema_migrations` (RLS, no policy, no API grant), `themis.touch_updated_at()`, USAGE to
  anon/authenticated/service_role, and an `alter default privileges in schema themis revoke execute … from public`
  that is a NO-OP (see §5; found in P1.8, open for the builder).
  **Static guard (P1.3):** `scripts/check-migrations.mjs` (`npm run db:check [dir]`), run FIRST by
  `db:gate`, which applies nothing if the guard is red. It prints `file:line [rule]` with the rules
  `filename`, `forbidden-schema` (public/auth/storage/supabase_migrations: qualified, `schema x`
  or in a search_path; only `references auth.users` and `auth.uid()` are allowed),
  `target-outside-themis` (an unqualified DDL/DML target), `auth-users-trigger`,
  `create-extension`, `alter-system`, `drop-schema`, `alter-role`, and `default-privileges`
  (allowed only `in schema themis`). Comments are blanked and strings are kept. Exports
  `checkMigrationSql(file, sql)`/`checkMigrationsDir(dir)` for tests.
  **Tenancy (P1.4):** `20260928210000_themis_tenancy.sql` adds `themis.profiles` (pk user_id →
  auth.users), `workspaces` (logo = png/jpeg/webp data URL ≤ 140000 chars), `memberships` (pk
  workspace_id+user_id, role owner|admin|editor|viewer), `invites` (lower-case email, unique 64-hex
  `token_hash`). Membership RLS goes ONLY through the SECURITY DEFINER helpers `themis.is_member(ws)`,
  `themis.has_role(ws, roles[])` and `themis.shares_workspace(other)` (`search_path=''`, EXECUTE for
  authenticated only). Memberships and invites are SELECT-only for clients, and workspaces have no
  INSERT policy. Those writes go through P2.5/P2.6 SECURITY DEFINER RPCs. anon holds nothing.
  **Tenancy tests:** `scripts/db-tenancy.test.ts` (82 tests, 1 shared PGlite, real archive applied
  twice). Harness: `actAs(uid | ANON | SUPERUSER, s => …)` runs in an always-rolled-back transaction,
  and `s.attempt` is savepoint-wrapped. The table-driven A/B isolation matrix is `TENANT_TABLES`, derived
  (P1.8) from `LEAK_MATRIX` in `scripts/db-gate/leak-matrix.mjs`. `DB_GATE_MIGRATIONS` points it at a mutated archive copy.
  **Leak suite (P1.8):** `scripts/db-gate/leak-matrix.mjs` is the ONE home of the fixture (`seedFixture`, ids U/WA/WB/D/O/…),
  the harness (`createHarness(db).actAs`, `refused`/`noEffect`/`snapshot`), `foreignSnapshot`, `checkValues` and
  `LEAK_MATRIX` (one entry per themis table: tenant entries with ofA/ofB/probe/viewerReads/write/insert/cross, plus `plans`
  as reference; `SERVICE_ONLY_TABLES = ['schema_migrations']`). Both `db-gate.mjs` and `db-tenancy.test.ts` import it.
  `db:gate` runs, after the bootstrap checks: an 18-line structural sweep (RLS, views, policies/service-only grants, pinned
  search_path, definer paths, anon/PUBLIC EXECUTE, policy roles with the `plans.plans_select` exception, the recursion rule,
  helper-only workspace policies, anon = `plans.SELECT` only, the public/auth diff, the auth.users trigger, convalidated FKs,
  the decision.ts enums); coverage (a catalogue table without an entry is RED); the seeded orphan scan; and the A/B matrix with
  controls and the positive path (290 PASS lines). **A new table = a LEAK_MATRIX entry + fixture rows in seedFixture**, or the
  gate goes red.
  **Prove-red (P1.9):** `scripts/db-gate-prove-red.mjs` (`npm run db:gate:prove-red`). Its `SABOTAGES` array (34: PLAN
  a–f, the P1.8 mutations, non-idempotent, apply error) pairs each SQL with the red line(s) it must produce. Each run
  appends ONE `29991231235959_themis_zz_sabotage.sql` to a temp copy (os.tmpdir, removed by the script) and runs the
  gate with `DB_GATE_MIGRATIONS`. RED = exit 1 + every expected line + no `GATE PASSED`; plus a control that must pass.
  Parallel (`--jobs`, default min(8, cores)), about 40 s; `--only id,…` for one. **A new gate check = a new SABOTAGES entry.**
  Its P1.4 exact-set assertions (FKs, policies, column grants) are scoped to the P1.4 `TABLES`. Scope
  each later exact-set assertion to its own tables in the same way.
  **Decision core (P1.5):** `20260928220000_themis_decisions.sql` adds `decisions` (lineage_id,
  revision, question, methodology, scale, status, frozen, approved_by/at; `unique(id, workspace_id)`,
  `unique(lineage_id, revision)`), `options` and `criteria` (weight smallint 0–5, `position`), and `scores`
  (value 1–5, pk (option_id, criterion_id)). Each child has its own `workspace_id` and a composite
  FK `(decision_id, workspace_id)`, and scores also pin option and criterion to the same decision.
  Members read, and editor+ write. A frozen decision cannot be updated or deleted (RLS). The client
  cannot write the lifecycle columns, ids, tenancy keys or `created_by` (column grants), because
  those change only through the P4.2 RPCs. The DB stores inputs only.
  **Analysis and collaboration (P1.6):** `20260928230000_themis_analysis.sql` adds `swot_items`
  (option_id nullable = decision-level, quadrant `s|w|o|t`, text, position), `risks` (option_id required,
  title, likelihood/impact 1–5, owner free text, mitigation, position — exposure is NOT stored, it is
  `decision.ts` P4.1), `comments` (body, author) and `approvals` (verdict approved|rejected, reason required,
  actor). Same pattern: own `workspace_id`, composite FK `(decision_id, workspace_id)`, and swot/risks also
  `(option_id, decision_id)` → options. swot/risks: members read, editor+ write. comments: any member posts
  (viewer too); only the author (still a member) updates/deletes. approvals: admin|owner INSERT only, nobody
  updates/deletes; `author`/`actor`/`created_by` default `auth.uid()` and are client-unwritable.
  **AI, billing, audit, plans (P1.7):** `20260928235000_themis_ai_billing_audit.sql` adds `plans` (key free|pro|team,
  non-tenant; SELECT for anon+authenticated, no writer but a migration; seeded `on conflict do nothing` with the §4
  PROPOSAL, table comment says UNCONFIRMED; exactly one of ai_runs_month / ai_runs_per_seat; € ceilings 1/10/60 are
  placeholders), `ai_runs` (composite FK to decisions; kind incl. `swot_draft`; status reserved|succeeded|failed;
  accepted jsonb array), `subscriptions` (workspace_id unique, plan → plans, Stripe status enum), `usage_monthly`
  (pk workspace_id+month, month = day 1) and `audit_log`. ai_runs/subscriptions/usage_monthly: members SELECT, NO
  client write (no policy, no grant); only service_role writes. audit_log: admin|owner SELECT; service_role SELECT +
  INSERT only; a BEFORE UPDATE trigger raises `audit_log_append_only` for every role; rows leave only by workspace
  cascade. **Actor erasure (`20260928235500_themis_audit_actor_erasure.sql`):** the trigger function lets exactly ONE
  update through: `actor` non-null → NULL with every other column unchanged. That is the `actor → auth.users on delete
set null` FK action, so deleting a user (Themis or Hephaestus) works. No role holds UPDATE on audit_log; the FK action
  runs as the table owner and needs no grant.
- **External services / keys:** none wired yet. `.env.example` reserves `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY` (unset, unused).
- **How to run / build / test / deploy:** `npm run dev` · `npm test` · `npm run lint && npm run
typecheck` · `npm run build`. Deploy = push to `main` → `.github/workflows/deploy.yml`
  (verify job, then `actions/deploy-pages`). Pages source is "GitHub Actions".
- **Integration points:** none yet. Not wired to fleet telemetry (❓ decide when/if).

---

## 3. CURRENT STATE (what's true RIGHT NOW)

- **What's live:** P0 shell + a working client-side weighted decision matrix with
  Waterfall/Agile/YOLO × small/mid/enterprise criteria presets. 16 tests (12 model, 4 UI), black-and-gold Themis brand.
- **What's in progress:** P1 (data spine) per `PLAN.md`. P1.1 done: ADR-0002 + constitution
  §2/§8/§11 for the shared database. P1.2 done: `npm run db:gate` + bootstrap migration (local
  only, nothing applied live). P1.3 done: static migration guard `npm run db:check`, run first
  by `db:gate` (covered by `scripts/check-migrations.test.ts`, 39 tests, typechecked via `tsconfig.scripts.json`).
  P1.4 done: tenancy migration (profiles, workspaces, memberships, invites + RLS helpers), local only,
  covered by `scripts/db-tenancy.test.ts` (82 tests; suite total 138).
  P1.5 done (builder): the decision-core migration (decisions, options, criteria, scores), local
  only. P1.5 tests done: `db-tenancy.test.ts` now covers the decision core too (isolation matrix,
  composite-FK cross-tenant inserts, role gating, lifecycle columns, constraints, grants, cascades;
  170 tests in that file, suite total 228).
  P1.6 done (builder): the analysis migration (swot_items, risks, comments, approvals), local only;
  P1.6 tests done: `db-tenancy.test.ts` covers the analysis tables too (271 tests in that file, suite total 327).
  P1.7 done (builder + tests; 432 tests in total): AI, billing, audit and plans, local only. The P1.7 tests found that
  deleting an audit actor failed. That is fixed by the new migration `20260928235500_themis_audit_actor_erasure.sql`
  (local only, not pushed). P1.8 done: `db:gate` now runs the structural sweep, the leak-matrix coverage check, the orphan
  scan and the A/B leak matrix (290 PASS), sharing `scripts/db-gate/leak-matrix.mjs` with the Vitest suite (still 432
  tests). Every new check was proven RED on a mutated archive copy. OPEN: the bootstrap's default-privileges revoke is a
  no-op (§5, BUILD_LOG P1.8), and the builder must decide the fix. `db:gate:prove-red` and `db:apply` arrive in
  P1.9/P1.11. Next: that decision, then P1.9.
- **What's next / planned:** a SPEC for the AI analyst (❓ needs human input: which models,
  who pays for inference, whether decisions must be saved/shared → that decides Supabase + auth).

---

## 4. OUTSTANDING (the triage queue)

| id  | sev | type       | summary                                                                                                                                                                                                                                                            | status                                                                                                                | added      |
| --- | --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------- |
| S1  | 🟠  | checkpoint | Commercial v1 spec (`zeus/specs/THEMIS_SPEC.md`) awaiting operator approval + §10 answers (entity, prices, domain, email provider, repo visibility)                                                                                                                | open                                                                                                                  | 2026-09-28 |
| B2  | 🟡  | bug        | Bootstrap `alter default privileges in schema themis revoke execute … from public` is a no-op (§5). Existing functions revoke explicitly and db:gate guards new ones. Builder: fix the comment/approach in a NEW migration; the global form would touch Hephaestus | closed 2026-09-28: per-function revokes are the rule, enforced by the db:gate PUBLIC/anon EXECUTE line (DECISIONS.md) | 2026-09-28 |
| F1  | 🟠  | feature    | AI analyst — challenge assumptions, suggest missing criteria, stress-test the winner. Needs a server-side proxy (never a key in the bundle) → reopens ADR-0001                                                                                                     | open                                                                                                                  | 2026-09-28 |
| F2  | 🔵  | feature    | Persist/share decisions (localStorage first, Supabase EU when multi-user)                                                                                                                                                                                          | open                                                                                                                  | 2026-09-28 |
| F3  | 🔵  | feature    | Playwright e2e against the production build; then name `e2e` in CLAUDE.md §8                                                                                                                                                                                       | open                                                                                                                  | 2026-09-28 |
| Q1  | 🟡  | question   | ❓ needs human input — product scope beyond the matrix: methodology playbooks (stage-gates, sprint decisions), RACI/approvals for enterprise?                                                                                                                      | open                                                                                                                  | 2026-09-28 |

---

## 5. GOTCHAS (hard-won "don't do X, it breaks Y")

- **Every migration must survive being run twice** — `db:gate` re-applies the whole archive.
  `create policy` and `create type` have no `if not exists`: use `drop policy if exists` first and a
  `do $$ … exception when duplicate_object` block for enums.
- **The kit's guard hook blocks any Bash/PowerShell COMMAND whose text looks like destructive
  SQL** (the DROP verb followed by table/database/schema and a name, or TRUNCATE TABLE and a name), even inside a heredoc
  that only writes a test fixture. Put such fixture SQL in a file with the Write tool, or build it in
  the test file. Never split the string to dodge the regex. Found in P1.3.
- **Postgres grants EXECUTE on new functions to PUBLIC, and the bootstrap does NOT stop it.** Its
  `alter default privileges in schema themis revoke execute on functions from public` is a no-op: a per-schema
  default can only ADD to the global defaults, never revoke them (no `pg_default_acl` row is created; a new themis
  function has proacl NULL and anon can EXECUTE it). Every function migration must `revoke execute … from public, anon`
  itself, and an RPC for signed-in users needs `grant execute … to authenticated`. `db:gate` now fails on any themis
  function PUBLIC or anon can execute. Found in P1.8 (the old text of this gotcha said the opposite).
- **The static guard (`db:check`) cannot see DDL built from strings.** `do $$ … execute 'create trigger … on au' || 'th.users …' $$`
  or `execute format(…, 'pub' || 'lic')` passes it. The post-apply checks in `db:gate` (the public/auth diff and the
  auth.users trigger check) are what catch those, so never weaken them because "the guard covers it". Found in P1.8.
- **A long Bash heredoc of markdown prose can fail to parse in this tool** (`unexpected EOF while looking for matching '`)
  even when quoted `<<'EOF'`. Write the prose with the Write tool to a scratch file and `cat >>` it. Found in P1.8.
- **A `scripts/**/*.test.ts` file is only typechecked because of `tsconfig.scripts.json`** (allowJs,
  so the JSDoc in `.mjs` scripts types the imports). A test file elsewhere outside `src/` is run by
  Vitest and linted but NOT typechecked unless a tsconfig include covers it. Found in P1.3.

- **A policy recursion bug poisons a PGlite instance.** A non-definer helper that re-enters
  memberships RLS ends in `ERRORDATA_STACK_SIZE exceeded`, and every later query on that instance
  returns empty or fails. With one PGlite per test file, one such bug turns dozens of unrelated tests
  RED. The FIRST failure is the real signal. Found in the P1.4 tests.
- **An exact-set catalog assertion over the whole `themis` schema breaks on the NEXT migration.**
  P1.4's FK, policy and grant lists went RED the moment P1.5 added tables. Scope every such
  assertion to the tables of its own task. Found in P1.5.
- **A unique/PK violation fires before a foreign-key violation.** FK checks run as after-row
  triggers, so an insert that hits both reports "duplicate key" and never reaches the FK. A test
  that proves a composite FK refuses a cross-tenant score must target a FREE cell, or it passes
  for the wrong reason. The P1.5 fixture leaves OA1×CA2 and OA2×CA2 unscored for this. Found in the P1.5 tests.
- **On this Windows desktop a very long Bash heredoc fails with `ENAMETOOLONG: uv_spawn`** and runs nothing.
  To append a large test block, Write it to a scratch file and `cat >>` it. Found in the P1.6 tests.
- **A schema-wide policy sweep must know about non-tenant tables.** The recursion-rule test required every `themis`
  policy to call `is_member`/`has_role`; `plans` (readable by anon, `using (true)`) turned it RED in P1.7. Keep
  such sweeps' exception list (`profiles.`, `plans.`) in step with every non-workspace-scoped table.
- **An FK `ON DELETE SET NULL`/`CASCADE` INTO an append-only (UPDATE/DELETE-guarded) table is itself an UPDATE/DELETE
  of that table.** Guard triggers fire on it. P1.7's audit_log trigger refused the `actor` SET NULL, which would have
  broken deletion of any audit actor. Because **auth.users is shared with Hephaestus**, that would also have broken user
  deletion on Hephaestus's side, in the live project. Before guarding a table, list every FK INTO it
  (`pg_constraint where conrelid = <table>` with confdeltype `n`/`c`/`d`) and let exactly that action through, as
  `20260928235500` does. Grants are not the issue: RI actions run as the table owner. Found in the P1.7 tests.
- **The gate's verdict lines do not start with `FAIL`.** `GATE FAILED — …`, `APPLY FAILED` and `MIGRATION GUARD FAILED`
  are separate from the `FAIL  <check>` lines. Grepping only `^FAIL` for them misses them (the first P1.9 run went 31/34
  on exactly that). prove-red's `RED_LINE` matches all four. Found in P1.9.
- **In SQL, `text || "char"` is ambiguous.** Cast `polcmd`/`confdeltype` with `::text` before concatenating.

- **Served at the domain root (`base: '/'`, ADR-0003).** It was `/themis/` while on github.io. Build every asset URL from
  `import.meta.env.BASE_URL`, never a hard-coded path, so a move back under a path stays a one-line change.
- **The kit's `format.sh` rewrites files on Write/Edit here** (this repo HAS a prettier config),
  including `.claude/CLAUDE.project.md` — after editing that file, re-run
  `node <zeus>/.zeus/kit/kit.mjs apply themis` so the composed CLAUDE.md matches.
- **A static bundle is public.** No `VITE_*` secret, ever — Vite inlines them.
- **A CSS grid column grows to fit its widest child's min-width.** The score table's
  `min-w-[36rem]` pushed every panel off-screen on phones even though the table sat inside
  `overflow-x-auto`. The fix is `grid-cols-[minmax(0,1fr)]` on the mobile grid. Found 2026-09-28.
- **Headless Edge/Chrome screenshots at `--window-size=390` are not phone renders.** The window
  has a minimum width, so the page lays out wider and gets cropped. To check a real 390px layout,
  screenshot the page inside a `<iframe style="width:390px">`.
- **The gh token on this desktop has no `workflow` scope** (`gist, read:org, repo`). A push that
  adds or edits `.github/workflows/*` is rejected outright.

---

## 6. CHANGELOG (append-only — newest first)

### 2026-09-28 (P1.9) — `npm run db:gate:prove-red`: the gate is proven RED

- Did: NEW `scripts/db-gate-prove-red.mjs` and a `package.json` script (see §2). 34 sabotages, each appended as one last
  migration to a temp copy of the archive: PLAN (a)–(f), the 28 P1.8 mutations rewritten (their SQL had never been
  committed), a non-idempotent CREATE and an apply error. Each must exit 1 AND print its expected red line(s); a control
  on the untouched copy must pass. Result: `PROVE-RED PASSED — 34/34 … control GREEN`, wall about 40 s with 8 jobs. The
  prover was proven too: three wrong expectations reported "red for the WRONG reason", and a benign sabotage reported
  "the gate PASSED" and exited 1. lint, typecheck, 432 tests, db:check and db:gate are green. `supabase/` is untouched.
  Nothing is live, and nothing is pushed.
- Decided: the sabotages live as data in the script (P1.9's file scope), and exit 1 without the expected line is not
  RED (DECISIONS.md P1.9).
- Left off: P1.10 (CI runs db:check, db:gate and db:gate:prove-red), ∥ P1.11, P1.12. A new gate check needs its
  own SABOTAGES entry.

### 2026-09-28 (P1.8) — the leak suite: structural and functional gates in `db:gate`

- Did: new `scripts/db-gate/leak-matrix.mjs`, the fixture + harness + `LEAK_MATRIX` shared by `db-gate.mjs` and
  `db-tenancy.test.ts`. The test file now imports them, and no assertion changed (432 tests). `db-gate.mjs` gained an
  18-line structural sweep, a 3-line coverage check derived from the catalogue (a table without an entry is RED), a seeded
  orphan scan over all 36 FKs, and a 244-line A/B matrix. The matrix has a control for every refused INSERT and cross-child
  row, and the positive path: UA and the declared writer write, the viewer reads but cannot write, server-written tables
  hold no client write privilege. The gate reports 290 PASS. 28 archive-copy mutations each went RED on the expected
  line(s) (BUILD_LOG.md P1.8). lint, typecheck, test, db:check and db:gate are green. `supabase/` is untouched, not pushed.
- Decided: the matrix declares a writer per table (`UA`, `editor` for author-only comments, or `service` for
  server-written tables), and the gate cross-checks `service` against the catalogue, so the "UA can write" rule does not
  apply to tables no client may write. The enum check now runs in the gate too; the Vitest copy stays and uses the same
  `checkValues`.
- Found: (1) the bootstrap's per-schema default-privileges revoke is a no-op (§5), a latent bug that product code/migrations
  must fix, not the tests; (2) the static guard misses string-built DDL (§5), and the gate's post-apply checks catch it.
- Left off: the builder decides the default-privileges fix (NOT the global form, because that would touch Hephaestus's
  functions), then P1.9 `db:gate:prove-red`. Its sabotage (f), dropping the scores composite FK, fails the scores
  cross-child line.

### 2026-09-28 (fix) — audit_log actor erasure (bug found by the P1.7 tests)

- Did: NEW migration `supabase/migrations/20260928235500_themis_audit_actor_erasure.sql`. It replaces
  `themis.audit_log_append_only()` in place, so the only UPDATE it allows is `actor` non-null → NULL with every other column
  unchanged. The pushed P1.7 file is untouched, no grant was added, search_path stays pinned, and anon/authenticated get
  no EXECUTE. In `scripts/db-tenancy.test.ts`, the `it.fails` BUG test is now `it`, and 5 new tests cover: nulling actor
  plus changing another column is refused for superuser and service_role; re-pointing or filling actor is refused; an
  auth-admin-like role with only DELETE on auth.users deletes an actor, and the row survives, nulled and otherwise
  identical (so the FK action needs no grant); deleting ownerB touches only B1. Three archive-copy mutations went RED
  (BUILD_LOG.md). lint, typecheck, 432 tests (0 expected-fail), db:check and db:gate (6 files, twice) are green. Nothing
  applied live, not pushed.
- Decided: keep `on delete set null` and let exactly that update through (DECISIONS.md "audit_log actor erasure").
- Resolved: the P1.7 audit-actor bug, which was a blocker for going live.
- Left off: P1.8. When applying live (P1.11), BOTH 20260928235000 and 20260928235500 must go together, never the first alone.

### 2026-09-28 (P1.7) — AI, billing, audit, plans and seed migration

- Did: `supabase/migrations/20260928235000_themis_ai_billing_audit.sql` (see §2). A scratch PGlite script ran 79
  behavioural checks, all PASS (BUILD_LOG.md), and was not committed. One existing test went RED: the recursion-rule
  sweep required a helper call in EVERY themis policy, and `plans_select` is `true` by design. It now skips `plans.`
  as it skipped `profiles.`; no expected value changed. lint, typecheck, 327 tests, db:check and db:gate (5 files,
  applied twice) are green. Nothing applied live, nothing pushed.
- Decided: seed marked UNCONFIRMED via a table comment; € ceilings are placeholders; audit_log append-only by trigger
  as well as grant; `swot_draft` kind admitted now (DECISIONS.md P1.7).
- Left off: test-writer for P1.7 (append the four tenant tables to `TENANT_TABLES`; server-only writes; audit
  append-only; plans anon read + seed). Then P1.8. Open for P3.9: appending to `ai_runs.accepted` needs a
  server-side RPC, since clients cannot write ai_runs. Open for P4-PRICING: the flat Team € ceiling vs seats.

### 2026-09-28 (P1.6 tests) — analysis tables in `scripts/db-tenancy.test.ts`

- Did: 99 tests in the same file/PGlite. The fixture gained SWOT, risks, an editor-authored comment and two
  approvals in A, and one of each in B. The four tables joined `TENANT_TABLES`. The new tests cover composite
  decision-FK and option-FK refusals, the viewer comment right, author-only comment edit (including a removed
  author), admin|owner-only approvals and append-only approvals for every role, CHECK/NOT NULL limits, no stored
  exposure, the exact FK/policy (14)/column-grant sets, defaults, updated_at and cascades. Five archive-copy
  mutations went RED (BUILD_LOG.md). lint, typecheck, 327 tests, db:check and db:gate are green. `supabase/` is
  untouched, nothing is pushed.
- Resolved: the builder's uncommitted 82-check scratch script is now permanent coverage.
- Left off: P1.7.

### 2026-09-28 (P1.6) — analysis and collaboration migration

- Did: `supabase/migrations/20260928230000_themis_analysis.sql` (see §2). No existing test went RED (P1.4/P1.5
  exact-set assertions were already scoped), so `scripts/db-tenancy.test.ts` is untouched. A scratch PGlite script
  ran 82 behavioural checks, all PASS (BUILD_LOG.md), and was not committed. lint, typecheck, 228 tests, db:check and
  db:gate (4 files, applied twice) are green. Nothing applied live, nothing pushed.
- Decided: approvals follow PLAN P1.6 (admin|owner direct INSERT, append-only); risks carry decision_id for the
  composite chain; risk owner is free text; option of a swot/risk is not updatable (DECISIONS.md P1.6).
- Left off: test-writer for P1.6 (append the four tables to `TENANT_TABLES`; comment-author rule, approval
  append-only, option FKs, column grants). Then P1.7. Open for P4.2: a direct approval insert does not freeze the
  decision — decide there whether to revoke the direct INSERT grant once `approve()`/`reject()` exist.

### 2026-09-28 (P1.5 tests) — decision core in `scripts/db-tenancy.test.ts`

- Did: 88 tests added in the same file and PGlite instance (the actAs helpers are module-local). The
  fixture gained a draft decision and a frozen decision in A and a draft in B, with options, criteria
  and scores. The four tables joined `TENANT_TABLES`. The file now covers: composite-FK and RLS
  refusals for cross-tenant child inserts, scores that mix two decisions, viewer read-only access,
  editor/admin/owner writes and the upsert, lifecycle columns refused on UPDATE and INSERT, frozen
  decisions that cannot be updated or deleted, CHECK/unique limits, exact column grants, anon
  refusals, created_by defaults, updated_at bumps and cascades. Three archive-copy mutations each went RED
  (BUILD_LOG.md). lint, typecheck, 228 tests, db:check and db:gate are green. `supabase/` is untouched.
- Left off: P1.6. Children of a frozen decision are still writable by editors until the P4.2
  `decision_frozen` triggers. That is by plan, and the P1.5 tests do not lock it in either direction.

### 2026-09-28 (P1.5) — decision core migration

- Did: `supabase/migrations/20260928220000_themis_decisions.sql` (see §2). Three P1.4 exact-set tests are
  scoped to the P1.4 tables so that new tables do not break them. Added the enum-match test (the CHECK values
  equal the keys of `METHODOLOGIES`/`SCALES`), which was proven RED by a mutation. A scratch PGlite script ran
  50 behavioural checks, all PASS, and was not committed. lint, typecheck, 140 tests, db:check and db:gate
  (3 files, applied twice) are green. Nothing was applied live, and nothing was pushed.
- Decided: lifecycle columns are RPC-only (P4.2), frozen is enforced by RLS on `decisions`, scores pin both
  ends to one decision, and `position` is added (DECISIONS.md P1.5).
- Left off: the P1.5 test-writer appends the four tables to `TENANT_TABLES` and adds role gating,
  composite-FK and column-grant tests. Then P1.6. P1.8 moves the enum check into db-gate.mjs.

### 2026-09-28 (P1.4 tests) — `scripts/db-tenancy.test.ts`

- Did: 82 Vitest tests replace the builder's scratch 84-check script. They cover shapes, FKs, CHECKs,
  helpers, RLS, the exact policy set, grants, A/B isolation, role gating, RPC-only writes, cascades,
  updated_at, and an unchanged Hephaestus side. Four mutations on archive copies each went RED:
  ws-select `true`, anon grant, invoker helper, and update-memberships grant (BUILD_LOG.md). lint,
  typecheck, 138 tests (about 2 s), db:check and db:gate are green. The committed migration is untouched.
- Decided: the tenancy contract lives in Vitest, not in `db-gate.mjs`. P1.8 still owns the gate's
  structural sweep and leak matrix, and it can reuse `actAs`/`TENANT_TABLES`.
- Left off: P1.5 (decision core). Extend `TENANT_TABLES` for its tables.

### 2026-09-28 (P1.4) — tenancy migration

- Did: `supabase/migrations/20260928210000_themis_tenancy.sql` (see §2). lint, typecheck, 56 tests,
  db:check and db:gate all green, with both files applied and re-applied. A scratch PGlite script
  ran 84 checks, all PASS: A/B cross-tenant reads return 0, cross-tenant writes have no effect,
  viewer and editor are role-gated, anon holds nothing, there is no recursion, and deletes cascade.
  It is not committed, because P1.8 owns the leak suite. Nothing was applied live.
- Decided: membership, invite and workspace-creation writes are RPC-only. Grants are
  column-limited to match the policies. There is no citext (DECISIONS.md P1.4).
- Left off: test-writer for P1.4, which should add tenancy contract checks to `db-gate.mjs`. Then P1.5.

### 2026-09-28 (P1.3 tests) — `scripts/check-migrations.test.ts`

- Did: 39 Vitest tests, one RED fixture per guard rule plus GREEN allowed forms, asserting rule id
  and line; real archive PASS. Five mutations of the guard each turned tests RED (BUILD_LOG.md).
  Added `tsconfig.scripts.json` (referenced from `tsconfig.json`) so `tsc -b` typechecks
  `scripts/**/*.test.ts`. lint/typecheck/56 tests/db:gate green.
- Left off: P1.4 (tenancy migration).

### 2026-09-28 (P1.3) — static migration guard

- Did: `scripts/check-migrations.mjs` + `npm run db:check`. `db-gate.mjs` now runs it before the
  shim and applies nothing when it is red. It exits 0 on the archive. It was proven RED (exit 1,
  `file:line [rule]`) on 19 scratch fixtures, one or more per rule, including a string-literal
  evasion. Two allowed-pattern fixtures stay GREEN. lint, typecheck, 17 tests and db:gate are green.
- Decided: the guard is stricter than the PLAN's four bullets, and that is recorded in DECISIONS.md.
- Left off: test-writer writes `scripts/check-migrations.test.ts`; then P1.4.

### 2026-09-28 (P1.2) — `db:gate` harness and bootstrap migration

- Did: PGlite gate + shared-project shim + `20260928200000_themis_schema.sql` (see §2). Gate: 17
  PASS, exit 0; proven RED on empty/missing dir, removed USAGE grant, non-idempotent file, SQL
  error. lint/typecheck/17 tests green. No live project touched.
- Decided: archive applied twice; default EXECUTE revoked from PUBLIC in `themis` (DECISIONS.md).
- Left off: P1.3 (static migration guard, called first by `db-gate.mjs`).

### 2026-09-28 (P1.1) — ADR-0002: shared Supabase, own schema `themis`

- Did: wrote ADR-0002 in DECISIONS.md (supersedes ADR-0001's "no Supabase" clause); constitution
  §2 names Supabase schema `themis` + ADR-0002 deviation, §8 names `db:gate`, `db:gate:prove-red`,
  `db:apply` (migrate) and "e2e arrives in P2", §11 forbids `supabase db push`/`link`. CLAUDE.md
  recomposed with `kit.mjs apply`; `kit.mjs check` canonical. No live project touched.
- Left off: P1.2 (`db:gate` harness + bootstrap migration).

### 2026-09-28 (domain) — live at https://themis.adeonanalytics.com (ADR-0003)

- The operator added CNAME `themis` → `intotheveil.github.io` in the adeonanalytics.com zone, then Pages `cname` was set and the `base: '/'` build pushed. The cert was approved within about a minute and HTTPS is enforced. Verified: 200 on the page and all assets; http→https and github.io/themis/ → domain are both 301; a live screenshot matches.
- Gotcha: set the Pages custom domain ONLY after the CNAME resolves at the zone's own nameserver. Setting it first 301s the old URL to a name that does not exist yet. Google DNS cached my earlier NXDOMAIN for up to the SOA minimum (300 s), while 1.1.1.1 and the authoritative server already had the record.
- Also listed on adeonanalytics.com as "Decision Intelligence" with an "Open the app" button (adeon-site `APP_URL`).

### 2026-09-28 (spec) — commercial v1 specified; AWAITING OPERATOR APPROVAL (checkpoint)

- Operator asked for a "commercial ready product" and ruled: hosted AI (we pay, metered), Free/Pro/Team via Stripe, v1 = AI analyst + SWOT/Risk + PDF report + Team workspace, seller = another entity (unnamed).
- Did: wrote `zeus/specs/THEMIS_SPEC.md` (defensibility rule, modules, plans, Supabase EU + Edge Functions + Stripe, data model, hard constraints, P1–P6 arc with checkpoints, 6 open questions).
- Left off: **CHECKPOINT (CLAUDE.md §7).** Nothing past P0 is built until the operator approves the spec and answers §10 Q1–Q2. Next after approval: `planner` turns the spec into PLAN.md, then P1 (needs the operator's OK to create the Supabase EU project).

### 2026-09-28 (logo) — the operator's real artwork replaces the drawn mark

- Did: the source is `C:\Users\Master\Documents\4M Studios\Themis Log.png` (1254², a poster, NOT committed; only crops are). PIL crops live in `public/brand/`: the bust (300,10)-(860,570) as `themis-bust.webp`, the THEMIS wordmark (280,640)-(990,800) as `themis-wordmark.webp`, and round-masked icons (`favicon.png` 64, `themis-icon.png` 96, `apple-touch-icon.png` 180). `og-themis.jpg` 512² adds a share preview. `Mark.tsx` and `favicon.svg` were removed. Resolved: F4.
- Decided: the full poster is NOT shown on the page. It advertises Forecast, SWOT, scenario planning and more as working features, and none is built. Crops only, until those ship.
- Gotcha: the wordmark crop carries the poster's dark backdrop, so it shows as a box on the page. `.brand-fade` masks all four edges (two gradients with `mask-composite: intersect`).
- Gotcha: Vitest runs with `BASE_URL` = `/`, not `/themis/`. Asset URLs are asserted to derive from `BASE_URL`; the `/themis/` prefix is checked in the built bundle (`grep /themis/brand/ dist/assets/*.js`).

### 2026-09-28 (deploy) — LIVE at https://intotheveil.github.io/themis/

- Resolved: **B1.** The operator granted the gh `workflow` scope, `main` was pushed and Pages enabled (`build_type=workflow`). Run 36448167598 passed both verify and deploy. The live URL, JS, CSS and favicon all return 200, and a headless screenshot of the live page matches the local build.
- Gotcha: Pages was enabled AFTER the first push, and that first run still deployed. Order does not matter for `build_type=workflow`.
- Left off: P0 is live. Next is Q1 (scope), then an F1 spec.

### 2026-09-28 (later) — renamed Metis → Themis; brand applied; NOT yet deployed

- Did: the operator sent Themis brand artwork (a marble statue with the scales, gold on black,
  "Decision Intelligence Platform · Better analysis. Clearer options. Stronger decisions.") and
  chose to rename the product. Repo `intotheveil/metis` → `intotheveil/themis` (public), local dir,
  Pages base and zeus `fleet.repos` all moved. The UI was restyled to match: `src/Mark.tsx`, a
  Cinzel gold wordmark and warm-black tokens. The brief's modules (SWOT, scenarios, risk, …) are
  listed as ROADMAP, not features. A phone-overflow bug was fixed. 16 tests; lint, typecheck and
  build green.
- Left off: **§4 B1**. Local commits are unpushed until the `workflow` scope is granted.

### 2026-09-28 — created greenfield via Zeus NEW PRODUCT (as Metis)

- Did: named Metis (operator-confirmed; renamed to Themis later the same day, see above), created `intotheveil/themis`, scaffolded the house front-end
  stack, built a dark "serious, modern" UI with a working weighted decision matrix (operator asked
  mid-build), CI + GitHub Pages deploy, crew kit from zeus `.zeus/kit/` (7 hooks, 7 agents,
  composed constitution, `settings.template.json`), this brain.
- Decided: ADR-0001 — GitHub Pages, no Supabase until needed. No `BRAIN_DISCIPLINE.md` append (kit CORE §0).
- Left off: live P0. Next is a spec for F1 once Q1 is answered.

---

## 7. DECISIONS (dated ADR-lite)

- **2026-09-28:** GitHub Pages + no backend yet — the operator asked for a quick Pages project and P0 stores nothing (DECISIONS.md ADR-0001).
- **2026-09-28:** shared Supabase `lss-platform`, schema `themis` only, own `themis.schema_migrations`, Management-API applier, never `db push` (DECISIONS.md ADR-0002; supersedes ADR-0001's no-Supabase clause).
- **2026-09-28:** `db:gate` applies the archive twice (idempotency proof); `themis` revokes default EXECUTE from PUBLIC (DECISIONS.md, P1.2).
- **2026-09-28:** tenancy writes (memberships, invites, new workspaces) are RPC-only; RLS reads membership only via SECURITY DEFINER helpers (DECISIONS.md P1.4).
- **2026-09-28:** decision lifecycle columns (status, frozen, approved_*, lineage/revision) are not client-writable; only the P4.2 RPCs change them. A frozen decision cannot be updated or deleted (DECISIONS.md P1.5).
- **2026-09-28:** approvals are append-only (admin|owner INSERT, no UPDATE/DELETE); only a comment's author edits it; risk exposure is never stored (DECISIONS.md P1.6).
- **2026-09-28:** billing and AI ledgers (ai_runs, subscriptions, usage_monthly) are client read-only, service_role writes; audit_log is append-only for every role (trigger); plans is public reference data seeded with UNCONFIRMED proposal values (DECISIONS.md P1.7).
- **2026-09-28:** audit_log's append-only trigger permits only the actor FK's SET NULL (actor → NULL, all else unchanged); no role gains UPDATE (DECISIONS.md "audit_log actor erasure").
- **2026-09-28:** `db:gate:prove-red` counts a sabotage as RED only on exit 1 AND its expected FAIL line(s), with a green control run; sabotages are data in the script (DECISIONS.md P1.9).
- **2026-09-28:** a 1 maps to 0, not 20% — "worst" must read as worst, or a poor option looks acceptable.
- **2026-09-28:** no winner is named while any option is partly scored, and <5 points is "too close to call" — Themis must not manufacture confidence.

---

## 8. TELEMETRY FIX LEDGER

_Not wired to fleet telemetry yet._

| fingerprint | error (short) + URL/count | first seen | root cause | fix commit | deployed | status | if it recurs → start here |
| ----------- | ------------------------- | ---------- | ---------- | ---------- | -------- | ------ | ------------------------- |
