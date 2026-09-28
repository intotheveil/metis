// @vitest-environment node
//
// P1.12 — `npm run db:snapshot` (read-only live catalogue snapshot) and `npm run db:snapshot:diff`.
// No network, no live project, no real token. Three layers:
//   1. the read-only checker: every snapshot query passes it, and a catalogue of writes / side
//      effects / non-catalogue reads is REFUSED before anything is sent;
//   2. the CLI on a fake fetch (usage, env, request shape, file shape, API errors, redaction);
//   3. the same SELECTs run on PGlite dressed as the shared project (the db:gate shim): they parse,
//      return the expected shape, and a real `db:apply --apply` of the Themis archive shows up in the
//      diff ONLY under schema themis, while sabotage outside themis turns the diff RED.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { bloom } from '@electric-sql/pglite/contrib/bloom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ENV_REF,
  ENV_TOKEN,
  FORMAT,
  ReadOnlyViolation,
  SECTIONS,
  assertReadOnly,
  readOnlyClient,
  run,
  snapshotFileName,
  splitRoleSettings,
  takeSnapshot,
} from './db-snapshot.mjs'
import {
  diffSnapshots,
  formatChange,
  resolveSnapshot,
  run as runDiff,
} from './db-snapshot-diff.mjs'
import { run as runApply } from './db-apply.mjs'
import { createMgmtClient } from './lib/mgmt-api.mjs'
import { HEPHAESTUS_MIGRATION_ROWS, installShim } from './db-gate/shim.mjs'

const ARCHIVE = fileURLToPath(new URL('../supabase/migrations', import.meta.url))
const TOKEN = 'sbp_FAKE_SNAPSHOT_TOKEN_0123456789_never_real'
const REF = 'abcdefghijklmnopqrst'
const ENV = { [ENV_TOKEN]: TOKEN, [ENV_REF]: REF }
const T0 = new Date('2026-09-28T20:00:00.000Z')
const T1 = new Date('2026-09-28T20:05:00.000Z')

type Row = Record<string, unknown>
type Snap = Awaited<ReturnType<typeof takeSnapshot>>

let dirs: string[] = []
const tempDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'themis-db-snapshot-'))
  dirs = [...dirs, d]
  return d
}
beforeEach(() => {
  dirs = []
})
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const json = (body: unknown, status = 201) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A fake endpoint answering every SELECT with a canned row set; records every request. */
function fakeApi(opts: { failWhen?: RegExp; failMessage?: string } = {}) {
  const calls: { url: string; headers: Record<string, string>; query: string }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const query = (JSON.parse(String(init?.body)) as { query: string }).query
    calls.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      query,
    })
    if (opts.failWhen?.test(query)) {
      return json({ message: opts.failMessage ?? 'Failed to run sql query: ERROR: boom' }, 400)
    }
    if (query.includes('from pg_catalog.pg_namespace n\nwhere left')) {
      return json([{ schema: 'public', owner: 'postgres', acl: '{}' }])
    }
    if (query.includes('supabase_migrations.schema_migrations')) {
      return json([
        { schema: 'supabase_migrations', version: '20260101000000' },
        { schema: 'supabase_migrations', version: '20260102000000' },
      ])
    }
    return json([])
  }
  return { fetch: fetchImpl, calls }
}

// ---------------------------------------------------------------------------------------------
describe('the read-only checker', () => {
  it.each(SECTIONS.map((s) => [s.name, s.sql]))(
    'the %s query is a plain catalogue SELECT',
    (_n, sql) => {
      expect(() => assertReadOnly(sql)).not.toThrow()
      expect(sql.trimStart().toLowerCase().startsWith('select')).toBe(true)
    },
  )

  it('captures what PLAN P1.12 asks for', () => {
    const names = SECTIONS.map((s) => s.name)
    for (const n of [
      'schemas',
      'relations',
      'policies',
      'functions',
      'triggers',
      'extensions',
      'migrations_ledger',
      'role_settings',
      'default_acl',
    ]) {
      expect(names).toContain(n)
    }
  })

  const REFUSED: [string, string][] = [
    ['insert', 'insert into themis.x values (1)'],
    ['update', 'update public.profiles set full_name = null'],
    ['delete', 'delete from auth.users'],
    ['ddl', 'create table public.x (id int)'],
    ['a second statement', 'select 1 from pg_catalog.pg_class; delete from public.tasks'],
    [
      'a trailing second statement after a string',
      "select 'a;b' from pg_catalog.pg_class; select 1",
    ],
    ['select into (creates a table)', 'select * into public.copy from pg_catalog.pg_class'],
    ['row locks', 'select * from pg_catalog.pg_class for update'],
    ['share locks', 'select * from pg_catalog.pg_class for share'],
    ['a data-modifying CTE', 'with x as (delete from public.tasks returning *) select * from x'],
    ['set_config', "select set_config('role', 'service_role', false)"],
    ['pg_sleep', 'select pg_sleep(10)'],
    ['nextval', "select nextval('public.seq')"],
    ['pg_terminate_backend', 'select pg_terminate_backend(1)'],
    ['a qualified user function', 'select public.do_things()'],
    ['an unknown function', 'select dblink_exec(1)'],
    ['a pg_catalog side-effect function', 'select pg_catalog.pg_reload_conf()'],
    ['a public table', 'select * from public.profiles'],
    ['auth.users data', 'select email from auth.users'],
    ['an unqualified relation', 'select * from pg_class'],
    ['a joined public table', 'select 1 from pg_catalog.pg_class c join public.tasks t on true'],
    ['a public table in a subquery', 'select * from (select * from public.tasks) s'],
    [
      'a public table in a scalar subquery',
      'select (select count(*) from public.tasks) from pg_catalog.pg_class',
    ],
    ['a comma join', 'select 1 from pg_catalog.pg_class c, public.tasks t'],
    ['a comma join after a subquery', 'select 1 from (select 1) s, public.tasks t'],
    ['dollar quoting', 'select $x$ drop $x$ from pg_catalog.pg_class'],
    ['a quoted identifier', 'select * from "public"."tasks"'],
    ['a line comment', 'select 1 from pg_catalog.pg_class -- ok'],
    ['a block comment', 'select 1 /* x */ from pg_catalog.pg_class'],
    ['a backslash escape string', "select E'\\'' from pg_catalog.pg_class"],
    ['an unterminated string', "select 'abc from pg_catalog.pg_class"],
    ['begin', 'begin'],
    ['explain analyze', 'explain analyze select 1'],
    ['empty', '   '],
    ['do', 'do 1'],
    ['unbalanced parens', 'select (1 from pg_catalog.pg_class'],
  ]
  it.each(REFUSED)('refuses %s', (_label, sql) => {
    expect(() => assertReadOnly(sql)).toThrow(ReadOnlyViolation)
  })

  it('does not trip over keywords inside a string literal', () => {
    expect(() =>
      assertReadOnly("select 'insert; drop; delete' as note from pg_catalog.pg_class order by 1;"),
    ).not.toThrow()
  })

  it('readOnlyClient sends nothing for a refused statement', async () => {
    const api = fakeApi()
    const ro = readOnlyClient(createMgmtClient({ token: TOKEN, ref: REF, fetch: api.fetch }))
    await expect(ro.query('delete from public.tasks')).rejects.toThrow(ReadOnlyViolation)
    expect(api.calls).toHaveLength(0)
    await ro.query('select 1 from pg_catalog.pg_class')
    expect(api.calls).toHaveLength(1)
  })

  it('takeSnapshot validates EVERY query before sending the first (a bad last query = zero requests)', async () => {
    const api = fakeApi()
    const client = createMgmtClient({ token: TOKEN, ref: REF, fetch: api.fetch })
    const sections = [
      ...SECTIONS,
      { name: 'evil', key: ['x'], sql: 'update public.tasks set done = true' },
    ]
    await expect(takeSnapshot({ client, label: 'pre', projectRef: REF, sections })).rejects.toThrow(
      ReadOnlyViolation,
    )
    expect(api.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe('splitRoleSettings', () => {
  it('splits pgrst.db_schemas into one row per schema, hashes every other value', () => {
    const rows = splitRoleSettings([
      { role: 'authenticator', database: '', setting: 'pgrst.db_schemas=public, graphql_public' },
      { role: 'authenticator', database: '', setting: 'statement_timeout=8s' },
    ])
    expect(rows).toEqual([
      {
        schema: 'public',
        role: 'authenticator',
        database: '',
        setting: 'pgrst.db_schemas',
        value: 'public',
      },
      {
        schema: 'graphql_public',
        role: 'authenticator',
        database: '',
        setting: 'pgrst.db_schemas',
        value: 'graphql_public',
      },
      {
        schema: null,
        role: 'authenticator',
        database: '',
        setting: 'statement_timeout',
        value_md5: expect.stringMatching(/^[0-9a-f]{32}$/),
      },
    ])
    expect(JSON.stringify(rows)).not.toContain('8s')
  })
})

// ---------------------------------------------------------------------------------------------
describe('db:snapshot CLI (fake fetch)', () => {
  const runIt = async (o: {
    argv?: string[]
    env?: Record<string, string | undefined>
    api?: ReturnType<typeof fakeApi>
    outDir?: string
    now?: Date
  }) => {
    const out: string[] = []
    const err: string[] = []
    const api = o.api ?? fakeApi()
    const outDir = o.outDir ?? tempDir()
    const code = await run({
      argv: o.argv ?? ['pre'],
      env: o.env ?? ENV,
      fetch: api.fetch,
      outDir,
      now: o.now ?? T0,
      log: (s) => out.push(s),
      error: (s) => err.push(s),
    })
    return { code, out, err, api, outDir, all: [...out, ...err].join('\n') }
  }

  it.each([[[]], [['a', 'b']], [['Pre']], [['../x']], [['-pre']]])(
    'usage error for argv %j → exit 2, nothing sent',
    async (argv) => {
      const r = await runIt({ argv })
      expect(r.code).toBe(2)
      expect(r.api.calls).toHaveLength(0)
      expect(readdirSync(r.outDir)).toHaveLength(0)
    },
  )

  it.each([
    [{}],
    [{ [ENV_TOKEN]: TOKEN }],
    [{ [ENV_REF]: REF }],
    [{ [ENV_TOKEN]: '', [ENV_REF]: REF }],
  ])('missing env %j → exit 2, nothing sent', async (env) => {
    const r = await runIt({ env })
    expect(r.code).toBe(2)
    expect(r.api.calls).toHaveLength(0)
    expect(r.err.join('\n')).toMatch(/missing env/)
  })

  it('sends only read-only SELECTs, to the query endpoint, and writes <iso>-<label>.json', async () => {
    const r = await runIt({})
    expect(r.code).toBe(0)
    expect(r.api.calls).toHaveLength(SECTIONS.length)
    for (const c of r.api.calls) {
      expect(c.url).toBe(`https://api.supabase.com/v1/projects/${REF}/database/query`)
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`)
      expect(() => assertReadOnly(c.query)).not.toThrow()
      expect(c.query.trimStart().startsWith('select')).toBe(true)
    }
    const files = readdirSync(r.outDir)
    expect(files).toEqual(['2026-09-28T20-00-00-000Z-pre.json'])
    expect(files[0]).toBe(snapshotFileName(T0, 'pre'))
    const text = readFileSync(path.join(r.outDir, files[0]), 'utf8')
    expect(text).not.toContain(TOKEN)
    expect(r.all).not.toContain(TOKEN)
    const snap = JSON.parse(text) as Snap
    expect(snap.format).toBe(FORMAT)
    expect(snap.label).toBe('pre')
    expect(snap.projectRef).toBe(REF)
    expect(snap.takenAt).toBe(T0.toISOString())
    expect(Object.keys(snap.sections)).toEqual(SECTIONS.map((s) => s.name))
    expect(snap.summary.supabaseMigrations).toEqual({ count: 2, maxVersion: '20260102000000' })
    expect(snap.summary.themisSchemaExists).toBe(false)
    expect(r.out.at(-1)).toMatch(/^WROTE .*-pre\.json$/)
  })

  it('an API error → exit 1, no file, token redacted', async () => {
    const api = fakeApi({
      failWhen: /pg_policies/,
      failMessage: `permission denied (token ${TOKEN})`,
    })
    const r = await runIt({ api })
    expect(r.code).toBe(1)
    expect(readdirSync(r.outDir)).toHaveLength(0)
    expect(r.all).toMatch(/HTTP 400/)
    expect(r.all).toMatch(/no file written/)
    expect(r.all).not.toContain(TOKEN)
  })

  it('a non-array success payload counts as an error', async () => {
    const f: typeof fetch = async () => json({ message: 'something odd' }, 200)
    const out: string[] = []
    const code = await run({
      argv: ['pre'],
      env: ENV,
      fetch: f,
      outDir: tempDir(),
      log: () => undefined,
      error: (s) => out.push(s),
    })
    expect(code).toBe(1)
    expect(out.join('\n')).toMatch(/something odd/)
  })
})

// ---------------------------------------------------------------------------------------------
describe('db:snapshot:diff (pure + CLI)', () => {
  const snap = (label: string, sections: Record<string, Row[]>, projectRef = REF): Snap => {
    const full: Record<string, Row[]> = {}
    for (const s of SECTIONS) full[s.name] = sections[s.name] ?? []
    return {
      format: FORMAT,
      label,
      takenAt: T0.toISOString(),
      projectRef,
      summary: {} as Snap['summary'],
      sections: full,
    }
  }
  const pubTable = { schema: 'public', name: 'tasks', kind: 'r', rls: true }

  it('identical snapshots → no changes', () => {
    const a = snap('pre', { relations: [pubTable] })
    const d = diffSnapshots(a, snap('post', { relations: [pubTable] }))
    expect(d.problems).toEqual([])
    expect(d.changes).toEqual([])
  })

  it('a themis-only change is inside; a public change is outside', () => {
    const a = snap('pre', { relations: [pubTable] })
    const b = snap('post', {
      relations: [
        { ...pubTable, rls: false },
        { schema: 'themis', name: 'plans', kind: 'r', rls: true },
      ],
    })
    const d = diffSnapshots(a, b)
    expect(d.inside.map(formatChange)).toEqual(['+ relations: themis | plans'])
    expect(d.outside.map(formatChange)).toEqual(['~ relations: public | tasks (rls: true → false)'])
  })

  it('a database-level row (schema null) is outside', () => {
    const a = snap('pre', { extensions: [{ schema: null, name: 'pgcrypto', version: '1.3' }] })
    const b = snap('post', { extensions: [] })
    expect(diffSnapshots(a, b).outside.map(formatChange)).toEqual(['- extensions: pgcrypto'])
  })

  it('a row whose owner moves from themis to elsewhere is outside', () => {
    const a = snap('pre', {
      triggers: [{ schema: 'themis', on_schema: 'auth', on_table: 'users', name: 't' }],
    })
    const b = snap('post', {
      triggers: [{ schema: 'auth', on_schema: 'auth', on_table: 'users', name: 't' }],
    })
    expect(diffSnapshots(a, b).outside).toHaveLength(1)
  })

  it('refuses to compare different projects, formats or section sets', () => {
    expect(
      diffSnapshots(snap('a', {}), snap('b', {}, 'zzzzzzzzzzzzzzzzzzzz')).problems.join(),
    ).toMatch(/different projects/)
    expect(diffSnapshots({ ...snap('a', {}), format: 'x' }, snap('b', {})).problems.join()).toMatch(
      /format/,
    )
    const missing = snap('b', {})
    delete (missing.sections as Record<string, Row[] | undefined>).policies
    expect(diffSnapshots(snap('a', {}), missing).problems.join()).toMatch(/policies/)
  })

  it('CLI: labels resolve to the newest file; exit codes 0 / 1 / 2', () => {
    const dir = tempDir()
    const write = (name: string, s: Snap) => writeFileSync(path.join(dir, name), JSON.stringify(s))
    write(
      '2026-09-28T19-00-00-000Z-pre.json',
      snap('pre', { relations: [{ ...pubTable, rls: false }] }),
    )
    write('2026-09-28T20-00-00-000Z-pre.json', snap('pre', { relations: [pubTable] }))
    write(
      '2026-09-28T20-05-00-000Z-post.json',
      snap('post', { relations: [pubTable, { schema: 'themis', name: 'x' }] }),
    )
    write('2026-09-28T20-06-00-000Z-bad.json', snap('bad', { relations: [] }))
    expect(resolveSnapshot('pre', dir)).toBe(path.join(dir, '2026-09-28T20-00-00-000Z-pre.json'))

    const out: string[] = []
    const q = { dir, log: (s: string) => out.push(s), error: (s: string) => out.push(s) }
    expect(runDiff({ argv: ['pre', 'post'], ...q })).toBe(0)
    expect(out.join('\n')).toMatch(/DIFF PASSED/)
    expect(runDiff({ argv: ['pre', 'bad'], ...q })).toBe(1)
    expect(out.join('\n')).toMatch(/DIFF FAILED — 1 change\(s\) outside schema themis/)
    expect(runDiff({ argv: ['pre'], ...q })).toBe(2)
    expect(runDiff({ argv: ['pre', 'nope'], ...q })).toBe(2)
    writeFileSync(path.join(dir, 'garbage.json'), '{not json')
    expect(runDiff({ argv: ['pre', path.join(dir, 'garbage.json')], ...q })).toBe(2)
  })
})

// ---------------------------------------------------------------------------------------------
// The same SELECTs on real Postgres: PGlite + the db:gate shim, behind a fake fetch that executes
// each request like the endpoint does.
describe('on real Postgres (PGlite + the db:gate shim)', () => {
  const pgliteApi = async () => {
    // bloom is loadable (not installed) so the extension check has a real CREATE EXTENSION to see.
    const db = new PGlite({ extensions: { bloom } })
    await installShim(db)
    const queries: string[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const query = (JSON.parse(String(init?.body)) as { query: string }).query
      queries.push(query)
      try {
        const results = await db.exec(query)
        return json(results.at(-1)?.rows ?? [])
      } catch (e) {
        await db.exec('rollback;').catch(() => undefined)
        return json(
          { message: `Failed to run sql query: ${e instanceof Error ? e.message : String(e)}` },
          400,
        )
      }
    }
    return { db, fetch: fetchImpl, queries }
  }
  const quiet = { log: () => undefined, error: () => undefined }
  const shoot = (f: typeof fetch, label: string, now: Date) =>
    takeSnapshot({
      client: createMgmtClient({ token: TOKEN, ref: REF, fetch: f }),
      label,
      projectRef: REF,
      now,
    })

  it('every SELECT parses and returns the expected shape; a Themis apply shows up ONLY under themis', async () => {
    const { db, fetch: f } = await pgliteApi()
    // A PostgREST-style exposed-schemas role setting, so the split is exercised on real Postgres.
    await db.exec(
      "create role authenticator noinherit; alter role authenticator set pgrst.db_schemas = 'public, graphql_public';",
    )

    const pre = await shoot(f, 'pre', T0)
    expect(pre.summary.themisSchemaExists).toBe(false)
    expect(pre.summary.supabaseMigrations.count).toBe(HEPHAESTUS_MIGRATION_ROWS)
    expect(
      pre.sections.relations.find((r) => r.schema === 'public' && r.name === 'tasks'),
    ).toMatchObject({
      kind: 'r',
      rls: true,
      owner: expect.any(String),
      columns_md5: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
    expect(pre.sections.policies.map((r) => `${String(r.tbl)}.${String(r.name)}`)).toContain(
      'tasks.tasks_member',
    )
    expect(
      pre.sections.functions.find((r) => r.schema === 'auth' && r.name === 'uid'),
    ).toBeDefined()
    expect(pre.sections.extensions.map((r) => r.name)).toContain('plpgsql')
    expect(
      pre.sections.role_settings
        .filter((r) => r.setting === 'pgrst.db_schemas')
        .map((r) => r.schema),
    ).toEqual(['public', 'graphql_public'])
    // Hephaestus's own FK public.profiles → auth.users puts RI triggers on auth.users, owned by public.
    expect(pre.summary.authUsersTriggers.length).toBeGreaterThan(0)
    expect(pre.summary.authUsersTriggers.every((t) => t.owner === 'public')).toBe(true)

    // The real archive, applied by the real applier, through the same fake endpoint.
    const dir = tempDir()
    for (const file of readdirSync(ARCHIVE))
      writeFileSync(path.join(dir, file), readFileSync(path.join(ARCHIVE, file)))
    expect(await runApply({ argv: ['--apply'], env: ENV, fetch: f, dir, ...quiet })).toBe(0)
    // Expose themis the way a role setting would (the P1.13 step): a themis-only change.
    await db.exec(
      "alter role authenticator set pgrst.db_schemas = 'public, graphql_public, themis';",
    )

    const post = await shoot(f, 'post', T1)
    expect(post.summary.themisSchemaExists).toBe(true)
    expect(post.summary.themisObjects).toEqual(
      expect.arrayContaining(['r plans', 'r workspaces', 'r schema_migrations']),
    )
    expect(post.summary.supabaseMigrations).toEqual(pre.summary.supabaseMigrations)
    // themis FKs into auth.users add RI triggers ON auth.users that are OWNED by themis.
    expect(post.summary.authUsersTriggers.some((t) => t.owner === 'themis')).toBe(true)

    const d = diffSnapshots(pre, post)
    expect(d.problems).toEqual([])
    expect(d.outside.map(formatChange)).toEqual([])
    expect(d.inside.length).toBeGreaterThan(50)
    const insideKeys = d.inside.map(formatChange)
    expect(insideKeys).toContain('+ schemas: themis')
    expect(insideKeys).toContain('+ relations: themis | plans')
    expect(insideKeys).toContain('+ role_settings: authenticator |  | pgrst.db_schemas | themis')
    expect(
      insideKeys.some((k) => k.startsWith('+ triggers: auth | users | RI_ConstraintTrigger')),
    ).toBe(true)
    await db.close()
  }, 60_000)

  it.each<[string, string, RegExp]>([
    ['a new public table', 'create table public.leak (id int)', /^\+ relations: public \| leak/m],
    [
      'a trigger on auth.users',
      "create function public.f() returns trigger language plpgsql as 'begin return new; end'; create trigger t_themis after insert on auth.users for each row execute function public.f()",
      /^\+ triggers: auth \| users \| t_themis/m,
    ],
    [
      'a changed public policy',
      'alter policy tasks_member on public.tasks to anon',
      /^~ policies: public \| tasks \| tasks_member/m,
    ],
    [
      'RLS off on a public table',
      'alter table public.tasks disable row level security',
      /^~ relations: public \| tasks .*rls: true → false/m,
    ],
    [
      'a Hephaestus ledger row',
      "insert into supabase_migrations.schema_migrations (version) values ('29990101000000')",
      /^\+ migrations_ledger: 29990101000000/m,
    ],
    [
      'a global default privilege',
      'alter default privileges grant execute on functions to anon',
      /default_acl/,
    ],
    ['a new schema', 'create schema themis_private', /^\+ schemas: themis_private/m],
    [
      'an exposed schema removed',
      "alter role authenticator set pgrst.db_schemas = 'public'",
      /^- role_settings: authenticator \| {2}\| pgrst\.db_schemas \| graphql_public/m,
    ],
    ['a new extension', 'create extension if not exists bloom', /^\+ extensions: bloom/m],
    [
      'a changed auth.users column',
      'alter table auth.users add column themis_flag boolean',
      /^~ relations: auth \| users/m,
    ],
  ])(
    'RED: %s outside themis',
    async (_label, sql, expected) => {
      const { db, fetch: f } = await pgliteApi()
      await db.exec(
        "create role authenticator noinherit; alter role authenticator set pgrst.db_schemas = 'public, graphql_public';",
      )
      const pre = await shoot(f, 'pre', T0)
      await db.exec(sql)
      const post = await shoot(f, 'post', T1)
      const d = diffSnapshots(pre, post)
      expect(d.problems).toEqual([])
      expect(d.outside.length).toBeGreaterThan(0)
      expect(d.outside.map(formatChange).join('\n')).toMatch(expected)

      const out = tempDir()
      writeFileSync(path.join(out, snapshotFileName(T0, 'pre')), JSON.stringify(pre))
      writeFileSync(path.join(out, snapshotFileName(T1, 'post')), JSON.stringify(post))
      expect(runDiff({ argv: ['pre', 'post'], dir: out, ...quiet })).toBe(1)
      expect(existsSync(path.join(out, snapshotFileName(T1, 'post')))).toBe(true)
      await db.close()
    },
    60_000,
  )
})
