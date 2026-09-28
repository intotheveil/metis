// @vitest-environment node
//
// P1.4 — tenancy contract: themis.profiles, workspaces, memberships, invites.
// P1.5 — the decisions enums match src/lib/decision.ts (the rest of P1.5 is the test-writer's).
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

/**
 * The isolation matrix. `ofA` selects workspace A's rows (rows UB must never see or change);
 * `probe` is a SET clause an attacker would try. P1.5+ appends its tables here.
 */
const TENANT_TABLES: { table: Table; ofA: string; probe: string }[] = [
  { table: 'workspaces', ofA: `id = '${WA}'`, probe: `name = 'pwned'` },
  { table: 'memberships', ofA: `workspace_id = '${WA}'`, probe: `role = 'viewer'` },
  { table: 'invites', ofA: `workspace_id = '${WA}'`, probe: `role = 'owner'` },
  {
    table: 'profiles',
    ofA: `user_id in (${A_ONLY_USERS.map((u) => `'${u}'`).join(',')})`,
    probe: `display_name = 'pwned'`,
  },
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
