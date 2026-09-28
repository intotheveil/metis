// @vitest-environment node
//
// P1.4 — tenancy contract: themis.profiles, workspaces, memberships, invites.
// P1.5 — decision core: decisions, options, criteria, scores (isolation matrix, cross-tenant child
//        inserts through the composite FKs, role gating, lifecycle columns, constraints, grants)
//        and the enum match with src/lib/decision.ts.
// The P1.4 exact-set assertions (FKs, policies, column grants) are scoped to the P1.4 TABLES, so
// a later migration's tables extend the schema without rewriting P1.4's contract.
//
// Runs the REAL committed archive (supabase/migrations, applied twice like `npm run db:gate`)
// against real Postgres (PGlite) dressed as Hephaestus's shared project by ./db-gate/shim.mjs.
// No SQL from the migrations is restated here: every assertion is about the database the archive
// produces. One PGlite instance per file; every `actAs` session is a transaction that is ROLLED
// BACK, so the fixture is identical for every test and the tests are order-independent.
//
// Extending this file (P1.5–P1.8): add a table to TENANT_TABLES with its "rows of workspace A"
// predicate and an update probe, and the cross-workspace isolation block covers it. Use
// `actAs(user, s => …)` to run as a signed-in user, `actAs(ANON, …)` for the anon key, and
// `actAs(SUPERUSER, …)` for fixture-level reads/writes that must also be rolled back.
//
// Mutation knob: DB_GATE_MIGRATIONS points this suite (like the gate) at a mutated COPY of the
// archive, so a sabotaged migration can be shown to turn these tests RED without touching the
// committed files.

import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { HEPHAESTUS_MIGRATION_ROWS, installShim } from './db-gate/shim.mjs'
import { METHODOLOGIES, SCALES } from '../src/lib/decision'

const MIG =
  process.env.DB_GATE_MIGRATIONS ??
  fileURLToPath(new URL('../supabase/migrations', import.meta.url))

// --- fixture identities ----------------------------------------------------------------------
const U = {
  ownerA: '00000000-0000-4000-8000-0000000000a1',
  adminA: '00000000-0000-4000-8000-0000000000a2',
  editorA: '00000000-0000-4000-8000-0000000000a3',
  viewerA: '00000000-0000-4000-8000-0000000000a4',
  ownerB: '00000000-0000-4000-8000-0000000000b1',
  loner: '00000000-0000-4000-8000-0000000000c1', // signed up, no workspace, no profile yet
} as const
const WA = '10000000-0000-4000-8000-00000000000a'
const WB = '10000000-0000-4000-8000-00000000000b'
const A_ONLY_USERS = [U.ownerA, U.adminA, U.editorA, U.viewerA]
const OLD = '2000-01-01T00:00:00Z' // fixture updated_at, so a trigger bump is unmistakable

const TABLES = ['profiles', 'workspaces', 'memberships', 'invites'] as const
type Table = (typeof TABLES)[number]

// --- P1.5 decision-core fixture ----------------------------------------------------------------
// Workspace A: draft decision DA (options OA1, OA2; criteria CA1, CA2; scored cells OA1×CA1 and
// OA2×CA1, so OA1×CA2 and OA2×CA2 are free) and a frozen, approved decision DAF (OF1 × CF1 scored).
// Workspace B: draft decision DB_ (OB1 × CB1 scored).
const D = {
  A: '20000000-0000-4000-8000-00000000000a',
  AF: '20000000-0000-4000-8000-0000000000af',
  B: '20000000-0000-4000-8000-00000000000b',
} as const
const LINEAGE_A = '21000000-0000-4000-8000-00000000000a'
const O = {
  A1: '30000000-0000-4000-8000-0000000000a1',
  A2: '30000000-0000-4000-8000-0000000000a2',
  F1: '30000000-0000-4000-8000-0000000000f1',
  B1: '30000000-0000-4000-8000-0000000000b1',
} as const
const C = {
  A1: '40000000-0000-4000-8000-0000000000a1',
  A2: '40000000-0000-4000-8000-0000000000a2',
  F1: '40000000-0000-4000-8000-0000000000f1',
  B1: '40000000-0000-4000-8000-0000000000b1',
} as const
const DECISION_TABLES = ['decisions', 'options', 'criteria', 'scores'] as const
type DecisionTable = (typeof DECISION_TABLES)[number]

/**
 * The isolation matrix. `ofA` selects workspace A's rows (rows UB must never see or change);
 * `probe` is a SET clause an attacker would try. P1.5+ appends its tables here.
 */
const TENANT_TABLES: { table: Table | DecisionTable; ofA: string; probe: string }[] = [
  { table: 'workspaces', ofA: `id = '${WA}'`, probe: `name = 'pwned'` },
  { table: 'memberships', ofA: `workspace_id = '${WA}'`, probe: `role = 'viewer'` },
  { table: 'invites', ofA: `workspace_id = '${WA}'`, probe: `role = 'owner'` },
  {
    table: 'profiles',
    ofA: `user_id in (${A_ONLY_USERS.map((u) => `'${u}'`).join(',')})`,
    probe: `display_name = 'pwned'`,
  },
  { table: 'decisions', ofA: `workspace_id = '${WA}'`, probe: `question = 'pwned'` },
  { table: 'options', ofA: `workspace_id = '${WA}'`, probe: `name = 'pwned'` },
  { table: 'criteria', ofA: `workspace_id = '${WA}'`, probe: `weight = 0` },
  { table: 'scores', ofA: `workspace_id = '${WA}'`, probe: `value = 1` },
]

// --- harness -----------------------------------------------------------------------------------
const db = new PGlite()

type Row = Record<string, unknown>
type Outcome = { ok: true; affected: number } | { ok: false; error: string }

const ANON = Symbol('anon')
const SUPERUSER = Symbol('superuser')
type Who = string | typeof ANON | typeof SUPERUSER

interface Session {
  /** Rows of a query; throws on error (use `attempt` when an error is the expected outcome). */
  rows<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>
  /** Rows of themis.<table> visible to this identity, optionally filtered. */
  count(table: string, where?: string): Promise<number>
  /** Runs one statement inside a savepoint, so a refused write does not abort the session. */
  attempt(sql: string, params?: unknown[]): Promise<Outcome>
  /** Run `fn` as the superuser inside the same (rolled-back) transaction, then switch back. */
  sudo<T>(fn: () => Promise<T>): Promise<T>
}

async function setIdentity(who: Who) {
  if (who === SUPERUSER) {
    await db.exec(`reset role`)
    await db.query(`select set_config('request.jwt.claim.sub', '', true)`)
  } else if (who === ANON) {
    await db.exec(`set local role anon`)
    await db.query(`select set_config('request.jwt.claim.sub', '', true)`)
  } else {
    await db.exec(`set local role authenticated`)
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [who])
  }
}

let savepoints = 0
const session = (who: Who): Session => ({
  rows: async <T extends Row = Row>(sql: string, params?: unknown[]) =>
    (await db.query<T>(sql, params)).rows,
  count: async (table, where = 'true') =>
    (await db.query<{ n: number }>(`select count(*)::int as n from themis.${table} where ${where}`))
      .rows[0].n,
  attempt: async (sql, params) => {
    const sp = `sp_${++savepoints}`
    await db.exec(`savepoint ${sp}`)
    try {
      const r = await db.query(sql, params)
      await db.exec(`release savepoint ${sp}`)
      return { ok: true, affected: r.affectedRows ?? 0 }
    } catch (e) {
      await db.exec(`rollback to savepoint ${sp}`)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
  sudo: async (fn) => {
    await setIdentity(SUPERUSER)
    try {
      return await fn()
    } finally {
      await setIdentity(who)
    }
  },
})

/** Act as `who` inside a transaction that is always rolled back. */
async function actAs<T>(who: Who, fn: (s: Session) => Promise<T>): Promise<T> {
  await db.exec('begin')
  try {
    await setIdentity(who)
    return await fn(session(who))
  } finally {
    await db.exec('rollback')
  }
}

const refused = (o: Outcome) =>
  !o.ok && /permission denied|violates row-level security/.test(o.error)
/** No effect = refused outright, or ran and touched nothing (RLS filtered every row). */
const noEffect = (o: Outcome) => refused(o) || (o.ok && o.affected === 0)

/** A content hash of the rows matching `where`, read as superuser (for before/after checks). */
const snapshot = (s: Session, table: string, where: string) =>
  s.sudo(async () => {
    const r = await s.rows<{ h: string | null; n: number }>(
      `select md5(string_agg(t::text, '|' order by t::text)) as h, count(*)::int as n
         from themis.${table} t where ${where}`,
    )
    return r[0]
  })

// Snapshot of everything Themis must never change in Hephaestus's schemas.
async function foreignSnapshot() {
  const q = async (sql: string) => JSON.stringify((await db.query(sql)).rows)
  return {
    classes: await q(`select c.relname, c.relkind, c.relrowsecurity, c.relacl::text as acl
                        from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where n.nspname in ('public', 'auth', 'supabase_migrations')
                       order by n.nspname, c.relname`),
    policies: await q(`select c.relname, p.polname, p.polcmd,
                              pg_get_expr(p.polqual, p.polrelid) as qual,
                              pg_get_expr(p.polwithcheck, p.polrelid) as chk
                         from pg_policy p join pg_class c on c.oid = p.polrelid
                         join pg_namespace n on n.oid = c.relnamespace
                        where n.nspname in ('public', 'auth') order by 1, 2`),
    functions: await q(`select n.nspname, p.proname, p.prosrc, p.proacl::text as acl
                          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname in ('public', 'auth') order by 1, 2`),
    triggers: await q(`select c.relname, t.tgname from pg_trigger t
                         join pg_class c on c.oid = t.tgrelid
                         join pg_namespace n on n.oid = c.relnamespace
                        where n.nspname in ('public', 'auth') and not t.tgisinternal
                        order by 1, 2`),
  }
}

let foreignBefore: Awaited<ReturnType<typeof foreignSnapshot>>
let foreignAfter: Awaited<ReturnType<typeof foreignSnapshot>>

beforeAll(async () => {
  await installShim(db)
  foreignBefore = await foreignSnapshot()

  const files = readdirSync(MIG)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  // Twice, exactly as the gate does: the state under test is the RE-APPLIED archive.
  for (let pass = 0; pass < 2; pass++)
    for (const f of files) await db.exec(readFileSync(path.join(MIG, f), 'utf8'))
  foreignAfter = await foreignSnapshot()

  // Fixture, committed as superuser. Every test's writes are rolled back by actAs.
  const users = Object.values(U)
  await db.exec(`
    insert into auth.users (id, email) values
      ${users.map((u, i) => `('${u}', 'u${i}@example.com')`).join(',\n      ')};
    insert into themis.workspaces (id, name, created_by, updated_at) values
      ('${WA}', 'Workspace A', '${U.ownerA}', '${OLD}'),
      ('${WB}', 'Workspace B', '${U.ownerB}', '${OLD}');
    insert into themis.memberships (workspace_id, user_id, role, updated_at) values
      ('${WA}', '${U.ownerA}', 'owner', '${OLD}'),
      ('${WA}', '${U.adminA}', 'admin', '${OLD}'),
      ('${WA}', '${U.editorA}', 'editor', '${OLD}'),
      ('${WA}', '${U.viewerA}', 'viewer', '${OLD}'),
      ('${WB}', '${U.ownerB}', 'owner', '${OLD}');
    insert into themis.profiles (user_id, display_name, updated_at) values
      ('${U.ownerA}', 'Owner A', '${OLD}'), ('${U.adminA}', 'Admin A', '${OLD}'),
      ('${U.editorA}', 'Editor A', '${OLD}'), ('${U.viewerA}', 'Viewer A', '${OLD}'),
      ('${U.ownerB}', 'Owner B', '${OLD}');
    insert into themis.invites (workspace_id, email, role, token_hash, expires_at, updated_at) values
      ('${WA}', 'new-a@example.com', 'editor', repeat('a', 64), now() + interval '7 days', '${OLD}'),
      ('${WB}', 'new-b@example.com', 'viewer', repeat('b', 64), now() + interval '7 days', '${OLD}');
    insert into themis.decisions (id, workspace_id, lineage_id, question, methodology, scale, status,
                                  frozen, approved_by, approved_at, created_by, updated_at) values
      ('${D.A}', '${WA}', '${LINEAGE_A}', 'Draft A', 'agile', 'mid', 'draft',
       false, null, null, '${U.ownerA}', '${OLD}'),
      ('${D.AF}', '${WA}', gen_random_uuid(), 'Approved A', 'waterfall', 'enterprise', 'approved',
       true, '${U.ownerA}', now(), '${U.ownerA}', '${OLD}'),
      ('${D.B}', '${WB}', gen_random_uuid(), 'Draft B', 'yolo', 'small', 'draft',
       false, null, null, '${U.ownerB}', '${OLD}');
    insert into themis.options (id, workspace_id, decision_id, name, position, updated_at) values
      ('${O.A1}', '${WA}', '${D.A}', 'Option A1', 0, '${OLD}'),
      ('${O.A2}', '${WA}', '${D.A}', 'Option A2', 1, '${OLD}'),
      ('${O.F1}', '${WA}', '${D.AF}', 'Option F1', 0, '${OLD}'),
      ('${O.B1}', '${WB}', '${D.B}', 'Option B1', 0, '${OLD}');
    insert into themis.criteria (id, workspace_id, decision_id, name, weight, position, updated_at) values
      ('${C.A1}', '${WA}', '${D.A}', 'Cost', 4, 0, '${OLD}'),
      ('${C.A2}', '${WA}', '${D.A}', 'Risk', 2, 1, '${OLD}'),
      ('${C.F1}', '${WA}', '${D.AF}', 'Speed', 3, 0, '${OLD}'),
      ('${C.B1}', '${WB}', '${D.B}', 'Cost', 5, 0, '${OLD}');
    insert into themis.scores (workspace_id, decision_id, option_id, criterion_id, value, updated_at) values
      ('${WA}', '${D.A}', '${O.A1}', '${C.A1}', 4, '${OLD}'),
      ('${WA}', '${D.A}', '${O.A2}', '${C.A1}', 2, '${OLD}'),
      ('${WA}', '${D.AF}', '${O.F1}', '${C.F1}', 5, '${OLD}'),
      ('${WB}', '${D.B}', '${O.B1}', '${C.B1}', 3, '${OLD}');
  `)
}, 60_000)

// =================================================================================================
// Structure
// =================================================================================================

describe('table shapes', () => {
  const columns = async (t: Table) =>
    (
      await db.query<{ c: string }>(
        `select a.attname || ':' || format_type(a.atttypid, a.atttypmod)
                || case when a.attnotnull then '!' else '' end as c
           from pg_attribute a
          where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
          order by a.attnum`,
        [`themis.${t}`],
      )
    ).rows.map((r) => r.c)

  const TSZ = 'timestamp with time zone'
  it.each([
    [
      'profiles',
      ['user_id:uuid!', 'display_name:text', `created_at:${TSZ}!`, `updated_at:${TSZ}!`],
    ],
    [
      'workspaces',
      [
        'id:uuid!',
        'name:text!',
        'logo_data_url:text',
        'created_by:uuid',
        `created_at:${TSZ}!`,
        `updated_at:${TSZ}!`,
      ],
    ],
    [
      'memberships',
      [
        'workspace_id:uuid!',
        'user_id:uuid!',
        'role:text!',
        `created_at:${TSZ}!`,
        `updated_at:${TSZ}!`,
      ],
    ],
    [
      'invites',
      [
        'id:uuid!',
        'workspace_id:uuid!',
        'email:text!',
        'role:text!',
        'token_hash:text!',
        `expires_at:${TSZ}!`,
        'created_by:uuid',
        `created_at:${TSZ}!`,
        `accepted_at:${TSZ}`,
        `updated_at:${TSZ}!`,
      ],
    ],
  ] as const)('themis.%s has the planned columns, types and NOT NULLs', async (t, want) => {
    expect(await columns(t)).toEqual(want)
  })

  it('memberships is keyed by (workspace_id, user_id) — one role per user per workspace', async () => {
    const pk = await db.query<{ cols: string }>(
      `select string_agg(a.attname, ',' order by k.ord) as cols
         from pg_constraint c
         cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
        where c.conrelid = 'themis.memberships'::regclass and c.contype = 'p'`,
    )
    expect(pk.rows[0].cols).toBe('workspace_id,user_id')
  })

  it('foreign keys point where planned, with the planned ON DELETE', async () => {
    const fks = await db.query<{ fk: string }>(
      `select c.conrelid::regclass::text || '(' || a.attname || ')->' || c.confrelid::regclass::text
              || ' ' || c.confdeltype::text as fk
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and c.connamespace = 'themis'::regnamespace
          and c.conrelid::regclass::text = any ($1::text[])
        order by 1`,
      [TABLES.map((t) => `themis.${t}`)],
    )
    // c = cascade, n = set null
    expect(fks.rows.map((r) => r.fk)).toEqual([
      'themis.invites(created_by)->auth.users n',
      'themis.invites(workspace_id)->themis.workspaces c',
      'themis.memberships(user_id)->auth.users c',
      'themis.memberships(workspace_id)->themis.workspaces c',
      'themis.profiles(user_id)->auth.users c',
      'themis.workspaces(created_by)->auth.users n',
    ])
  })
})

describe('check constraints (as superuser, so only the constraint can refuse)', () => {
  const insertLogo = (s: Session, logo: string) =>
    s.attempt(`insert into themis.workspaces (name, logo_data_url) values ('L', $1)`, [logo])
  const PNG = 'data:image/png;base64,'

  it('logo: exactly 140000 chars is accepted, 140001 is refused', () =>
    actAs(SUPERUSER, async (s) => {
      expect(await insertLogo(s, PNG + 'A'.repeat(140_000 - PNG.length))).toEqual({
        ok: true,
        affected: 1,
      })
      const over = await insertLogo(s, PNG + 'A'.repeat(140_001 - PNG.length))
      expect(over.ok).toBe(false)
      expect(!over.ok && over.error).toMatch(/check constraint/)
    }))

  it('logo: png, jpeg and webp data URLs pass; svg, gif and a remote URL are refused', () =>
    actAs(SUPERUSER, async (s) => {
      for (const mime of ['png', 'jpeg', 'webp'])
        expect((await insertLogo(s, `data:image/${mime};base64,AAAA`)).ok, mime).toBe(true)
      for (const bad of [
        'data:image/svg+xml;base64,PHN2Zz4=',
        'data:image/gif;base64,AAAA',
        'https://evil.example/logo.png',
        'data:image/png,not-base64',
      ])
        expect((await insertLogo(s, bad)).ok, bad).toBe(false)
      expect((await s.attempt(`insert into themis.workspaces (name) values ('No logo')`)).ok).toBe(
        true,
      )
    }))

  it('workspace name must be 1..120 non-blank chars', () =>
    actAs(SUPERUSER, async (s) => {
      for (const bad of ['', '   ', 'x'.repeat(121)])
        expect(
          (await s.attempt(`insert into themis.workspaces (name) values ($1)`, [bad])).ok,
        ).toBe(false)
      expect(
        (await s.attempt(`insert into themis.workspaces (name) values ($1)`, ['x'.repeat(120)])).ok,
      ).toBe(true)
    }))

  it('membership role is one of owner|admin|editor|viewer', () =>
    actAs(SUPERUSER, async (s) => {
      const add = (role: string) =>
        s.attempt(
          `insert into themis.memberships (workspace_id, user_id, role) values ($1, $2, $3)`,
          [WB, U.loner, role],
        )
      for (const bad of ['god', 'Owner', 'member', '']) expect((await add(bad)).ok, bad).toBe(false)
      expect(await add('editor')).toEqual({ ok: true, affected: 1 })
    }))

  it('a duplicate (workspace, user) membership is refused', () =>
    actAs(SUPERUSER, async (s) => {
      const dup = await s.attempt(
        `insert into themis.memberships (workspace_id, user_id, role) values ($1, $2, 'viewer')`,
        [WA, U.ownerA],
      )
      expect(!dup.ok && dup.error).toMatch(/duplicate key/)
    }))

  describe('invites', () => {
    const invite = (s: Session, email: string, tokenHash: string, role = 'viewer') =>
      s.attempt(
        `insert into themis.invites (workspace_id, email, role, token_hash, expires_at)
         values ($1, $2, $3, $4, now() + interval '1 day')`,
        [WA, email, role, tokenHash],
      )
    const HEX = 'c'.repeat(64)

    it('email must be stored lower-case and look like an address', () =>
      actAs(SUPERUSER, async (s) => {
        expect((await invite(s, 'Someone@Example.com', HEX)).ok).toBe(false)
        expect((await invite(s, 'no-at-sign', HEX)).ok).toBe(false)
        expect((await invite(s, 'two words@example.com', HEX)).ok).toBe(false)
        expect(await invite(s, 'someone@example.com', HEX)).toEqual({ ok: true, affected: 1 })
      }))

    it('token_hash must be 64 lower-hex chars', () =>
      actAs(SUPERUSER, async (s) => {
        expect((await invite(s, 'x@example.com', 'C'.repeat(64))).ok).toBe(false) // upper-case
        expect((await invite(s, 'x@example.com', 'c'.repeat(63))).ok).toBe(false)
        expect((await invite(s, 'x@example.com', 'c'.repeat(65))).ok).toBe(false)
        expect((await invite(s, 'x@example.com', 'g'.repeat(64))).ok).toBe(false) // not hex
        expect((await invite(s, 'x@example.com', 'raw-token')).ok).toBe(false)
        expect((await invite(s, 'x@example.com', '0123456789abcdef'.repeat(4))).ok).toBe(true)
      }))

    it('token_hash is unique across all workspaces', () =>
      actAs(SUPERUSER, async (s) => {
        // 'b'*64 is workspace B's invite; reusing it from A must still collide.
        const dup = await invite(s, 'x@example.com', 'b'.repeat(64))
        expect(!dup.ok && dup.error).toMatch(/duplicate key/)
      }))

    it('invite role uses the same role set', () =>
      actAs(SUPERUSER, async (s) => {
        expect((await invite(s, 'x@example.com', HEX, 'superadmin')).ok).toBe(false)
      }))
  })
})

describe('recursion-safe membership helpers', () => {
  const HELPERS = [
    ['is_member', 'themis.is_member(uuid)'],
    ['has_role', 'themis.has_role(uuid,text[])'],
    ['shares_workspace', 'themis.shares_workspace(uuid)'],
  ] as const

  it.each(HELPERS)('%s is SECURITY DEFINER, STABLE, search_path pinned empty', async (_n, sig) => {
    const r = await db.query<{
      prosecdef: boolean
      provolatile: string
      proconfig: string[] | null
    }>(`select prosecdef, provolatile, proconfig from pg_proc where oid = $1::regprocedure`, [sig])
    expect(r.rows[0]).toEqual({ prosecdef: true, provolatile: 's', proconfig: ['search_path=""'] })
  })

  it.each(HELPERS)('%s: EXECUTE for authenticated only (not PUBLIC, not anon)', async (_n, sig) => {
    const r = await db.query<{ anon: boolean; authn: boolean; public_acl: boolean }>(
      `select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as authn,
              exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where p.oid = $1::regprocedure and a.grantee = 0) as public_acl`,
      [sig],
    )
    expect(r.rows[0]).toEqual({ anon: false, authn: true, public_acl: false })
  })

  it('answer only about the CALLER (auth.uid()), per workspace and role', () =>
    actAs(U.editorA, async (s) => {
      const [r] = await s.rows(
        `select themis.is_member($1) as in_a, themis.is_member($2) as in_b,
                themis.has_role($1, array['editor']) as editor_a,
                themis.has_role($1, array['owner','admin']) as admin_a,
                themis.shares_workspace($3) as with_viewer_a,
                themis.shares_workspace($4) as with_owner_b`,
        [WA, WB, U.viewerA, U.ownerB],
      )
      expect(r).toEqual({
        in_a: true,
        in_b: false,
        editor_a: true,
        admin_a: false,
        with_viewer_a: true,
        with_owner_b: false,
      })
    }))

  it('anon cannot call any helper', () =>
    actAs(ANON, async (s) => {
      for (const call of [
        `select themis.is_member('${WA}')`,
        `select themis.has_role('${WA}', array['owner'])`,
        `select themis.shares_workspace('${U.ownerA}')`,
      ])
        expect(refused(await s.attempt(call)), call).toBe(true)
    }))
})

describe('RLS, policies and grants', () => {
  it.each(TABLES)('RLS is enabled on themis.%s', async (t) => {
    const r = await db.query<{ on: boolean }>(
      `select relrowsecurity as on from pg_class where oid = $1::regclass`,
      [`themis.${t}`],
    )
    expect(r.rows[0].on).toBe(true)
  })

  it('the policy set is exactly the planned one, all TO authenticated', async () => {
    const r = await db.query<{ p: string }>(
      `select c.relname || '.' || p.polname || ' ' || p.polcmd::text || ' ' || p.polroles::regrole[]::text as p
         from pg_policy p join pg_class c on c.oid = p.polrelid
        where c.relnamespace = 'themis'::regnamespace and c.relname = any ($1::text[])
        order by 1`,
      [[...TABLES]],
    )
    // polcmd: r select, a insert, w update, d delete, * all
    expect(r.rows.map((x) => x.p)).toEqual([
      'invites.invites_select r {authenticated}',
      'memberships.memberships_select r {authenticated}',
      'profiles.profiles_insert_self a {authenticated}',
      'profiles.profiles_select r {authenticated}',
      'profiles.profiles_update_self w {authenticated}',
      'workspaces.workspaces_delete d {authenticated}',
      'workspaces.workspaces_select r {authenticated}',
      'workspaces.workspaces_update w {authenticated}',
    ])
  })

  it('no policy expression references memberships directly (recursion rule)', async () => {
    const r = await db.query<{ name: string; expr: string }>(
      `select c.relname || '.' || p.polname as name,
              coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
              coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
         from pg_policy p join pg_class c on c.oid = p.polrelid
        where c.relnamespace = 'themis'::regnamespace`,
    )
    expect(r.rows.length).toBeGreaterThan(0)
    expect(r.rows.filter((x) => /memberships/.test(x.expr))).toEqual([])
    // Every workspace-scoped policy asks through a helper (not `true`, not an inline subquery).
    for (const x of r.rows.filter((x) => !x.name.startsWith('profiles.')))
      expect(x.expr, x.name).toMatch(/themis\.(is_member|has_role)\(/)
  })

  const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
  const tablePrivs = async (role: string, t: Table) =>
    (
      await db.query<{ p: string }>(
        `select p from unnest($3::text[]) p
          where has_table_privilege($1, $2, p)
             or (p in ('SELECT','INSERT','UPDATE','REFERENCES') and has_any_column_privilege($1, $2, p))`,
        [role, `themis.${t}`, PRIVS],
      )
    ).rows.map((r) => r.p)

  it.each(TABLES)('anon holds no privilege (table or column) on themis.%s', async (t) => {
    expect(await tablePrivs('anon', t)).toEqual([])
  })

  it.each(TABLES)('themis.%s is granted to authenticated and service_role only', async (t) => {
    const r = await db.query<{ g: string }>(
      `select distinct grantee as g from information_schema.role_table_grants
        where table_schema = 'themis' and table_name = $1
       union
       select distinct grantee from information_schema.column_privileges
        where table_schema = 'themis' and table_name = $1
       order by 1`,
      [t],
    )
    expect(r.rows.map((x) => x.g).filter((g) => g !== 'postgres')).toEqual([
      'authenticated',
      'service_role',
    ])
  })

  it('authenticated holds exactly the verbs its policies admit', async () => {
    const got: Record<string, string[]> = {}
    for (const t of TABLES) got[t] = await tablePrivs('authenticated', t)
    expect(got).toEqual({
      profiles: ['SELECT', 'INSERT', 'UPDATE'],
      workspaces: ['SELECT', 'UPDATE', 'DELETE'],
      memberships: ['SELECT'],
      invites: ['SELECT'],
    })
    // Column-limited writes: keys and created_by are never client-writable.
    const cols = await db.query<{ c: string }>(
      `select table_name || '.' || column_name || ' ' || privilege_type as c
         from information_schema.column_privileges
        where table_schema = 'themis' and grantee = 'authenticated'
          and privilege_type in ('INSERT', 'UPDATE') and table_name = any ($1::text[])
        order by 1`,
      [[...TABLES]],
    )
    expect(cols.rows.map((r) => r.c)).toEqual([
      'profiles.display_name INSERT',
      'profiles.display_name UPDATE',
      'profiles.user_id INSERT',
      'workspaces.logo_data_url UPDATE',
      'workspaces.name UPDATE',
    ])
  })

  it('service_role has full DML on all four tables', async () => {
    for (const t of TABLES)
      expect(await tablePrivs('service_role', t), t).toEqual(
        expect.arrayContaining(['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
      )
  })
})

// =================================================================================================
// Behaviour
// =================================================================================================

describe('anon (the public API key)', () => {
  it.each(TABLES)('cannot read themis.%s at all', (t) =>
    actAs(ANON, async (s) => {
      expect(refused(await s.attempt(`select * from themis.${t}`))).toBe(true)
    }),
  )
})

describe('members see their own workspace (positive control, no recursion error)', () => {
  it('owner A sees A and only A, in every table', () =>
    actAs(U.ownerA, async (s) => {
      expect(await s.count('workspaces')).toBe(1)
      expect(await s.count('workspaces', `id = '${WA}'`)).toBe(1)
      expect(await s.count('memberships')).toBe(4)
      expect(await s.count('invites')).toBe(1)
      // own profile + the three A-mates; not B's owner
      expect(await s.count('profiles')).toBe(4)
    }))

  it('a user with no workspace sees nothing but can create their own profile', () =>
    actAs(U.loner, async (s) => {
      for (const t of TABLES) expect(await s.count(t), t).toBe(0)
      expect(
        await s.attempt(`insert into themis.profiles (user_id, display_name) values ($1, 'Me')`, [
          U.loner,
        ]),
      ).toEqual({ ok: true, affected: 1 })
      expect(await s.count('profiles')).toBe(1)
    }))
})

describe('cross-workspace isolation: owner of B against workspace A', () => {
  it('the fixture is non-vacuous: A has rows in every table, and B sees its own', async () => {
    await actAs(SUPERUSER, async (s) => {
      for (const { table, ofA } of TENANT_TABLES)
        expect(await s.count(table, ofA), table).toBeGreaterThan(0)
    })
    await actAs(U.ownerB, async (s) => {
      expect(await s.count('workspaces', `id = '${WB}'`)).toBe(1)
      expect(await s.count('memberships', `workspace_id = '${WB}'`)).toBe(1)
      expect(await s.count('invites', `workspace_id = '${WB}'`)).toBe(1)
      expect(await s.count('profiles', `user_id = '${U.ownerB}'`)).toBe(1)
      for (const t of DECISION_TABLES) expect(await s.count(t, `workspace_id = '${WB}'`), t).toBe(1)
    })
  })

  it.each(TENANT_TABLES)('B reads zero rows of A in themis.$table', ({ table, ofA }) =>
    actAs(U.ownerB, async (s) => {
      expect(await s.count(table, ofA)).toBe(0)
    }),
  )

  it.each(TENANT_TABLES)(
    "B's UPDATE of A's rows in themis.$table has no effect",
    ({ table, ofA, probe }) =>
      actAs(U.ownerB, async (s) => {
        const before = await snapshot(s, table, ofA)
        const o = await s.attempt(`update themis.${table} set ${probe} where ${ofA}`)
        expect(noEffect(o), JSON.stringify(o)).toBe(true)
        expect(await snapshot(s, table, ofA)).toEqual(before)
      }),
  )

  it.each(TENANT_TABLES)(
    "B's DELETE of A's rows in themis.$table has no effect",
    ({ table, ofA }) =>
      actAs(U.ownerB, async (s) => {
        const before = await snapshot(s, table, ofA)
        const o = await s.attempt(`delete from themis.${table} where ${ofA}`)
        expect(noEffect(o), JSON.stringify(o)).toBe(true)
        expect(await snapshot(s, table, ofA)).toEqual(before)
      }),
  )

  it('B cannot insert itself into A, invite into A, or write a profile for A', () =>
    actAs(U.ownerB, async (s) => {
      expect(
        refused(
          await s.attempt(
            `insert into themis.memberships (workspace_id, user_id, role) values ($1, $2, 'owner')`,
            [WA, U.ownerB],
          ),
        ),
      ).toBe(true)
      expect(
        refused(
          await s.attempt(
            `insert into themis.invites (workspace_id, email, role, token_hash, expires_at)
             values ($1, 'x@example.com', 'owner', repeat('d', 64), now() + interval '1 day')`,
            [WA],
          ),
        ),
      ).toBe(true)
      expect(
        refused(
          await s.attempt(`insert into themis.profiles (user_id, display_name) values ($1, 'x')`, [
            U.ownerA,
          ]),
        ),
      ).toBe(true)
      await s.sudo(async () => {
        expect(await s.count('memberships', `workspace_id = '${WA}'`)).toBe(4)
        expect(await s.count('invites', `workspace_id = '${WA}'`)).toBe(1)
      })
    }))

  it("B's helpers say no about A", () =>
    actAs(U.ownerB, async (s) => {
      const [r] = await s.rows(
        `select themis.is_member($1) as m, themis.has_role($1, array['owner','admin','editor','viewer']) as r,
                themis.shares_workspace($2) as sh`,
        [WA, U.ownerA],
      )
      expect(r).toEqual({ m: false, r: false, sh: false })
    }))
})

describe('role gating inside workspace A', () => {
  const rename = (s: Session) =>
    s.attempt(`update themis.workspaces set name = 'Renamed' where id = $1`, [WA])
  const del = (s: Session) => s.attempt(`delete from themis.workspaces where id = $1`, [WA])

  it.each([
    ['viewer', U.viewerA],
    ['editor', U.editorA],
  ])('%s can read A but cannot rename or delete it, and sees no invites', (_r, uid) =>
    actAs(uid, async (s) => {
      expect(await s.count('workspaces', `id = '${WA}'`)).toBe(1)
      expect(await rename(s)).toEqual({ ok: true, affected: 0 })
      expect(await del(s)).toEqual({ ok: true, affected: 0 })
      expect(await s.count('invites')).toBe(0)
      await s.sudo(async () => {
        expect(await s.count('workspaces', `id = '${WA}' and name = 'Workspace A'`)).toBe(1)
      })
    }),
  )

  it('admin can rename A and see its invites, but cannot delete it', () =>
    actAs(U.adminA, async (s) => {
      expect(await rename(s)).toEqual({ ok: true, affected: 1 })
      expect(await s.count('invites')).toBe(1)
      expect(await del(s)).toEqual({ ok: true, affected: 0 })
    }))

  it('owner can rename A (name and logo) but not rewrite created_by or the id', () =>
    actAs(U.ownerA, async (s) => {
      expect(await rename(s)).toEqual({ ok: true, affected: 1 })
      expect(
        await s.attempt(`update themis.workspaces set logo_data_url = $2 where id = $1`, [
          WA,
          'data:image/webp;base64,AAAA',
        ]),
      ).toEqual({ ok: true, affected: 1 })
      expect(
        refused(
          await s.attempt(`update themis.workspaces set created_by = $2 where id = $1`, [
            WA,
            U.ownerB,
          ]),
        ),
      ).toBe(true)
      expect(
        refused(
          await s.attempt(`update themis.workspaces set id = gen_random_uuid() where id = $1`, [
            WA,
          ]),
        ),
      ).toBe(true)
    }))

  it('nobody can create a workspace directly (RPC-only, P2.5)', () =>
    actAs(U.ownerA, async (s) => {
      expect(refused(await s.attempt(`insert into themis.workspaces (name) values ('New')`))).toBe(
        true,
      )
    }))

  it('a user edits only their own profile', () =>
    actAs(U.ownerA, async (s) => {
      expect(
        await s.attempt(`update themis.profiles set display_name = 'Me' where user_id = $1`, [
          U.ownerA,
        ]),
      ).toEqual({ ok: true, affected: 1 })
      // Visible (shared workspace) but not writable.
      expect(
        await s.attempt(`update themis.profiles set display_name = 'x' where user_id = $1`, [
          U.viewerA,
        ]),
      ).toEqual({ ok: true, affected: 0 })
      expect(
        refused(
          await s.attempt(`update themis.profiles set user_id = $2 where user_id = $1`, [
            U.ownerA,
            U.loner,
          ]),
        ),
      ).toBe(true)
    }))
})

describe('memberships and invites are RPC-only: even the owner cannot write them directly', () => {
  it.each([
    [
      'insert membership',
      `insert into themis.memberships (workspace_id, user_id, role) values ('${WA}', '${U.loner}', 'viewer')`,
    ],
    [
      'promote via update',
      `update themis.memberships set role = 'owner' where workspace_id = '${WA}' and user_id = '${U.viewerA}'`,
    ],
    [
      'remove member',
      `delete from themis.memberships where workspace_id = '${WA}' and user_id = '${U.viewerA}'`,
    ],
    [
      'insert invite',
      `insert into themis.invites (workspace_id, email, role, token_hash, expires_at)
       values ('${WA}', 'x@example.com', 'viewer', repeat('e', 64), now() + interval '1 day')`,
    ],
    [
      'accept invite via update',
      `update themis.invites set accepted_at = now() where workspace_id = '${WA}'`,
    ],
    ['revoke invite via delete', `delete from themis.invites where workspace_id = '${WA}'`],
  ])('%s is refused', (_name, sql) =>
    actAs(U.ownerA, async (s) => {
      const o = await s.attempt(sql)
      expect(refused(o), JSON.stringify(o)).toBe(true)
    }),
  )
})

describe('lifecycle', () => {
  it('owner deleting A cascades its memberships and invites and leaves B intact', () =>
    actAs(U.ownerA, async (s) => {
      expect(await s.attempt(`delete from themis.workspaces where id = $1`, [WA])).toEqual({
        ok: true,
        affected: 1,
      })
      await s.sudo(async () => {
        expect(await s.count('workspaces', `id = '${WA}'`)).toBe(0)
        expect(await s.count('memberships', `workspace_id = '${WA}'`)).toBe(0)
        expect(await s.count('invites', `workspace_id = '${WA}'`)).toBe(0)
        expect(await s.count('workspaces', `id = '${WB}'`)).toBe(1)
        expect(await s.count('memberships', `workspace_id = '${WB}'`)).toBe(1)
        expect(await s.count('invites', `workspace_id = '${WB}'`)).toBe(1)
        // Profiles belong to the user, not the workspace.
        expect(await s.count('profiles', `user_id = '${U.viewerA}'`)).toBe(1)
      })
    }))

  it('deleting an auth user cascades their profile and memberships, and nulls created_by', () =>
    actAs(SUPERUSER, async (s) => {
      await s.rows(`delete from auth.users where id = $1`, [U.ownerA])
      expect(await s.count('profiles', `user_id = '${U.ownerA}'`)).toBe(0)
      expect(await s.count('memberships', `user_id = '${U.ownerA}'`)).toBe(0)
      expect(await s.count('workspaces', `id = '${WA}' and created_by is null`)).toBe(1)
    }))

  it.each([
    ['profiles', `display_name = 'x'`, `user_id = '${U.ownerA}'`],
    ['workspaces', `name = 'x'`, `id = '${WA}'`],
    ['memberships', `role = 'admin'`, `workspace_id = '${WA}' and user_id = '${U.viewerA}'`],
    ['invites', `role = 'admin'`, `workspace_id = '${WA}'`],
  ])('an UPDATE on themis.%s bumps updated_at', (t, set, where) =>
    actAs(SUPERUSER, async (s) => {
      expect(await s.count(t, `${where} and updated_at = '${OLD}'`)).toBe(1)
      await s.rows(`update themis.${t} set ${set} where ${where}`)
      expect(
        await s.count(t, `${where} and updated_at > '${OLD}'::timestamptz + interval '1 day'`),
      ).toBe(1)
    }),
  )
})

describe("Hephaestus's side of the shared project is untouched", () => {
  it('public/auth tables, policies, functions and triggers are identical before and after apply', () => {
    expect(foreignAfter).toEqual(foreignBefore)
  })

  it('no trigger on auth.users', async () => {
    const r = await db.query(
      `select tgname from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal`,
    )
    expect(r.rows).toEqual([])
  })

  it(`supabase_migrations.schema_migrations still holds ${HEPHAESTUS_MIGRATION_ROWS} rows`, async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from supabase_migrations.schema_migrations`,
    )
    expect(r.rows[0].n).toBe(HEPHAESTUS_MIGRATION_ROWS)
  })

  it('every object the archive created lives in schema themis', async () => {
    const r = await db.query<{ n: string }>(
      `select n.nspname as n from pg_namespace n
        where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast', 'public', 'auth',
                                'supabase_migrations', 'themis')
          and n.nspname not like 'pg_temp_%' and n.nspname not like 'pg_toast_temp_%'`,
    )
    expect(r.rows).toEqual([])
  })
})

describe('decision core (P1.5): the DB enums match src/lib/decision.ts exactly', () => {
  // The allowed values of a CHECK (col in (...)) constraint on themis.decisions, read back from
  // the catalog, so a value added on only one side (TS or SQL) turns this RED.
  const allowed = async (col: string) => {
    const r = await db.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
        where c.conrelid = 'themis.decisions'::regclass and c.contype = 'c'
          and a.attname = $1 and cardinality(c.conkey) = 1`,
      [col],
    )
    expect(r.rows, `one single-column CHECK on decisions.${col}`).toHaveLength(1)
    return [...r.rows[0].def.matchAll(/'([^']*)'::text/g)].map((m) => m[1]).sort()
  }

  it.each([
    ['methodology', Object.keys(METHODOLOGIES)],
    ['scale', Object.keys(SCALES)],
  ])('decisions.%s allows exactly the decision.ts values', async (col, ts) => {
    expect(await allowed(col)).toEqual([...ts].sort())
  })
})

// =================================================================================================
// P1.5 decision core — structure
// =================================================================================================

const TSZ_ = 'timestamp with time zone'
const columnsOf = async (t: string) =>
  (
    await db.query<{ c: string }>(
      `select a.attname || ':' || format_type(a.atttypid, a.atttypmod)
              || case when a.attnotnull then '!' else '' end as c
         from pg_attribute a
        where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
      [`themis.${t}`],
    )
  ).rows.map((r) => r.c)

const PRIVS_ = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
/** Table verbs `role` holds on themis.<t>, directly or through any column grant. */
const privsOf = async (role: string, t: string) =>
  (
    await db.query<{ p: string }>(
      `select p from unnest($3::text[]) p
        where has_table_privilege($1, $2, p)
           or (p in ('SELECT','INSERT','UPDATE','REFERENCES') and has_any_column_privilege($1, $2, p))`,
      [role, `themis.${t}`, PRIVS_],
    )
  ).rows.map((r) => r.p)

/** Postgres refused because of a (named) foreign key. */
const fkRefused = (o: Outcome, constraint: string) =>
  !o.ok && o.error.includes('violates foreign key constraint') && o.error.includes(constraint)
const checkRefused = (o: Outcome, constraint?: string) =>
  !o.ok &&
  o.error.includes('violates check constraint') &&
  (constraint === undefined || o.error.includes(constraint))
const dupRefused = (o: Outcome, constraint: string) =>
  !o.ok && o.error.includes('duplicate key') && o.error.includes(constraint)

/** Content hash of every decision-core row of workspace `ws` (read as superuser). */
const decisionCoreSnapshot = async (s: Session, ws: string) => {
  const out: Record<string, unknown> = {}
  for (const t of DECISION_TABLES) out[t] = await snapshot(s, t, `workspace_id = '${ws}'`)
  return out
}

describe('decision core (P1.5): table shapes and keys', () => {
  it.each([
    [
      'decisions',
      [
        'id:uuid!',
        'workspace_id:uuid!',
        'lineage_id:uuid!',
        'revision:integer!',
        'question:text!',
        'methodology:text!',
        'scale:text!',
        'status:text!',
        'frozen:boolean!',
        'approved_by:uuid',
        `approved_at:${TSZ_}`,
        'created_by:uuid',
        `created_at:${TSZ_}!`,
        `updated_at:${TSZ_}!`,
      ],
    ],
    [
      'options',
      [
        'id:uuid!',
        'workspace_id:uuid!',
        'decision_id:uuid!',
        'name:text!',
        'position:smallint!',
        'created_by:uuid',
        `created_at:${TSZ_}!`,
        `updated_at:${TSZ_}!`,
      ],
    ],
    [
      'criteria',
      [
        'id:uuid!',
        'workspace_id:uuid!',
        'decision_id:uuid!',
        'name:text!',
        'weight:smallint!',
        'position:smallint!',
        'created_by:uuid',
        `created_at:${TSZ_}!`,
        `updated_at:${TSZ_}!`,
      ],
    ],
    [
      'scores',
      [
        'workspace_id:uuid!',
        'decision_id:uuid!',
        'option_id:uuid!',
        'criterion_id:uuid!',
        'value:smallint!',
        'created_by:uuid',
        `created_at:${TSZ_}!`,
        `updated_at:${TSZ_}!`,
      ],
    ],
  ] as const)('themis.%s has the planned columns, types and NOT NULLs', async (t, want) => {
    expect(await columnsOf(t)).toEqual(want)
  })

  it('primary and unique keys are exactly the planned ones', async () => {
    const r = await db.query<{ k: string }>(
      `select c.conrelid::regclass::text || ' ' || c.conname || ' ' || c.contype::text || ' (' ||
              (select string_agg(a.attname, ',' order by k.ord)
                 from unnest(c.conkey) with ordinality k(n, ord)
                 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n) || ')' as k
         from pg_constraint c
        where c.contype in ('p', 'u') and c.conrelid::regclass::text = any ($1::text[])`,
      [DECISION_TABLES.map((t) => `themis.${t}`)],
    )
    expect(r.rows.map((x) => x.k).sort()).toEqual(
      [
        'themis.decisions decisions_pkey p (id)',
        'themis.decisions decisions_id_workspace_id_key u (id,workspace_id)',
        'themis.decisions decisions_lineage_id_revision_key u (lineage_id,revision)',
        'themis.options options_pkey p (id)',
        'themis.options options_id_decision_id_key u (id,decision_id)',
        'themis.criteria criteria_pkey p (id)',
        'themis.criteria criteria_id_decision_id_key u (id,decision_id)',
        'themis.scores scores_pkey p (option_id,criterion_id)',
      ].sort(),
    )
  })

  it('foreign keys: children reach decisions only through the composite (decision_id, workspace_id)', async () => {
    const cols = (rel: string, key: string) =>
      `(select string_agg(a.attname, ',' order by k.ord)
          from unnest(c.${key}) with ordinality k(n, ord)
          join pg_attribute a on a.attrelid = c.${rel} and a.attnum = k.n)`
    const r = await db.query<{ fk: string }>(
      `select c.conrelid::regclass::text || '(' || ${cols('conrelid', 'conkey')} || ')->' ||
              c.confrelid::regclass::text || '(' || ${cols('confrelid', 'confkey')} || ') ' ||
              c.confdeltype::text as fk
         from pg_constraint c
        where c.contype = 'f' and c.conrelid::regclass::text = any ($1::text[])`,
      [DECISION_TABLES.map((t) => `themis.${t}`)],
    )
    // c = cascade, n = set null. No child has a direct FK to workspaces (DECISIONS.md P1.5).
    expect(r.rows.map((x) => x.fk).sort()).toEqual(
      [
        'themis.decisions(workspace_id)->themis.workspaces(id) c',
        'themis.decisions(approved_by)->auth.users(id) n',
        'themis.decisions(created_by)->auth.users(id) n',
        'themis.options(decision_id,workspace_id)->themis.decisions(id,workspace_id) c',
        'themis.options(created_by)->auth.users(id) n',
        'themis.criteria(decision_id,workspace_id)->themis.decisions(id,workspace_id) c',
        'themis.criteria(created_by)->auth.users(id) n',
        'themis.scores(decision_id,workspace_id)->themis.decisions(id,workspace_id) c',
        'themis.scores(option_id,decision_id)->themis.options(id,decision_id) c',
        'themis.scores(criterion_id,decision_id)->themis.criteria(id,decision_id) c',
        'themis.scores(created_by)->auth.users(id) n',
      ].sort(),
    )
  })
})

describe('decision core (P1.5): RLS, policies and grants', () => {
  it.each(DECISION_TABLES)('RLS is enabled on themis.%s', async (t) => {
    const r = await db.query<{ on: boolean }>(
      `select relrowsecurity as on from pg_class where oid = $1::regclass`,
      [`themis.${t}`],
    )
    expect(r.rows[0].on).toBe(true)
  })

  it('the policy set is exactly select/insert/update/delete per table, all TO authenticated', async () => {
    const r = await db.query<{ p: string }>(
      `select c.relname || '.' || p.polname || ' ' || p.polcmd::text || ' ' || p.polroles::regrole[]::text as p
         from pg_policy p join pg_class c on c.oid = p.polrelid
        where c.relnamespace = 'themis'::regnamespace and c.relname = any ($1::text[])`,
      [[...DECISION_TABLES]],
    )
    const want = DECISION_TABLES.flatMap((t) =>
      [
        ['select', 'r'],
        ['insert', 'a'],
        ['update', 'w'],
        ['delete', 'd'],
      ].map(([verb, cmd]) => `${t}.${t}_${verb} ${cmd} {authenticated}`),
    )
    expect(r.rows.map((x) => x.p).sort()).toEqual(want.sort())
  })

  it.each(DECISION_TABLES)('anon holds no privilege (table or column) on themis.%s', async (t) => {
    expect(await privsOf('anon', t)).toEqual([])
  })

  it.each(DECISION_TABLES)(
    'themis.%s is granted to authenticated and service_role only',
    async (t) => {
      const r = await db.query<{ g: string }>(
        `select distinct grantee as g from information_schema.role_table_grants
          where table_schema = 'themis' and table_name = $1
         union
         select distinct grantee from information_schema.column_privileges
          where table_schema = 'themis' and table_name = $1
         order by 1`,
        [t],
      )
      expect(r.rows.map((x) => x.g).filter((g) => g !== 'postgres')).toEqual([
        'authenticated',
        'service_role',
      ])
    },
  )

  it('authenticated: SELECT/DELETE on the table, INSERT/UPDATE only on the exact planned columns', async () => {
    for (const t of DECISION_TABLES) {
      expect(await privsOf('authenticated', t), t).toEqual(['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      // Writes are column-level only: no table-wide INSERT or UPDATE.
      const [w] = (
        await db.query<{ ins: boolean; upd: boolean }>(
          `select has_table_privilege('authenticated', $1, 'INSERT') as ins,
                  has_table_privilege('authenticated', $1, 'UPDATE') as upd`,
          [`themis.${t}`],
        )
      ).rows
      expect(w, t).toEqual({ ins: false, upd: false })
    }
    const cols = await db.query<{ c: string }>(
      `select table_name || '.' || column_name || ' ' || privilege_type as c
         from information_schema.column_privileges
        where table_schema = 'themis' and grantee = 'authenticated'
          and privilege_type in ('INSERT', 'UPDATE') and table_name = any ($1::text[])`,
      [[...DECISION_TABLES]],
    )
    expect(cols.rows.map((r) => r.c).sort()).toEqual(
      [
        'decisions.workspace_id INSERT',
        'decisions.question INSERT',
        'decisions.question UPDATE',
        'decisions.methodology INSERT',
        'decisions.methodology UPDATE',
        'decisions.scale INSERT',
        'decisions.scale UPDATE',
        'options.workspace_id INSERT',
        'options.decision_id INSERT',
        'options.name INSERT',
        'options.name UPDATE',
        'options.position INSERT',
        'options.position UPDATE',
        'criteria.workspace_id INSERT',
        'criteria.decision_id INSERT',
        'criteria.name INSERT',
        'criteria.name UPDATE',
        'criteria.weight INSERT',
        'criteria.weight UPDATE',
        'criteria.position INSERT',
        'criteria.position UPDATE',
        'scores.workspace_id INSERT',
        'scores.decision_id INSERT',
        'scores.option_id INSERT',
        'scores.criterion_id INSERT',
        'scores.value INSERT',
        'scores.value UPDATE',
      ].sort(),
    )
  })

  it('service_role has full DML on the four decision tables', async () => {
    for (const t of DECISION_TABLES)
      expect(await privsOf('service_role', t), t).toEqual(
        expect.arrayContaining(['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
      )
  })
})

// =================================================================================================
// P1.5 decision core — behaviour
// =================================================================================================

describe('decision core (P1.5): visibility', () => {
  it.each(DECISION_TABLES)('anon cannot read themis.%s', (t) =>
    actAs(ANON, async (s) => {
      expect(refused(await s.attempt(`select * from themis.${t}`))).toBe(true)
    }),
  )

  it('anon cannot create a decision', () =>
    actAs(ANON, async (s) => {
      const o = await s.attempt(
        `insert into themis.decisions (workspace_id, question, methodology, scale)
         values ($1, 'q', 'agile', 'mid')`,
        [WA],
      )
      expect(refused(o), JSON.stringify(o)).toBe(true)
    }))

  it('a member of A sees all of A and nothing of B', () =>
    actAs(U.viewerA, async (s) => {
      expect(await s.count('decisions')).toBe(2)
      expect(await s.count('options')).toBe(3)
      expect(await s.count('criteria')).toBe(3)
      expect(await s.count('scores')).toBe(3)
      for (const t of DECISION_TABLES) expect(await s.count(t, `workspace_id = '${WB}'`), t).toBe(0)
    }))

  it('a user with no workspace sees no decision-core rows', () =>
    actAs(U.loner, async (s) => {
      for (const t of DECISION_TABLES) expect(await s.count(t), t).toBe(0)
    }))
})

describe('decision core (P1.5): cross-tenant child writes by the owner of B', () => {
  it.each([
    ['options', 'name', `'x'`],
    ['criteria', 'name', `'x'`],
  ] as const)(
    "a %s row claiming workspace B but pointing at A's decision is refused by the composite FK",
    (t, col, val) =>
      actAs(U.ownerB, async (s) => {
        const before = await decisionCoreSnapshot(s, WA)
        const o = await s.attempt(
          `insert into themis.${t} (workspace_id, decision_id, ${col}) values ($1, $2, ${val})`,
          [WB, D.A],
        )
        expect(fkRefused(o, `${t}_decision_fkey`), JSON.stringify(o)).toBe(true)
        expect(await decisionCoreSnapshot(s, WA)).toEqual(before)
      }),
  )

  it.each([['options'], ['criteria']] as const)(
    'a %s row claiming workspace A is refused by RLS',
    (t) =>
      actAs(U.ownerB, async (s) => {
        const o = await s.attempt(
          `insert into themis.${t} (workspace_id, decision_id, name) values ($1, $2, 'x')`,
          [WA, D.A],
        )
        expect(!o.ok && o.error, JSON.stringify(o)).toMatch(/violates row-level security/)
        await s.sudo(async () => expect(await s.count(t, `decision_id = '${D.A}'`)).toBe(2))
      }),
  )

  it("a score claiming workspace B on A's decision/option/criterion is refused by the composite FK", () =>
    actAs(U.ownerB, async (s) => {
      const o = await s.attempt(
        `insert into themis.scores (workspace_id, decision_id, option_id, criterion_id, value)
         values ($1, $2, $3, $4, 5)`,
        [WB, D.A, O.A2, C.A2],
      )
      expect(fkRefused(o, 'scores_decision_fkey'), JSON.stringify(o)).toBe(true)
    }))

  it("a score on B's own decision that points at A's option is refused (option pinned to decision)", () =>
    actAs(U.ownerB, async (s) => {
      const o = await s.attempt(
        `insert into themis.scores (workspace_id, decision_id, option_id, criterion_id, value)
         values ($1, $2, $3, $4, 5)`,
        [WB, D.B, O.A2, C.B1],
      )
      expect(fkRefused(o, 'scores_option_fkey'), JSON.stringify(o)).toBe(true)
    }))

  it('a score claiming workspace A is refused by RLS', () =>
    actAs(U.ownerB, async (s) => {
      const o = await s.attempt(
        `insert into themis.scores (workspace_id, decision_id, option_id, criterion_id, value)
         values ($1, $2, $3, $4, 5)`,
        [WA, D.A, O.A2, C.A2],
      )
      expect(!o.ok && o.error, JSON.stringify(o)).toMatch(/violates row-level security/)
      await s.sudo(async () => expect(await s.count('scores', `workspace_id = '${WA}'`)).toBe(3))
    }))

  it('B cannot create a decision in A', () =>
    actAs(U.ownerB, async (s) => {
      const o = await s.attempt(
        `insert into themis.decisions (workspace_id, question, methodology, scale)
         values ($1, 'x', 'agile', 'mid')`,
        [WA],
      )
      expect(!o.ok && o.error, JSON.stringify(o)).toMatch(/violates row-level security/)
    }))

  it("B cannot re-point its own rows at A's decision (tenancy keys are not updatable)", () =>
    actAs(U.ownerB, async (s) => {
      for (const sql of [
        `update themis.options set decision_id = '${D.A}' where id = '${O.B1}'`,
        `update themis.options set workspace_id = '${WA}' where id = '${O.B1}'`,
        `update themis.criteria set decision_id = '${D.A}' where id = '${C.B1}'`,
        `update themis.scores set decision_id = '${D.A}' where option_id = '${O.B1}'`,
        `update themis.decisions set workspace_id = '${WA}' where id = '${D.B}'`,
      ]) {
        const o = await s.attempt(sql)
        expect(refused(o), `${sql} -> ${JSON.stringify(o)}`).toBe(true)
      }
    }))
})

describe('decision core (P1.5): a score cannot mix two decisions', () => {
  const score = (s: Session, decision: string, option: string, criterion: string) =>
    s.attempt(
      `insert into themis.scores (workspace_id, decision_id, option_id, criterion_id, value)
       values ($1, $2, $3, $4, 3)`,
      [WA, decision, option, criterion],
    )

  it('positive control: an editor scores a free cell of one decision', () =>
    actAs(U.editorA, async (s) => {
      expect(await score(s, D.A, O.A2, C.A2)).toEqual({ ok: true, affected: 1 })
    }))

  it('an option of DA with a criterion of DAF is refused (criterion pinned to decision)', () =>
    actAs(U.editorA, async (s) => {
      const o = await score(s, D.A, O.A2, C.F1)
      expect(fkRefused(o, 'scores_criterion_fkey'), JSON.stringify(o)).toBe(true)
    }))

  it('an option of DAF with a criterion of DA is refused (option pinned to decision)', () =>
    actAs(U.editorA, async (s) => {
      const o = await score(s, D.A, O.F1, C.A2)
      expect(fkRefused(o, 'scores_option_fkey'), JSON.stringify(o)).toBe(true)
    }))

  it('both ends from DA but decision_id = DAF is refused', () =>
    actAs(U.editorA, async (s) => {
      const o = await score(s, D.AF, O.A2, C.A2)
      expect(!o.ok && o.error, JSON.stringify(o)).toMatch(
        /violates foreign key constraint "scores_(option|criterion)_fkey"/,
      )
    }))
})

describe('decision core (P1.5): role gating inside workspace A', () => {
  it('viewer reads every table but every write is refused or has no effect', () =>
    actAs(U.viewerA, async (s) => {
      const before = await decisionCoreSnapshot(s, WA)
      const inserts = [
        `insert into themis.decisions (workspace_id, question, methodology, scale) values ('${WA}', 'v', 'agile', 'mid')`,
        `insert into themis.options (workspace_id, decision_id, name) values ('${WA}', '${D.A}', 'v')`,
        `insert into themis.criteria (workspace_id, decision_id, name) values ('${WA}', '${D.A}', 'v')`,
        `insert into themis.scores (workspace_id, decision_id, option_id, criterion_id, value)
           values ('${WA}', '${D.A}', '${O.A2}', '${C.A2}', 3)`,
      ]
      for (const sql of inserts) {
        const o = await s.attempt(sql)
        expect(refused(o), `${sql} -> ${JSON.stringify(o)}`).toBe(true)
      }
      const writes = [
        `update themis.decisions set question = 'v' where id = '${D.A}'`,
        `update themis.options set name = 'v' where id = '${O.A1}'`,
        `update themis.criteria set weight = 0 where id = '${C.A1}'`,
        `update themis.scores set value = 1 where option_id = '${O.A1}' and criterion_id = '${C.A1}'`,
        `delete from themis.scores where workspace_id = '${WA}'`,
        `delete from themis.options where workspace_id = '${WA}'`,
        `delete from themis.criteria where workspace_id = '${WA}'`,
        `delete from themis.decisions where workspace_id = '${WA}'`,
      ]
      for (const sql of writes) expect(await s.attempt(sql), sql).toEqual({ ok: true, affected: 0 })
      expect(await decisionCoreSnapshot(s, WA)).toEqual(before)
    }))

  it.each([
    ['editor', U.editorA],
    ['admin', U.adminA],
    ['owner', U.ownerA],
  ])('%s creates a decision and writes options, criteria and scores', (_r, uid) =>
    actAs(uid, async (s) => {
      const [d] = await s.rows<{ id: string }>(
        `insert into themis.decisions (workspace_id, question, methodology, scale)
         values ($1, 'New?', 'yolo', 'small') returning id`,
        [WA],
      )
      const [o] = await s.rows<{ id: string }>(
        `insert into themis.options (workspace_id, decision_id, name, position)
         values ($1, $2, 'Opt', 0) returning id`,
        [WA, d.id],
      )
      const [c] = await s.rows<{ id: string }>(
        `insert into themis.criteria (workspace_id, decision_id, name, weight, position)
         values ($1, $2, 'Crit', 5, 0) returning id`,
        [WA, d.id],
      )
      expect(
        await s.attempt(
          `insert into themis.scores (workspace_id, decision_id, option_id, criterion_id, value)
           values ($1, $2, $3, $4, 4)`,
          [WA, d.id, o.id, c.id],
        ),
      ).toEqual({ ok: true, affected: 1 })
      // The score upsert the UI uses (PK = one row per cell).
      expect(
        await s.attempt(
          `insert into themis.scores (workspace_id, decision_id, option_id, criterion_id, value)
           values ($1, $2, $3, $4, 2)
           on conflict (option_id, criterion_id) do update set value = excluded.value`,
          [WA, d.id, o.id, c.id],
        ),
      ).toEqual({ ok: true, affected: 1 })
      expect(await s.count('scores', `option_id = '${o.id}' and value = 2`)).toBe(1)
    }),
  )

  it.each([
    ['editor', U.editorA],
    ['admin', U.adminA],
    ['owner', U.ownerA],
  ])('%s edits a draft decision and its children, and deletes them', (_r, uid) =>
    actAs(uid, async (s) => {
      for (const sql of [
        `update themis.decisions set question = 'Edited', methodology = 'waterfall', scale = 'enterprise' where id = '${D.A}'`,
        `update themis.options set name = 'Renamed', position = 5 where id = '${O.A1}'`,
        `update themis.criteria set name = 'Renamed', weight = 0, position = 5 where id = '${C.A1}'`,
        `update themis.scores set value = 1 where option_id = '${O.A1}' and criterion_id = '${C.A1}'`,
        `delete from themis.scores where option_id = '${O.A2}' and criterion_id = '${C.A1}'`,
        `delete from themis.options where id = '${O.A2}'`,
        `delete from themis.criteria where id = '${C.A2}'`,
      ])
        expect(await s.attempt(sql), sql).toEqual({ ok: true, affected: 1 })
      expect(await s.count('decisions', `id = '${D.A}' and question = 'Edited'`)).toBe(1)
      expect(await s.attempt(`delete from themis.decisions where id = $1`, [D.A])).toEqual({
        ok: true,
        affected: 1,
      })
    }),
  )

  // Every lifecycle / identity / tenancy column, with a value that would otherwise be valid, so
  // only the column grant can refuse it.
  const DECISION_LOCKED: [string, string][] = [
    ['status', `'in_review'`],
    ['frozen', 'false'],
    ['approved_by', `'${U.ownerA}'`],
    ['approved_at', 'now()'],
    ['lineage_id', 'gen_random_uuid()'],
    ['revision', '2'],
    ['created_by', `'${U.editorA}'`],
    ['id', 'gen_random_uuid()'],
    ['workspace_id', `'${WA}'`],
    ['created_at', 'now()'],
    ['updated_at', 'now()'],
  ]

  it.each([
    ['editor', U.editorA],
    ['admin', U.adminA],
    ['owner', U.ownerA],
  ])('%s cannot UPDATE any lifecycle column of a draft decision', (_r, uid) =>
    actAs(uid, async (s) => {
      const before = await snapshot(s, 'decisions', `id = '${D.A}'`)
      for (const [col, val] of DECISION_LOCKED) {
        const o = await s.attempt(`update themis.decisions set ${col} = ${val} where id = $1`, [
          D.A,
        ])
        expect(refused(o), `${col}: ${JSON.stringify(o)}`).toBe(true)
      }
      expect(await snapshot(s, 'decisions', `id = '${D.A}'`)).toEqual(before)
    }),
  )

  it.each([
    ['editor', U.editorA],
    ['owner', U.ownerA],
  ])('%s cannot INSERT a decision that presets a lifecycle column', (_r, uid) =>
    actAs(uid, async (s) => {
      const presets: [string, string][] = [
        ['status', `'approved'`],
        ['frozen', 'false'],
        ['approved_by', `'${U.ownerA}'`],
        ['approved_at', 'now()'],
        // Forging a revision into another lineage would block its real next revision.
        ['lineage_id', `'${LINEAGE_A}'`],
        ['revision', '7'],
        ['created_by', `'${U.ownerB}'`],
        ['id', 'gen_random_uuid()'],
      ]
      for (const [col, val] of presets) {
        const o = await s.attempt(
          `insert into themis.decisions (workspace_id, question, methodology, scale, ${col})
           values ('${WA}', 'q', 'agile', 'mid', ${val})`,
        )
        expect(refused(o), `${col}: ${JSON.stringify(o)}`).toBe(true)
      }
      await s.sudo(async () => expect(await s.count('decisions', `workspace_id = '${WA}'`)).toBe(2))
    }),
  )

  it('an owner cannot rewrite identity, tenancy or created_by columns of children', () =>
    actAs(U.ownerA, async (s) => {
      for (const sql of [
        `update themis.options set id = gen_random_uuid() where id = '${O.A1}'`,
        `update themis.options set created_by = '${U.ownerB}' where id = '${O.A1}'`,
        `update themis.options set decision_id = '${D.AF}' where id = '${O.A1}'`,
        `update themis.criteria set id = gen_random_uuid() where id = '${C.A1}'`,
        `update themis.criteria set created_by = '${U.ownerB}' where id = '${C.A1}'`,
        `update themis.criteria set workspace_id = '${WA}' where id = '${C.A1}'`,
        `update themis.scores set option_id = '${O.A2}' where option_id = '${O.A1}' and criterion_id = '${C.A1}'`,
        `update themis.scores set criterion_id = '${C.A2}' where option_id = '${O.A1}' and criterion_id = '${C.A1}'`,
        `update themis.scores set created_by = '${U.ownerB}' where option_id = '${O.A1}'`,
        `insert into themis.options (workspace_id, decision_id, name, created_by) values ('${WA}', '${D.A}', 'x', '${U.ownerB}')`,
        `insert into themis.criteria (id, workspace_id, decision_id, name) values (gen_random_uuid(), '${WA}', '${D.A}', 'x')`,
      ]) {
        const o = await s.attempt(sql)
        expect(refused(o), `${sql} -> ${JSON.stringify(o)}`).toBe(true)
      }
    }))

  it.each([
    ['editor', U.editorA],
    ['admin', U.adminA],
    ['owner', U.ownerA],
  ])('%s cannot update or delete a frozen (approved) decision', (_r, uid) =>
    actAs(uid, async (s) => {
      const before = await snapshot(s, 'decisions', `id = '${D.AF}'`)
      expect(
        await s.attempt(`update themis.decisions set question = 'Tampered' where id = $1`, [D.AF]),
      ).toEqual({ ok: true, affected: 0 })
      expect(
        await s.attempt(`update themis.decisions set methodology = 'yolo' where id = $1`, [D.AF]),
      ).toEqual({ ok: true, affected: 0 })
      expect(await s.attempt(`delete from themis.decisions where id = $1`, [D.AF])).toEqual({
        ok: true,
        affected: 0,
      })
      expect(await snapshot(s, 'decisions', `id = '${D.AF}'`)).toEqual(before)
      // Still visible: frozen is read-only, not hidden.
      expect(await s.count('decisions', `id = '${D.AF}'`)).toBe(1)
    }),
  )
})

describe('decision core (P1.5): check and unique constraints (as superuser)', () => {
  const decision = (s: Session, cols: Record<string, unknown>) => {
    const all: Record<string, unknown> = {
      workspace_id: WA,
      methodology: 'agile',
      scale: 'mid',
      ...cols,
    }
    const k = Object.keys(all)
    return s.attempt(
      `insert into themis.decisions (${k.join(', ')}) values (${k.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(all),
    )
  }
  const criterion = (s: Session, weight: number) =>
    s.attempt(
      `insert into themis.criteria (workspace_id, decision_id, name, weight) values ($1, $2, 'w', $3)`,
      [WA, D.A, weight],
    )
  const score = (s: Session, option: string, criterion: string, value: number) =>
    s.attempt(
      `insert into themis.scores (workspace_id, decision_id, option_id, criterion_id, value)
       values ($1, $2, $3, $4, $5)`,
      [WA, D.A, option, criterion, value],
    )
  const OK = { ok: true, affected: 1 }

  it('criterion weight is 0..5: -1 and 6 refused, 0 and 5 accepted', () =>
    actAs(SUPERUSER, async (s) => {
      expect(checkRefused(await criterion(s, -1), 'criteria_weight_check')).toBe(true)
      expect(checkRefused(await criterion(s, 6), 'criteria_weight_check')).toBe(true)
      expect(await criterion(s, 0)).toEqual(OK)
      expect(await criterion(s, 5)).toEqual(OK)
    }))

  it('score value is 1..5: 0 and 6 refused, 1 and 5 accepted, update to 6 refused', () =>
    actAs(SUPERUSER, async (s) => {
      expect(checkRefused(await score(s, O.A2, C.A2, 0), 'scores_value_check')).toBe(true)
      expect(checkRefused(await score(s, O.A2, C.A2, 6), 'scores_value_check')).toBe(true)
      expect(await score(s, O.A2, C.A2, 1)).toEqual(OK)
      expect(await score(s, O.A1, C.A2, 5)).toEqual(OK)
      const up = await s.attempt(
        `update themis.scores set value = 6 where option_id = $1 and criterion_id = $2`,
        [O.A1, C.A1],
      )
      expect(checkRefused(up, 'scores_value_check'), JSON.stringify(up)).toBe(true)
    }))

  it('one score per cell: a second row for (option, criterion) is refused', () =>
    actAs(SUPERUSER, async (s) => {
      expect(dupRefused(await score(s, O.A1, C.A1, 2), 'scores_pkey')).toBe(true)
    }))

  it('revision must be >= 1', () =>
    actAs(SUPERUSER, async (s) => {
      expect(checkRefused(await decision(s, { revision: 0 }), 'decisions_revision_check')).toBe(
        true,
      )
      expect(checkRefused(await decision(s, { revision: -1 }), 'decisions_revision_check')).toBe(
        true,
      )
      expect(await decision(s, { revision: 1 })).toEqual(OK)
    }))

  it('frozen requires approved_at', () =>
    actAs(SUPERUSER, async (s) => {
      expect(
        checkRefused(
          await decision(s, { frozen: true, status: 'draft' }),
          'decisions_frozen_needs_approval',
        ),
      ).toBe(true)
      expect(
        await decision(s, {
          frozen: true,
          status: 'approved',
          approved_at: '2026-09-28T12:00:00Z',
        }),
      ).toEqual(OK)
      // Unsetting approved_at on the frozen fixture decision is refused too.
      const o = await s.attempt(`update themis.decisions set approved_at = null where id = $1`, [
        D.AF,
      ])
      expect(!o.ok && o.error, JSON.stringify(o)).toMatch(/violates check constraint/)
    }))

  it('status approved requires approved_at', () =>
    actAs(SUPERUSER, async (s) => {
      expect(
        checkRefused(await decision(s, { status: 'approved' }), 'decisions_approved_needs_time'),
      ).toBe(true)
      expect(
        await decision(s, { status: 'approved', approved_at: '2026-09-28T12:00:00Z' }),
      ).toEqual(OK)
    }))

  it('status is one of draft|in_review|approved|rejected|archived', () =>
    actAs(SUPERUSER, async (s) => {
      for (const bad of ['done', 'Draft', 'frozen', ''])
        expect(checkRefused(await decision(s, { status: bad })), bad).toBe(true)
      for (const ok of ['draft', 'in_review', 'rejected', 'archived'])
        expect(await decision(s, { status: ok }), ok).toEqual(OK)
    }))

  it('methodology and scale reject values outside decision.ts', () =>
    actAs(SUPERUSER, async (s) => {
      expect(checkRefused(await decision(s, { methodology: 'scrum' }))).toBe(true)
      expect(checkRefused(await decision(s, { scale: 'huge' }))).toBe(true)
    }))

  it('(lineage_id, revision) is unique across ALL workspaces; the next revision is free', () =>
    actAs(SUPERUSER, async (s) => {
      expect(
        dupRefused(
          await decision(s, { lineage_id: LINEAGE_A, revision: 1 }),
          'decisions_lineage_id_revision_key',
        ),
      ).toBe(true)
      expect(
        dupRefused(
          await decision(s, { workspace_id: WB, lineage_id: LINEAGE_A, revision: 1 }),
          'decisions_lineage_id_revision_key',
        ),
      ).toBe(true)
      expect(await decision(s, { lineage_id: LINEAGE_A, revision: 2 })).toEqual(OK)
    }))

  it('text limits: question <= 1000, option/criterion name <= 200, position >= 0', () =>
    actAs(SUPERUSER, async (s) => {
      expect(await decision(s, { question: 'q'.repeat(1000) })).toEqual(OK)
      expect(checkRefused(await decision(s, { question: 'q'.repeat(1001) }))).toBe(true)
      for (const t of ['options', 'criteria']) {
        const ins = (name: string, position = 0) =>
          s.attempt(
            `insert into themis.${t} (workspace_id, decision_id, name, position) values ($1, $2, $3, $4)`,
            [WA, D.A, name, position],
          )
        expect(await ins('n'.repeat(200)), t).toEqual(OK)
        expect(checkRefused(await ins('n'.repeat(201))), t).toBe(true)
        expect(checkRefused(await ins('n', -1)), t).toBe(true)
      }
    }))
})

describe('decision core (P1.5): defaults and updated_at', () => {
  it('created_by defaults to the caller on all four tables; a new decision starts as a clean draft', () =>
    actAs(U.editorA, async (s) => {
      const [d] = await s.rows<Row>(
        `insert into themis.decisions (workspace_id, methodology, scale) values ($1, 'agile', 'mid')
         returning id, created_by, revision, status, frozen, approved_by, approved_at, question,
                   lineage_id`,
        [WA],
      )
      expect(d).toMatchObject({
        created_by: U.editorA,
        revision: 1,
        status: 'draft',
        frozen: false,
        approved_by: null,
        approved_at: null,
        question: '',
      })
      expect(d.lineage_id).not.toBe(LINEAGE_A)
      const [o] = await s.rows<Row>(
        `insert into themis.options (workspace_id, decision_id) values ($1, $2) returning id, created_by`,
        [WA, d.id],
      )
      const [c] = await s.rows<Row>(
        `insert into themis.criteria (workspace_id, decision_id) values ($1, $2)
         returning id, created_by, weight`,
        [WA, d.id],
      )
      const [sc] = await s.rows<Row>(
        `insert into themis.scores (workspace_id, decision_id, option_id, criterion_id, value)
         values ($1, $2, $3, $4, 3) returning created_by`,
        [WA, d.id, o.id, c.id],
      )
      expect([o.created_by, c.created_by, sc.created_by]).toEqual([U.editorA, U.editorA, U.editorA])
      expect(c.weight).toBe(3)
    }))

  it.each([
    ['decisions', `question = 'x'`, `id = '${D.A}'`],
    ['options', `name = 'x'`, `id = '${O.A1}'`],
    ['criteria', `weight = 1`, `id = '${C.A1}'`],
    ['scores', `value = 1`, `option_id = '${O.A1}' and criterion_id = '${C.A1}'`],
  ])('an UPDATE on themis.%s bumps updated_at', (t, set, where) =>
    actAs(SUPERUSER, async (s) => {
      expect(await s.count(t, `${where} and updated_at = '${OLD}'`)).toBe(1)
      await s.rows(`update themis.${t} set ${set} where ${where}`)
      expect(
        await s.count(t, `${where} and updated_at > '${OLD}'::timestamptz + interval '1 day'`),
      ).toBe(1)
    }),
  )
})

describe('decision core (P1.5): cascades', () => {
  it('deleting a draft decision cascades its options, criteria and scores only', () =>
    actAs(U.editorA, async (s) => {
      expect(await s.attempt(`delete from themis.decisions where id = $1`, [D.A])).toEqual({
        ok: true,
        affected: 1,
      })
      await s.sudo(async () => {
        for (const t of ['options', 'criteria', 'scores'])
          expect(await s.count(t, `decision_id = '${D.A}'`), t).toBe(0)
        for (const t of ['options', 'criteria', 'scores']) {
          expect(await s.count(t, `decision_id = '${D.AF}'`), t).toBe(1)
          expect(await s.count(t, `decision_id = '${D.B}'`), t).toBe(1)
        }
      })
    }))

  it("deleting an option or a criterion removes that row's scores only", () =>
    actAs(U.editorA, async (s) => {
      await s.rows(`delete from themis.options where id = $1`, [O.A1])
      await s.sudo(async () => {
        expect(await s.count('scores', `option_id = '${O.A1}'`)).toBe(0)
        expect(await s.count('scores', `option_id = '${O.A2}'`)).toBe(1)
      })
      await s.rows(`delete from themis.criteria where id = $1`, [C.A1])
      await s.sudo(async () => {
        expect(await s.count('scores', `decision_id = '${D.A}'`)).toBe(0)
        expect(await s.count('scores', `decision_id = '${D.AF}'`)).toBe(1)
      })
    }))

  it("the owner deleting workspace A removes all of A's decision core, frozen included; B intact", () =>
    actAs(U.ownerA, async (s) => {
      expect(await s.attempt(`delete from themis.workspaces where id = $1`, [WA])).toEqual({
        ok: true,
        affected: 1,
      })
      await s.sudo(async () => {
        for (const t of DECISION_TABLES) {
          expect(await s.count(t, `workspace_id = '${WA}'`), t).toBe(0)
          expect(await s.count(t, `workspace_id = '${WB}'`), t).toBe(1)
        }
      })
    }))

  it('deleting an auth user nulls created_by and approved_by, keeping the decisions', () =>
    actAs(SUPERUSER, async (s) => {
      await s.rows(`delete from auth.users where id = $1`, [U.ownerA])
      expect(
        await s.count('decisions', `id = '${D.AF}' and created_by is null and approved_by is null`),
      ).toBe(1)
      expect(await s.count('decisions', `workspace_id = '${WA}'`)).toBe(2)
    }))
})
