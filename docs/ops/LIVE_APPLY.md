# LIVE_APPLY — the first apply of schema `themis` to the shared Supabase project

**Task:** PLAN P1.13 (runbook + pre-apply evidence pack). **Executed by:** P1.14, only after the operator says
**go** at **CHECKPOINT P1-LIVE**. **Rulebook:** ADR-0002 in `DECISIONS.md`, `zeus/specs/THEMIS_SPEC.md` §5a.

> **Nothing in this document has been run against a live project.** Every output below comes from local runs
> (PGlite, a fake HTTP server) on 2026-09-28 at commit `0dc46ae`. The live outputs are pasted into `BUILD_LOG.md`
> by P1.14, step by step.

---

## 0. What changes on the live project, and what must not

| Fact                  | Value                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Project               | `lss-platform`, ref `atopkqykdmrcfvvcistc`, eu-west-1. It is **Hephaestus's LIVE production project** (https://lss-platform.netlify.app) |
| Data API URL          | `https://atopkqykdmrcfvvcistc.supabase.co`                                                                                               |
| Themis's own ledger   | `themis.schema_migrations` (created by the first migration)                                                                              |
| Hephaestus's ledger   | `supabase_migrations.schema_migrations`: **never written by Themis, by any tool**                                                        |
| Files applied         | the 6 files in `supabase/migrations/` (checksums in §7.1), as **5 transactions**                                                         |
| Project setting added | `themis` appended to the Data API's exposed schemas (project-wide, shared with Hephaestus)                                               |

After P1.14 the project differs from today in exactly two ways: (1) a new schema `themis` holding 18 tables, 43
indexes, 5 functions and 43 policies, plus the internal FK triggers that its foreign keys put on `auth.users`, and
(2) `themis` at the END of the exposed-schema list. Anything else that changes is a failure (§4).

**Never, against this project:**

- `supabase db push`, `supabase link`, `supabase db reset`, `supabase migration *` (CLAUDE.md §11).
- The Supabase connector's **`apply_migration`** tool. It records a version in `supabase_migrations.schema_migrations`,
  which is Hephaestus's ledger. A foreign row there breaks Hephaestus's next `supabase db push`. Also never the
  connector's branch tools (`create_branch`, `merge_branch`, `reset_branch`, `rebase_branch`), `pause_project` or
  `restore_project`.
- Changing any other Data API field: not `db_extra_search_path`, not `max_rows`, not the order of the existing
  exposed schemas.
- Pasting the full `GET /postgrest` response anywhere. **It contains the project's JWT secret.** The snippets below
  print only `db_schema`, `db_extra_search_path` and `max_rows`.

---

## 1. Transports: two ways to reach the project

There is **no `SUPABASE_ACCESS_TOKEN` on the operator's desktop today.** The runbook therefore supports two transports.
Pick ONE for the whole session. All snapshots (`pre`, `post`, `exposed`) MUST be taken through the same transport, so that the
diff compares like with like.

### Transport A — the repo scripts with a token (recommended)

The operator creates a personal access token (Dashboard → Account → Access Tokens), named for example
`themis-p1-live-2026-09-28`. It is exported in the shell for this session only, and **revoked right after step 8**.
Nothing is written to a file. `db:apply` and `db:snapshot` read the environment and never read a `.env` file.

```bash
# Git Bash, repo root D:/projects/themis
export THEMIS_SUPABASE_PROJECT_REF=atopkqykdmrcfvvcistc
read -rs SUPABASE_ACCESS_TOKEN && export SUPABASE_ACCESS_TOKEN   # paste the token; it is not echoed
# … steps 1–8 …
unset SUPABASE_ACCESS_TOKEN   # then revoke the token in the Dashboard
```

The token is redacted from every line `db:apply` and `db:snapshot` print (P1.11/P1.12 tests).

### Transport B — the operator's authenticated Supabase connector, `execute_sql` only

This runs in a Claude session that has the operator's Supabase connector. The session runs **only `execute_sql`**
(with `project_id: atopkqykdmrcfvvcistc`) and read-only reads (`list_tables`, `get_advisors`). It sends **exactly
the SQL the repo prints**. The helpers below write that SQL to files under `ops-snapshots/` (gitignored), using the
same exported functions the scripts use. The session then passes each file's content as the `query` argument
**verbatim**. It reads the file and never retypes, reformats or "fixes" the SQL.

- **Batches:** `ops-snapshots/sql/dryrun-<k>.sql` and `apply-<k>.sql` come from `db-apply.mjs`'s own `plan()` and
  `buildBatch()`. Verified locally: all 5 dry-run and 5 apply files are **byte-identical** to the request bodies
  `db:apply` sends (§7.5).
- **Snapshots:** `ops-snapshots/sql/snapshot-<section>.sql` are `db-snapshot.mjs`'s 14 `SECTIONS`, each passed through
  its read-only checker. The session saves each result into `ops-snapshots/raw-<label>/<section>.json`, and a helper
  assembles the snapshot file with `takeSnapshot()`. Verified locally: the assembled file equals the one
  `takeSnapshot()` produces directly (§7.5).
- **The exposed-schema list is not SQL.** The connector has no PostgREST-config tool, so in transport B, steps 2 and 6
  are done by the operator in the Dashboard (Project Settings → Data API → Exposed schemas).
- **Read-only mode.** If the connector runs in read-only mode, the snapshots work, but the dry-run fails with a
  read-only/permission error. That is the connector's mode, not a migration bug. The dry-run and apply need a
  connector with write access.
- **Size.** The largest batch (`dryrun-5.sql`) is about 56 KB. If the connector refuses a query that size, stop. The
  fallback is transport A, or the operator pasting the same file into the Dashboard SQL Editor (which, like
  `execute_sql`, does not touch `supabase_migrations`).
- **Fidelity.** The ledger's checksum literals are computed locally, so a correct ledger does NOT prove that the text
  executed was the text in the file. Step 5 therefore compares the live `themis` object list with the reference list
  in §7.4.

**Transport B helper 1: the batch files.** First read the live ledger with `execute_sql`:

```sql
select to_regclass('themis.schema_migrations') is not null as ledger_present;
```

If it is `false` (the first apply), the applied list is empty. If it is `true`, run the following and save the value
of `applied`:

```sql
select coalesce(json_agg(json_build_object('version', version, 'name', name, 'checksum', checksum)
  order by version), '[]'::json) as applied from themis.schema_migrations;
```

Then, in the repo root:

```bash
mkdir -p ops-snapshots/sql && echo '[]' > ops-snapshots/sql/applied.json   # or the saved `applied` value
node --input-type=module <<'EOF'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { checkMigrationsDir } from './scripts/check-migrations.mjs'
import { DEFAULT_DIR, buildBatch, loadMigrations, plan } from './scripts/db-apply.mjs'
const out = 'ops-snapshots/sql'
mkdirSync(out, { recursive: true })
const applied = JSON.parse(readFileSync(`${out}/applied.json`, 'utf8'))
const guard = checkMigrationsDir(DEFAULT_DIR)
if (guard.error || guard.violations.length > 0) { console.error('REFUSED: db:check is red'); process.exit(1) }
const { units, problems } = plan(loadMigrations(DEFAULT_DIR), applied)
if (problems.length > 0) { for (const p of problems) console.error(`FAIL  ${p}`); process.exit(1) }
if (units.length === 0) { console.log('nothing pending'); process.exit(0) }
units.forEach((unit, i) => {
  const k = i + 1
  writeFileSync(`${out}/dryrun-${k}.sql`, buildBatch(units.slice(0, k).flat(), 'rollback'))
  writeFileSync(`${out}/apply-${k}.sql`, buildBatch(unit, 'commit'))
  console.log(`${k}. ${unit.map((m) => `${m.file} sha256 ${m.checksum}`).join(' + ')}`)
})
console.log(`wrote ${out}/dryrun-1..${units.length}.sql and ${out}/apply-1..${units.length}.sql`)
EOF
```

It applies the same refusals as `db:apply`: the guard, checksum changed, a file missing, out of order, transaction
control, and an incomplete PAIRED group. It prints the plan, which must match §7.1.

**Transport B helper 2: the snapshot SELECTs.**

```bash
node --input-type=module <<'EOF'
import { mkdirSync, writeFileSync } from 'node:fs'
import { SECTIONS, assertReadOnly } from './scripts/db-snapshot.mjs'
mkdirSync('ops-snapshots/sql', { recursive: true })
for (const s of SECTIONS) {
  assertReadOnly(s.sql)
  writeFileSync(`ops-snapshots/sql/snapshot-${s.name}.sql`, s.sql)
  console.log(`ops-snapshots/sql/snapshot-${s.name}.sql`)
}
EOF
```

The session runs each of the 14 files through `execute_sql`, and saves the returned JSON array (only the array, not
the connector's wrapper text) as `ops-snapshots/raw-<label>/<section>.json`, where `<section>` is the part of the file
name after `snapshot-`.

**Transport B helper 3: assemble a snapshot** (set `LABEL=pre`, `post`, `exposed` or `dryrun`):

```bash
LABEL=pre node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs'
import { SECTIONS, snapshotFileName, takeSnapshot } from './scripts/db-snapshot.mjs'
const label = process.env.LABEL
const client = {
  async query(sql) {
    const s = SECTIONS.find((x) => x.sql === sql)
    return JSON.parse(readFileSync(`ops-snapshots/raw-${label}/${s.name}.json`, 'utf8'))
  },
}
const now = new Date()
const snap = await takeSnapshot({ client, label, projectRef: 'atopkqykdmrcfvvcistc', now })
const file = `ops-snapshots/${snapshotFileName(now, label)}`
writeFileSync(file, JSON.stringify(snap, null, 2) + '\n')
console.log(JSON.stringify(snap.summary, null, 2))
console.log(`WROTE ${file}`)
EOF
```

`npm run db:snapshot:diff -- pre post` then works the same as in transport A. Keep `ops-snapshots/` free of any other
`*-pre.json` / `*-post.json` file, because a label resolves to the NEWEST matching file.

---

## 2. Pre-flight (local; no network; the day of the apply)

1. **The repo.** `git status` is clean, and HEAD is the commit the operator approved. Run `npm ci`, then
   `npm run lint && npm run typecheck && npm test && npm run db:check && npm run db:gate && npm run db:gate:prove-red`.
   Every command must pass, with `GATE PASSED` and `PROVE-RED PASSED — 34/34`.
2. **The plan.** The migration list and checksums equal §7.1. Any difference means the archive changed after this
   runbook was reviewed, so stop and re-review.
3. **The Hephaestus baseline, taken BEFORE step 1** (so that a failure that already exists is not blamed on the
   apply):
   - `cd D:/projects/lss-platform && git status --short && git log -1 --oneline && npm test`. Record the pass count;
     it was 721/721 in 57 files at `4573d80` on 2026-09-28.
   - The live read-only smoke and the Data API probes in step 8 (b) and (c), labelled **pre**.
4. **Coordinate with Hephaestus.** Hephaestus has production migrations waiting (its BRAIN: `…019`–`…025`). No
   Hephaestus `supabase db push`, Netlify deploy or project-settings change may happen between step 1 and step 8. If
   one happens, it shows up in the diff as a change outside `themis`, and the run cannot be judged.
5. **Pick a low-traffic window.** Adding each FK to `auth.users` takes a SHARE ROW EXCLUSIVE lock on `auth.users` that
   lasts until the batch ends. The dry-run holds it too. While a batch runs, Hephaestus sign-ups and profile updates
   wait, for about a second per batch. `lock_timeout = 5s` makes a batch give up rather than queue behind a busy
   `auth.users`. A lock timeout is safe: the batch is rolled back, and a retry in a quieter moment needs no change.

---

## 3. The steps, in order

Every PLAN P1.13 step is here, but **two are reordered, and a second diff is added** (DECISIONS.md P1.13):

| PLAN P1.13 order             | This runbook                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| 1. `db:snapshot pre`         | step 1                                                                                        |
| (3. read the exposed list)   | step 2: read-only, moved first so the rollback target is on record before anything changes    |
| 2. `db:apply` dry-run        | step 3                                                                                        |
| 4. `db:apply --apply`        | step 4                                                                                        |
| 5. snapshot post + diff      | step 5: taken BEFORE exposing, so it gates the exposure                                       |
| 3. expose `themis`           | step 6: AFTER the schema exists and the diff is clean                                         |
| (new)                        | step 7: `db:snapshot exposed` + a second diff, which proves the exposure changed nothing else |
| 6. the Hephaestus regression | step 8                                                                                        |

Why expose last: before the apply, the Data API that Hephaestus uses would have a schema in its config that does not
exist yet, for the whole time between the two steps. After a clean diff, exposing costs nothing, and the schema is
never exposed on top of an unexplained change.

### Step 1 — `db:snapshot pre` (read-only)

- **A:** `npm run db:snapshot -- pre`
- **B:** helpers 2 and 3 with `LABEL=pre`.

**Record** the summary: `themisSchemaExists` (must be `false`), `supabaseMigrations {count, maxVersion}`,
`authUsersTriggers`, the `public` counts, `extensions` and `exposedSchemaFacts`.
**Stop if** `themisSchemaExists` is `true`. Something already created the schema, and this runbook's first-apply
premise does not hold.
**Rollback:** none needed (read-only).

### Step 2 — read the exposed-schema list (read-only) and record it

The exposed-schema list is **PostgREST config, not SQL**. It is read with `GET /v1/projects/{ref}/postgrest`. It is a
**project-wide setting that Hephaestus's Data API uses too.**

**A:**

```bash
node --input-type=module <<'EOF'
const { SUPABASE_ACCESS_TOKEN: token, THEMIS_SUPABASE_PROJECT_REF: ref } = process.env
const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/postgrest`, {
  headers: { Authorization: `Bearer ${token}` },
})
if (res.ok) {
  const cfg = await res.json()
  // Print ONLY these three fields. The response also carries the project's JWT secret.
  const { db_schema, db_extra_search_path, max_rows } = cfg
  console.log(JSON.stringify({ db_schema, db_extra_search_path, max_rows }))
} else {
  console.error(`GET /postgrest failed: HTTP ${res.status}`)
  process.exitCode = 1
}
EOF
```

**B:** Dashboard → Project Settings → Data API. Copy **Exposed schemas** exactly as shown, in order, and also
**Extra search path**.

**Record** `db_schema` verbatim in `BUILD_LOG.md` (P1.14). This value is the rollback target for step 6.
**The value is NOT known today.** P1.13 may not contact the project. Supabase's default is `public, graphql_public`,
but that is an unverified expectation, not a reading.
**Rollback:** none needed (read-only).

### Step 3 — `db:apply` (dry-run: every batch ends in ROLLBACK)

- **A:** `npm run db:apply`. The expected output is below; this is the PGlite rehearsal, and the live output replaces
  it in `BUILD_LOG.md`:

  ```text
  db:apply — DRY-RUN (every batch ends in ROLLBACK; nothing is committed) · project atopkqykdmrcfvvcistc · ledger themis.schema_migrations
  PASS  migration guard: 6 migration(s) stay inside schema themis
  ledger: themis.schema_migrations does not exist — nothing applied yet
  PLAN  6 pending file(s) in 5 transaction(s):
     1. 20260928200000_themis_schema.sql  sha256 cf85be6e40d6…
     2. 20260928210000_themis_tenancy.sql  sha256 083bdf4c9169…
     3. 20260928220000_themis_decisions.sql  sha256 83b94b357e9f…
     4. 20260928230000_themis_analysis.sql  sha256 f129b996cc4b…
     5. 20260928235000_themis_ai_billing_audit.sql  sha256 b4bc915f3477…  [paired: one transaction]
        20260928235500_themis_audit_actor_erasure.sql  sha256 7cb7f63eb009…
  OK    dry-run 20260928200000_themis_schema.sql — rolled back
  OK    dry-run 20260928210000_themis_tenancy.sql (on top of 1 earlier pending unit(s)) — rolled back
  OK    dry-run 20260928220000_themis_decisions.sql (on top of 2 earlier pending unit(s)) — rolled back
  OK    dry-run 20260928230000_themis_analysis.sql (on top of 3 earlier pending unit(s)) — rolled back
  OK    dry-run 20260928235000_themis_ai_billing_audit.sql + 20260928235500_themis_audit_actor_erasure.sql (on top of 4 earlier pending unit(s)) — rolled back
  DRY-RUN PASSED — 6 pending file(s) apply cleanly; everything was rolled back. Commit with: npm run db:apply -- --apply (operator's go only).
  ```

  Then `npm run db:snapshot -- dryrun` and `npm run db:snapshot:diff -- pre dryrun`. This must exit 0 with **zero**
  changes, including zero inside `themis`, because nothing was committed.

- **B:** helper 1 (batch files). Then `execute_sql` `dryrun-1.sql`, `dryrun-2.sql`, … `dryrun-5.sql` in order. Each
  must return an empty result and no error. After the last one, run:

  ```sql
  select to_regclass('themis.schema_migrations') as ledger,
    (select count(*) from pg_catalog.pg_namespace where nspname = 'themis') as themis_schemas;
  ```

  It must return `ledger = null` and `themis_schemas = 0`.

This is the first time the project's own event triggers (for example PostgREST's schema-reload trigger) and its
real `auth.users` see this SQL. A failure here is exactly what the dry-run is for.
**Stop if** any batch fails, or if anything survived the rollback. Nothing is committed in that case. Record the
error; the fix is a code task, not an improvisation (§5, "Step 3 (dry-run) fails").
**This is the last point where "no-go" costs nothing.**
**Rollback:** none needed. Every batch ended in ROLLBACK, and the check above proves it.

### Step 4 — `db:apply --apply` (commits)

- **A:** `npm run db:apply -- --apply`. Expected (rehearsal):

  ```text
  APPLIED 20260928200000_themis_schema.sql — committed with its ledger row(s)
  APPLIED 20260928210000_themis_tenancy.sql — committed with its ledger row(s)
  APPLIED 20260928220000_themis_decisions.sql — committed with its ledger row(s)
  APPLIED 20260928230000_themis_analysis.sql — committed with its ledger row(s)
  APPLIED 20260928235000_themis_ai_billing_audit.sql + 20260928235500_themis_audit_actor_erasure.sql — committed with its ledger row(s)
  APPLY PASSED — 6 file(s) committed and recorded in themis.schema_migrations.
  ```

  Then run `npm run db:apply` again (dry-run). It must print
  `PLAN  nothing pending — the live ledger matches all 6 file(s).` This re-reads the live ledger and re-checks every checksum.

- **B:** `execute_sql` `apply-1.sql` … `apply-5.sql`, in order, **one at a time. Stop at the first error.** Then run:

  ```sql
  select version, name, checksum from themis.schema_migrations order by version;
  ```

  The result must equal §7.1 row for row, with the full sha256. Save it as `ops-snapshots/sql/applied.json` (as the
  `applied` JSON of helper 1) and re-run helper 1. It must print `nothing pending`.

**The paired rule.** `20260928235000_themis_ai_billing_audit.sql` and `20260928235500_themis_audit_actor_erasure.sql`
are ONE unit, sent in ONE transaction (`apply-5.sql`). They are never split and never sent one without the other.
The first file alone installs `audit_log`'s append-only trigger WITHOUT the fix that lets the `actor` FK's `ON DELETE
SET NULL` through. Deleting any user who is an audit actor would then fail. `auth.users` is shared, so that would
break **Hephaestus's** user deletion. `db:apply` enforces the pair (`PAIRED`) and refuses an archive where one half is
missing. Transport B inherits this because helper 1 calls the same `plan()`. **Never hand-edit a batch file to drop,
split or reorder a unit.**

**Rollback:** see §5 "apply fails midway". A clean apply has no rollback short of the destructive one (§5, last row).

### Step 5 — `db:snapshot post` and `db:snapshot:diff` (read-only; the gate for step 6)

- **A:** `npm run db:snapshot -- post`, then `npm run db:snapshot:diff -- pre post`
- **B:** helpers 2 and 3 with `LABEL=post`, then `npm run db:snapshot:diff -- pre post`

**Pass:** exit 0, `DIFF PASSED — nothing outside schema themis changed`. The "inside themis (allowed)" block lists
the new objects. The `post` summary's `themisObjects` must equal §7.4 exactly (18 tables, 43 indexes, 5 functions).
`authUsersTriggers` gains only entries whose `owner` is `themis` (the FK triggers). `supabaseMigrations` is unchanged.
**Fail:** exit 1 means something outside `themis` changed (§5). Exit 2 means the snapshots cannot be compared (for
example, a different transport or project). **Step 6 runs only after this step passes**, so the schema is never
exposed on top of an unexplained change.
**Rollback:** none needed (read-only).

### Step 6 — expose `themis` in the Data API (additive; project-wide)

**This is a project-wide setting, shared with Hephaestus.** Its rules are:

- **Keep every existing schema, in the same order, and append `themis` at the END.** The FIRST schema in the list is
  the default for any request without an `Accept-Profile`/`Content-Profile` header. Putting `themis` first would
  send every such request (Hephaestus's included, whenever its client omits the header) to the wrong schema.
- Do not touch `db_extra_search_path` or `max_rows`.
- Saving makes the Data API reload its config, so Hephaestus's REST calls may blip for a few seconds.

**A:** replace the placeholder with the exact step-2 value. The snippet refuses to act if the live value is no
longer the recorded one (someone changed it in between), and it is idempotent:

```bash
RECORDED='<db_schema exactly as recorded in step 2>' MODE=expose node --input-type=module <<'EOF'
const { SUPABASE_ACCESS_TOKEN: token, THEMIS_SUPABASE_PROJECT_REF: ref, RECORDED: recorded, MODE: mode } = process.env
const url = `https://api.supabase.com/v1/projects/${ref}/postgrest`
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const read = async () => {
  const r = await fetch(url, { headers })
  if (!r.ok) throw new Error(`GET /postgrest failed: HTTP ${r.status}`)
  return list((await r.json()).db_schema) // only db_schema is kept; the body also holds the JWT secret
}
const main = async () => {
  const old = list(recorded)
  const withThemis = [...old, 'themis']
  if (old.length === 0 || old.includes('themis')) return ['REFUSED: RECORDED must be the step-2 value, without themis', 1]
  const now = await read()
  let target
  if (mode === 'expose') {
    if (same(now, withThemis)) return [`ALREADY EXPOSED  db_schema: ${now.join(', ')}`, 0]
    if (!same(now, old)) return [`REFUSED: db_schema is now "${now.join(', ')}", step 2 recorded "${old.join(', ')}"`, 1]
    target = withThemis
  } else if (mode === 'unexpose') {
    if (same(now, old)) return [`ALREADY UNEXPOSED  db_schema: ${now.join(', ')}`, 0]
    if (!same(now, withThemis)) return [`REFUSED: db_schema is now "${now.join(', ')}", expected "${withThemis.join(', ')}"`, 1]
    target = old
  } else return ['REFUSED: MODE must be expose or unexpose', 2]
  const r = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ db_schema: target.join(', ') }) })
  if (!r.ok) return [`PATCH /postgrest failed: HTTP ${r.status}`, 1]
  const after = await read()
  const ok = same(after, target)
  return [`${ok ? 'OK' : 'MISMATCH'}  ${mode}  before: ${now.join(', ')}  after: ${after.join(', ')}`, ok ? 0 : 1]
}
const [line, code] = await main().catch((e) => [String(e.message), 1])
;(code === 0 ? console.log : console.error)(line)
process.exitCode = code
EOF
```

The expected line is `OK  expose  before: <recorded>  after: <recorded>, themis`. The PATCH body is only
`{"db_schema": "<recorded>, themis"}`.

**B:** Dashboard → Project Settings → Data API → Exposed schemas: add `themis` as the last entry, leave everything
else as it is, and Save. Re-open the page and record the list; it must be the step-2 list plus `themis`.

**Verify** (both transports; read-only; the anon/publishable key is public, but it still goes in the shell, not in a
file):

```bash
read -r SUPABASE_ANON_KEY   # Hephaestus's VITE_SUPABASE_ANON_KEY value, or Dashboard → API keys
curl -s -H "apikey: $SUPABASE_ANON_KEY" -H "Accept-Profile: themis" \
  "https://atopkqykdmrcfvvcistc.supabase.co/rest/v1/plans?select=key&order=key"
# expected: [{"key":"free"},{"key":"pro"},{"key":"team"}]
```

Also re-run the step-8 (c) probes. A request without a profile header must answer exactly as it did in **pre**, which
proves the default schema did not move.
**Rollback:** `MODE=unexpose` with the same `RECORDED` (A), or remove `themis` in the Dashboard (B). This is additive
and safe, and it takes effect in seconds. It restores exactly the step-2 list.

### Step 7 — `db:snapshot exposed` and the second diff (read-only)

- **A:** `npm run db:snapshot -- exposed`, then `npm run db:snapshot:diff -- pre exposed`
- **B:** helpers 2 and 3 with `LABEL=exposed`, then `npm run db:snapshot:diff -- pre exposed`

**Pass:** exit 0, as in step 5. If the platform stores the exposed list as a `pgrst.db_schemas` role setting, the new
`themis` entry shows up inside themis (P1.12 splits that setting per schema). Removing any other schema would show up
outside themis. A REORDER would not (the rows are per schema); the step-6 `before/after` line is the order check.
**Rollback:** none needed (read-only). If it fails, un-expose (step 6 rollback) and treat it like a step-5 failure.

### Step 8 — the Hephaestus regression check

Run each item after step 7, and compare it with its **pre** baseline (§2.3). A difference from the baseline is a
regression; a failure that was already present at baseline is not.

- **(a) Hephaestus's own suite** (its BRAIN §2 commands: `npm test` → `vitest run` through `scripts/run-tool.cjs`):
  `cd D:/projects/lss-platform && npm test`. It must equal the baseline (721/721 at `4573d80`). **Limitation:** this
  suite is static. Its `src/__tests__/rls-isolation.test.ts` reads Hephaestus's migration FILES and never connects to
  a database, so it cannot see the live project. It proves the Hephaestus checkout is intact, not that the live DB is.
  The live proof is the two diffs (steps 5 and 7) plus (b)–(d).
- **(b) The live site smoke** (read-only: page loads, `/login` and `/signup` render, SPA routing, static assets):

  ```bash
  cd D:/projects/lss-platform && DEPLOY_URL=https://lss-platform.netlify.app npx playwright test e2e/deploy-smoke.spec.ts
  ```

  Its playwright config also starts a local dev server, which is harmless. Its first test expects the text
  `LSS Platform` in the page, which may already fail since the Hephaestus rebrand. That is why the pre run matters.
  `curl -s -o /dev/null -w "%{http_code}\n" https://lss-platform.netlify.app/` must be `200`.

- **(c) Data API probes** (read-only, anon, no profile header = the default schema):

  ```bash
  curl -s -w "\nHTTP %{http_code}\n" -H "apikey: $SUPABASE_ANON_KEY" \
    "https://atopkqykdmrcfvvcistc.supabase.co/rest/v1/tool_registry?select=id&limit=1"
  curl -s -o /dev/null -w "HTTP %{http_code}\n" -H "apikey: $SUPABASE_ANON_KEY" \
    "https://atopkqykdmrcfvvcistc.supabase.co/auth/v1/settings"
  ```

  Status and body must match pre (for example, the same `[]`, or the same permission error).

- **(d) Operator hands-on:** sign in at https://lss-platform.netlify.app with the operator's own account, open an
  existing organization and workspace, and open one tool. Read only: create nothing.
- **Optional (connector, read-only):** `get_advisors` (security) before step 1 and after step 7. New findings may name
  only `themis` objects.
- **NOT run against live by default: `e2e/tenant-isolation.spec.ts`.** PLAN P1.13 calls it read-only, but it is not.
  It **signs up two new users and creates two organizations and a workspace** in whatever project its `.env` points
  at, and against live that is the shared `auth.users`. There is also **no `rls-isolation` e2e spec**; that name is
  the static Vitest suite already in (a). Running `tenant-isolation` live needs the operator's separate approval and a
  plan to delete the two test users and their orgs afterwards.

**Rollback if (a)–(d) regress:** first un-expose `themis` (step 6 rollback; fast and additive) and re-test. If it is
green again, the exposure caused it, so leave it un-exposed and investigate. If it is still red, compare with the
step-5 and step-7 diffs. Destructive removal of the schema is the last row of §5 and needs its own approval.

After step 8, in transport A: `unset SUPABASE_ACCESS_TOKEN` and **revoke the token**.

---

## 4. Success criteria (P1.14 acceptance, restated)

- `themis.schema_migrations` lists all 6 files, with checksums equal to §7.1.
- `db:snapshot:diff pre post` (step 5) and `db:snapshot:diff pre exposed` (step 7) both exit 0.
- The Hephaestus checks (a)–(d) equal their baseline.
- The Data API's list is the step-2 list plus `themis` at the end, and the `Accept-Profile: themis` curl returns 3
  plans.
- Both brains (Themis §3/§6, Hephaestus §5/§6) record the date, the 6 applied versions and the exposed-schema change,
  including the before/after `db_schema` values.

---

## 5. Rollback plan

| When                                                     | State of the project                                                                                                                                                                                                                 | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step 1, 2, 5 or 7 cannot run                             | Unchanged: they only read.                                                                                                                                                                                                           | Fix the cause (token, network) and re-run. Nothing to undo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Step 3 (dry-run) fails                                   | Unchanged. Every batch ends in ROLLBACK, and an error aborts the batch's transaction.                                                                                                                                                | Confirm with the step-3 check (or a `dryrun` snapshot plus a diff against `pre`) that `themis` does not exist. Record the error. **No-go:** the fix is a new code task, followed by a new review of this runbook.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Step 4 fails midway** (unit k of 5)                    | Units 1..k-1 are committed, each with its ledger row(s). **Unit k is rolled back entirely**, because it is one transaction: the pair `apply-5.sql` rolls back BOTH files. Units k+1.. were never sent. No unit is ever half-applied. | 1. **Stop.** Do not run step 6, so `themis` stays unexposed and invisible to the Data API. 2. Take `db:snapshot post` and diff it against `pre`. It must still exit 0: a partial `themis` is inside `themis`. 3. Read the ledger (step-4 B query, or `npm run db:apply` dry-run) and confirm it holds exactly units 1..k-1. 4. Record everything in `BUILD_LOG.md`. The partial schema is **inert**: unexposed, with no Hephaestus object depending on it, and it holds only empty tables and the `plans` seed. Leaving it in place is safe. 5. **If the error is `lock timeout` or `statement timeout`:** nothing is wrong with the SQL. Re-run `db:apply -- --apply` later; it resumes at unit k. 6. **If unit k's SQL is wrong:** it is a pending file that never reached the live project. It is, however, committed and pushed, and CLAUDE.md §3.3 says a pushed migration is never edited. Whether to amend it (with an ADR) or supersede it is an **operator decision** at a new checkpoint. Do not improvise. |
| Transport B: `execute_sql` errors, or the session breaks | The same as the row above for that batch: an error inside `begin … commit` does not commit.                                                                                                                                          | Before anything else, run the step-4 B ledger query and `select to_regclass('themis.schema_migrations')`, so the state is read, not assumed. Resume only by regenerating the files with helper 1 from the live ledger.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Step 6 fails, or the Data API misbehaves after it        | The list may or may not include `themis`.                                                                                                                                                                                            | Run `MODE=unexpose` (A) or remove `themis` in the Dashboard (B). This restores exactly the step-2 value. It is additive, safe and fast. Re-run step-8 (c).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Step 5 or 7 diff exits 1 (a change outside `themis`)     | Unknown until it is read.                                                                                                                                                                                                            | **Stop.** After a red step 5, do not run step 6. After a red step 7, un-expose (step 6 rollback). Read the `OUTSIDE themis` lines. A Hephaestus deploy or migration in the window explains it only if that activity is confirmed. Otherwise escalate to the operator. **Never "fix" a Hephaestus object from here.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Step 8 regresses                                         | `themis` applied (and exposed).                                                                                                                                                                                                      | Un-expose first and re-test (the step-8 rollback).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Last resort: remove Themis's schema entirely             | Destructive and irreversible.                                                                                                                                                                                                        | **Needs its own, explicit operator approval (CLAUDE.md §7), separate from the P1-LIVE go.** Order: (1) un-expose `themis` first; (2) run the §5.1 query, which must return zero rows; (3) snapshot `pre-drop`; (4) `drop schema themis cascade` (the whole ledger goes with it, so a later re-apply starts from nothing); (5) snapshot `post-drop` and diff it: the diff tool classes every removed row as a themis change, including the themis-owned FK triggers on `auth.users`, so it must exit 0. Record it in both brains.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 5.1 Before any removal: does anything outside `themis` depend on it? (read-only)

```sql
select distinct dn.nspname as dependent_schema, dc.relname as dependent, d.classid::regclass::text as via
from pg_catalog.pg_depend d
join pg_catalog.pg_class rc on d.refclassid = 'pg_catalog.pg_class'::regclass and rc.oid = d.refobjid
join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace and rn.nspname = 'themis'
left join pg_catalog.pg_rewrite rw on d.classid = 'pg_catalog.pg_rewrite'::regclass and rw.oid = d.objid
left join pg_catalog.pg_constraint co on d.classid = 'pg_catalog.pg_constraint'::regclass and co.oid = d.objid
left join pg_catalog.pg_class dc on dc.oid = coalesce(rw.ev_class, co.conrelid)
left join pg_catalog.pg_namespace dn on dn.oid = dc.relnamespace
where dn.nspname is not null and dn.nspname <> 'themis';
```

It lists every view (`pg_rewrite`) and foreign key (`pg_constraint`) OUTSIDE `themis` that points at a `themis`
table. Such an object would be dropped by the cascade too. The query must return zero rows. Proven on PGlite after the
real apply: zero rows; then, with a `public` view over `themis.plans` and a `public` FK into it added, exactly those
2 rows. Limitation: a SQL/plpgsql function body that names a `themis` table leaves no `pg_depend` row, so it is not
listed.

---

## 6. Follow-ups (not built in P1.13; out of its declared file scope)

- **`db:apply --print`.** A flag that writes the exact batches (helper 1) without sending anything and without needing
  the token, with tests asserting that the output is byte-identical to the sent bodies. It needs `scripts/db-apply.mjs`
  and `scripts/db-apply.test.ts`, which are outside P1.13's scope (`docs/ops/LIVE_APPLY.md` only), so it is a separate
  task. Until it exists, helper 1 does the job using the same exports, and §7.5 proves it byte-identical.
- **`db:snapshot --print` / `--from-raw <dir>`.** The same idea for helpers 2 and 3 (`scripts/db-snapshot.mjs`).
- **`db:postgrest` (get / expose / unexpose).** The step 2/6 snippets as a tested script over `scripts/lib/mgmt-api.mjs`,
  which today only POSTs SQL. The snippets here were exercised only against a local fake server (§7.6).
- **A body-fidelity check for transport B:** compare `md5(prosrc)` and the policy md5s in the `post` snapshot with a
  PGlite reference snapshot of the same archive.

---

## 7. Pre-apply evidence pack (2026-09-28, commit `0dc46ae`, Node v24.11.1, all local)

### 7.1 The archive and its checksums (sha256 of LF-normalised text, as `db:apply` records them)

| unit | version        | name                  | sha256                                                             |
| ---- | -------------- | --------------------- | ------------------------------------------------------------------ |
| 1    | 20260928200000 | `schema`              | `cf85be6e40d6902a7773eb08b24ee3edfc567a07ebc0f0b2d5680d3e0b92b383` |
| 2    | 20260928210000 | `tenancy`             | `083bdf4c91695231269828f4387bf215785dfc58626ef3e90ff5e82fca43f594` |
| 3    | 20260928220000 | `decisions`           | `83b94b357e9fdbfad20e6e18b2f6af111d0d4886f090e82e05db62802d2671d8` |
| 4    | 20260928230000 | `analysis`            | `f129b996cc4b0aad1f68b85df7eda87e50e03d071e4ad1b37809041726589d55` |
| 5    | 20260928235000 | `ai_billing_audit`    | `b4bc915f3477c66a3da65ae5f2c3ccb002d50ba87cc10a612dc447a4667b5a61` |
| 5    | 20260928235500 | `audit_actor_erasure` | `7cb7f63eb009c4dd7af9fbc9e68ae9bd256633d85878670e1539269dcac7ecc1` |

### 7.2 The live dry-run output

**Not available at P1.13.** Producing it means contacting the live project, which P1.13 may not do, and no token
exists on the desktop. It is produced by step 3 in P1.14 and pasted into `BUILD_LOG.md`. The expected text is the
PGlite rehearsal in step 3: the REAL `db:apply` `run()`, with its HTTP pointed at PGlite + the `db:gate` shim through
a fake `fetch`. It made 6 requests (the ledger probe + 5 rolled-back batches), and after it schema `themis` did not
exist. A following `--apply` made 6 requests, recorded all 6 versions with the checksums above, left
`supabase_migrations.schema_migrations` at its 25 rows, and a re-run printed `PLAN  nothing pending`.

### 7.3 `npm run db:check`

```text
PASS  migration guard: 6 migration(s) stay inside schema themis
```

### 7.4 Reference: the `themis` objects after the apply (from the PGlite rehearsal's `post` snapshot)

66 objects: 18 tables (`r`), 43 indexes (`i`) and 5 functions, plus 43 policies.

- Tables: ai_runs, approvals, audit_log, comments, criteria, decisions, invites, memberships, options, plans, profiles,
  risks, schema_migrations, scores, subscriptions, swot_items, usage_monthly, workspaces.
- Functions: `audit_log_append_only()`, `has_role(ws uuid, roles text[])`, `is_member(ws uuid)`,
  `shares_workspace(other uuid)`, `touch_updated_at()`.

### 7.5 Transport-B helpers proven faithful (scratch harness, not committed)

```text
PASS  dry-run: db:apply sent 5 batches, printer wrote 5
PASS  dryrun-1.sql == db:apply dry-run batch 1
PASS  dryrun-2.sql == db:apply dry-run batch 2
PASS  dryrun-3.sql == db:apply dry-run batch 3
PASS  dryrun-4.sql == db:apply dry-run batch 4
PASS  dryrun-5.sql == db:apply dry-run batch 5
PASS  apply-1.sql == db:apply --apply batch 1
PASS  apply-2.sql == db:apply --apply batch 2
PASS  apply-3.sql == db:apply --apply batch 3
PASS  apply-4.sql == db:apply --apply batch 4
PASS  apply-5.sql == db:apply --apply batch 5
PASS  transport B: the full cumulative dry-run leaves no schema themis
PASS  transport B ledger == db:apply ledger (6 rows)
PASS  supabase_migrations untouched (25 rows)
ALL PASS
```

The snapshots assembled by helper 3 from raw section results were deep-equal to `takeSnapshot()`'s own (pre: 106
rows, post: 624 rows). `npm run db:snapshot:diff -- rehpre rehpost` printed `DIFF PASSED — nothing outside schema
themis changed`, exit 0. The scratch `ops-snapshots/` was deleted afterwards. The final check extracted the five heredoc blocks from THIS file and
ran them as written. Helper 1 printed the §7.1 plan, and the harness above passed on its files. Helper 2 wrote 14 files.
Helper 3's snapshot was deep-equal to `takeSnapshot()`'s. The step 2/6 blocks behaved as in §7.6 against the fake
server.

### 7.6 The step 2/6 PostgREST snippets against a local fake `/v1/projects/{ref}/postgrest`

The fake's GET body included a fake `jwt_secret`, and it appeared in no output.

```text
get                          → {"db_schema":"public, graphql_public","db_extra_search_path":"public, extensions","max_rows":1000}  exit 0
expose, RECORDED='public'    → REFUSED: db_schema is now "public, graphql_public", step 2 recorded "public"  exit 1
expose, placeholder left in  → REFUSED: …  exit 1
expose                       → OK  expose  before: public, graphql_public  after: public, graphql_public, themis  exit 0
expose again                 → ALREADY EXPOSED  exit 0
unexpose                     → OK  unexpose  before: public, graphql_public, themis  after: public, graphql_public  exit 0
unexpose again               → ALREADY UNEXPOSED  exit 0
MODE=nope                    → REFUSED: MODE must be expose or unexpose  exit 2
wrong token (401)            → GET /postgrest failed: HTTP 401  exit 1
PATCH bodies seen by the fake: {"db_schema":"public, graphql_public, themis"}, then {"db_schema":"public, graphql_public"}
```

(An earlier draft that used `process.exit()` after `fetch` crashed Node on Windows with a libuv assertion (exit 127)
AFTER a successful PATCH. The snippets therefore set `process.exitCode` instead.)

### 7.7 The Hephaestus baseline (local only)

`D:/projects/lss-platform` on `master` at `4573d80`, working tree clean: `npm test` → `Test Files 57 passed (57)`,
`Tests 721 passed (721)`.

### 7.8 `npm run db:gate:prove-red`

```text
prove-red: 34 sabotage(s) + 1 control against a copy of 6 migration(s), 8 parallel job(s)

GREEN  control — the untouched archive copy: exit 0, GATE PASSED, 290 PASS (21.3s)
RED    (a) decisions-select-true — exit 1, 3 FAIL line(s), 3 expected matched (11.4s)
RED    (b) scores-rls-disabled — exit 1, 6 FAIL line(s), 2 expected matched (11.1s)
RED    (c) table-without-leak-entry — exit 1, 3 FAIL line(s), 2 expected matched (11.5s)
RED    (d) public-table — exit 1, 1 FAIL line(s), 2 expected matched (0.4s)
RED    (e) auth-users-trigger — exit 1, 2 FAIL line(s), 2 expected matched (0.4s)
RED    (f) scores-composite-fk-dropped — exit 1, 1 FAIL line(s), 1 expected matched (11.4s)
RED    table-rls-policy-no-entry — exit 1, 1 FAIL line(s), 1 expected matched (11.9s)
RED    update-policy-to-public — exit 1, 3 FAIL line(s), 2 expected matched (11.4s)
RED    definer-no-search-path — exit 1, 3 FAIL line(s), 3 expected matched (11.7s)
RED    definer-search-path-public — exit 1, 1 FAIL line(s), 1 expected matched (0.5s)
RED    definer-search-path-pg-temp — exit 1, 1 FAIL line(s), 1 expected matched (9.5s)
RED    execute-to-public — exit 1, 2 FAIL line(s), 2 expected matched (9.6s)
RED    execute-to-anon — exit 1, 1 FAIL line(s), 1 expected matched (9.7s)
RED    anon-select-grant — exit 1, 1 FAIL line(s), 1 expected matched (9.7s)
RED    policy-reads-memberships — exit 1, 2 FAIL line(s), 1 expected matched (9.4s)
RED    enum-mismatch — exit 1, 1 FAIL line(s), 1 expected matched (9.9s)
RED    fk-not-valid-orphans — exit 1, 2 FAIL line(s), 2 expected matched (9.8s)
RED    helper-returns-true — exit 1, 14 FAIL line(s), 3 expected matched (10.1s)
RED    locked-down-update-grant — exit 1, 1 FAIL line(s), 1 expected matched (10.5s)
RED    client-grant-on-server-table — exit 1, 1 FAIL line(s), 1 expected matched (10.4s)
RED    view-owner-rights — exit 1, 1 FAIL line(s), 1 expected matched (10.4s)
RED    public-function-evading-guard — exit 1, 1 FAIL line(s), 1 expected matched (10.5s)
RED    auth-users-trigger-evading-guard — exit 1, 2 FAIL line(s), 2 expected matched (11.5s)
RED    anon-insert-plans — exit 1, 2 FAIL line(s), 2 expected matched (10.9s)
RED    service-only-grant — exit 1, 2 FAIL line(s), 2 expected matched (10.3s)
RED    update-policy-true — exit 1, 2 FAIL line(s), 2 expected matched (14.4s)
RED    anon-read-policy — exit 1, 4 FAIL line(s), 2 expected matched (13.9s)
RED    delete-policy-true — exit 1, 2 FAIL line(s), 2 expected matched (15.3s)
RED    audit-log-readable-by-viewer — exit 1, 1 FAIL line(s), 1 expected matched (15.8s)
RED    table-dropped-stale-entry — exit 1, 2 FAIL line(s), 1 expected matched (10.7s)
RED    select-update-delete-true — exit 1, 5 FAIL line(s), 3 expected matched (15.5s)
RED    select-locked-out — exit 1, 4 FAIL line(s), 3 expected matched (14.6s)
RED    not-idempotent — exit 1, 4 FAIL line(s), 1 expected matched (15.2s)
RED    apply-error — exit 1, 1 FAIL line(s), 2 expected matched (7.4s)

PROVE-RED PASSED — 34/34 sabotages went RED on the expected FAIL line (PLAN P1.9 a, b, c, d, e, f included); control GREEN. Wall 50.1s.
```

### 7.9 `npm run db:gate` (full output)

<details><summary>312 lines: guard, 6 files applied twice, structural sweep, coverage, orphan scan, A/B leak matrix; 290 PASS, 0 FAIL, GATE PASSED</summary>

```text
PASS  migration guard: 6 migration(s) stay inside schema themis

PASS  shim: Hephaestus migration ledger holds 25 rows — 25 rows
applied  20260928200000_themis_schema.sql
applied  20260928210000_themis_tenancy.sql
applied  20260928220000_themis_decisions.sql
applied  20260928230000_themis_analysis.sql
applied  20260928235000_themis_ai_billing_audit.sql
applied  20260928235500_themis_audit_actor_erasure.sql
PASS  re-apply 20260928200000_themis_schema.sql (idempotent-safe)
PASS  re-apply 20260928210000_themis_tenancy.sql (idempotent-safe)
PASS  re-apply 20260928220000_themis_decisions.sql (idempotent-safe)
PASS  re-apply 20260928230000_themis_analysis.sql (idempotent-safe)
PASS  re-apply 20260928235000_themis_ai_billing_audit.sql (idempotent-safe)
PASS  re-apply 20260928235500_themis_audit_actor_erasure.sql (idempotent-safe)

PASS  schema themis exists
PASS  themis.schema_migrations has (version text, name text, checksum text, applied_at timestamptz) — version:text,name:text,checksum:text,applied_at:timestamp with time zone
PASS  themis.schema_migrations primary key is version — version
PASS  themis.schema_migrations has RLS enabled
PASS  themis.schema_migrations has NO policies — 0 policies
PASS  anon holds no privilege on themis.schema_migrations
PASS  authenticated holds no privilege on themis.schema_migrations
PASS  anon has USAGE on schema themis
PASS  authenticated has USAGE on schema themis
PASS  service_role has USAGE on schema themis
PASS  themis.touch_updated_at() exists and returns trigger
PASS  themis.touch_updated_at() has search_path pinned — search_path=""
PASS  anon holds no EXECUTE on themis.touch_updated_at()
PASS  themis.touch_updated_at() sets updated_at on UPDATE
PASS  supabase_migrations.schema_migrations still holds 25 rows — 25 rows

--- structural sweep ---
PASS  RLS is enabled on every themis table (18)
PASS  no themis view bypasses RLS (views are security_invoker, no materialized views)
PASS  every themis table has at least one policy (service-only exceptions: schema_migrations)
PASS  service-only themis.schema_migrations grants nothing to anon/authenticated
PASS  search_path is pinned on every themis function (5)
PASS  no SECURITY DEFINER function has public/$user/pg_temp on its search_path
PASS  anon has EXECUTE on no themis function
PASS  PUBLIC has EXECUTE on no themis function
PASS  no write policy admits anon or PUBLIC
PASS  every themis policy is TO authenticated (exceptions: plans.plans_select SELECT)
PASS  no policy expression references memberships directly (recursion rule)
PASS  every workspace-scoped policy asks through themis.is_member/has_role
PASS  anon holds exactly SELECT on themis.plans and no other themis privilege — plans.SELECT
PASS  zero objects in public/auth/supabase_migrations changed (pg_class, pg_policy, pg_proc, triggers)
PASS  no trigger on auth.users
PASS  every themis foreign key is validated (convalidated)
PASS  decisions.methodology CHECK admits exactly the decision.ts values — db agile|waterfall|yolo vs ts agile|waterfall|yolo
PASS  decisions.scale CHECK admits exactly the decision.ts values — db enterprise|mid|small vs ts enterprise|mid|small

--- leak-matrix coverage ---
PASS  every themis table (except schema_migrations) has a leak-matrix entry
PASS  every leak-matrix entry names an existing themis table
PASS  the leak matrix names each table once

--- fixture and orphan scan ---
PASS  fixture seeded (workspaces A and B, rows in every tenant table)
PASS  orphan scan: zero dangling references over every themis foreign key — 36 FKs clean

--- leak matrix (UB = owner of B against workspace A) ---
PASS  anon reads nothing in themis.ai_runs — permission denied for table ai_runs
PASS  anon reads nothing in themis.approvals — permission denied for table approvals
PASS  anon reads nothing in themis.audit_log — permission denied for table audit_log
PASS  anon reads nothing in themis.comments — permission denied for table comments
PASS  anon reads nothing in themis.criteria — permission denied for table criteria
PASS  anon reads nothing in themis.decisions — permission denied for table decisions
PASS  anon reads nothing in themis.invites — permission denied for table invites
PASS  anon reads nothing in themis.memberships — permission denied for table memberships
PASS  anon reads nothing in themis.options — permission denied for table options
PASS  anon reads exactly 3 rows of themis.plans — 3 rows
PASS  anon reads nothing in themis.profiles — permission denied for table profiles
PASS  anon reads nothing in themis.risks — permission denied for table risks
PASS  anon reads nothing in themis.schema_migrations — permission denied for table schema_migrations
PASS  anon reads nothing in themis.scores — permission denied for table scores
PASS  anon reads nothing in themis.subscriptions — permission denied for table subscriptions
PASS  anon reads nothing in themis.swot_items — permission denied for table swot_items
PASS  anon reads nothing in themis.usage_monthly — permission denied for table usage_monthly
PASS  anon reads nothing in themis.workspaces — permission denied for table workspaces
PASS  themis.workspaces: fixture is non-vacuous (A and B both have rows) — A 1, B 1
PASS  themis.workspaces: UB reads ZERO rows of A — 0 rows
PASS  themis.workspaces: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.workspaces: UB's UPDATE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.workspaces: UB's DELETE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.workspaces: UB's INSERT of a row of A is refused — {"ok":false,"error":"permission denied for table workspaces"}
PASS  themis.workspaces: control — the same INSERT succeeds as service — {"ok":true,"affected":1}
PASS  themis.workspaces: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table workspaces"},"d":{"ok":false,"error":"permission denied for table workspaces"}}
PASS  themis.workspaces: UA reads all of A's rows — 1/1
PASS  themis.workspaces: A's viewer reads all of A's rows — 1/1
PASS  themis.workspaces: UA writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.workspaces: A's viewer cannot write A's data — [{"ok":true,"affected":0},{"ok":true,"affected":0},{"ok":true,"affected":0}]
PASS  themis.memberships: fixture is non-vacuous (A and B both have rows) — A 4, B 1
PASS  themis.memberships: UB reads ZERO rows of A — 0 rows
PASS  themis.memberships: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.memberships: UB's UPDATE of A's rows has no effect — {"ok":false,"error":"permission denied for table memberships"}
PASS  themis.memberships: UB's DELETE of A's rows has no effect — {"ok":false,"error":"permission denied for table memberships"}
PASS  themis.memberships: UB's INSERT of a row of A is refused — {"ok":false,"error":"permission denied for table memberships"}
PASS  themis.memberships: control — the same INSERT succeeds as service — {"ok":true,"affected":1}
PASS  themis.memberships: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table memberships"},"d":{"ok":false,"error":"permission denied for table memberships"}}
PASS  themis.memberships: UA reads all of A's rows — 4/4
PASS  themis.memberships: A's viewer reads all of A's rows — 4/4
PASS  themis.memberships: service writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.memberships: A's viewer cannot write A's data — [{"ok":false,"error":"permission denied for table memberships"},{"ok":false,"error":"permission denied for table memberships"},{"ok":false,"error":"permission denied for table memberships"}]
PASS  themis.memberships: server-written — authenticated holds no write privilege
PASS  themis.memberships: server-written — UA's writes have no effect — [{"ok":false,"error":"permission denied for table memberships"},{"ok":false,"error":"permission denied for table memberships"},{"ok":false,"error":"permission denied for table memberships"}]
PASS  themis.invites: fixture is non-vacuous (A and B both have rows) — A 1, B 1
PASS  themis.invites: UB reads ZERO rows of A — 0 rows
PASS  themis.invites: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.invites: UB's UPDATE of A's rows has no effect — {"ok":false,"error":"permission denied for table invites"}
PASS  themis.invites: UB's DELETE of A's rows has no effect — {"ok":false,"error":"permission denied for table invites"}
PASS  themis.invites: UB's INSERT of a row of A is refused — {"ok":false,"error":"permission denied for table invites"}
PASS  themis.invites: control — the same INSERT succeeds as service — {"ok":true,"affected":1}
PASS  themis.invites: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table invites"},"d":{"ok":false,"error":"permission denied for table invites"}}
PASS  themis.invites: UA reads all of A's rows — 1/1
PASS  themis.invites: A's viewer reads none of A's rows (role-gated) — 0/1
PASS  themis.invites: service writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.invites: A's viewer cannot write A's data — [{"ok":false,"error":"permission denied for table invites"},{"ok":false,"error":"permission denied for table invites"},{"ok":false,"error":"permission denied for table invites"}]
PASS  themis.invites: server-written — authenticated holds no write privilege
PASS  themis.invites: server-written — UA's writes have no effect — [{"ok":false,"error":"permission denied for table invites"},{"ok":false,"error":"permission denied for table invites"},{"ok":false,"error":"permission denied for table invites"}]
PASS  themis.profiles: fixture is non-vacuous (A and B both have rows) — A 4, B 1
PASS  themis.profiles: UB reads ZERO rows of A — 0 rows
PASS  themis.profiles: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.profiles: UB's UPDATE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.profiles: UB's DELETE of A's rows has no effect — {"ok":false,"error":"permission denied for table profiles"}
PASS  themis.profiles: UB's INSERT of a row of A is refused — {"ok":false,"error":"new row violates row-level security policy for table \"profiles\""}
PASS  themis.profiles: control — the same INSERT succeeds as loner — {"ok":true,"affected":1}
PASS  themis.profiles: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table profiles"},"d":{"ok":false,"error":"permission denied for table profiles"}}
PASS  themis.profiles: UA reads all of A's rows — 4/4
PASS  themis.profiles: A's viewer reads all of A's rows — 4/4
PASS  themis.profiles: UA writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.profiles: A's viewer cannot write A's data — [{"ok":true,"affected":0},{"ok":false,"error":"permission denied for table profiles"},{"ok":true,"affected":0}]
PASS  themis.decisions: fixture is non-vacuous (A and B both have rows) — A 2, B 1
PASS  themis.decisions: UB reads ZERO rows of A — 0 rows
PASS  themis.decisions: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.decisions: UB's UPDATE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.decisions: UB's DELETE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.decisions: UB's INSERT of a row of A is refused — {"ok":false,"error":"new row violates row-level security policy for table \"decisions\""}
PASS  themis.decisions: control — the same INSERT succeeds as UA — {"ok":true,"affected":1}
PASS  themis.decisions: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table decisions"},"d":{"ok":false,"error":"permission denied for table decisions"}}
PASS  themis.decisions: UA reads all of A's rows — 2/2
PASS  themis.decisions: A's viewer reads all of A's rows — 2/2
PASS  themis.decisions: UA writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.decisions: A's viewer cannot write A's data — [{"ok":true,"affected":0},{"ok":true,"affected":0},{"ok":true,"affected":0}]
PASS  themis.options: fixture is non-vacuous (A and B both have rows) — A 3, B 1
PASS  themis.options: UB reads ZERO rows of A — 0 rows
PASS  themis.options: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.options: UB's UPDATE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.options: UB's DELETE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.options: UB's INSERT of a row of A is refused — {"ok":false,"error":"new row violates row-level security policy for table \"options\""}
PASS  themis.options: control — the same INSERT succeeds as UA — {"ok":true,"affected":1}
PASS  themis.options: UB's child row (workspace B) pointing at A's parent is refused — {"ok":false,"error":"insert or update on table \"options\" violates foreign key constraint \"options_decision_fkey\""}
PASS  themis.options: control — the same child row pointing at B's parent succeeds (service) — {"ok":true,"affected":1}
PASS  themis.options: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table options"},"d":{"ok":false,"error":"permission denied for table options"}}
PASS  themis.options: UA reads all of A's rows — 3/3
PASS  themis.options: A's viewer reads all of A's rows — 3/3
PASS  themis.options: UA writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.options: A's viewer cannot write A's data — [{"ok":true,"affected":0},{"ok":true,"affected":0},{"ok":true,"affected":0}]
PASS  themis.criteria: fixture is non-vacuous (A and B both have rows) — A 3, B 1
PASS  themis.criteria: UB reads ZERO rows of A — 0 rows
PASS  themis.criteria: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.criteria: UB's UPDATE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.criteria: UB's DELETE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.criteria: UB's INSERT of a row of A is refused — {"ok":false,"error":"new row violates row-level security policy for table \"criteria\""}
PASS  themis.criteria: control — the same INSERT succeeds as UA — {"ok":true,"affected":1}
PASS  themis.criteria: UB's child row (workspace B) pointing at A's parent is refused — {"ok":false,"error":"insert or update on table \"criteria\" violates foreign key constraint \"criteria_decision_fkey\""}
PASS  themis.criteria: control — the same child row pointing at B's parent succeeds (service) — {"ok":true,"affected":1}
PASS  themis.criteria: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table criteria"},"d":{"ok":false,"error":"permission denied for table criteria"}}
PASS  themis.criteria: UA reads all of A's rows — 3/3
PASS  themis.criteria: A's viewer reads all of A's rows — 3/3
PASS  themis.criteria: UA writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.criteria: A's viewer cannot write A's data — [{"ok":true,"affected":0},{"ok":true,"affected":0},{"ok":true,"affected":0}]
PASS  themis.scores: fixture is non-vacuous (A and B both have rows) — A 3, B 1
PASS  themis.scores: UB reads ZERO rows of A — 0 rows
PASS  themis.scores: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.scores: UB's UPDATE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.scores: UB's DELETE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.scores: UB's INSERT of a row of A is refused — {"ok":false,"error":"new row violates row-level security policy for table \"scores\""}
PASS  themis.scores: control — the same INSERT succeeds as UA — {"ok":true,"affected":1}
PASS  themis.scores: UB's child row (workspace B) pointing at A's parent is refused — {"ok":false,"error":"insert or update on table \"scores\" violates foreign key constraint \"scores_decision_fkey\""}
PASS  themis.scores: control — the same child row pointing at B's parent succeeds (service) — {"ok":true,"affected":1}
PASS  themis.scores: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table scores"},"d":{"ok":false,"error":"permission denied for table scores"}}
PASS  themis.scores: UA reads all of A's rows — 3/3
PASS  themis.scores: A's viewer reads all of A's rows — 3/3
PASS  themis.scores: UA writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.scores: A's viewer cannot write A's data — [{"ok":true,"affected":0},{"ok":true,"affected":0},{"ok":true,"affected":0}]
PASS  themis.swot_items: fixture is non-vacuous (A and B both have rows) — A 2, B 1
PASS  themis.swot_items: UB reads ZERO rows of A — 0 rows
PASS  themis.swot_items: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.swot_items: UB's UPDATE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.swot_items: UB's DELETE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.swot_items: UB's INSERT of a row of A is refused — {"ok":false,"error":"new row violates row-level security policy for table \"swot_items\""}
PASS  themis.swot_items: control — the same INSERT succeeds as UA — {"ok":true,"affected":1}
PASS  themis.swot_items: UB's child row (workspace B) pointing at A's parent is refused — {"ok":false,"error":"insert or update on table \"swot_items\" violates foreign key constraint \"swot_items_decision_fkey\""}
PASS  themis.swot_items: control — the same child row pointing at B's parent succeeds (service) — {"ok":true,"affected":1}
PASS  themis.swot_items: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table swot_items"},"d":{"ok":false,"error":"permission denied for table swot_items"}}
PASS  themis.swot_items: UA reads all of A's rows — 2/2
PASS  themis.swot_items: A's viewer reads all of A's rows — 2/2
PASS  themis.swot_items: UA writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.swot_items: A's viewer cannot write A's data — [{"ok":true,"affected":0},{"ok":true,"affected":0},{"ok":true,"affected":0}]
PASS  themis.risks: fixture is non-vacuous (A and B both have rows) — A 2, B 1
PASS  themis.risks: UB reads ZERO rows of A — 0 rows
PASS  themis.risks: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.risks: UB's UPDATE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.risks: UB's DELETE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.risks: UB's INSERT of a row of A is refused — {"ok":false,"error":"new row violates row-level security policy for table \"risks\""}
PASS  themis.risks: control — the same INSERT succeeds as UA — {"ok":true,"affected":1}
PASS  themis.risks: UB's child row (workspace B) pointing at A's parent is refused — {"ok":false,"error":"insert or update on table \"risks\" violates foreign key constraint \"risks_decision_fkey\""}
PASS  themis.risks: control — the same child row pointing at B's parent succeeds (service) — {"ok":true,"affected":1}
PASS  themis.risks: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table risks"},"d":{"ok":false,"error":"permission denied for table risks"}}
PASS  themis.risks: UA reads all of A's rows — 2/2
PASS  themis.risks: A's viewer reads all of A's rows — 2/2
PASS  themis.risks: UA writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.risks: A's viewer cannot write A's data — [{"ok":true,"affected":0},{"ok":true,"affected":0},{"ok":true,"affected":0}]
PASS  themis.comments: fixture is non-vacuous (A and B both have rows) — A 1, B 1
PASS  themis.comments: UB reads ZERO rows of A — 0 rows
PASS  themis.comments: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.comments: UB's UPDATE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.comments: UB's DELETE of A's rows has no effect — {"ok":true,"affected":0}
PASS  themis.comments: UB's INSERT of a row of A is refused — {"ok":false,"error":"new row violates row-level security policy for table \"comments\""}
PASS  themis.comments: control — the same INSERT succeeds as UA — {"ok":true,"affected":1}
PASS  themis.comments: UB's child row (workspace B) pointing at A's parent is refused — {"ok":false,"error":"insert or update on table \"comments\" violates foreign key constraint \"comments_decision_fkey\""}
PASS  themis.comments: control — the same child row pointing at B's parent succeeds (service) — {"ok":true,"affected":1}
PASS  themis.comments: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table comments"},"d":{"ok":false,"error":"permission denied for table comments"}}
PASS  themis.comments: UA reads all of A's rows — 1/1
PASS  themis.comments: A's viewer reads all of A's rows — 1/1
PASS  themis.comments: editor writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.comments: A's viewer cannot write A's data — [{"ok":true,"affected":0},{"ok":true,"affected":0},{"ok":true,"affected":0}]
PASS  themis.approvals: fixture is non-vacuous (A and B both have rows) — A 2, B 1
PASS  themis.approvals: UB reads ZERO rows of A — 0 rows
PASS  themis.approvals: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.approvals: UB's UPDATE of A's rows has no effect — {"ok":false,"error":"permission denied for table approvals"}
PASS  themis.approvals: UB's DELETE of A's rows has no effect — {"ok":false,"error":"permission denied for table approvals"}
PASS  themis.approvals: UB's INSERT of a row of A is refused — {"ok":false,"error":"new row violates row-level security policy for table \"approvals\""}
PASS  themis.approvals: control — the same INSERT succeeds as UA — {"ok":true,"affected":1}
PASS  themis.approvals: UB's child row (workspace B) pointing at A's parent is refused — {"ok":false,"error":"insert or update on table \"approvals\" violates foreign key constraint \"approvals_decision_fkey\""}
PASS  themis.approvals: control — the same child row pointing at B's parent succeeds (service) — {"ok":true,"affected":1}
PASS  themis.approvals: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table approvals"},"d":{"ok":false,"error":"permission denied for table approvals"}}
PASS  themis.approvals: UA reads all of A's rows — 2/2
PASS  themis.approvals: A's viewer reads all of A's rows — 2/2
PASS  themis.approvals: UA writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.approvals: A's viewer cannot write A's data — [{"ok":false,"error":"permission denied for table approvals"},{"ok":false,"error":"permission denied for table approvals"},{"ok":false,"error":"new row violates row-level security policy for table \"approvals\""}]
PASS  themis.ai_runs: fixture is non-vacuous (A and B both have rows) — A 2, B 1
PASS  themis.ai_runs: UB reads ZERO rows of A — 0 rows
PASS  themis.ai_runs: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.ai_runs: UB's UPDATE of A's rows has no effect — {"ok":false,"error":"permission denied for table ai_runs"}
PASS  themis.ai_runs: UB's DELETE of A's rows has no effect — {"ok":false,"error":"permission denied for table ai_runs"}
PASS  themis.ai_runs: UB's INSERT of a row of A is refused — {"ok":false,"error":"permission denied for table ai_runs"}
PASS  themis.ai_runs: control — the same INSERT succeeds as service — {"ok":true,"affected":1}
PASS  themis.ai_runs: UB's child row (workspace B) pointing at A's parent is refused — {"ok":false,"error":"permission denied for table ai_runs"}
PASS  themis.ai_runs: control — the same child row pointing at B's parent succeeds (service) — {"ok":true,"affected":1}
PASS  themis.ai_runs: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table ai_runs"},"d":{"ok":false,"error":"permission denied for table ai_runs"}}
PASS  themis.ai_runs: UA reads all of A's rows — 2/2
PASS  themis.ai_runs: A's viewer reads all of A's rows — 2/2
PASS  themis.ai_runs: service writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.ai_runs: A's viewer cannot write A's data — [{"ok":false,"error":"permission denied for table ai_runs"},{"ok":false,"error":"permission denied for table ai_runs"},{"ok":false,"error":"permission denied for table ai_runs"}]
PASS  themis.ai_runs: server-written — authenticated holds no write privilege
PASS  themis.ai_runs: server-written — UA's writes have no effect — [{"ok":false,"error":"permission denied for table ai_runs"},{"ok":false,"error":"permission denied for table ai_runs"},{"ok":false,"error":"permission denied for table ai_runs"}]
PASS  themis.subscriptions: fixture is non-vacuous (A and B both have rows) — A 1, B 1
PASS  themis.subscriptions: UB reads ZERO rows of A — 0 rows
PASS  themis.subscriptions: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.subscriptions: UB's UPDATE of A's rows has no effect — {"ok":false,"error":"permission denied for table subscriptions"}
PASS  themis.subscriptions: UB's DELETE of A's rows has no effect — {"ok":false,"error":"permission denied for table subscriptions"}
PASS  themis.subscriptions: UB's INSERT of a row of A is refused — {"ok":false,"error":"permission denied for table subscriptions"}
PASS  themis.subscriptions: control — the same INSERT succeeds as service — {"ok":true,"affected":1}
PASS  themis.subscriptions: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table subscriptions"},"d":{"ok":false,"error":"permission denied for table subscriptions"}}
PASS  themis.subscriptions: UA reads all of A's rows — 1/1
PASS  themis.subscriptions: A's viewer reads all of A's rows — 1/1
PASS  themis.subscriptions: service writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.subscriptions: A's viewer cannot write A's data — [{"ok":false,"error":"permission denied for table subscriptions"},{"ok":false,"error":"permission denied for table subscriptions"},{"ok":false,"error":"permission denied for table subscriptions"}]
PASS  themis.subscriptions: server-written — authenticated holds no write privilege
PASS  themis.subscriptions: server-written — UA's writes have no effect — [{"ok":false,"error":"permission denied for table subscriptions"},{"ok":false,"error":"permission denied for table subscriptions"},{"ok":false,"error":"permission denied for table subscriptions"}]
PASS  themis.usage_monthly: fixture is non-vacuous (A and B both have rows) — A 1, B 1
PASS  themis.usage_monthly: UB reads ZERO rows of A — 0 rows
PASS  themis.usage_monthly: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.usage_monthly: UB's UPDATE of A's rows has no effect — {"ok":false,"error":"permission denied for table usage_monthly"}
PASS  themis.usage_monthly: UB's DELETE of A's rows has no effect — {"ok":false,"error":"permission denied for table usage_monthly"}
PASS  themis.usage_monthly: UB's INSERT of a row of A is refused — {"ok":false,"error":"permission denied for table usage_monthly"}
PASS  themis.usage_monthly: control — the same INSERT succeeds as service — {"ok":true,"affected":1}
PASS  themis.usage_monthly: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table usage_monthly"},"d":{"ok":false,"error":"permission denied for table usage_monthly"}}
PASS  themis.usage_monthly: UA reads all of A's rows — 1/1
PASS  themis.usage_monthly: A's viewer reads all of A's rows — 1/1
PASS  themis.usage_monthly: service writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.usage_monthly: A's viewer cannot write A's data — [{"ok":false,"error":"permission denied for table usage_monthly"},{"ok":false,"error":"permission denied for table usage_monthly"},{"ok":false,"error":"permission denied for table usage_monthly"}]
PASS  themis.usage_monthly: server-written — authenticated holds no write privilege
PASS  themis.usage_monthly: server-written — UA's writes have no effect — [{"ok":false,"error":"permission denied for table usage_monthly"},{"ok":false,"error":"permission denied for table usage_monthly"},{"ok":false,"error":"permission denied for table usage_monthly"}]
PASS  themis.audit_log: fixture is non-vacuous (A and B both have rows) — A 2, B 1
PASS  themis.audit_log: UB reads ZERO rows of A — 0 rows
PASS  themis.audit_log: UB reads all of B's own rows (not locked out) — 1/1
PASS  themis.audit_log: UB's UPDATE of A's rows has no effect — {"ok":false,"error":"permission denied for table audit_log"}
PASS  themis.audit_log: UB's DELETE of A's rows has no effect — {"ok":false,"error":"permission denied for table audit_log"}
PASS  themis.audit_log: UB's INSERT of a row of A is refused — {"ok":false,"error":"permission denied for table audit_log"}
PASS  themis.audit_log: control — the same INSERT succeeds as service — {"ok":true,"affected":1}
PASS  themis.audit_log: anon's UPDATE and DELETE of A's rows have no effect — {"u":{"ok":false,"error":"permission denied for table audit_log"},"d":{"ok":false,"error":"permission denied for table audit_log"}}
PASS  themis.audit_log: UA reads all of A's rows — 2/2
PASS  themis.audit_log: A's viewer reads none of A's rows (role-gated) — 0/2
PASS  themis.audit_log: service writes A's data (takes effect) — {"ok":true,"affected":1}
PASS  themis.audit_log: A's viewer cannot write A's data — [{"ok":false,"error":"permission denied for table audit_log"},{"ok":false,"error":"permission denied for table audit_log"},{"ok":false,"error":"permission denied for table audit_log"}]
PASS  themis.audit_log: server-written — authenticated holds no write privilege
PASS  themis.audit_log: server-written — UA's writes have no effect — [{"ok":false,"error":"permission denied for table audit_log"},{"ok":false,"error":"permission denied for table audit_log"},{"ok":false,"error":"permission denied for table audit_log"}]
PASS  themis.plans holds 3 rows — 3 rows
PASS  themis.plans: UA reads all 3 rows — 3 rows
PASS  themis.plans: UB reads all 3 rows — 3 rows
PASS  themis.plans: UA's UPDATE and DELETE have no effect — {"u":{"ok":false,"error":"permission denied for table plans"},"d":{"ok":false,"error":"permission denied for table plans"}}
PASS  themis.plans: anon's UPDATE and DELETE have no effect — {"u":{"ok":false,"error":"permission denied for table plans"},"d":{"ok":false,"error":"permission denied for table plans"}}
PASS  themis.plans: no client role holds a write privilege

GATE PASSED — migrations apply (twice) on a fresh copy of the shared project; structure, coverage and the A/B leak matrix are green.
```

</details>
