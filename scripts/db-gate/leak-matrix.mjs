// THE LEAK MATRIX and its fixture, shared by `npm run db:gate` (scripts/db-gate.mjs) and the Vitest
// suite (scripts/db-tenancy.test.ts). One fixture, one harness, one matrix: the gate and the tests
// cannot drift apart on what "workspace A's rows" means.
//
// Fixture: workspaces A and B. A has an owner (UA), an admin, an editor and a viewer; B has an owner
// (UB). Every tenant table holds rows of both workspaces (see seedFixture). `loner` is signed up but
// belongs to no workspace and has no profile yet.
//
// LEAK_MATRIX has ONE entry per `themis` table except SERVICE_ONLY_TABLES. The gate derives the
// table list from the catalogue and FAILS on any table without an entry, so a new table cannot be
// silently skipped. Adding a table = adding its entry here (and its rows to seedFixture).
//
// Harness: `createHarness(db).actAs(who, s => …)` runs `fn` in a transaction that is ALWAYS rolled
// back, as a signed-in user (uuid), ANON, SERVICE (service_role, BYPASSRLS) or SUPERUSER.
// `s.attempt` wraps one statement in a savepoint, so a refused write does not abort the session.

// --- fixture identities ----------------------------------------------------------------------
export const U = Object.freeze({
  ownerA: '00000000-0000-4000-8000-0000000000a1',
  adminA: '00000000-0000-4000-8000-0000000000a2',
  editorA: '00000000-0000-4000-8000-0000000000a3',
  viewerA: '00000000-0000-4000-8000-0000000000a4',
  ownerB: '00000000-0000-4000-8000-0000000000b1',
  loner: '00000000-0000-4000-8000-0000000000c1', // signed up, no workspace, no profile yet
})
export const WA = '10000000-0000-4000-8000-00000000000a'
export const WB = '10000000-0000-4000-8000-00000000000b'
export const A_ONLY_USERS = [U.ownerA, U.adminA, U.editorA, U.viewerA]
export const OLD = '2000-01-01T00:00:00Z' // fixture updated_at, so a trigger bump is unmistakable

// --- P1.5 decision core ------------------------------------------------------------------------
// Workspace A: draft decision DA (options OA1, OA2; criteria CA1, CA2; scored cells OA1×CA1 and
// OA2×CA1, so OA1×CA2 and OA2×CA2 are free) and a frozen, approved decision DAF (OF1 × CF1 scored).
// Workspace B: draft decision DB_ (OB1 × CB1 scored).
export const D = Object.freeze({
  A: '20000000-0000-4000-8000-00000000000a',
  AF: '20000000-0000-4000-8000-0000000000af',
  B: '20000000-0000-4000-8000-00000000000b',
})
export const LINEAGE_A = '21000000-0000-4000-8000-00000000000a'
export const O = Object.freeze({
  A1: '30000000-0000-4000-8000-0000000000a1',
  A2: '30000000-0000-4000-8000-0000000000a2',
  F1: '30000000-0000-4000-8000-0000000000f1',
  B1: '30000000-0000-4000-8000-0000000000b1',
})
export const C = Object.freeze({
  A1: '40000000-0000-4000-8000-0000000000a1',
  A2: '40000000-0000-4000-8000-0000000000a2',
  F1: '40000000-0000-4000-8000-0000000000f1',
  B1: '40000000-0000-4000-8000-0000000000b1',
})

// --- P1.6 analysis -----------------------------------------------------------------------------
// Workspace A: SWOT SA1 (decision-level on DA, quadrant s) and SA2 (on OA1, quadrant w); risks
// RA1 (OA1) and RA2 (OA2); comment CMA on DA written by the EDITOR; approvals APA (DA, rejected,
// by admin) and APAF (DAF, approved, by owner). Workspace B: one of each on DB_/OB1 by ownerB.
export const SW = Object.freeze({
  A1: '50000000-0000-4000-8000-0000000000a1',
  A2: '50000000-0000-4000-8000-0000000000a2',
  B1: '50000000-0000-4000-8000-0000000000b1',
})
export const RK = Object.freeze({
  A1: '60000000-0000-4000-8000-0000000000a1',
  A2: '60000000-0000-4000-8000-0000000000a2',
  B1: '60000000-0000-4000-8000-0000000000b1',
})
export const CM = Object.freeze({
  A: '70000000-0000-4000-8000-0000000000a1',
  B: '70000000-0000-4000-8000-0000000000b1',
})
export const AP = Object.freeze({
  A: '80000000-0000-4000-8000-0000000000a1',
  AF: '80000000-0000-4000-8000-0000000000af',
  B: '80000000-0000-4000-8000-0000000000b1',
})

// --- P1.7 AI, billing and audit ----------------------------------------------------------------
// Workspace A: ai_runs ARA (on DA, by the editor) and ARAF (on DAF); a Pro subscription; one
// usage_monthly row for 2026-09; two audit rows (one by the VIEWER, one with no actor). Workspace
// B: one of each (free subscription). No audit row names ownerA/adminA/editorA as actor: the
// P1.4-P1.6 user-deletion tests delete those users (see the P1.7 cascade tests for why).
export const AR = Object.freeze({
  A: '90000000-0000-4000-8000-0000000000a1',
  AF: '90000000-0000-4000-8000-0000000000af',
  B: '90000000-0000-4000-8000-0000000000b1',
})
export const SUB = Object.freeze({
  A: '91000000-0000-4000-8000-0000000000a1',
  B: '91000000-0000-4000-8000-0000000000b1',
})
export const AU = Object.freeze({
  A1: '92000000-0000-4000-8000-0000000000a1',
  A2: '92000000-0000-4000-8000-0000000000a2',
  B1: '92000000-0000-4000-8000-0000000000b1',
})
export const MONTH = '2026-09-01'

/**
 * Seed the fixture, committed, as the superuser (every test/gate write is rolled back by actAs).
 * @param {import('@electric-sql/pglite').PGlite} db
 */
export async function seedFixture(db) {
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
    insert into themis.swot_items (id, workspace_id, decision_id, option_id, quadrant, text,
                                   created_by, updated_at) values
      ('${SW.A1}', '${WA}', '${D.A}', null, 's', 'Decision-level strength', '${U.editorA}', '${OLD}'),
      ('${SW.A2}', '${WA}', '${D.A}', '${O.A1}', 'w', 'A1 weakness', '${U.editorA}', '${OLD}'),
      ('${SW.B1}', '${WB}', '${D.B}', '${O.B1}', 'o', 'B1 opportunity', '${U.ownerB}', '${OLD}');
    insert into themis.risks (id, workspace_id, decision_id, option_id, title, likelihood, impact,
                              created_by, updated_at) values
      ('${RK.A1}', '${WA}', '${D.A}', '${O.A1}', 'Vendor lock-in', 4, 5, '${U.editorA}', '${OLD}'),
      ('${RK.A2}', '${WA}', '${D.A}', '${O.A2}', 'Slow hiring', 2, 3, '${U.editorA}', '${OLD}'),
      ('${RK.B1}', '${WB}', '${D.B}', '${O.B1}', 'B risk', 3, 3, '${U.ownerB}', '${OLD}');
    insert into themis.comments (id, workspace_id, decision_id, body, author, created_by,
                                 updated_at) values
      ('${CM.A}', '${WA}', '${D.A}', 'Editor comment', '${U.editorA}', '${U.editorA}', '${OLD}'),
      ('${CM.B}', '${WB}', '${D.B}', 'B comment', '${U.ownerB}', '${U.ownerB}', '${OLD}');
    insert into themis.approvals (id, workspace_id, decision_id, verdict, reason, actor, created_by,
                                  updated_at) values
      ('${AP.A}', '${WA}', '${D.A}', 'rejected', 'Not ready', '${U.adminA}', '${U.adminA}', '${OLD}'),
      ('${AP.AF}', '${WA}', '${D.AF}', 'approved', 'Go', '${U.ownerA}', '${U.ownerA}', '${OLD}'),
      ('${AP.B}', '${WB}', '${D.B}', 'approved', 'B go', '${U.ownerB}', '${U.ownerB}', '${OLD}');
    insert into themis.ai_runs (id, workspace_id, decision_id, kind, model, status, input_snapshot,
                                output, tokens_in, tokens_out, cost_eur, created_by, updated_at) values
      ('${AR.A}', '${WA}', '${D.A}', 'challenge', 'model-x', 'succeeded', '{"q":"A"}',
       '{"s":[]}', 100, 50, 0.0123, '${U.editorA}', '${OLD}'),
      ('${AR.AF}', '${WA}', '${D.AF}', 'explain', 'model-x', 'succeeded', '{"q":"AF"}',
       '{"s":[]}', 80, 40, 0.0100, '${U.ownerA}', '${OLD}'),
      ('${AR.B}', '${WB}', '${D.B}', 'challenge', 'model-x', 'succeeded', '{"q":"B"}',
       '{"s":[]}', 90, 30, 0.0090, '${U.ownerB}', '${OLD}');
    insert into themis.subscriptions (id, workspace_id, stripe_customer_id, stripe_subscription_id,
                                      plan, seats, status, updated_at) values
      ('${SUB.A}', '${WA}', 'cus_A1', 'sub_A1', 'pro', 1, 'active', '${OLD}'),
      ('${SUB.B}', '${WB}', null, null, 'free', 1, 'active', '${OLD}');
    insert into themis.usage_monthly (workspace_id, month, ai_runs, ai_cost_eur, updated_at) values
      ('${WA}', '${MONTH}', 2, 0.0223, '${OLD}'),
      ('${WB}', '${MONTH}', 1, 0.0090, '${OLD}');
    insert into themis.audit_log (id, workspace_id, actor, entity, entity_id, action, after) values
      ('${AU.A1}', '${WA}', '${U.viewerA}', 'comment', gen_random_uuid(), 'insert', '{"body":"x"}'),
      ('${AU.A2}', '${WA}', null, 'subscription', '${SUB.A}', 'update', '{"plan":"pro"}'),
      ('${AU.B1}', '${WB}', '${U.ownerB}', 'decision', '${D.B}', 'insert', '{}');
  `)
}

// --- P2.7 RPC fixture --------------------------------------------------------------------------
// The P2.5/P2.6 RPC checks need three more signed-up users than seedFixture has. They are NOT in the
// committed fixture (the leak matrix and the Vitest suite count auth.users-backed rows): each RPC
// check adds them inside its own rolled-back actAs with `addRpcUsers(s)`.
//   invitee     confirmed, mixed-case address (accept compares lower-cased)
//   unverified  email_confirmed_at NULL, set EXPLICITLY: the shim's column defaults to now(), real
//               Supabase's has no default (BRAIN §5)
//   owner2      a second owner for the two-owner paths
export const RPC_USERS = Object.freeze({
  invitee: '00000000-0000-4000-8000-0000000000d1',
  unverified: '00000000-0000-4000-8000-0000000000d2',
  owner2: '00000000-0000-4000-8000-0000000000d3',
})
export const INVITEE_EMAIL = 'invitee@example.com'
export const UNVERIFIED_EMAIL = 'unverified@example.com'

/**
 * Every client RPC of P2.5/P2.6, by regprocedure signature: SECURITY DEFINER, `search_path = ''`,
 * EXECUTE for authenticated only. `call` is a well-formed call anon/service_role must be refused.
 * @type {readonly { name: string, sig: string, call: string }[]}
 */
export const CLIENT_RPCS = Object.freeze([
  { name: 'bootstrap_me', sig: 'themis.bootstrap_me()', call: `select themis.bootstrap_me()` },
  {
    name: 'import_local_decision',
    sig: 'themis.import_local_decision(uuid,jsonb)',
    call: `select themis.import_local_decision('${WA}', '{}'::jsonb)`,
  },
  {
    name: 'create_invite',
    sig: 'themis.create_invite(uuid,text,text)',
    call: `select themis.create_invite('${WA}', 'x@example.com', 'viewer')`,
  },
  {
    name: 'accept_invite',
    sig: 'themis.accept_invite(text)',
    call: `select themis.accept_invite(repeat('a', 64))`,
  },
  {
    name: 'revoke_invite',
    sig: 'themis.revoke_invite(uuid)',
    call: `select themis.revoke_invite(gen_random_uuid())`,
  },
  {
    name: 'set_member_role',
    sig: 'themis.set_member_role(uuid,uuid,text)',
    call: `select themis.set_member_role('${WA}', '${U.viewerA}', 'editor')`,
  },
  {
    name: 'remove_member',
    sig: 'themis.remove_member(uuid,uuid)',
    call: `select themis.remove_member('${WA}', '${U.viewerA}')`,
  },
])

/**
 * Add RPC_USERS to auth.users inside the current (rolled-back) actAs, as the superuser. `s.sudo`
 * restores the actAs identity afterwards (BRAIN §5): re-set any other caller after it.
 * @param {Session} s
 */
export const addRpcUsers = (s) =>
  s.sudo(() =>
    s.rows(
      `insert into auth.users (id, email, email_confirmed_at) values
         ($1, 'Invitee@Example.com', now()),
         ($2, $4, null),
         ($3, 'owner2@example.com', now())`,
      [RPC_USERS.invitee, RPC_USERS.unverified, RPC_USERS.owner2, UNVERIFIED_EMAIL],
    ),
  )

/**
 * Everything Themis must never change in Hephaestus's schemas (public, auth, supabase_migrations):
 * relations, policies, functions and triggers. Take it before AND after the archive is applied.
 * @param {import('@electric-sql/pglite').PGlite} db
 */
export async function foreignSnapshot(db) {
  /** @param {string} sql */
  const q = async (sql) => JSON.stringify((await db.query(sql)).rows)
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

/**
 * The values a single-column `CHECK (col in (...))` on themis.<table> admits, read back from the
 * catalogue and sorted. Returns null unless exactly one such constraint exists.
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {string} table
 * @param {string} column
 * @returns {Promise<string[] | null>}
 */
export async function checkValues(db, table, column) {
  const r = await db.query(
    `select pg_get_constraintdef(c.oid) as def
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.conrelid = $1::regclass and c.contype = 'c'
        and a.attname = $2 and cardinality(c.conkey) = 1`,
    [`themis.${table}`, column],
  )
  if (r.rows.length !== 1) return null
  const def = String(/** @type {{ def: string }} */ (r.rows[0]).def)
  return [...def.matchAll(/'([^']*)'::text/g)].map((m) => m[1]).sort()
}

// --- harness -----------------------------------------------------------------------------------
export const ANON = Symbol('anon')
export const SUPERUSER = Symbol('superuser')
/** The service key (BYPASSRLS): Edge Functions and service-only RPCs (P1.7). */
export const SERVICE = Symbol('service_role')

/** @typedef {string | typeof ANON | typeof SUPERUSER | typeof SERVICE} Who */
/** @typedef {Record<string, unknown>} Row */
/** @typedef {{ ok: true, affected: number } | { ok: false, error: string }} Outcome */
/**
 * @typedef {object} Session
 * @property {<T extends Row = Row>(sql: string, params?: unknown[]) => Promise<T[]>} rows
 *   Rows of a query; throws on error (use `attempt` when an error is the expected outcome).
 * @property {(table: string, where?: string) => Promise<number>} count
 *   Rows of themis.<table> visible to this identity, optionally filtered.
 * @property {(sql: string, params?: unknown[]) => Promise<Outcome>} attempt
 *   Runs one statement inside a savepoint, so a refused write does not abort the session.
 * @property {<T>(fn: () => Promise<T>) => Promise<T>} sudo
 *   Run `fn` as the superuser inside the same (rolled-back) transaction, then switch back.
 */

/** @param {import('@electric-sql/pglite').PGlite} db */
export function createHarness(db) {
  /** @param {Who} who */
  async function setIdentity(who) {
    if (who === SUPERUSER) {
      await db.exec(`reset role`)
      await db.query(`select set_config('request.jwt.claim.sub', '', true)`)
    } else if (who === SERVICE) {
      await db.exec(`set local role service_role`)
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
  /**
   * @param {Who} who
   * @returns {Session}
   */
  const session = (who) => ({
    // reason: `any` because the row type T is the caller's claim about the query's shape.
    rows: async (sql, params) => /** @type {any} */ ((await db.query(sql, params)).rows),
    count: async (table, where = 'true') =>
      /** @type {{ n: number }} */ (
        (await db.query(`select count(*)::int as n from themis.${table} where ${where}`)).rows[0]
      ).n,
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

  /**
   * Act as `who` inside a transaction that is always rolled back.
   * @template T
   * @param {Who} who
   * @param {(s: Session) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function actAs(who, fn) {
    await db.exec('begin')
    try {
      await setIdentity(who)
      return await fn(session(who))
    } finally {
      await db.exec('rollback')
    }
  }

  return { actAs }
}

/** Refused by a privilege check or by RLS (not by a constraint or a typo). @param {Outcome} o */
export const refused = (o) => !o.ok && /permission denied|violates row-level security/.test(o.error)
/** No effect = refused outright, or ran and touched nothing (RLS filtered every row). @param {Outcome} o */
export const noEffect = (o) => refused(o) || (o.ok && o.affected === 0)
/** Refused by a foreign key (the composite tenant FKs). @param {Outcome} o */
export const fkRefused = (o) => !o.ok && o.error.includes('violates foreign key constraint')

/**
 * A content hash of the rows matching `where`, read as superuser (for before/after checks).
 * @param {Session} s
 * @param {string} table
 * @param {string} where
 */
export const snapshot = (s, table, where) =>
  s.sudo(async () => {
    const r = await s.rows(
      `select md5(string_agg(t::text, '|' order by t::text)) as h, count(*)::int as n
         from themis.${table} t where ${where}`,
    )
    return /** @type {{ h: string | null, n: number }} */ (r[0])
  })

// --- the matrix --------------------------------------------------------------------------------

/**
 * Tables that are neither tenant data nor reference data: nothing but the service key and the
 * migration applier touch them. They need no policy, and the gate requires ZERO grants to
 * anon/authenticated on them instead.
 */
export const SERVICE_ONLY_TABLES = ['schema_migrations']

/** The actors of the fixture, by the name the matrix uses. */
export const ACTORS = Object.freeze({
  UA: U.ownerA,
  UB: U.ownerB,
  editor: U.editorA,
  viewer: U.viewerA,
  loner: U.loner,
  service: SERVICE,
})
/** @typedef {keyof typeof ACTORS} Actor */

/**
 * The parents a decision child points at. A's `criterion` is CA2 so that the score cell OA1×CA2
 * is FREE (a duplicate-key error would otherwise fire before the FK — BRAIN §5).
 */
export const PARENTS = Object.freeze({
  A: Object.freeze({ decision: D.A, option: O.A1, criterion: C.A2 }),
  B: Object.freeze({ decision: D.B, option: O.B1, criterion: C.B1 }),
})
/** @typedef {{ decision: string, option: string, criterion: string }} Parents */

/**
 * @typedef {object} TenantEntry
 * @property {string} table
 * @property {'tenant'} kind
 * @property {'workspace' | 'user'} scope  workspace-scoped policies must go through the helpers
 * @property {string} ofA     predicate: workspace A's rows (UB must never see or change them)
 * @property {string} ofB     predicate: workspace B's rows (UB must see all of them)
 * @property {string} probe   a SET clause an attacker would try
 * @property {boolean} viewerReads  whether A's viewer may read A's rows (false = must read zero)
 * @property {string} [viewerOfA]  A's rows the viewer must not change (default ofA)
 * @property {{ as: Actor, sql: string }} write
 *   the legitimate write on A's data. `as: 'service'` = no client may write this table (the
 *   catalogue must agree: authenticated holds no INSERT/UPDATE/DELETE on it).
 * @property {{ as: Actor, sql: string, inserted: string }} insert
 *   an INSERT that would create a row of A, using only columns a client may name. UB must be
 *   refused (privilege or RLS) and `inserted` must stay empty; `as` runs it for real as the
 *   control that proves the statement is valid and only the tenancy boundary stops UB.
 * @property {(p: Parents) => string} [cross]
 *   a decision child with workspace_id = B pointing at a parent of A (p = PARENTS.A). UB must be
 *   refused; the same statement with B's parents (p = PARENTS.B) succeeds as the service key.
 */
/**
 * @typedef {object} ReferenceEntry
 * @property {string} table
 * @property {'reference'} kind
 * @property {number} rows  exact row count every reader (anon included) sees
 * @property {string} probe
 */
/** @typedef {TenantEntry | ReferenceEntry} LeakEntry */

const inA = `workspace_id = '${WA}'`
const inB = `workspace_id = '${WB}'`
/** Rows a cross-workspace child insert would leave: B's workspace, A's decision. */
export const CROSS_INSERTED = `workspace_id = '${WB}' and decision_id = '${D.A}'`

/** @type {LeakEntry[]} */
export const LEAK_MATRIX = [
  // --- P1.4 tenancy ---
  {
    table: 'workspaces',
    kind: 'tenant',
    scope: 'workspace',
    ofA: `id = '${WA}'`,
    ofB: `id = '${WB}'`,
    probe: `name = 'pwned'`,
    viewerReads: true,
    write: {
      as: 'UA',
      sql: `update themis.workspaces set name = 'Renamed by A' where id = '${WA}'`,
    },
    // Workspaces are created only by the P2.5 RPC: no client may insert one at all.
    insert: {
      as: 'service',
      sql: `insert into themis.workspaces (name) values ('LEAK')`,
      inserted: `name = 'LEAK'`,
    },
  },
  {
    table: 'memberships',
    kind: 'tenant',
    scope: 'workspace',
    ofA: inA,
    ofB: inB,
    probe: `role = 'viewer'`,
    viewerReads: true,
    write: {
      as: 'service',
      sql: `update themis.memberships set role = 'editor' where ${inA} and user_id = '${U.viewerA}'`,
    },
    insert: {
      as: 'service',
      sql: `insert into themis.memberships (workspace_id, user_id, role) values ('${WA}', '${U.ownerB}', 'owner')`,
      inserted: `${inA} and user_id = '${U.ownerB}'`,
    },
  },
  {
    table: 'invites',
    kind: 'tenant',
    scope: 'workspace',
    ofA: inA,
    ofB: inB,
    probe: `role = 'owner'`,
    viewerReads: false, // admin|owner only
    write: { as: 'service', sql: `update themis.invites set role = 'viewer' where ${inA}` },
    insert: {
      as: 'service',
      sql: `insert into themis.invites (workspace_id, email, role, token_hash, expires_at)
            values ('${WA}', 'leak@example.com', 'owner', repeat('f', 64), now() + interval '1 day')`,
      inserted: `email = 'leak@example.com'`,
    },
  },
  {
    table: 'profiles',
    kind: 'tenant',
    scope: 'user',
    ofA: `user_id in (${A_ONLY_USERS.map((u) => `'${u}'`).join(',')})`,
    ofB: `user_id = '${U.ownerB}'`,
    probe: `display_name = 'pwned'`,
    viewerReads: true,
    viewerOfA: `user_id in ('${U.ownerA}', '${U.adminA}', '${U.editorA}')`, // not their own
    write: {
      as: 'UA',
      sql: `update themis.profiles set display_name = 'Me' where user_id = '${U.ownerA}'`,
    },
    // A profile for someone else: only that user may create it.
    insert: {
      as: 'loner',
      sql: `insert into themis.profiles (user_id, display_name) values ('${U.loner}', 'LEAK')`,
      inserted: `display_name = 'LEAK'`,
    },
  },
  // --- P1.5 decision core ---
  {
    table: 'decisions',
    kind: 'tenant',
    scope: 'workspace',
    ofA: inA,
    ofB: inB,
    probe: `question = 'pwned'`,
    viewerReads: true,
    write: {
      as: 'UA',
      sql: `update themis.decisions set question = 'Renamed by A' where id = '${D.A}'`,
    },
    insert: {
      as: 'UA',
      sql: `insert into themis.decisions (workspace_id, question, methodology, scale)
            values ('${WA}', 'LEAK', 'agile', 'mid')`,
      inserted: `question = 'LEAK'`,
    },
  },
  {
    table: 'options',
    kind: 'tenant',
    scope: 'workspace',
    ofA: inA,
    ofB: inB,
    probe: `name = 'pwned'`,
    viewerReads: true,
    write: {
      as: 'UA',
      sql: `update themis.options set name = 'Renamed by A' where id = '${O.A1}'`,
    },
    insert: {
      as: 'UA',
      sql: `insert into themis.options (workspace_id, decision_id, name, position)
            values ('${WA}', '${D.A}', 'LEAK', 9)`,
      inserted: `name = 'LEAK'`,
    },
    cross: (p) =>
      `insert into themis.options (workspace_id, decision_id, name, position)
       values ('${WB}', '${p.decision}', 'LEAK', 9)`,
  },
  {
    table: 'criteria',
    kind: 'tenant',
    scope: 'workspace',
    ofA: inA,
    ofB: inB,
    probe: `weight = 0`,
    viewerReads: true,
    write: { as: 'UA', sql: `update themis.criteria set weight = 1 where id = '${C.A1}'` },
    insert: {
      as: 'UA',
      sql: `insert into themis.criteria (workspace_id, decision_id, name, weight, position)
            values ('${WA}', '${D.A}', 'LEAK', 3, 9)`,
      inserted: `name = 'LEAK'`,
    },
    cross: (p) =>
      `insert into themis.criteria (workspace_id, decision_id, name, weight, position)
       values ('${WB}', '${p.decision}', 'LEAK', 3, 9)`,
  },
  {
    table: 'scores',
    kind: 'tenant',
    scope: 'workspace',
    ofA: inA,
    ofB: inB,
    probe: `value = 1`,
    viewerReads: true,
    write: {
      as: 'UA',
      sql: `update themis.scores set value = 1 where option_id = '${O.A1}' and criterion_id = '${C.A1}'`,
    },
    insert: {
      as: 'UA',
      sql: `insert into themis.scores (workspace_id, decision_id, option_id, criterion_id, value)
            values ('${WA}', '${D.A}', '${O.A1}', '${C.A2}', 5)`,
      inserted: `option_id = '${O.A1}' and criterion_id = '${C.A2}'`,
    },
    // B has no free cell, so the control upserts B's one scored cell (affected 1); A's cell is free,
    // so the attack takes the INSERT path and meets the composite FK.
    cross: (p) =>
      `insert into themis.scores (workspace_id, decision_id, option_id, criterion_id, value)
       values ('${WB}', '${p.decision}', '${p.option}', '${p.criterion}', 5)
       on conflict (option_id, criterion_id) do update set value = excluded.value`,
  },
  // --- P1.6 analysis and collaboration ---
  {
    table: 'swot_items',
    kind: 'tenant',
    scope: 'workspace',
    ofA: inA,
    ofB: inB,
    probe: `text = 'pwned'`,
    viewerReads: true,
    write: {
      as: 'UA',
      sql: `update themis.swot_items set text = 'Edited by A' where id = '${SW.A1}'`,
    },
    insert: {
      as: 'UA',
      sql: `insert into themis.swot_items (workspace_id, decision_id, option_id, quadrant, text)
            values ('${WA}', '${D.A}', null, 's', 'LEAK')`,
      inserted: `text = 'LEAK'`,
    },
    cross: (p) =>
      `insert into themis.swot_items (workspace_id, decision_id, option_id, quadrant, text)
       values ('${WB}', '${p.decision}', '${p.option}', 's', 'LEAK')`,
  },
  {
    table: 'risks',
    kind: 'tenant',
    scope: 'workspace',
    ofA: inA,
    ofB: inB,
    probe: `likelihood = 1`,
    viewerReads: true,
    write: { as: 'UA', sql: `update themis.risks set likelihood = 1 where id = '${RK.A1}'` },
    insert: {
      as: 'UA',
      sql: `insert into themis.risks (workspace_id, decision_id, option_id, title, likelihood, impact)
            values ('${WA}', '${D.A}', '${O.A1}', 'LEAK', 1, 1)`,
      inserted: `title = 'LEAK'`,
    },
    cross: (p) =>
      `insert into themis.risks (workspace_id, decision_id, option_id, title, likelihood, impact)
       values ('${WB}', '${p.decision}', '${p.option}', 'LEAK', 1, 1)`,
  },
  {
    table: 'comments',
    kind: 'tenant',
    scope: 'workspace',
    ofA: inA,
    ofB: inB,
    probe: `body = 'pwned'`,
    viewerReads: true,
    // Only a comment's author edits it (P1.6): the fixture comment is the editor's.
    write: { as: 'editor', sql: `update themis.comments set body = 'Edited' where id = '${CM.A}'` },
    insert: {
      as: 'UA',
      sql: `insert into themis.comments (workspace_id, decision_id, body) values ('${WA}', '${D.A}', 'LEAK')`,
      inserted: `body = 'LEAK'`,
    },
    cross: (p) =>
      `insert into themis.comments (workspace_id, decision_id, body) values ('${WB}', '${p.decision}', 'LEAK')`,
  },
  {
    table: 'approvals',
    kind: 'tenant',
    scope: 'workspace',
    ofA: inA,
    ofB: inB,
    probe: `reason = 'pwned'`,
    viewerReads: true,
    // Append-only: admin|owner INSERT is the only client write there is.
    write: {
      as: 'UA',
      sql: `insert into themis.approvals (workspace_id, decision_id, verdict, reason)
            values ('${WA}', '${D.A}', 'approved', 'Approved by A')`,
    },
    insert: {
      as: 'UA',
      sql: `insert into themis.approvals (workspace_id, decision_id, verdict, reason)
            values ('${WA}', '${D.A}', 'approved', 'LEAK')`,
      inserted: `reason = 'LEAK'`,
    },
    cross: (p) =>
      `insert into themis.approvals (workspace_id, decision_id, verdict, reason)
       values ('${WB}', '${p.decision}', 'approved', 'LEAK')`,
  },
  // --- P1.7 AI, billing, audit (server-written) ---
  {
    table: 'ai_runs',
    kind: 'tenant',
    scope: 'workspace',
    ofA: inA,
    ofB: inB,
    probe: `accepted = '["pwned"]'`,
    viewerReads: true,
    write: {
      as: 'service',
      sql: `update themis.ai_runs set status = 'failed' where id = '${AR.A}'`,
    },
    insert: {
      as: 'service',
      sql: `insert into themis.ai_runs (workspace_id, decision_id, kind, model, input_snapshot)
            values ('${WA}', '${D.A}', 'challenge', 'LEAK', '{}')`,
      inserted: `model = 'LEAK'`,
    },
    cross: (p) =>
      `insert into themis.ai_runs (workspace_id, decision_id, kind, model, input_snapshot)
       values ('${WB}', '${p.decision}', 'challenge', 'LEAK', '{}')`,
  },
  {
    table: 'subscriptions',
    kind: 'tenant',
    scope: 'workspace',
    ofA: inA,
    ofB: inB,
    probe: `plan = 'free'`,
    viewerReads: true,
    write: { as: 'service', sql: `update themis.subscriptions set seats = 2 where ${inA}` },
    // One subscription per workspace: the control upserts A's (affected 1).
    insert: {
      as: 'service',
      sql: `insert into themis.subscriptions (workspace_id, plan, status) values ('${WA}', 'team', 'active')
            on conflict (workspace_id) do update set plan = excluded.plan`,
      inserted: `${inA} and plan = 'team'`,
    },
  },
  {
    table: 'usage_monthly',
    kind: 'tenant',
    scope: 'workspace',
    ofA: inA,
    ofB: inB,
    probe: `ai_runs = 0`,
    viewerReads: true,
    write: { as: 'service', sql: `update themis.usage_monthly set ai_runs = 5 where ${inA}` },
    insert: {
      as: 'service',
      sql: `insert into themis.usage_monthly (workspace_id, month) values ('${WA}', '2026-10-01')`,
      inserted: `${inA} and month = '2026-10-01'`,
    },
  },
  {
    table: 'audit_log',
    kind: 'tenant',
    scope: 'workspace',
    ofA: inA,
    ofB: inB,
    probe: `action = 'pwned'`,
    viewerReads: false, // admin|owner only
    write: {
      as: 'service',
      sql: `insert into themis.audit_log (workspace_id, entity, action) values ('${WA}', 'gate', 'insert')`,
    },
    insert: {
      as: 'service',
      sql: `insert into themis.audit_log (workspace_id, entity, action) values ('${WA}', 'gate', 'LEAK')`,
      inserted: `action = 'LEAK'`,
    },
  },
  // --- reference data ---
  { table: 'plans', kind: 'reference', rows: 3, probe: `min_seats = 99` },
]
