# 🧠 BRAIN — Themis (`themis`)

> This is the single source of truth for this product. It is read BEFORE any work and
> written AFTER any work (CLAUDE.md §0). Knowledge lives here, not in conversation history.
> Seeded 2026-09-28 from the operator's intent at NEW PRODUCT time; genuine unknowns are
> marked **❓ needs human input** rather than invented.

**Last updated:** 2026-09-28 by Claude Code (Opus 5.5, Windows desktop, dispatched from zeus)
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
  §2/§8/§11 for the shared database. The `db:*` scripts named in §8 arrive in P1.2/P1.9/P1.11.
- **What's next / planned:** a SPEC for the AI analyst (❓ needs human input: which models,
  who pays for inference, whether decisions must be saved/shared → that decides Supabase + auth).

---

## 4. OUTSTANDING (the triage queue)

| id  | sev | type     | summary                                                                                                                                                                                                                                                                                                                                                                                                           | status | added      |
| --- | --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| S1 | 🟠 | checkpoint | Commercial v1 spec (`zeus/specs/THEMIS_SPEC.md`) awaiting operator approval + §10 answers (entity, prices, domain, email provider, repo visibility) | open | 2026-09-28 |
| F1  | 🟠  | feature  | AI analyst — challenge assumptions, suggest missing criteria, stress-test the winner. Needs a server-side proxy (never a key in the bundle) → reopens ADR-0001                                                                                                                                                                                                                                                    | open   | 2026-09-28 |
| F2  | 🔵  | feature  | Persist/share decisions (localStorage first, Supabase EU when multi-user)                                                                                                                                                                                                                                                                                                                                         | open   | 2026-09-28 |
| F3  | 🔵  | feature  | Playwright e2e against the production build; then name `e2e` in CLAUDE.md §8                                                                                                                                                                                                                                                                                                                                      | open   | 2026-09-28 |
| Q1  | 🟡  | question | ❓ needs human input — product scope beyond the matrix: methodology playbooks (stage-gates, sprint decisions), RACI/approvals for enterprise?                                                                                                                                                                                                                                                                     | open   | 2026-09-28 |

---

## 5. GOTCHAS (hard-won "don't do X, it breaks Y")

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
- **2026-09-28:** a 1 maps to 0, not 20% — "worst" must read as worst, or a poor option looks acceptable.
- **2026-09-28:** no winner is named while any option is partly scored, and <5 points is "too close to call" — Themis must not manufacture confidence.

---

## 8. TELEMETRY FIX LEDGER

_Not wired to fleet telemetry yet._

| fingerprint | error (short) + URL/count | first seen | root cause | fix commit | deployed | status | if it recurs → start here |
| ----------- | ------------------------- | ---------- | ---------- | ---------- | -------- | ------ | ------------------------- |
