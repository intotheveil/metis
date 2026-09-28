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
