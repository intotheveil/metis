// @vitest-environment node
//
// P1.4 — tenancy contract: themis.profiles, workspaces, memberships, invites.
// P1.5 — decision core: decisions, options, criteria, scores (isolation matrix, cross-tenant child
//        inserts through the composite FKs, role gating, lifecycle columns, constraints, grants)
//        and the enum match with src/lib/decision.ts.
// P1.6 — analysis and collaboration: swot_items, risks, comments, approvals (isolation matrix,
//        composite decision/option FKs, comment-author rule, append-only approvals, constraints,
//        column grants, defaults, cascades).
// P1.7 — AI, billing, audit and plans: ai_runs, subscriptions, usage_monthly, audit_log (isolation
//        matrix, server-side-only writes, append-only audit, service_role scope) and plans (anon
//        read, proposal seed, idempotent re-apply, one quota basis).
// Audit actor erasure (20260928235500): the actor FK's ON DELETE SET NULL passes the append-only
//        trigger; every other UPDATE of audit_log is still refused.
// The P1.4 exact-set assertions (FKs, policies, column grants) are scoped to the P1.4 TABLES, so
// a later migration's tables extend the schema without rewriting P1.4's contract.
//
// Runs the REAL committed archive (supabase/migrations, applied twice like `npm run db:gate`)
// against real Postgres (PGlite) dressed as Hephaestus's shared project by ./db-gate/shim.mjs.
// No SQL from the migrations is restated here: every assertion is about the database the archive
// produces. One PGlite instance per file; every `actAs` session is a transaction that is ROLLED
// BACK, so the fixture is identical for every test and the tests are order-independent.
//
// Extending this file: add a new table's entry (and fixture rows) to LEAK_MATRIX/seedFixture in
// scripts/db-gate/leak-matrix.mjs; TENANT_TABLES below is derived from it, so the cross-workspace
// isolation block here AND the gate's leak matrix (npm run db:gate, P1.8) both cover it. Use
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
import {
  ANON,
  AP,
  AR,
  AU,
  C,
  CM,
  D,
  LEAK_MATRIX,
  LINEAGE_A,
  MONTH,
  O,
  OLD,
  RK,
  SERVICE,
  SUB,
  SUPERUSER,
  SW,
  U,
  WA,
  WB,
  checkValues,
  createHarness,
  foreignSnapshot,
  noEffect,
  refused,
  seedFixture,
  snapshot,
} from './db-gate/leak-matrix.mjs'
import type { Outcome, Row, Session } from './db-gate/leak-matrix.mjs'
import { METHODOLOGIES, SCALES } from '../src/lib/decision'

const MIG =
  process.env.DB_GATE_MIGRATIONS ??
  fileURLToPath(new URL('../supabase/migrations', import.meta.url))

// --- fixture, harness and leak matrix: SHARED with `npm run db:gate` (P1.8) ----------------------
// scripts/db-gate/leak-matrix.mjs holds the fixture identities and rows (`seedFixture`, with the
// comments that explain each row), the `actAs` harness and LEAK_MATRIX. One copy, so the gate and
// this suite cannot disagree about what "workspace A's rows" are.

const TABLES = ['profiles', 'workspaces', 'memberships', 'invites'] as const
type Table = (typeof TABLES)[number]
const DECISION_TABLES = ['decisions', 'options', 'criteria', 'scores'] as const
const ANALYSIS_TABLES = ['swot_items', 'risks', 'comments', 'approvals'] as const
type AnalysisTable = (typeof ANALYSIS_TABLES)[number]
/** The P1.7 tenant tables (plans is reference data, not tenant data). */
const BILLING_TABLES = ['ai_runs', 'subscriptions', 'usage_monthly', 'audit_log'] as const
const P17_TABLES = ['plans', ...BILLING_TABLES] as const

/**
 * The isolation matrix: the tenant entries of the shared LEAK_MATRIX. `ofA` selects workspace A's
 * rows (rows UB must never see or change); `probe` is a SET clause an attacker would try. A new
 * tenant table gets its entry in leak-matrix.mjs, and both this block and the gate cover it.
 */
const TENANT_TABLES = LEAK_MATRIX.flatMap((e) =>
  e.kind === 'tenant' ? [{ table: e.table, ofA: e.ofA, probe: e.probe }] : [],
)

// --- harness -----------------------------------------------------------------------------------
const db = new PGlite()
const { actAs } = createHarness(db)

let foreignBefore: Awaited<ReturnType<typeof foreignSnapshot>>
let foreignAfter: Awaited<ReturnType<typeof foreignSnapshot>>

beforeAll(async () => {
  await installShim(db)
  foreignBefore = await foreignSnapshot(db)

  const files = readdirSync(MIG)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  // Twice, exactly as the gate does: the state under test is the RE-APPLIED archive.
  for (let pass = 0; pass < 2; pass++)
    for (const f of files) await db.exec(readFileSync(path.join(MIG, f), 'utf8'))
  foreignAfter = await foreignSnapshot(db)

  // Fixture, committed as superuser. Every test's writes are rolled back by actAs.
  await seedFixture(db)
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
    // profiles is user-scoped, and plans (P1.7) is non-tenant reference data readable by all.
    const NOT_WORKSPACE_SCOPED = ['profiles.', 'plans.']
    for (const x of r.rows.filter((x) => !NOT_WORKSPACE_SCOPED.some((p) => x.name.startsWith(p))))
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
      for (const t of ANALYSIS_TABLES) expect(await s.count(t, `workspace_id = '${WB}'`), t).toBe(1)
      for (const t of BILLING_TABLES) expect(await s.count(t, `workspace_id = '${WB}'`), t).toBe(1)
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
  // The allowed values of the single-column CHECK (col in (...)) on themis.decisions, read back
  // from the catalog (checkValues, shared with the gate), so a value added on only one side (TS or
  // SQL) turns this RED. checkValues is null unless exactly one such CHECK exists.
  it.each([
    ['methodology', Object.keys(METHODOLOGIES)],
    ['scale', Object.keys(SCALES)],
  ])('decisions.%s allows exactly the decision.ts values', async (col, ts) => {
    expect(await checkValues(db, 'decisions', col)).toEqual([...ts].sort())
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

// =================================================================================================
// P1.6 analysis and collaboration — structure
// =================================================================================================

const notNullRefused = (o: Outcome, column: string) =>
  !o.ok && o.error.includes('null value in column') && o.error.includes(column)

/** Content hash of every analysis row of workspace `ws` (read as superuser). */
const analysisSnapshot = async (s: Session, ws: string) => {
  const out: Record<string, unknown> = {}
  for (const t of ANALYSIS_TABLES) out[t] = await snapshot(s, t, `workspace_id = '${ws}'`)
  return out
}

/** Every FK on the given themis tables as `t(cols)->ref(cols) ondelete`, sorted. */
const fkList = async (tables: readonly string[]) => {
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
    [tables.map((t) => `themis.${t}`)],
  )
  return r.rows.map((x) => x.fk).sort()
}

describe('analysis (P1.6): table shapes and keys', () => {
  it.each([
    [
      'swot_items',
      [
        'id:uuid!',
        'workspace_id:uuid!',
        'decision_id:uuid!',
        'option_id:uuid',
        'quadrant:text!',
        'text:text!',
        'position:smallint!',
        'created_by:uuid',
        `created_at:${TSZ_}!`,
        `updated_at:${TSZ_}!`,
      ],
    ],
    [
      'risks',
      [
        'id:uuid!',
        'workspace_id:uuid!',
        'decision_id:uuid!',
        'option_id:uuid!',
        'title:text!',
        'likelihood:smallint!',
        'impact:smallint!',
        'owner:text!',
        'mitigation:text!',
        'position:smallint!',
        'created_by:uuid',
        `created_at:${TSZ_}!`,
        `updated_at:${TSZ_}!`,
      ],
    ],
    [
      'comments',
      [
        'id:uuid!',
        'workspace_id:uuid!',
        'decision_id:uuid!',
        'body:text!',
        'author:uuid',
        'created_by:uuid',
        `created_at:${TSZ_}!`,
        `updated_at:${TSZ_}!`,
      ],
    ],
    [
      'approvals',
      [
        'id:uuid!',
        'workspace_id:uuid!',
        'decision_id:uuid!',
        'verdict:text!',
        'reason:text!',
        'actor:uuid',
        'created_by:uuid',
        `created_at:${TSZ_}!`,
        `updated_at:${TSZ_}!`,
      ],
    ],
  ] as const)('themis.%s has the planned columns, types and NOT NULLs', async (t, want) => {
    expect(await columnsOf(t)).toEqual(want)
  })

  it('risk exposure is never stored: no exposure/score column and no generated column in P1.6', async () => {
    const r = await db.query<{ c: string }>(
      `select c.relname || '.' || a.attname as c
         from pg_attribute a join pg_class c on c.oid = a.attrelid
        where c.relnamespace = 'themis'::regnamespace and c.relname = any ($1::text[])
          and a.attnum > 0 and not a.attisdropped
          and (a.attname ~* '(exposure|score|severity|rating)' or a.attgenerated <> '')`,
      [[...ANALYSIS_TABLES]],
    )
    expect(r.rows.map((x) => x.c)).toEqual([])
  })

  it('each table is keyed by id alone, with no other unique key', async () => {
    const r = await db.query<{ k: string }>(
      `select c.conrelid::regclass::text || ' ' || c.contype::text || ' (' ||
              (select string_agg(a.attname, ',' order by k.ord)
                 from unnest(c.conkey) with ordinality k(n, ord)
                 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n) || ')' as k
         from pg_constraint c
        where c.contype in ('p', 'u') and c.conrelid::regclass::text = any ($1::text[])`,
      [ANALYSIS_TABLES.map((t) => `themis.${t}`)],
    )
    expect(r.rows.map((x) => x.k).sort()).toEqual(
      ANALYSIS_TABLES.map((t) => `themis.${t} p (id)`).sort(),
    )
  })

  it('foreign keys: composite (decision_id, workspace_id) and (option_id, decision_id), exactly', async () => {
    // c = cascade, n = set null. No row reaches workspaces or options by a single column.
    expect(await fkList(ANALYSIS_TABLES)).toEqual(
      [
        'themis.swot_items(decision_id,workspace_id)->themis.decisions(id,workspace_id) c',
        'themis.swot_items(option_id,decision_id)->themis.options(id,decision_id) c',
        'themis.swot_items(created_by)->auth.users(id) n',
        'themis.risks(decision_id,workspace_id)->themis.decisions(id,workspace_id) c',
        'themis.risks(option_id,decision_id)->themis.options(id,decision_id) c',
        'themis.risks(created_by)->auth.users(id) n',
        'themis.comments(decision_id,workspace_id)->themis.decisions(id,workspace_id) c',
        'themis.comments(author)->auth.users(id) n',
        'themis.comments(created_by)->auth.users(id) n',
        'themis.approvals(decision_id,workspace_id)->themis.decisions(id,workspace_id) c',
        'themis.approvals(actor)->auth.users(id) n',
        'themis.approvals(created_by)->auth.users(id) n',
      ].sort(),
    )
  })

  it.each(ANALYSIS_TABLES)('themis.%s has exactly one touch_updated_at trigger', async (t) => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_trigger t join pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = $1::regclass and not t.tgisinternal and p.proname = 'touch_updated_at'`,
      [`themis.${t}`],
    )
    expect(r.rows[0].n).toBe(1)
  })
})

describe('analysis (P1.6): RLS, policies and grants', () => {
  it.each(ANALYSIS_TABLES)('RLS is enabled on themis.%s', async (t) => {
    const r = await db.query<{ on: boolean }>(
      `select relrowsecurity as on from pg_class where oid = $1::regclass`,
      [`themis.${t}`],
    )
    expect(r.rows[0].on).toBe(true)
  })

  it('the policy set is exactly 14, all TO authenticated; approvals have select/insert ONLY', async () => {
    const r = await db.query<{ p: string }>(
      `select c.relname || '.' || p.polname || ' ' || p.polcmd::text || ' ' || p.polroles::regrole[]::text as p
         from pg_policy p join pg_class c on c.oid = p.polrelid
        where c.relnamespace = 'themis'::regnamespace and c.relname = any ($1::text[])`,
      [[...ANALYSIS_TABLES]],
    )
    const verbs: [string, string][] = [
      ['select', 'r'],
      ['insert', 'a'],
      ['update', 'w'],
      ['delete', 'd'],
    ]
    const want = [
      ...(['swot_items', 'risks', 'comments'] as const).flatMap((t) =>
        verbs.map(([verb, cmd]) => `${t}.${t}_${verb} ${cmd} {authenticated}`),
      ),
      'approvals.approvals_select r {authenticated}',
      'approvals.approvals_insert a {authenticated}',
    ]
    expect(want).toHaveLength(14)
    expect(r.rows.map((x) => x.p).sort()).toEqual(want.sort())
  })

  it.each(ANALYSIS_TABLES)('anon holds no privilege (table or column) on themis.%s', async (t) => {
    expect(await privsOf('anon', t)).toEqual([])
  })

  it.each(ANALYSIS_TABLES)(
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

  it('authenticated: approvals are SELECT+INSERT only; the rest SELECT/INSERT/UPDATE/DELETE', async () => {
    for (const t of ['swot_items', 'risks', 'comments'])
      expect(await privsOf('authenticated', t), t).toEqual(['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
    expect(await privsOf('authenticated', 'approvals')).toEqual(['SELECT', 'INSERT'])
    for (const t of ANALYSIS_TABLES) {
      const [w] = (
        await db.query<{ ins: boolean; upd: boolean }>(
          `select has_table_privilege('authenticated', $1, 'INSERT') as ins,
                  has_table_privilege('authenticated', $1, 'UPDATE') as upd`,
          [`themis.${t}`],
        )
      ).rows
      expect(w, t).toEqual({ ins: false, upd: false })
    }
  })

  it('authenticated INSERT/UPDATE column grants are exactly the planned set', async () => {
    const cols = await db.query<{ c: string }>(
      `select table_name || '.' || column_name || ' ' || privilege_type as c
         from information_schema.column_privileges
        where table_schema = 'themis' and grantee = 'authenticated'
          and privilege_type in ('INSERT', 'UPDATE') and table_name = any ($1::text[])`,
      [[...ANALYSIS_TABLES]],
    )
    const ins = (t: string, cs: string[]) => cs.map((c) => `${t}.${c} INSERT`)
    const upd = (t: string, cs: string[]) => cs.map((c) => `${t}.${c} UPDATE`)
    // Never client-writable: id, created_by, author, actor, created_at, updated_at.
    // Never client-updatable: workspace_id, decision_id, option_id.
    expect(cols.rows.map((r) => r.c).sort()).toEqual(
      [
        ...ins('swot_items', [
          'workspace_id',
          'decision_id',
          'option_id',
          'quadrant',
          'text',
          'position',
        ]),
        ...upd('swot_items', ['quadrant', 'text', 'position']),
        ...ins('risks', [
          'workspace_id',
          'decision_id',
          'option_id',
          'title',
          'likelihood',
          'impact',
          'owner',
          'mitigation',
          'position',
        ]),
        ...upd('risks', ['title', 'likelihood', 'impact', 'owner', 'mitigation', 'position']),
        ...ins('comments', ['workspace_id', 'decision_id', 'body']),
        ...upd('comments', ['body']),
        ...ins('approvals', ['workspace_id', 'decision_id', 'verdict', 'reason']),
      ].sort(),
    )
  })

  it('service_role has full DML on the four analysis tables', async () => {
    for (const t of ANALYSIS_TABLES)
      expect(await privsOf('service_role', t), t).toEqual(
        expect.arrayContaining(['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
      )
  })
})

// =================================================================================================
// P1.6 analysis and collaboration — behaviour
// =================================================================================================

describe('analysis (P1.6): visibility', () => {
  it.each(ANALYSIS_TABLES)('anon cannot read themis.%s', (t) =>
    actAs(ANON, async (s) => {
      expect(refused(await s.attempt(`select * from themis.${t}`))).toBe(true)
    }),
  )

  it('anon cannot post a comment or record an approval', () =>
    actAs(ANON, async (s) => {
      for (const sql of [
        `insert into themis.comments (workspace_id, decision_id, body) values ('${WA}', '${D.A}', 'x')`,
        `insert into themis.approvals (workspace_id, decision_id, verdict, reason)
           values ('${WA}', '${D.A}', 'approved', 'x')`,
      ]) {
        const o = await s.attempt(sql)
        expect(refused(o), `${sql} -> ${JSON.stringify(o)}`).toBe(true)
      }
    }))

  it('a viewer of A reads all four tables of A and nothing of B', () =>
    actAs(U.viewerA, async (s) => {
      expect(await s.count('swot_items')).toBe(2)
      expect(await s.count('risks')).toBe(2)
      expect(await s.count('comments')).toBe(1)
      expect(await s.count('approvals')).toBe(2)
      for (const t of ANALYSIS_TABLES) expect(await s.count(t, `workspace_id = '${WB}'`), t).toBe(0)
    }))

  it('a user with no workspace sees no analysis rows', () =>
    actAs(U.loner, async (s) => {
      for (const t of ANALYSIS_TABLES) expect(await s.count(t), t).toBe(0)
    }))
})

/**
 * An insert into `t` with the given (workspace_id, decision_id, option_id); comments and approvals
 * have no option. Every other column is valid, so only RLS or a foreign key can refuse it.
 */
const analysisInsert = (
  s: Session,
  t: AnalysisTable,
  ws: string,
  decision: string,
  option: string,
) => {
  switch (t) {
    case 'swot_items':
      return s.attempt(
        `insert into themis.swot_items (workspace_id, decision_id, option_id, quadrant, text)
         values ($1, $2, $3, 't', 'x')`,
        [ws, decision, option],
      )
    case 'risks':
      return s.attempt(
        `insert into themis.risks (workspace_id, decision_id, option_id, title, likelihood, impact)
         values ($1, $2, $3, 'x', 3, 3)`,
        [ws, decision, option],
      )
    case 'comments':
      return s.attempt(
        `insert into themis.comments (workspace_id, decision_id, body) values ($1, $2, 'x')`,
        [ws, decision],
      )
    case 'approvals':
      return s.attempt(
        `insert into themis.approvals (workspace_id, decision_id, verdict, reason)
         values ($1, $2, 'approved', 'x')`,
        [ws, decision],
      )
  }
}

describe('analysis (P1.6): cross-tenant writes by the owner of B', () => {
  // (OA1, DA) is a VALID option/decision pair, so for a ws=B row only the composite decision FK
  // stands between B and A's decision.
  it.each(ANALYSIS_TABLES)(
    "a %s row claiming workspace B but pointing at A's decision is refused by the composite FK",
    (t) =>
      actAs(U.ownerB, async (s) => {
        const before = await analysisSnapshot(s, WA)
        const o = await analysisInsert(s, t, WB, D.A, O.A1)
        expect(fkRefused(o, `${t}_decision_fkey`), JSON.stringify(o)).toBe(true)
        expect(await analysisSnapshot(s, WA)).toEqual(before)
      }),
  )

  it.each(ANALYSIS_TABLES)('a %s row claiming workspace A is refused by RLS', (t) =>
    actAs(U.ownerB, async (s) => {
      const before = await analysisSnapshot(s, WA)
      const o = await analysisInsert(s, t, WA, D.A, O.A1)
      expect(!o.ok && o.error, JSON.stringify(o)).toMatch(/violates row-level security/)
      expect(await analysisSnapshot(s, WA)).toEqual(before)
    }),
  )

  it.each(ANALYSIS_TABLES)('positive control: B writes a %s row on its own decision', (t) =>
    actAs(U.ownerB, async (s) => {
      expect(await analysisInsert(s, t, WB, D.B, O.B1)).toEqual({ ok: true, affected: 1 })
    }),
  )

  it.each([['swot_items'], ['risks']] as const)(
    "a %s row on B's OWN decision naming A's option is refused by the option FK",
    (t) =>
      actAs(U.ownerB, async (s) => {
        const before = await analysisSnapshot(s, WA)
        const o = await analysisInsert(s, t, WB, D.B, O.A1)
        expect(fkRefused(o, `${t}_option_fkey`), JSON.stringify(o)).toBe(true)
        expect(await analysisSnapshot(s, WA)).toEqual(before)
      }),
  )

  it('B cannot re-point its own rows at A (tenancy and option keys are not updatable)', () =>
    actAs(U.ownerB, async (s) => {
      for (const sql of [
        `update themis.swot_items set decision_id = '${D.A}' where id = '${SW.B1}'`,
        `update themis.swot_items set workspace_id = '${WA}' where id = '${SW.B1}'`,
        `update themis.swot_items set option_id = '${O.A1}' where id = '${SW.B1}'`,
        `update themis.risks set decision_id = '${D.A}' where id = '${RK.B1}'`,
        `update themis.risks set workspace_id = '${WA}' where id = '${RK.B1}'`,
        `update themis.risks set option_id = '${O.A1}' where id = '${RK.B1}'`,
        `update themis.comments set decision_id = '${D.A}' where id = '${CM.B}'`,
        `update themis.comments set workspace_id = '${WA}' where id = '${CM.B}'`,
        `update themis.approvals set decision_id = '${D.A}' where id = '${AP.B}'`,
        `update themis.approvals set workspace_id = '${WA}' where id = '${AP.B}'`,
      ]) {
        const o = await s.attempt(sql)
        expect(refused(o), `${sql} -> ${JSON.stringify(o)}`).toBe(true)
      }
    }))
})

describe('analysis (P1.6): an item cannot name an option of another decision', () => {
  const swot = (s: Session, decision: string, option: string | null) =>
    s.attempt(
      `insert into themis.swot_items (workspace_id, decision_id, option_id, quadrant, text)
       values ($1, $2, $3, 's', 'x')`,
      [WA, decision, option],
    )
  const risk = (s: Session, decision: string, option: string) =>
    s.attempt(
      `insert into themis.risks (workspace_id, decision_id, option_id, title, likelihood, impact)
       values ($1, $2, $3, 'x', 1, 1)`,
      [WA, decision, option],
    )

  it('positive control: an editor adds option-level and decision-level SWOT and a risk on DA', () =>
    actAs(U.editorA, async (s) => {
      expect(await swot(s, D.A, O.A2)).toEqual({ ok: true, affected: 1 })
      expect(await swot(s, D.A, null)).toEqual({ ok: true, affected: 1 })
      expect(await risk(s, D.A, O.A2)).toEqual({ ok: true, affected: 1 })
    }))

  it("a SWOT item on DA naming DAF's option is refused by swot_items_option_fkey", () =>
    actAs(U.editorA, async (s) => {
      const o = await swot(s, D.A, O.F1)
      expect(fkRefused(o, 'swot_items_option_fkey'), JSON.stringify(o)).toBe(true)
    }))

  it("a risk on DA naming DAF's option is refused by risks_option_fkey", () =>
    actAs(U.editorA, async (s) => {
      const o = await risk(s, D.A, O.F1)
      expect(fkRefused(o, 'risks_option_fkey'), JSON.stringify(o)).toBe(true)
    }))
})

describe('analysis (P1.6): role gating inside workspace A', () => {
  it('viewer cannot write SWOT, risks or approvals: inserts refused, updates/deletes touch 0 rows', () =>
    actAs(U.viewerA, async (s) => {
      const before = await analysisSnapshot(s, WA)
      for (const sql of [
        `insert into themis.swot_items (workspace_id, decision_id, quadrant, text) values ('${WA}', '${D.A}', 's', 'v')`,
        `insert into themis.risks (workspace_id, decision_id, option_id, title, likelihood, impact)
           values ('${WA}', '${D.A}', '${O.A1}', 'v', 1, 1)`,
        `insert into themis.approvals (workspace_id, decision_id, verdict, reason)
           values ('${WA}', '${D.A}', 'approved', 'v')`,
      ]) {
        const o = await s.attempt(sql)
        expect(refused(o), `${sql} -> ${JSON.stringify(o)}`).toBe(true)
      }
      for (const sql of [
        `update themis.swot_items set text = 'v' where id = '${SW.A1}'`,
        `update themis.risks set likelihood = 1 where id = '${RK.A1}'`,
        `delete from themis.swot_items where workspace_id = '${WA}'`,
        `delete from themis.risks where workspace_id = '${WA}'`,
      ])
        expect(await s.attempt(sql), sql).toEqual({ ok: true, affected: 0 })
      expect(await analysisSnapshot(s, WA)).toEqual(before)
    }))

  it('viewer CAN post a comment, recorded in their own name, and edit/delete it', () =>
    actAs(U.viewerA, async (s) => {
      const [c] = await s.rows<Row>(
        `insert into themis.comments (workspace_id, decision_id, body)
         values ($1, $2, 'Viewer thought') returning id, author, created_by`,
        [WA, D.A],
      )
      expect(c).toMatchObject({ author: U.viewerA, created_by: U.viewerA })
      expect(
        await s.attempt(`update themis.comments set body = 'Edited' where id = $1`, [c.id]),
      ).toEqual({ ok: true, affected: 1 })
      expect(await s.attempt(`delete from themis.comments where id = $1`, [c.id])).toEqual({
        ok: true,
        affected: 1,
      })
    }))

  it.each([
    ['editor', U.editorA],
    ['admin', U.adminA],
    ['owner', U.ownerA],
  ])('%s writes, edits and deletes SWOT items and risks', (_r, uid) =>
    actAs(uid, async (s) => {
      const [sw] = await s.rows<{ id: string }>(
        `insert into themis.swot_items (workspace_id, decision_id, option_id, quadrant, text, position)
         values ($1, $2, $3, 'o', 'Opp', 1) returning id`,
        [WA, D.A, O.A2],
      )
      const [rk] = await s.rows<{ id: string }>(
        `insert into themis.risks (workspace_id, decision_id, option_id, title, likelihood, impact,
                                   owner, mitigation, position)
         values ($1, $2, $3, 'Risk', 5, 5, 'Vendor', 'Contract', 1) returning id`,
        [WA, D.A, O.A2],
      )
      for (const sql of [
        `update themis.swot_items set quadrant = 't', text = 'Threat', position = 2 where id = '${sw.id}'`,
        `update themis.risks set title = 'R', likelihood = 1, impact = 2, owner = 'o', mitigation = 'm',
           position = 3 where id = '${rk.id}'`,
        `update themis.swot_items set text = 'fixture edit' where id = '${SW.A1}'`,
        `delete from themis.swot_items where id = '${sw.id}'`,
        `delete from themis.risks where id = '${rk.id}'`,
        `delete from themis.risks where id = '${RK.A2}'`,
      ])
        expect(await s.attempt(sql), sql).toEqual({ ok: true, affected: 1 })
    }),
  )

  it.each([
    ['owner', U.ownerA],
    ['admin', U.adminA],
    ['viewer', U.viewerA],
  ])("%s cannot edit or delete the editor's comment (0 rows)", (_r, uid) =>
    actAs(uid, async (s) => {
      const before = await snapshot(s, 'comments', `id = '${CM.A}'`)
      expect(
        await s.attempt(`update themis.comments set body = 'Tampered' where id = $1`, [CM.A]),
      ).toEqual({ ok: true, affected: 0 })
      expect(await s.attempt(`delete from themis.comments where id = $1`, [CM.A])).toEqual({
        ok: true,
        affected: 0,
      })
      expect(await snapshot(s, 'comments', `id = '${CM.A}'`)).toEqual(before)
    }),
  )

  it('the author edits and deletes their own comment', () =>
    actAs(U.editorA, async (s) => {
      expect(
        await s.attempt(`update themis.comments set body = 'Revised' where id = $1`, [CM.A]),
      ).toEqual({ ok: true, affected: 1 })
      expect(await s.count('comments', `id = '${CM.A}' and body = 'Revised'`)).toBe(1)
      expect(await s.attempt(`delete from themis.comments where id = $1`, [CM.A])).toEqual({
        ok: true,
        affected: 1,
      })
    }))

  it('an author removed from the workspace can no longer edit or delete their comment', () =>
    actAs(U.editorA, async (s) => {
      await s.sudo(() =>
        s.rows(`delete from themis.memberships where workspace_id = $1 and user_id = $2`, [
          WA,
          U.editorA,
        ]),
      )
      expect(
        await s.attempt(`update themis.comments set body = 'Late edit' where id = $1`, [CM.A]),
      ).toEqual({ ok: true, affected: 0 })
      expect(await s.attempt(`delete from themis.comments where id = $1`, [CM.A])).toEqual({
        ok: true,
        affected: 0,
      })
      await s.sudo(async () =>
        expect(await s.count('comments', `id = '${CM.A}' and body = 'Editor comment'`)).toBe(1),
      )
    }))

  it("nobody writes a row in someone else's name or rewrites identity/option columns", () =>
    actAs(U.ownerA, async (s) => {
      for (const sql of [
        `insert into themis.comments (workspace_id, decision_id, body, author)
           values ('${WA}', '${D.A}', 'x', '${U.viewerA}')`,
        `insert into themis.comments (workspace_id, decision_id, body, created_by)
           values ('${WA}', '${D.A}', 'x', '${U.viewerA}')`,
        `insert into themis.approvals (workspace_id, decision_id, verdict, reason, actor)
           values ('${WA}', '${D.A}', 'approved', 'x', '${U.adminA}')`,
        `insert into themis.approvals (workspace_id, decision_id, verdict, reason, created_by)
           values ('${WA}', '${D.A}', 'approved', 'x', '${U.adminA}')`,
        `insert into themis.swot_items (workspace_id, decision_id, quadrant, created_by)
           values ('${WA}', '${D.A}', 's', '${U.viewerA}')`,
        `insert into themis.risks (workspace_id, decision_id, option_id, likelihood, impact, created_by)
           values ('${WA}', '${D.A}', '${O.A1}', 1, 1, '${U.viewerA}')`,
        `insert into themis.swot_items (id, workspace_id, decision_id, quadrant)
           values (gen_random_uuid(), '${WA}', '${D.A}', 's')`,
        `update themis.comments set author = '${U.ownerA}' where id = '${CM.A}'`,
        `update themis.comments set created_by = '${U.ownerA}' where id = '${CM.A}'`,
        `update themis.swot_items set created_by = '${U.ownerB}' where id = '${SW.A1}'`,
        `update themis.risks set created_by = '${U.ownerB}' where id = '${RK.A1}'`,
        `update themis.swot_items set id = gen_random_uuid() where id = '${SW.A1}'`,
        `update themis.risks set option_id = '${O.A2}' where id = '${RK.A1}'`,
        `update themis.swot_items set option_id = null where id = '${SW.A2}'`,
        `update themis.risks set updated_at = now() where id = '${RK.A1}'`,
      ]) {
        const o = await s.attempt(sql)
        expect(refused(o), `${sql} -> ${JSON.stringify(o)}`).toBe(true)
      }
    }))

  it.each([
    ['admin', U.adminA],
    ['owner', U.ownerA],
  ])('%s records an approval, attributed to themselves', (_r, uid) =>
    actAs(uid, async (s) => {
      const [a] = await s.rows<Row>(
        `insert into themis.approvals (workspace_id, decision_id, verdict, reason)
         values ($1, $2, 'approved', 'Meets the bar') returning actor, created_by, verdict`,
        [WA, D.A],
      )
      expect(a).toEqual({ actor: uid, created_by: uid, verdict: 'approved' })
    }),
  )

  it.each([
    ['editor', U.editorA],
    ['viewer', U.viewerA],
  ])('%s cannot record an approval', (_r, uid) =>
    actAs(uid, async (s) => {
      const o = await s.attempt(
        `insert into themis.approvals (workspace_id, decision_id, verdict, reason)
         values ($1, $2, 'approved', 'x')`,
        [WA, D.A],
      )
      expect(!o.ok && o.error, JSON.stringify(o)).toMatch(/violates row-level security/)
      await s.sudo(async () => expect(await s.count('approvals', `workspace_id = '${WA}'`)).toBe(2))
    }),
  )

  it.each([
    ['owner', U.ownerA],
    ['admin', U.adminA],
    ['editor', U.editorA],
    ['viewer', U.viewerA],
  ])('approvals are append-only: %s can neither update nor delete one', (_r, uid) =>
    actAs(uid, async (s) => {
      const before = await snapshot(s, 'approvals', `workspace_id = '${WA}'`)
      for (const sql of [
        `update themis.approvals set verdict = 'approved' where id = '${AP.A}'`,
        `update themis.approvals set reason = 'Rewritten' where id = '${AP.AF}'`,
        `update themis.approvals set actor = '${U.editorA}' where id = '${AP.AF}'`,
        `delete from themis.approvals where id = '${AP.A}'`,
        `delete from themis.approvals where workspace_id = '${WA}'`,
      ]) {
        const o = await s.attempt(sql)
        expect(refused(o), `${sql} -> ${JSON.stringify(o)}`).toBe(true)
      }
      expect(await snapshot(s, 'approvals', `workspace_id = '${WA}'`)).toEqual(before)
    }),
  )
})

describe('analysis (P1.6): check constraints (as superuser, so only the constraint can refuse)', () => {
  const OK = { ok: true, affected: 1 }
  const insert = (s: Session, t: string, all: Record<string, unknown>) => {
    const k = Object.keys(all)
    return s.attempt(
      `insert into themis.${t} (${k.join(', ')}) values (${k.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(all),
    )
  }
  const risk = (s: Session, cols: Record<string, unknown>) =>
    insert(s, 'risks', {
      workspace_id: WA,
      decision_id: D.A,
      option_id: O.A1,
      likelihood: 3,
      impact: 3,
      ...cols,
    })
  const swot = (s: Session, cols: Record<string, unknown>) =>
    insert(s, 'swot_items', { workspace_id: WA, decision_id: D.A, quadrant: 's', ...cols })
  const comment = (s: Session, body: string | null) =>
    insert(s, 'comments', { workspace_id: WA, decision_id: D.A, body })
  const approval = (s: Session, verdict: string, reason: string | null) =>
    insert(s, 'approvals', { workspace_id: WA, decision_id: D.A, verdict, reason })

  it('likelihood and impact are 1..5: 0 and 6 refused, 1 and 5 accepted, update to 6 refused', () =>
    actAs(SUPERUSER, async (s) => {
      for (const col of ['likelihood', 'impact']) {
        expect(checkRefused(await risk(s, { [col]: 0 }), `risks_${col}_check`), col).toBe(true)
        expect(checkRefused(await risk(s, { [col]: 6 }), `risks_${col}_check`), col).toBe(true)
        expect(await risk(s, { [col]: 1 }), col).toEqual(OK)
        expect(await risk(s, { [col]: 5 }), col).toEqual(OK)
        const up = await s.attempt(`update themis.risks set ${col} = 6 where id = $1`, [RK.A1])
        expect(checkRefused(up, `risks_${col}_check`), JSON.stringify(up)).toBe(true)
        expect(notNullRefused(await risk(s, { [col]: null }), col), col).toBe(true)
      }
    }))

  it('a risk requires an option (option_id NOT NULL)', () =>
    actAs(SUPERUSER, async (s) => {
      expect(notNullRefused(await risk(s, { option_id: null }), 'option_id')).toBe(true)
    }))

  it('quadrant is s|w|o|t only; a SWOT item may be decision-level (no option)', () =>
    actAs(SUPERUSER, async (s) => {
      for (const q of ['s', 'w', 'o', 't']) expect(await swot(s, { quadrant: q }), q).toEqual(OK)
      for (const bad of ['x', 'S', 'strength', ''])
        expect(
          checkRefused(await swot(s, { quadrant: bad }), 'swot_items_quadrant_check'),
          bad,
        ).toBe(true)
      expect(notNullRefused(await swot(s, { quadrant: null }), 'quadrant')).toBe(true)
      expect(await swot(s, { option_id: null })).toEqual(OK)
      expect(await swot(s, { option_id: O.A2 })).toEqual(OK)
    }))

  it('verdict is approved|rejected only', () =>
    actAs(SUPERUSER, async (s) => {
      expect(await approval(s, 'approved', 'r')).toEqual(OK)
      expect(await approval(s, 'rejected', 'r')).toEqual(OK)
      for (const bad of ['maybe', 'Approved', 'pending', ''])
        expect(checkRefused(await approval(s, bad, 'r'), 'approvals_verdict_check'), bad).toBe(true)
    }))

  it('an approval reason is required and non-blank (<= 2000)', () =>
    actAs(SUPERUSER, async (s) => {
      expect(notNullRefused(await approval(s, 'approved', null), 'reason')).toBe(true)
      for (const blank of ['', '   '])
        expect(
          checkRefused(await approval(s, 'rejected', blank), 'approvals_reason_check'),
          JSON.stringify(blank),
        ).toBe(true)
      expect(await approval(s, 'approved', 'r'.repeat(2000))).toEqual(OK)
      expect(checkRefused(await approval(s, 'approved', 'r'.repeat(2001)))).toBe(true)
    }))

  it('an empty or blank comment is refused (<= 4000)', () =>
    actAs(SUPERUSER, async (s) => {
      expect(notNullRefused(await comment(s, null), 'body')).toBe(true)
      for (const blank of ['', '   '])
        expect(
          checkRefused(await comment(s, blank), 'comments_body_check'),
          JSON.stringify(blank),
        ).toBe(true)
      expect(await comment(s, 'b'.repeat(4000))).toEqual(OK)
      expect(checkRefused(await comment(s, 'b'.repeat(4001)))).toBe(true)
      const up = await s.attempt(`update themis.comments set body = ' ' where id = $1`, [CM.A])
      expect(checkRefused(up, 'comments_body_check'), JSON.stringify(up)).toBe(true)
    }))

  it('text limits: swot text <= 1000, risk title/owner <= 200, mitigation <= 2000, position >= 0', () =>
    actAs(SUPERUSER, async (s) => {
      expect(await swot(s, { text: 't'.repeat(1000) })).toEqual(OK)
      expect(checkRefused(await swot(s, { text: 't'.repeat(1001) }))).toBe(true)
      expect(checkRefused(await swot(s, { position: -1 }))).toBe(true)
      expect(await risk(s, { title: 't'.repeat(200), owner: 'o'.repeat(200) })).toEqual(OK)
      expect(checkRefused(await risk(s, { title: 't'.repeat(201) }))).toBe(true)
      expect(checkRefused(await risk(s, { owner: 'o'.repeat(201) }))).toBe(true)
      expect(await risk(s, { mitigation: 'm'.repeat(2000) })).toEqual(OK)
      expect(checkRefused(await risk(s, { mitigation: 'm'.repeat(2001) }))).toBe(true)
      expect(checkRefused(await risk(s, { position: -1 }))).toBe(true)
    }))
})

describe('analysis (P1.6): defaults and updated_at', () => {
  it('created_by (and author) default to the caller; text fields default to empty', () =>
    actAs(U.editorA, async (s) => {
      const [sw] = await s.rows<Row>(
        `insert into themis.swot_items (workspace_id, decision_id, quadrant) values ($1, $2, 'w')
         returning created_by, text, position, option_id`,
        [WA, D.A],
      )
      expect(sw).toEqual({ created_by: U.editorA, text: '', position: 0, option_id: null })
      const [rk] = await s.rows<Row>(
        `insert into themis.risks (workspace_id, decision_id, option_id, likelihood, impact)
         values ($1, $2, $3, 2, 4) returning created_by, title, owner, mitigation, position`,
        [WA, D.A, O.A2],
      )
      expect(rk).toEqual({
        created_by: U.editorA,
        title: '',
        owner: '',
        mitigation: '',
        position: 0,
      })
      const [cm] = await s.rows<Row>(
        `insert into themis.comments (workspace_id, decision_id, body) values ($1, $2, 'hi')
         returning created_by, author`,
        [WA, D.A],
      )
      expect(cm).toEqual({ created_by: U.editorA, author: U.editorA })
    }))

  it.each([
    ['swot_items', `text = 'x'`, SW.A1],
    ['risks', `impact = 1`, RK.A1],
    ['comments', `body = 'x'`, CM.A],
    ['approvals', `reason = 'x'`, AP.A],
  ])('an UPDATE on themis.%s bumps updated_at', (t, set, id) =>
    actAs(SUPERUSER, async (s) => {
      expect(await s.count(t, `id = '${id}' and updated_at = '${OLD}'`)).toBe(1)
      await s.rows(`update themis.${t} set ${set} where id = $1`, [id])
      expect(
        await s.count(t, `id = '${id}' and updated_at > '${OLD}'::timestamptz + interval '1 day'`),
      ).toBe(1)
    }),
  )
})

describe('analysis (P1.6): cascades', () => {
  it('deleting an option removes its risks and option-level SWOT only; decision-level SWOT stays', () =>
    actAs(U.editorA, async (s) => {
      expect(await s.attempt(`delete from themis.options where id = $1`, [O.A1])).toEqual({
        ok: true,
        affected: 1,
      })
      await s.sudo(async () => {
        expect(await s.count('risks', `id = '${RK.A1}'`)).toBe(0)
        expect(await s.count('swot_items', `id = '${SW.A2}'`)).toBe(0)
        expect(await s.count('risks', `id = '${RK.A2}'`)).toBe(1)
        expect(await s.count('swot_items', `id = '${SW.A1}'`)).toBe(1)
        expect(await s.count('comments', `id = '${CM.A}'`)).toBe(1)
        expect(await s.count('approvals', `id = '${AP.A}'`)).toBe(1)
      })
    }))

  it('deleting a draft decision removes its SWOT, risks, comments and approvals only', () =>
    actAs(U.editorA, async (s) => {
      expect(await s.attempt(`delete from themis.decisions where id = $1`, [D.A])).toEqual({
        ok: true,
        affected: 1,
      })
      await s.sudo(async () => {
        for (const t of ANALYSIS_TABLES) {
          expect(await s.count(t, `decision_id = '${D.A}'`), t).toBe(0)
          expect(await s.count(t, `decision_id = '${D.B}'`), t).toBe(1)
        }
        expect(await s.count('approvals', `id = '${AP.AF}'`)).toBe(1)
      })
    }))

  it("the owner deleting workspace A removes all of A's analysis rows; B intact", () =>
    actAs(U.ownerA, async (s) => {
      expect(await s.attempt(`delete from themis.workspaces where id = $1`, [WA])).toEqual({
        ok: true,
        affected: 1,
      })
      await s.sudo(async () => {
        for (const t of ANALYSIS_TABLES) {
          expect(await s.count(t, `workspace_id = '${WA}'`), t).toBe(0)
          expect(await s.count(t, `workspace_id = '${WB}'`), t).toBe(1)
        }
      })
    }))

  it('deleting an auth user nulls author, actor and created_by, keeping the rows', () =>
    actAs(SUPERUSER, async (s) => {
      await s.rows(`delete from auth.users where id in ($1, $2)`, [U.editorA, U.adminA])
      expect(
        await s.count('comments', `id = '${CM.A}' and author is null and created_by is null`),
      ).toBe(1)
      expect(
        await s.count('approvals', `id = '${AP.A}' and actor is null and created_by is null`),
      ).toBe(1)
      expect(await s.count('swot_items', `workspace_id = '${WA}' and created_by is null`)).toBe(2)
      expect(await s.count('risks', `workspace_id = '${WA}' and created_by is null`)).toBe(2)
    }))
})

// =================================================================================================
// P1.7 AI, billing, audit and plans — structure
// =================================================================================================

describe('AI/billing/audit (P1.7): table shapes, keys, foreign keys and triggers', () => {
  const N = 'numeric(10,4)'
  it.each([
    [
      'plans',
      [
        'key:text!',
        'active_decisions:integer',
        'ai_runs_month:integer',
        'ai_runs_per_seat:integer',
        `ai_cost_ceiling_eur:${N}!`,
        'members_max:integer',
        'pdf_footer:boolean!',
        'pdf_logo:boolean!',
        'min_seats:integer!',
        `created_at:${TSZ_}!`,
        `updated_at:${TSZ_}!`,
      ],
    ],
    [
      'ai_runs',
      [
        'id:uuid!',
        'workspace_id:uuid!',
        'decision_id:uuid!',
        'kind:text!',
        'model:text!',
        'status:text!',
        'input_snapshot:jsonb!',
        'output:jsonb',
        'tokens_in:integer!',
        'tokens_out:integer!',
        `cost_eur:${N}!`,
        'accepted:jsonb!',
        'created_by:uuid',
        `created_at:${TSZ_}!`,
        `updated_at:${TSZ_}!`,
      ],
    ],
    [
      'subscriptions',
      [
        'id:uuid!',
        'workspace_id:uuid!',
        'stripe_customer_id:text',
        'stripe_subscription_id:text',
        'plan:text!',
        'seats:integer!',
        'status:text!',
        `period_end:${TSZ_}`,
        `created_at:${TSZ_}!`,
        `updated_at:${TSZ_}!`,
      ],
    ],
    [
      'usage_monthly',
      [
        'workspace_id:uuid!',
        'month:date!',
        'ai_runs:integer!',
        `ai_cost_eur:${N}!`,
        `created_at:${TSZ_}!`,
        `updated_at:${TSZ_}!`,
      ],
    ],
    [
      'audit_log',
      [
        'id:uuid!',
        'workspace_id:uuid!',
        'actor:uuid',
        'entity:text!',
        'entity_id:uuid',
        'action:text!',
        'before:jsonb',
        'after:jsonb',
        `at:${TSZ_}!`,
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
      [P17_TABLES.map((t) => `themis.${t}`)],
    )
    expect(r.rows.map((x) => x.k).sort()).toEqual(
      [
        'themis.plans plans_pkey p (key)',
        'themis.ai_runs ai_runs_pkey p (id)',
        'themis.subscriptions subscriptions_pkey p (id)',
        'themis.subscriptions subscriptions_workspace_id_key u (workspace_id)',
        'themis.subscriptions subscriptions_stripe_customer_id_key u (stripe_customer_id)',
        'themis.subscriptions subscriptions_stripe_subscription_id_key u (stripe_subscription_id)',
        'themis.usage_monthly usage_monthly_pkey p (workspace_id,month)',
        'themis.audit_log audit_log_pkey p (id)',
      ].sort(),
    )
  })

  it('foreign keys: ai_runs reaches decisions only through the composite key; plan -> plans(key)', async () => {
    // c = cascade, n = set null, a = no action
    expect(await fkList(P17_TABLES)).toEqual(
      [
        'themis.ai_runs(created_by)->auth.users(id) n',
        'themis.ai_runs(decision_id,workspace_id)->themis.decisions(id,workspace_id) c',
        'themis.subscriptions(workspace_id)->themis.workspaces(id) c',
        'themis.subscriptions(plan)->themis.plans(key) a',
        'themis.usage_monthly(workspace_id)->themis.workspaces(id) c',
        'themis.audit_log(workspace_id)->themis.workspaces(id) c',
        'themis.audit_log(actor)->auth.users(id) n',
      ].sort(),
    )
  })

  it('triggers: touch_updated_at on four tables; audit_log has only the BEFORE UPDATE append-only guard', async () => {
    const r = await db.query<{ t: string }>(
      `select c.relname || '.' || t.tgname || ' ' || p.proname || ' ' || t.tgtype::text as t
         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
        where not t.tgisinternal and c.relnamespace = 'themis'::regnamespace
          and c.relname = any ($1::text[])`,
      [[...P17_TABLES]],
    )
    // tgtype 19 = ROW (1) | BEFORE (2) | UPDATE (16)
    expect(r.rows.map((x) => x.t).sort()).toEqual(
      [
        'plans.plans_touch_updated_at touch_updated_at 19',
        'ai_runs.ai_runs_touch_updated_at touch_updated_at 19',
        'subscriptions.subscriptions_touch_updated_at touch_updated_at 19',
        'usage_monthly.usage_monthly_touch_updated_at touch_updated_at 19',
        'audit_log.audit_log_no_update audit_log_append_only 19',
      ].sort(),
    )
  })

  it('audit_log_append_only(): search_path pinned, not executable by anon or authenticated', async () => {
    const [f] = (
      await db.query<{ cfg: string[] | null; anon: boolean; auth: boolean }>(
        `select p.proconfig as cfg,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
           from pg_proc p where p.oid = 'themis.audit_log_append_only()'::regprocedure`,
      )
    ).rows
    expect(f.cfg).toEqual(['search_path=""'])
    expect(f.anon).toBe(false)
    expect(f.auth).toBe(false)
  })

  it('the plans seed is marked UNCONFIRMED in the catalogue', async () => {
    const [r] = (
      await db.query<{ c: string | null }>(`select obj_description('themis.plans'::regclass) as c`)
    ).rows
    expect(r.c).toMatch(/UNCONFIRMED/)
  })
})

describe('AI/billing/audit (P1.7): RLS, policies and grants', () => {
  it.each(P17_TABLES)('RLS is enabled on themis.%s', async (t) => {
    const r = await db.query<{ on: boolean }>(
      `select relrowsecurity as on from pg_class where oid = $1::regclass`,
      [`themis.${t}`],
    )
    expect(r.rows[0].on).toBe(true)
  })

  it('the policy set is exactly one SELECT policy per table; no write policy anywhere', async () => {
    const r = await db.query<{ p: string }>(
      `select c.relname || '.' || p.polname || ' ' || p.polcmd::text || ' ' || p.polroles::regrole[]::text as p
         from pg_policy p join pg_class c on c.oid = p.polrelid
        where c.relnamespace = 'themis'::regnamespace and c.relname = any ($1::text[])`,
      [[...P17_TABLES]],
    )
    expect(r.rows.map((x) => x.p).sort()).toEqual(
      [
        'plans.plans_select r {anon,authenticated}',
        'ai_runs.ai_runs_select r {authenticated}',
        'subscriptions.subscriptions_select r {authenticated}',
        'usage_monthly.usage_monthly_select r {authenticated}',
        'audit_log.audit_log_select r {authenticated}',
      ].sort(),
    )
  })

  it('policy predicates: members via is_member, audit_log via has_role(owner, admin), plans true', async () => {
    const r = await db.query<{ t: string; q: string; chk: string | null }>(
      `select c.relname as t, pg_get_expr(p.polqual, p.polrelid) as q,
              pg_get_expr(p.polwithcheck, p.polrelid) as chk
         from pg_policy p join pg_class c on c.oid = p.polrelid
        where c.relnamespace = 'themis'::regnamespace and c.relname = any ($1::text[])`,
      [[...P17_TABLES]],
    )
    const q = Object.fromEntries(r.rows.map((x) => [x.t, x.q]))
    expect(q.plans).toBe('true')
    for (const t of ['ai_runs', 'subscriptions', 'usage_monthly'])
      expect(q[t], t).toBe('themis.is_member(workspace_id)')
    expect(q.audit_log).toMatch(
      /^themis\.has_role\(workspace_id, ARRAY\['owner'::text, 'admin'::text\]\)$/,
    )
    expect(r.rows.filter((x) => x.chk !== null)).toEqual([])
  })

  it('table and column privileges are exactly the planned set per role', async () => {
    const got: Record<string, Record<string, string[]>> = {}
    for (const role of ['anon', 'authenticated', 'service_role']) {
      got[role] = {}
      for (const t of P17_TABLES) got[role][t] = await privsOf(role, t)
    }
    const RW = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
    expect(got).toEqual({
      anon: { plans: ['SELECT'], ai_runs: [], subscriptions: [], usage_monthly: [], audit_log: [] },
      authenticated: {
        plans: ['SELECT'],
        ai_runs: ['SELECT'],
        subscriptions: ['SELECT'],
        usage_monthly: ['SELECT'],
        audit_log: ['SELECT'],
      },
      service_role: {
        plans: ['SELECT'],
        ai_runs: RW,
        subscriptions: RW,
        usage_monthly: RW,
        audit_log: ['SELECT', 'INSERT'],
      },
    })
  })

  it.each([
    ['plans', ['anon', 'authenticated', 'service_role']],
    ...BILLING_TABLES.map((t) => [t, ['authenticated', 'service_role']] as const),
  ] as const)('themis.%s is granted to exactly %j', async (t, want) => {
    const r = await db.query<{ g: string }>(
      `select distinct grantee as g from information_schema.role_table_grants
        where table_schema = 'themis' and table_name = $1
       union
       select distinct grantee from information_schema.column_privileges
        where table_schema = 'themis' and table_name = $1
       order by 1`,
      [t],
    )
    expect(r.rows.map((x) => x.g).filter((g) => g !== 'postgres')).toEqual(want)
  })

  it('anon holds exactly SELECT on plans and nothing else in schema themis', async () => {
    const r = await db.query<{ g: string }>(
      `select c.relname || ' ' || p as g
         from pg_class c cross join unnest($1::text[]) p
        where c.relnamespace = 'themis'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
          and (has_table_privilege('anon', c.oid, p)
               or (p in ('SELECT','INSERT','UPDATE','REFERENCES')
                   and has_any_column_privilege('anon', c.oid, p)))
       union all
       select c.relname || ' ' || p from pg_class c cross join unnest(array['USAGE','SELECT','UPDATE']) p
        where c.relnamespace = 'themis'::regnamespace and c.relkind = 'S'
          and has_sequence_privilege('anon', c.oid, p)
       union all
       select f.oid::regprocedure::text || ' EXECUTE' from pg_proc f
        where f.pronamespace = 'themis'::regnamespace and has_function_privilege('anon', f.oid, 'EXECUTE')`,
      [PRIVS_],
    )
    expect(r.rows.map((x) => x.g)).toEqual(['plans SELECT'])
  })
})

// =================================================================================================
// P1.7 AI, billing, audit and plans — behaviour
// =================================================================================================

/** One attempted client write per verb, on workspace A's own rows (or the free plan). */
const P17_WRITES: Record<(typeof P17_TABLES)[number], { ofA: string; ins: string; upd: string }> = {
  ai_runs: {
    ofA: `workspace_id = '${WA}'`,
    ins: `insert into themis.ai_runs (workspace_id, decision_id, kind, model, input_snapshot)
          values ('${WA}', '${D.A}', 'explain', 'm', '{}')`,
    upd: `update themis.ai_runs set accepted = '["s1"]' where workspace_id = '${WA}'`,
  },
  subscriptions: {
    ofA: `workspace_id = '${WA}'`,
    ins: `insert into themis.subscriptions (workspace_id, plan, seats, status)
          values ('${WA}', 'team', 99, 'active')`,
    upd: `update themis.subscriptions set plan = 'team', seats = 99 where workspace_id = '${WA}'`,
  },
  usage_monthly: {
    ofA: `workspace_id = '${WA}'`,
    ins: `insert into themis.usage_monthly (workspace_id, month) values ('${WA}', '2026-10-01')`,
    upd: `update themis.usage_monthly set ai_runs = 0, ai_cost_eur = 0 where workspace_id = '${WA}'`,
  },
  audit_log: {
    ofA: `workspace_id = '${WA}'`,
    ins: `insert into themis.audit_log (workspace_id, entity, action) values ('${WA}', 'decision', 'forged')`,
    upd: `update themis.audit_log set action = 'rewritten' where workspace_id = '${WA}'`,
  },
  plans: {
    ofA: `key = 'free'`,
    ins: `insert into themis.plans (key, ai_runs_month, ai_cost_ceiling_eur, pdf_footer, pdf_logo)
          values ('free', 100000, 999, false, true) on conflict (key) do nothing`,
    upd: `update themis.plans set ai_runs_month = 100000 where key = 'free'`,
  },
}

/** Every attempted write on `t` (INSERT, UPDATE, DELETE), outcome per verb. */
const tryWrites = async (s: Session, t: (typeof P17_TABLES)[number]) => {
  const w = P17_WRITES[t]
  return {
    insert: await s.attempt(w.ins),
    update: await s.attempt(w.upd),
    delete: await s.attempt(`delete from themis.${t} where ${w.ofA}`),
  }
}

describe('AI/billing/audit (P1.7): server-side writes only', () => {
  it.each(
    (['owner', 'admin', 'editor', 'viewer'] as const).flatMap((role) =>
      P17_TABLES.map((t) => [role, t] as const),
    ),
  )("the %s of A is refused INSERT, UPDATE and DELETE on A's themis.%s", (role, t) =>
    actAs(
      { owner: U.ownerA, admin: U.adminA, editor: U.editorA, viewer: U.viewerA }[role],
      async (s) => {
        const before = await snapshot(s, t, P17_WRITES[t].ofA)
        expect(before.n).toBeGreaterThan(0)
        const o = await tryWrites(s, t)
        for (const [verb, out] of Object.entries(o))
          expect(refused(out), `${verb}: ${JSON.stringify(out)}`).toBe(true)
        expect(await snapshot(s, t, P17_WRITES[t].ofA)).toEqual(before)
      },
    ),
  )

  it.each(P17_TABLES)('anon is refused INSERT, UPDATE and DELETE on themis.%s', (t) =>
    actAs(ANON, async (s) => {
      const before = await snapshot(s, t, P17_WRITES[t].ofA)
      const o = await tryWrites(s, t)
      for (const [verb, out] of Object.entries(o))
        expect(refused(out), `${verb}: ${JSON.stringify(out)}`).toBe(true)
      expect(await snapshot(s, t, P17_WRITES[t].ofA)).toEqual(before)
    }),
  )

  it('service_role writes ai_runs: insert, settle, accept, delete', () =>
    actAs(SERVICE, async (s) => {
      const [run] = await s.rows<{ id: string; status: string; created_by: string | null }>(
        `insert into themis.ai_runs (workspace_id, decision_id, kind, model, input_snapshot)
         values ($1, $2, 'stress_test', 'model-x', '{"q":1}') returning id, status, created_by`,
        [WA, D.A],
      )
      expect(run.status).toBe('reserved')
      expect(run.created_by).toBeNull() // auth.uid() is null under the service key
      expect(
        await s.attempt(
          `update themis.ai_runs set status = 'succeeded', accepted = '["s1"]' where id = $1`,
          [run.id],
        ),
      ).toEqual({ ok: true, affected: 1 })
      expect(await s.attempt(`delete from themis.ai_runs where id = $1`, [AR.AF])).toEqual({
        ok: true,
        affected: 1,
      })
      // BYPASSRLS: the service key sees every workspace's runs.
      expect(await s.count('ai_runs')).toBe(3)
    }))

  it('service_role writes subscriptions and usage_monthly', () =>
    actAs(SERVICE, async (s) => {
      expect(
        await s.attempt(`update themis.subscriptions set plan = 'team', seats = 3 where id = $1`, [
          SUB.A,
        ]),
      ).toEqual({ ok: true, affected: 1 })
      expect(await s.attempt(`delete from themis.subscriptions where id = $1`, [SUB.B])).toEqual({
        ok: true,
        affected: 1,
      })
      expect(
        await s.attempt(
          `insert into themis.subscriptions (workspace_id, stripe_customer_id, stripe_subscription_id,
                                             plan, status) values ($1, 'cus_B1', 'sub_B1', 'pro', 'trialing')`,
          [WB],
        ),
      ).toEqual({ ok: true, affected: 1 })
      expect(
        await s.attempt(
          `insert into themis.usage_monthly (workspace_id, month) values ($1, '2026-10-01')`,
          [WA],
        ),
      ).toEqual({ ok: true, affected: 1 })
      expect(
        await s.attempt(
          `update themis.usage_monthly set ai_runs = ai_runs + 1, ai_cost_eur = ai_cost_eur + 0.01
            where workspace_id = $1 and month = $2`,
          [WA, MONTH],
        ),
      ).toEqual({ ok: true, affected: 1 })
      expect(
        await s.attempt(
          `delete from themis.usage_monthly where workspace_id = $1 and month = '2026-10-01'`,
          [WA],
        ),
      ).toEqual({ ok: true, affected: 1 })
      expect(await s.count('usage_monthly', `workspace_id = '${WA}' and ai_runs = 3`)).toBe(1)
    }))

  it('service_role may INSERT audit_log but never UPDATE or DELETE it', () =>
    actAs(SERVICE, async (s) => {
      expect(
        await s.attempt(
          `insert into themis.audit_log (workspace_id, entity, entity_id, action, before, after)
           values ($1, 'decision', $2, 'approve', '{"status":"in_review"}', '{"status":"approved"}')`,
          [WA, D.A],
        ),
      ).toEqual({ ok: true, affected: 1 })
      expect(await s.count('audit_log', `workspace_id = '${WA}'`)).toBe(3)
      const before = await snapshot(s, 'audit_log', 'true')
      const upd = await s.attempt(
        `update themis.audit_log set action = 'x' where workspace_id = $1`,
        [WA],
      )
      const del = await s.attempt(`delete from themis.audit_log where workspace_id = $1`, [WA])
      expect(refused(upd), JSON.stringify(upd)).toBe(true)
      expect(refused(del), JSON.stringify(del)).toBe(true)
      expect(await snapshot(s, 'audit_log', 'true')).toEqual(before)
    }))

  it('service_role cannot write plans (plan values change only by migration)', () =>
    actAs(SERVICE, async (s) => {
      const before = await snapshot(s, 'plans', 'true')
      const o = await tryWrites(s, 'plans')
      for (const [verb, out] of Object.entries(o))
        expect(refused(out), `${verb}: ${JSON.stringify(out)}`).toBe(true)
      expect(await snapshot(s, 'plans', 'true')).toEqual(before)
      expect(await s.count('plans')).toBe(3)
    }))

  it('audit_log is append-only even for the table owner: UPDATE raises audit_log_append_only', () =>
    actAs(SUPERUSER, async (s) => {
      const o = await s.attempt(`update themis.audit_log set action = 'rewritten' where id = $1`, [
        AU.A1,
      ])
      expect(o.ok).toBe(false)
      expect(!o.ok && o.error).toMatch(/audit_log_append_only/)
      expect(await s.count('audit_log', `id = '${AU.A1}' and action = 'insert'`)).toBe(1)
    }))
})

describe('AI/billing/audit (P1.7): read rules', () => {
  it.each([
    ['owner', U.ownerA],
    ['admin', U.adminA],
    ['editor', U.editorA],
    ['viewer', U.viewerA],
  ])("the %s of A reads A's ai_runs, subscription and usage, and nothing of B", (_r, who) =>
    actAs(who, async (s) => {
      expect(await s.count('ai_runs')).toBe(2)
      expect(await s.count('ai_runs', `workspace_id = '${WA}'`)).toBe(2)
      expect(await s.count('subscriptions')).toBe(1)
      expect(await s.count('subscriptions', `id = '${SUB.A}' and plan = 'pro'`)).toBe(1)
      expect(await s.count('usage_monthly')).toBe(1)
      expect(await s.count('usage_monthly', `workspace_id = '${WA}'`)).toBe(1)
      for (const t of BILLING_TABLES) expect(await s.count(t, `workspace_id = '${WB}'`), t).toBe(0)
    }),
  )

  it.each([
    ['owner', U.ownerA, 2],
    ['admin', U.adminA, 2],
    ['editor', U.editorA, 0],
    ['viewer', U.viewerA, 0],
  ] as const)("the %s of A reads %i of A's audit_log rows (owner/admin only)", (_r, who, n) =>
    actAs(who, async (s) => {
      expect(await s.count('audit_log')).toBe(n)
      expect(await s.count('audit_log', `workspace_id = '${WB}'`)).toBe(0)
    }),
  )

  it('the viewer cannot read the audit row they are the actor of', () =>
    actAs(U.viewerA, async (s) => {
      expect(await s.count('audit_log', `id = '${AU.A1}'`)).toBe(0)
    }))

  it("the owner of B reads B's own rows in all four tables, and its own audit log", () =>
    actAs(U.ownerB, async (s) => {
      for (const t of BILLING_TABLES) expect(await s.count(t), t).toBe(1)
      expect(await s.count('audit_log', `id = '${AU.B1}'`)).toBe(1)
    }))

  it('a user with no workspace reads none of the four tenant tables, but all three plans', () =>
    actAs(U.loner, async (s) => {
      for (const t of BILLING_TABLES) expect(await s.count(t), t).toBe(0)
      expect(await s.count('plans')).toBe(3)
    }))

  it('anon reads all three plans and is refused on the four tenant tables', () =>
    actAs(ANON, async (s) => {
      expect(await s.count('plans')).toBe(3)
      for (const t of BILLING_TABLES) {
        const o = await s.attempt(`select * from themis.${t}`)
        expect(refused(o), `${t}: ${JSON.stringify(o)}`).toBe(true)
      }
    }))
})

describe('AI/billing/audit (P1.7): the plans seed', () => {
  const planRows = (s: Session) =>
    s.rows(
      `select key, active_decisions, ai_runs_month, ai_runs_per_seat,
              ai_cost_ceiling_eur::text as ceiling, members_max, pdf_footer, pdf_logo, min_seats
         from themis.plans order by key`,
    )
  const PROPOSAL = [
    {
      key: 'free',
      active_decisions: 3,
      ai_runs_month: 10,
      ai_runs_per_seat: null,
      ceiling: '1.0000',
      members_max: 1,
      pdf_footer: true,
      pdf_logo: false,
      min_seats: 1,
    },
    {
      key: 'pro',
      active_decisions: null,
      ai_runs_month: 200,
      ai_runs_per_seat: null,
      ceiling: '10.0000',
      members_max: 1,
      pdf_footer: false,
      pdf_logo: false,
      min_seats: 1,
    },
    {
      key: 'team',
      active_decisions: null,
      ai_runs_month: null,
      ai_runs_per_seat: 500,
      ceiling: '60.0000',
      members_max: null,
      pdf_footer: false,
      pdf_logo: true,
      min_seats: 3,
    },
  ]
  const p17File = () => {
    const f = readdirSync(MIG).find((x) => x.endsWith('_themis_ai_billing_audit.sql'))
    if (!f) throw new Error(`no *_themis_ai_billing_audit.sql in ${MIG}`)
    return readFileSync(path.join(MIG, f), 'utf8')
  }

  it('exactly three plans, with the spec §4 proposal values (anon sees the same)', async () => {
    await actAs(SUPERUSER, async (s) => expect(await planRows(s)).toEqual(PROPOSAL))
    await actAs(ANON, async (s) => expect(await planRows(s)).toEqual(PROPOSAL))
  })

  it('re-applying the migration neither duplicates nor overwrites a changed plan, and restores a missing one', () =>
    actAs(SUPERUSER, async (s) => {
      // A later migration (P4.9) confirms a value; a plan row goes missing.
      await s.rows(`update themis.plans set ai_runs_month = 250, members_max = 2 where key = 'pro'`)
      await s.rows(`delete from themis.plans where key = 'team'`)
      await db.exec(p17File())
      const rows = await planRows(s)
      expect(rows).toHaveLength(3)
      expect(rows[1]).toMatchObject({ key: 'pro', ai_runs_month: 250, members_max: 2 })
      expect(rows[2]).toEqual(PROPOSAL[2])
      expect(rows[0]).toEqual(PROPOSAL[0])
    }))

  it('exactly one quota basis per plan (plans_one_quota_basis)', () =>
    actAs(SUPERUSER, async (s) => {
      for (const [set, key] of [
        ['ai_runs_per_seat = 5', 'free'], // both
        ['ai_runs_month = null', 'pro'], // neither
        ['ai_runs_per_seat = null', 'team'], // neither
        ['ai_runs_month = 100', 'team'], // both
      ]) {
        const o = await s.attempt(`update themis.plans set ${set} where key = '${key}'`)
        expect(
          checkRefused(o, 'plans_one_quota_basis'),
          `${key} ${set}: ${JSON.stringify(o)}`,
        ).toBe(true)
      }
      // Positive control: switching basis in one statement is allowed.
      expect(
        await s.attempt(
          `update themis.plans set ai_runs_month = null, ai_runs_per_seat = 20 where key = 'pro'`,
        ),
      ).toEqual({ ok: true, affected: 1 })
    }))

  it('plan key is free|pro|team; min_seats >= 1; ceiling >= 0; members_max >= 1', () =>
    actAs(SUPERUSER, async (s) => {
      const gold = await s.attempt(
        `insert into themis.plans (key, ai_runs_month, ai_cost_ceiling_eur, pdf_footer, pdf_logo)
         values ('gold', 10, 1, true, false)`,
      )
      expect(checkRefused(gold, 'plans_key_check'), JSON.stringify(gold)).toBe(true)
      for (const [set, c] of [
        ['min_seats = 0', 'plans_min_seats_check'],
        ['ai_cost_ceiling_eur = -0.0001', 'plans_ai_cost_ceiling_eur_check'],
        ['members_max = 0', 'plans_members_max_check'],
        ['ai_runs_month = -1', 'plans_ai_runs_month_check'],
      ]) {
        const o = await s.attempt(`update themis.plans set ${set} where key = 'free'`)
        expect(checkRefused(o, c), `${set}: ${JSON.stringify(o)}`).toBe(true)
      }
    }))
})

describe('AI/billing/audit (P1.7): constraints (as superuser unless stated)', () => {
  const OK = { ok: true, affected: 1 }
  /** Insert an ai_run on DA; `cols` are SQL literals overriding the defaults. */
  const aiRun = (s: Session, cols: Record<string, string>) => {
    const all: Record<string, string> = {
      workspace_id: `'${WA}'`,
      decision_id: `'${D.A}'`,
      kind: `'challenge'`,
      model: `'m'`,
      input_snapshot: `'{}'`,
      ...cols,
    }
    return s.attempt(
      `insert into themis.ai_runs (${Object.keys(all).join(', ')}) values (${Object.values(all).join(', ')})`,
    )
  }

  it('ai_runs.kind is one of the five kinds', () =>
    actAs(SUPERUSER, async (s) => {
      for (const k of ['challenge', 'missing_criteria', 'stress_test', 'explain', 'swot_draft'])
        expect(await aiRun(s, { kind: `'${k}'` }), k).toEqual(OK)
      for (const k of ['summarize', 'Challenge', ''])
        expect(checkRefused(await aiRun(s, { kind: `'${k}'` }), 'ai_runs_kind_check'), k).toBe(true)
    }))

  it('ai_runs.status is reserved|succeeded|failed, default reserved; defaults for tokens, cost, accepted', () =>
    actAs(SUPERUSER, async (s) => {
      for (const st of ['reserved', 'succeeded', 'failed'])
        expect(await aiRun(s, { status: `'${st}'` }), st).toEqual(OK)
      for (const st of ['pending', 'error'])
        expect(
          checkRefused(await aiRun(s, { status: `'${st}'` }), 'ai_runs_status_check'),
          st,
        ).toBe(true)
      const [r] = await s.rows(
        `insert into themis.ai_runs (workspace_id, decision_id, kind, model, input_snapshot)
         values ($1, $2, 'explain', 'm', '{}')
         returning status, tokens_in, tokens_out, cost_eur::text as cost, accepted`,
        [WA, D.A],
      )
      expect(r).toEqual({
        status: 'reserved',
        tokens_in: 0,
        tokens_out: 0,
        cost: '0.0000',
        accepted: [],
      })
    }))

  it('ai_runs.accepted must be a JSON array (insert and update); input_snapshot an object', () =>
    actAs(SUPERUSER, async (s) => {
      expect(await aiRun(s, { accepted: `'[{"id":"s1","accepted":true}]'` })).toEqual(OK)
      for (const v of [`'{}'`, `'"s1"'`, `'null'`, `'1'`])
        expect(checkRefused(await aiRun(s, { accepted: v }), 'ai_runs_accepted_check'), v).toBe(
          true,
        )
      const upd = await s.attempt(
        `update themis.ai_runs set accepted = '{"s1":true}' where id = $1`,
        [AR.A],
      )
      expect(checkRefused(upd, 'ai_runs_accepted_check'), JSON.stringify(upd)).toBe(true)
      for (const v of [`'[]'`, `'"x"'`])
        expect(
          checkRefused(await aiRun(s, { input_snapshot: v }), 'ai_runs_input_snapshot_check'),
          v,
        ).toBe(true)
    }))

  it('ai_runs: tokens and cost are never negative; model is 1..100 chars', () =>
    actAs(SUPERUSER, async (s) => {
      for (const [c, v] of [
        ['tokens_in', '-1'],
        ['tokens_out', '-1'],
        ['cost_eur', '-0.0001'],
      ])
        expect(checkRefused(await aiRun(s, { [c]: v }), `ai_runs_${c}_check`), c).toBe(true)
      expect(checkRefused(await aiRun(s, { model: `''` }), 'ai_runs_model_check')).toBe(true)
      expect(
        checkRefused(await aiRun(s, { model: `repeat('m', 101)` }), 'ai_runs_model_check'),
      ).toBe(true)
      expect(await aiRun(s, { model: `repeat('m', 100)` })).toEqual(OK)
    }))

  it('the composite FK refuses a run pointing across workspaces, even from the service key', () =>
    actAs(SERVICE, async (s) => {
      // service_role bypasses RLS: the FK is the only barrier left.
      const bOnA = await aiRun(s, { workspace_id: `'${WB}'`, decision_id: `'${D.A}'` })
      expect(fkRefused(bOnA, 'ai_runs_decision_fkey'), JSON.stringify(bOnA)).toBe(true)
      const aOnB = await aiRun(s, { workspace_id: `'${WA}'`, decision_id: `'${D.B}'` })
      expect(fkRefused(aOnB, 'ai_runs_decision_fkey'), JSON.stringify(aOnB)).toBe(true)
      const repoint = await s.attempt(`update themis.ai_runs set decision_id = $1 where id = $2`, [
        D.A,
        AR.B,
      ])
      expect(fkRefused(repoint, 'ai_runs_decision_fkey'), JSON.stringify(repoint)).toBe(true)
      // Positive control: B's run on B's own decision.
      expect(await aiRun(s, { workspace_id: `'${WB}'`, decision_id: `'${D.B}'` })).toEqual(OK)
      await s.sudo(async () => expect(await s.count('ai_runs', `workspace_id = '${WB}'`)).toBe(2))
    }))

  it('subscriptions: one per workspace; plan must exist in plans and defaults to free', () =>
    actAs(SUPERUSER, async (s) => {
      const second = await s.attempt(
        `insert into themis.subscriptions (workspace_id, plan, status) values ($1, 'team', 'active')`,
        [WA],
      )
      expect(dupRefused(second, 'subscriptions_workspace_id_key'), JSON.stringify(second)).toBe(
        true,
      )
      await s.rows(`delete from themis.subscriptions where id = $1`, [SUB.B])
      const gold = await s.attempt(
        `insert into themis.subscriptions (workspace_id, plan, status) values ($1, 'gold', 'active')`,
        [WB],
      )
      expect(fkRefused(gold, 'subscriptions_plan_fkey'), JSON.stringify(gold)).toBe(true)
      const [r] = await s.rows(
        `insert into themis.subscriptions (workspace_id, status) values ($1, 'active') returning plan, seats`,
        [WB],
      )
      expect(r).toEqual({ plan: 'free', seats: 1 })
      // A plan in use cannot be deleted out from under its subscribers (no action).
      const del = await s.attempt(`delete from themis.plans where key = 'pro'`)
      expect(fkRefused(del, 'subscriptions_plan_fkey'), JSON.stringify(del)).toBe(true)
    }))

  it('subscriptions: Stripe id formats (cus_…, sub_…) and uniqueness across workspaces', () =>
    actAs(SUPERUSER, async (s) => {
      const set = (col: string, v: string) =>
        s.attempt(`update themis.subscriptions set ${col} = $1 where id = $2`, [v, SUB.B])
      for (const v of ['cust_1', 'cus_', 'cus_Ab-1', 'sub_A9', ' cus_A9'])
        expect(
          checkRefused(
            await set('stripe_customer_id', v),
            'subscriptions_stripe_customer_id_check',
          ),
          v,
        ).toBe(true)
      for (const v of ['si_1', 'sub_', 'sub_A 9', 'cus_A9'])
        expect(
          checkRefused(
            await set('stripe_subscription_id', v),
            'subscriptions_stripe_subscription_id_check',
          ),
          v,
        ).toBe(true)
      expect(await set('stripe_customer_id', 'cus_Zz09')).toEqual(OK)
      expect(await set('stripe_subscription_id', 'sub_Zz09')).toEqual(OK)
      const dupCus = await set('stripe_customer_id', 'cus_A1')
      expect(
        dupRefused(dupCus, 'subscriptions_stripe_customer_id_key'),
        JSON.stringify(dupCus),
      ).toBe(true)
      const dupSub = await set('stripe_subscription_id', 'sub_A1')
      expect(
        dupRefused(dupSub, 'subscriptions_stripe_subscription_id_key'),
        JSON.stringify(dupSub),
      ).toBe(true)
    }))

  it("subscriptions: status is Stripe's eight statuses verbatim; seats >= 1", () =>
    actAs(SUPERUSER, async (s) => {
      const st = (v: string) =>
        s.attempt(`update themis.subscriptions set status = $1 where id = $2`, [v, SUB.A])
      for (const v of [
        'trialing',
        'active',
        'incomplete',
        'incomplete_expired',
        'past_due',
        'canceled',
        'unpaid',
        'paused',
      ])
        expect(await st(v), v).toEqual(OK)
      for (const v of ['cancelled', 'expired', 'Active', ''])
        expect(checkRefused(await st(v), 'subscriptions_status_check'), v).toBe(true)
      const seats = await s.attempt(`update themis.subscriptions set seats = 0 where id = $1`, [
        SUB.A,
      ])
      expect(checkRefused(seats, 'subscriptions_seats_check'), JSON.stringify(seats)).toBe(true)
    }))

  it('usage_monthly: month must be the first of the month; one row per (workspace, month)', () =>
    actAs(SUPERUSER, async (s) => {
      const ins = (ws: string, m: string) =>
        s.attempt(`insert into themis.usage_monthly (workspace_id, month) values ($1, $2)`, [ws, m])
      for (const m of ['2026-10-15', '2026-10-31', '2026-10-02'])
        expect(checkRefused(await ins(WA, m), 'usage_monthly_month_check'), m).toBe(true)
      expect(await ins(WA, '2026-10-01')).toEqual(OK)
      const dup = await ins(WA, MONTH)
      expect(dupRefused(dup, 'usage_monthly_pkey'), JSON.stringify(dup)).toBe(true)
      // The same month in another workspace is a different key.
      expect(await ins(WB, '2026-10-01')).toEqual(OK)
      const [r] = await s.rows(
        `select ai_runs, ai_cost_eur::text as cost from themis.usage_monthly where workspace_id = $1 and month = '2026-10-01'`,
        [WA],
      )
      expect(r).toEqual({ ai_runs: 0, cost: '0.0000' })
      for (const set of ['ai_runs = -1', 'ai_cost_eur = -0.0001']) {
        const o = await s.attempt(
          `update themis.usage_monthly set ${set} where workspace_id = $1`,
          [WA],
        )
        expect(checkRefused(o), `${set}: ${JSON.stringify(o)}`).toBe(true)
      }
    }))

  it('audit_log: entity and action are 1..64 chars', () =>
    actAs(SUPERUSER, async (s) => {
      const ins = (entity: string, action: string) =>
        s.attempt(
          `insert into themis.audit_log (workspace_id, entity, action) values ($1, $2, $3)`,
          [WA, entity, action],
        )
      expect(checkRefused(await ins('', 'insert'), 'audit_log_entity_check')).toBe(true)
      expect(checkRefused(await ins('decision', ''), 'audit_log_action_check')).toBe(true)
      expect(checkRefused(await ins('x'.repeat(65), 'insert'), 'audit_log_entity_check')).toBe(true)
      expect(await ins('x'.repeat(64), 'y'.repeat(64))).toEqual(OK)
    }))
})

describe('AI/billing/audit (P1.7): updated_at and cascades', () => {
  it.each([
    ['ai_runs', `status = 'failed'`, `id = '${AR.A}'`],
    ['subscriptions', `seats = 2`, `id = '${SUB.A}'`],
    ['usage_monthly', `ai_runs = 3`, `workspace_id = '${WA}'`],
  ])('an UPDATE on themis.%s bumps updated_at', (t, set, where) =>
    actAs(SUPERUSER, async (s) => {
      expect(await s.count(t, `${where} and updated_at = '${OLD}'`)).toBe(1)
      await s.rows(`update themis.${t} set ${set} where ${where}`)
      expect(
        await s.count(t, `${where} and updated_at > '${OLD}'::timestamptz + interval '1 day'`),
      ).toBe(1)
    }),
  )

  it('an UPDATE on themis.plans bumps updated_at', () =>
    actAs(SUPERUSER, async (s) => {
      const [before] = await s.rows<{ u: string }>(
        `select updated_at::text as u from themis.plans where key = 'free'`,
      )
      await s.rows(`update themis.plans set members_max = 2 where key = 'free'`)
      expect(
        await s.count('plans', `key = 'free' and updated_at > '${before.u}'::timestamptz`),
      ).toBe(1)
    }))

  it("the owner deleting workspace A removes A's runs, subscription, usage and audit rows; B intact", () =>
    actAs(U.ownerA, async (s) => {
      expect(await s.attempt(`delete from themis.workspaces where id = $1`, [WA])).toEqual({
        ok: true,
        affected: 1,
      })
      await s.sudo(async () => {
        for (const t of BILLING_TABLES) {
          expect(await s.count(t, `workspace_id = '${WA}'`), t).toBe(0)
          expect(await s.count(t, `workspace_id = '${WB}'`), t).toBe(1)
        }
        expect(await s.count('plans')).toBe(3)
      })
    }))

  it("deleting a draft decision removes its ai_runs only (not the other decision's, not billing or audit)", () =>
    actAs(U.editorA, async (s) => {
      expect(await s.attempt(`delete from themis.decisions where id = $1`, [D.A])).toEqual({
        ok: true,
        affected: 1,
      })
      await s.sudo(async () => {
        expect(await s.count('ai_runs', `id = '${AR.A}'`)).toBe(0)
        expect(await s.count('ai_runs', `id in ('${AR.AF}', '${AR.B}')`)).toBe(2)
        expect(await s.count('subscriptions', `workspace_id = '${WA}'`)).toBe(1)
        expect(await s.count('usage_monthly', `workspace_id = '${WA}'`)).toBe(1)
        expect(await s.count('audit_log', `workspace_id = '${WA}'`)).toBe(2)
      })
    }))

  it('deleting an auth user nulls ai_runs.created_by, keeping the run', () =>
    actAs(SUPERUSER, async (s) => {
      await s.rows(`delete from auth.users where id = $1`, [U.editorA])
      expect(await s.count('ai_runs', `id = '${AR.A}' and created_by is null`)).toBe(1)
    }))

  // Fixed in 20260928235500_themis_audit_actor_erasure.sql: audit_log.actor is `on delete set null`,
  // and the FK's SET NULL is an UPDATE of audit_log. The append-only trigger now lets exactly that
  // UPDATE through (actor non-null -> NULL, every other column unchanged). Before the fix, deleting
  // ANY auth user who ever acted in a Themis audit row failed with `audit_log_append_only`, which
  // blocked account deletion (spec §7.6) and user deletion on Hephaestus's side of the shared
  // auth.users.
  it('deleting an auth user who is an audit actor keeps the audit row, actor nulled', () =>
    actAs(SUPERUSER, async (s) => {
      const o = await s.attempt(`delete from auth.users where id = $1`, [U.viewerA])
      expect(o, JSON.stringify(o)).toEqual({ ok: true, affected: 1 })
      expect(await s.count('audit_log', `id = '${AU.A1}' and actor is null`)).toBe(1)
    }))
})

describe('AI/billing/audit (actor-erasure fix): the audit actor may be erased, nothing else changes', () => {
  /** audit_log row `id` as text, every column except actor (for "nothing else changed"). */
  const rest = (s: Session, id: string) =>
    s.sudo(async () => {
      const [r] = await s.rows<{ j: string }>(
        `select (to_jsonb(a) - 'actor')::text as j from themis.audit_log a where id = $1`,
        [id],
      )
      return r.j
    })

  it('an UPDATE that nulls actor AND changes another column is refused, even for the superuser', () =>
    actAs(SUPERUSER, async (s) => {
      const before = await snapshot(s, 'audit_log', 'true')
      for (const set of [
        `actor = null, action = 'rewritten'`,
        `actor = null, after = '{"body":"forged"}'`,
        `actor = null, at = now() - interval '1 day'`,
        `actor = null, workspace_id = '${WB}'`,
      ]) {
        const o = await s.attempt(`update themis.audit_log set ${set} where id = $1`, [AU.A1])
        expect(o.ok, set).toBe(false)
        expect(!o.ok && o.error, set).toMatch(/audit_log_append_only/)
      }
      expect(await snapshot(s, 'audit_log', 'true')).toEqual(before)
    }))

  it('the same UPDATE is refused for service_role (no UPDATE grant), with the rows unchanged', () =>
    actAs(SERVICE, async (s) => {
      const before = await snapshot(s, 'audit_log', 'true')
      const o = await s.attempt(
        `update themis.audit_log set actor = null, action = 'rewritten' where id = $1`,
        [AU.A1],
      )
      expect(refused(o), JSON.stringify(o)).toBe(true)
      expect(await snapshot(s, 'audit_log', 'true')).toEqual(before)
    }))

  it('a direct UPDATE re-pointing actor to another (non-null) user is refused', () =>
    actAs(SUPERUSER, async (s) => {
      const before = await snapshot(s, 'audit_log', 'true')
      const o = await s.attempt(`update themis.audit_log set actor = $2 where id = $1`, [
        AU.A1,
        U.ownerA,
      ])
      expect(o.ok).toBe(false)
      expect(!o.ok && o.error).toMatch(/audit_log_append_only/)
      // Nor may an actor be written into a row that has none.
      const fill = await s.attempt(`update themis.audit_log set actor = $2 where id = $1`, [
        AU.A2,
        U.ownerA,
      ])
      expect(!fill.ok && fill.error).toMatch(/audit_log_append_only/)
      // A no-op UPDATE of a row with no actor is still an UPDATE: refused.
      const noop = await s.attempt(`update themis.audit_log set actor = null where id = $1`, [
        AU.A2,
      ])
      expect(!noop.ok && noop.error).toMatch(/audit_log_append_only/)
      expect(await snapshot(s, 'audit_log', 'true')).toEqual(before)
    }))

  it('an auth admin with DELETE on auth.users and NO privilege on audit_log deletes an actor: the row survives, actor NULL, all else unchanged', () =>
    actAs(SUPERUSER, async (s) => {
      // Stand-in for Supabase's auth admin (and for Hephaestus deleting a user): it may delete
      // auth.users and holds nothing on themis. The FK action runs as audit_log's owner, so no
      // role needs UPDATE on audit_log for the SET NULL to happen.
      await s.rows(`create role themis_test_auth_admin nologin`)
      await s.rows(`grant usage on schema auth to themis_test_auth_admin`)
      await s.rows(`grant select, delete on auth.users to themis_test_auth_admin`)
      const [p] = await s.rows<{ upd: boolean; usage: boolean }>(
        `select has_table_privilege('themis_test_auth_admin', 'themis.audit_log', 'UPDATE') as upd,
                has_schema_privilege('themis_test_auth_admin', 'themis', 'USAGE') as usage`,
      )
      expect(p).toEqual({ upd: false, usage: false })
      for (const r of ['anon', 'authenticated', 'service_role'])
        expect(
          (
            await s.rows<{ u: boolean }>(
              `select has_table_privilege($1, 'themis.audit_log', 'UPDATE') as u`,
              [r],
            )
          )[0].u,
          r,
        ).toBe(false)

      const restA1 = await rest(s, AU.A1)
      const others = await snapshot(s, 'audit_log', `id <> '${AU.A1}'`)
      await s.rows(`set local role themis_test_auth_admin`)
      const o = await s.attempt(`delete from auth.users where id = $1`, [U.viewerA])
      await s.rows(`reset role`)
      expect(o, JSON.stringify(o)).toEqual({ ok: true, affected: 1 })
      expect(await s.count('audit_log', `id = '${AU.A1}' and actor is null`)).toBe(1)
      expect(await rest(s, AU.A1)).toBe(restA1)
      expect(await snapshot(s, 'audit_log', `id <> '${AU.A1}'`)).toEqual(others)
    }))

  it("deleting B's owner (an actor) nulls only B1's actor; A's audit rows are untouched", () =>
    actAs(SUPERUSER, async (s) => {
      const a = await snapshot(s, 'audit_log', `workspace_id = '${WA}'`)
      const restB1 = await rest(s, AU.B1)
      const o = await s.attempt(`delete from auth.users where id = $1`, [U.ownerB])
      expect(o, JSON.stringify(o)).toEqual({ ok: true, affected: 1 })
      expect(await s.count('audit_log', `id = '${AU.B1}' and actor is null`)).toBe(1)
      expect(await rest(s, AU.B1)).toBe(restB1)
      expect(await snapshot(s, 'audit_log', `workspace_id = '${WA}'`)).toEqual(a)
    }))
})
