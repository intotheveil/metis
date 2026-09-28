# 🧠 BRAIN — Themis (`themis`)

> This is the single source of truth for this product. It is read BEFORE any work and
> written AFTER any work (CLAUDE.md §0). Knowledge lives here, not in conversation history.
> Seeded 2026-09-28 from the operator's intent at NEW PRODUCT time; genuine unknowns are
> marked **❓ needs human input** rather than invented.

**Last updated:** 2026-09-28 by Claude Code (Opus 5.5, Windows desktop, dispatched from zeus)
**Status:** in-development
**Repo:** `intotheveil/themis` · local `D:\projects\themis`   ·   **Deployed:** https://intotheveil.github.io/themis/ (GitHub Pages)

---

## 1. WHAT THIS IS  (never-changes context — read first, every time)

Themis is an AI-powered decision-making tool for projects run **Waterfall, Agile, or "YOLO"**
(ship-first), for companies from small to large. The operator's intent, verbatim: *"A tool which
is AI powered for decision making using all best models and practices for Waterfall and Agile and
even yolo projects. But also for Companies from small and large scale."* Named for the Titaness of
divine law and order, who holds the scales. "Working" means a user can frame a decision, weigh criteria for their delivery
method and org scale, score options, and get an honest recommendation — including "too close to
call".

---

## 2. ARCHITECTURE  (the canonical technical truth — investigate ONCE, record here)

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
- **External services / keys:** none. `.env.example` reserves `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY` (unset, unused).
- **How to run / build / test / deploy:** `npm run dev` · `npm test` · `npm run lint && npm run
  typecheck` · `npm run build`. Deploy = push to `main` → `.github/workflows/deploy.yml`
  (verify job, then `actions/deploy-pages`). Pages source is "GitHub Actions".
- **Integration points:** none yet. Not wired to fleet telemetry (❓ decide when/if).

---

## 3. CURRENT STATE  (what's true RIGHT NOW)

- **What's live / working:** P0 shell + a working client-side weighted decision matrix with
  Waterfall/Agile/YOLO × small/mid/enterprise criteria presets. 15 tests (12 model, 3 UI).
- **What's in progress:** nothing half-done.
- **What's next / planned:** a SPEC for the AI analyst (❓ needs human input: which models,
  who pays for inference, whether decisions must be saved/shared → that decides Supabase + auth).

---

## 4. OUTSTANDING  (the triage queue)

| id | sev | type | summary | status | added |
|----|-----|------|---------|--------|-------|
| F1 | 🟠 | feature | AI analyst — challenge assumptions, suggest missing criteria, stress-test the winner. Needs a server-side proxy (never a key in the bundle) → reopens ADR-0001 | open | 2026-09-28 |
| F2 | 🔵 | feature | Persist/share decisions (localStorage first, Supabase EU when multi-user) | open | 2026-09-28 |
| F3 | 🔵 | feature | Playwright e2e against the production build; then name `e2e` in CLAUDE.md §8 | open | 2026-09-28 |
| Q1 | 🟡 | question | ❓ needs human input — product scope beyond the matrix: methodology playbooks (stage-gates, sprint decisions), RACI/approvals for enterprise? | open | 2026-09-28 |

---

## 5. GOTCHAS  (hard-won "don't do X, it breaks Y")

- **Pages serves under `/themis/`.** `vite.config.ts` `base` must stay `/themis/`; `index.html`'s
  favicon is spelled `/themis/favicon.svg` for the same reason. Renaming the repo breaks every asset.
- **The kit's `format.sh` rewrites files on Write/Edit here** (this repo HAS a prettier config),
  including `.claude/CLAUDE.project.md` — after editing that file, re-run
  `node <zeus>/.zeus/kit/kit.mjs apply themis` so the composed CLAUDE.md matches.
- **A static bundle is public.** No `VITE_*` secret, ever — Vite inlines them.

---

## 6. CHANGELOG  (append-only — newest first)

### 2026-09-28 — created greenfield via Zeus NEW PRODUCT
- Did: named Themis (operator-confirmed), created `intotheveil/themis`, scaffolded the house front-end
  stack, built a dark "serious, modern" UI with a working weighted decision matrix (operator asked
  mid-build), CI + GitHub Pages deploy, crew kit from zeus `.zeus/kit/` (7 hooks, 7 agents,
  composed constitution, `settings.template.json`), this brain.
- Decided: ADR-0001 — GitHub Pages, no Supabase until needed. No `BRAIN_DISCIPLINE.md` append (kit CORE §0).
- Left off: live P0. Next is a spec for F1 once Q1 is answered.

---

## 7. DECISIONS  (dated ADR-lite)

- **2026-09-28:** GitHub Pages + no backend yet — the operator asked for a quick Pages project and P0 stores nothing (DECISIONS.md ADR-0001).
- **2026-09-28:** a 1 maps to 0, not 20% — "worst" must read as worst, or a poor option looks acceptable.
- **2026-09-28:** no winner is named while any option is partly scored, and <5 points is "too close to call" — Themis must not manufacture confidence.

---

## 8. TELEMETRY FIX LEDGER

_Not wired to fleet telemetry yet._

| fingerprint | error (short) + URL/count | first seen | root cause | fix commit | deployed | status | if it recurs → start here |
|-------------|---------------------------|-----------|------------|-----------|----------|--------|---------------------------|
