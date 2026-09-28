// @vitest-environment node
//
// P1.3 — the static migration guard. Every rule gets a RED fixture (asserting the rule id AND the
// line it is reported on) and, where the rule has an allowed form, a GREEN fixture. Fixture SQL
// lives here as string literals on purpose (BRAIN.md §5: the guard hook blocks destructive-looking
// shell command text). Directory tests write into an OS temp dir via node:fs, never the archive.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FILENAME_RE,
  checkMigrationSql,
  checkMigrationsDir,
  formatViolation,
  maskLiterals,
  runGuard,
  stripComments,
} from './check-migrations.mjs'

const GOOD_NAME = '20260928210000_themis_fixture.sql'
const ARCHIVE = fileURLToPath(new URL('../supabase/migrations', import.meta.url))

/** Join lines with \n so a fixture's line numbers are the array index + 1. */
const sql = (...lines: string[]) => lines.join('\n')

/** The guard's verdict reduced to what matters: which rule fired, on which line. */
const hits = (text: string, file = GOOD_NAME) =>
  checkMigrationSql(file, text).map(({ rule, line }) => ({ rule, line }))

describe('forbidden-schema', () => {
  it('flags DDL into public.* with the line it is on', () => {
    const text = sql(
      '-- a migration that reaches next door',
      'create table themis.ok (id int);',
      'create table public.leak (id int);',
    )
    expect(hits(text)).toEqual([{ rule: 'forbidden-schema', line: 3 }])
  })

  it('flags a write into auth.*', () => {
    const text = sql(
      'create table themis.ok (id int);',
      '',
      "insert into auth.users (id) values ('x');",
    )
    expect(hits(text)).toEqual([{ rule: 'forbidden-schema', line: 3 }])
  })

  it('flags a policy on storage.*', () => {
    const text = sql('create policy p on storage.objects for select using (true);')
    expect(hits(text)).toEqual([{ rule: 'forbidden-schema', line: 1 }])
  })

  it('flags a write into supabase_migrations.*', () => {
    const text = sql(
      'create table themis.ok (id int);',
      "insert into supabase_migrations.schema_migrations (version) values ('1');",
    )
    expect(hits(text)).toEqual([{ rule: 'forbidden-schema', line: 2 }])
  })

  it('is case-insensitive and sees through quoted identifiers', () => {
    expect(hits('CREATE TABLE PUBLIC.Leak (id int);')).toEqual([
      { rule: 'forbidden-schema', line: 1 },
    ])
    expect(hits('create table "public"."leak" (id int);')).toEqual([
      { rule: 'forbidden-schema', line: 1 },
    ])
  })

  it('does not match a forbidden name embedded in a longer identifier', () => {
    // `themis.public_notes` is a themis table, not a reference into public.
    expect(hits('create table themis.public_notes (id int);')).toEqual([])
  })

  it('still catches a reference hidden in a string literal (execute ...)', () => {
    const text = sql('do $$', 'begin', "  execute 'delete from public.tasks';", 'end', '$$;')
    expect(hits(text)).toEqual([{ rule: 'forbidden-schema', line: 3 }])
  })

  it('does NOT flag forbidden schemas that only appear in comments', () => {
    const text = sql(
      '-- Mirrors public.profiles but lives in themis; never touches auth.users.',
      '/* storage.objects and supabase_migrations.schema_migrations',
      '   belong to Hephaestus. /* nested: public.tasks */ still a comment */',
      'create table themis.profiles (id int); -- not public.profiles',
    )
    expect(hits(text)).toEqual([])
  })

  it('flags `schema public` in a grant', () => {
    const text = sql('create table themis.ok (id int);', 'grant usage on schema public to anon;')
    expect(hits(text)).toEqual([{ rule: 'forbidden-schema', line: 2 }])
  })

  it('flags a search_path that names public', () => {
    const text = sql(
      'create or replace function themis.f() returns int language sql',
      'set search_path = themis, public',
      'as $f$ select 1 $f$;',
    )
    expect(hits(text)).toEqual([{ rule: 'forbidden-schema', line: 2 }])
  })

  it("allows a search_path pinned to ''", () => {
    const text = sql(
      'create or replace function themis.f() returns int language sql',
      "set search_path = ''",
      'as $f$ select 1 $f$;',
    )
    expect(hits(text)).toEqual([])
  })
})

describe('the two allowed auth forms', () => {
  it('allows `references auth.users` and `auth.uid()`', () => {
    const text = sql(
      'create table themis.profiles (',
      '  user_id uuid primary key references auth.users on delete cascade',
      ');',
      'create policy own on themis.profiles for select using (user_id = auth.uid());',
      'create policy own2 on themis.profiles for update using (user_id = auth.uid ( ));',
    )
    expect(hits(text)).toEqual([])
  })

  it('does not stretch the allow-list to other auth references', () => {
    // a view publishing auth.users (not a plain read), auth.uid without a call, another auth function.
    const text = sql(
      'create view themis.v as select id from auth.users;',
      'create policy p on themis.t using (auth.jwt() is not null);',
      'create policy q on themis.t using (x = auth.uid);',
    )
    expect(hits(text)).toEqual([
      { rule: 'forbidden-schema', line: 1 },
      { rule: 'forbidden-schema', line: 2 },
      { rule: 'forbidden-schema', line: 3 },
    ])
  })
})

// B4 (2026-09-29): the P1.3 allow-list gains ONE form, a READ of auth.users written as code
// (`from auth.users` / `join auth.users`), so P2.6's accept_invite can compare the caller's email.
// Every write, lock, publish, string-built or other-table form must stay RED. Each RED case below
// was an attempt to fool the allowance; the line asserted is the auth.users reference.
describe('auth.users READ allowance (B4)', () => {
  const RED = (line: number) => [{ rule: 'forbidden-schema', line }]

  it.each([
    ['select … from', 'select email from auth.users where id = auth.uid();'],
    [
      'upper case, newline before the name',
      'SELECT email FROM\n  auth.users WHERE id = auth.uid();',
    ],
    ['join', 'select m.user_id from themis.memberships m join auth.users u on u.id = m.user_id;'],
    ['left join, quoted', 'select 1 from themis.memberships m left join "auth"."users" u on true;'],
    [
      'exists subquery',
      'select 1 where exists (select 1 from auth.users u where u.id = auth.uid());',
    ],
    ['a comment between from and the name', 'select 1 from /* the caller */ auth.users;'],
    [
      'update themis … from auth.users (writes themis, reads auth)',
      'update themis.invites i set email = lower(u.email) from auth.users u where u.id = i.created_by;',
    ],
  ])('GREEN: %s', (_label, text) => {
    expect(hits(text)).toEqual([])
  })

  it('GREEN: select … into … from auth.users in a PL/pgSQL body (the P2.6 shape)', () => {
    const text = sql(
      'create or replace function themis.f() returns text',
      "language plpgsql security definer set search_path = '' as $fn$",
      'declare my_email text; confirmed timestamptz;',
      'begin',
      '  select pg_catalog.lower(u.email), u.email_confirmed_at',
      '    into my_email, confirmed',
      '    from auth.users u',
      '   where u.id = auth.uid();',
      '  return my_email;',
      'end $fn$;',
    )
    expect(hits(text)).toEqual([])
  })

  it('GREEN: a SQL-language body', () => {
    const text = sql(
      'create or replace function themis.me() returns text language sql stable',
      "set search_path = ''",
      'as $f$ select email from auth.users where id = auth.uid() $f$;',
    )
    expect(hits(text)).toEqual([])
  })

  it('pre-existing: a body on the SAME line as `set search_path` trips the search_path rule', () => {
    // The search_path rule reads to the end of the line, so it sees `auth` in the body. Not a
    // B4 regression (the rule predates it); keep `set search_path` on its own line.
    const text = sql(
      'create or replace function themis.me() returns text language sql stable',
      "set search_path = '' as $f$ select email from auth.users where id = auth.uid() $f$;",
    )
    expect(hits(text)).toEqual(RED(2))
  })

  it.each([
    ['delete from', 'delete from auth.users where id = auth.uid();', 1],
    ['DELETE FROM across a newline', 'DELETE\n  FROM auth.users;', 2],
    ['delete with a comment before from', 'delete /* x */ from auth.users;', 1],
    ['delete from only', 'delete from only auth.users;', 1],
    ['delete from, quoted', 'delete from "auth"."users";', 1],
    [
      'delete in a CTE',
      'with d as (delete from auth.users where id = auth.uid() returning id) select * from d;',
      1,
    ],
    [
      'delete … using auth.users (only `from`/`join` count)',
      'delete from themis.invites i using auth.users u where u.id = i.created_by;',
      1,
    ],
    ['update', "update auth.users set email = 'x' where id = auth.uid();", 1],
    [
      'update with alias … from',
      'update auth.users u set email = i.email from themis.invites i;',
      1,
    ],
    ['insert … select', 'insert into auth.users (id) select created_by from themis.invites;', 1],
    [
      'merge into',
      'merge into auth.users u using themis.invites i on u.id = i.created_by when matched then delete;',
      1,
    ],
    ['alter table', 'alter table auth.users add column themis_flag boolean;', 1],
    ['truncate', 'truncate auth.users;', 1],
    ['truncate table', 'truncate table auth.users;', 1],
    ['lock table', 'lock table auth.users in exclusive mode;', 1],
    ['grant', 'grant select on auth.users to authenticated;', 1],
    ['comma join', 'select 1 from themis.invites i, auth.users u;', 1],
    ['select … for update', 'select email from auth.users where id = auth.uid() for update;', 1],
    ['select … for share', 'select email from auth.users u for share of u;', 1],
    ['select … for no key update', 'select 1 from auth.users for no key update;', 1],
    ['create table … as', 'create table themis.t as select id, email from auth.users;', 1],
    [
      'create materialized view',
      'create materialized view themis.mv as select email from auth.users;',
      1,
    ],
    [
      'create or replace view',
      'create or replace view themis.v as\n  select email from auth.users;',
      2,
    ],
    ['copy', 'copy (select email from auth.users) to stdout;', 1],
    ['another auth table', 'select * from auth.identities;', 1],
    ['auth.sessions via join', 'select 1 from themis.invites i join auth.sessions s on true;', 1],
  ])('RED: %s', (_label, text, line) => {
    expect(hits(text)).toEqual(RED(line))
  })

  it('RED: a write inside a PL/pgSQL body (the prove-red sabotage shape)', () => {
    const text = sql(
      'create or replace function themis.f() returns void',
      "language plpgsql security definer set search_path = '' as $fn$",
      'begin',
      "  update auth.users set email = 'x' where id = auth.uid();",
      'end $fn$;',
    )
    expect(hits(text)).toEqual(RED(4))
  })

  it('RED: a read that is TEXT for dynamic SQL, however it is spliced', () => {
    const text = sql(
      "do $do$ declare q text := '';",
      'begin',
      "  execute 'select email from auth.users';", // 3: single-quoted
      "  execute 'delete ' || 'from auth.users';", // 4: `delete` split from `from`
      "  execute 'delete '||' from auth.users';", // 5: split, with the space inside
      '  execute $q$delete $q$ || $q$ from auth.users $q$;', // 6: nested dollar quotes
      '  q := $q$ from auth.users $q$;', // 7: built across statements
      "  q := E'delete \\' from auth.users';", // 8: an E'' string with an escaped quote
      'end $do$;',
    )
    expect(hits(text)).toEqual([3, 4, 5, 6, 7, 8].flatMap(RED))
  })

  it('RED: `from` glued to a closing quote does not count as the keyword', () => {
    // A top-level dollar quote is treated as a body (code), so the keyword test must stop it.
    expect(hits('select $q$delete $q$from auth.users;')).toEqual(RED(1))
  })

  it('KNOWN BLIND SPOT (pre-existing, BRAIN.md §5): a target built by format() is not seen', () => {
    // Not a reference to auth.users at all, so neither the old nor the new rule can see it. The
    // guard reads text; the post-apply db:gate checks catch DDL built this way, but NOT a DML
    // statement in a function body that never runs during the gate. Review is the control here.
    const text = sql(
      'do $do$ begin',
      "  execute format('delete from %I.%I', 'au' || 'th', 'users');",
      'end $do$;',
    )
    expect(hits(text)).toEqual([])
  })
})

describe('maskLiterals', () => {
  it('blanks single-quoted and nested dollar strings, keeps bodies and identifiers', () => {
    const src = sql(
      'create function themis.f() returns int language plpgsql as $fn$',
      "begin perform 'a.b'; execute $q$x.y$q$; return 1; end $fn$;",
      'select "auth".users;',
    )
    const out = maskLiterals(src)
    expect(out).toHaveLength(src.length)
    expect(out.split('\n')).toHaveLength(3)
    expect(out).not.toContain('a.b')
    expect(out).not.toContain('x.y')
    expect(out).toContain('$fn$')
    expect(out).toContain('return 1; end $fn$;')
    expect(out).toContain('"auth".users')
  })
})

describe('auth-users-trigger', () => {
  it('flags create trigger ... on auth.users at the create line', () => {
    const text = sql(
      'create table themis.ok (id int);',
      'create trigger on_signup',
      '  after insert on auth.users',
      '  for each row execute function themis.handle_signup();',
    )
    const v = hits(text)
    expect(v).toContainEqual({ rule: 'auth-users-trigger', line: 2 })
    // The auth.users reference itself is also out of bounds (not `references auth.users`).
    expect(v).toContainEqual({ rule: 'forbidden-schema', line: 3 })
    expect(v).toHaveLength(2)
  })

  it('does not flag a trigger on a themis table', () => {
    const text = sql(
      'create trigger touch before update on themis.workspaces',
      '  for each row execute function themis.touch_updated_at();',
    )
    expect(hits(text)).toEqual([])
  })
})

describe('project-wide commands', () => {
  it('create-extension', () => {
    expect(
      hits(sql('create table themis.ok (id int);', 'create extension if not exists pgcrypto;')),
    ).toEqual([{ rule: 'create-extension', line: 2 }])
  })

  it('alter-system', () => {
    expect(hits(sql('', '', "ALTER SYSTEM SET work_mem = '64MB';"))).toEqual([
      { rule: 'alter-system', line: 3 },
    ])
  })

  it('drop-schema (even of themis itself)', () => {
    expect(hits(sql('create table themis.ok (id int);', 'drop schema themis cascade;'))).toEqual([
      { rule: 'drop-schema', line: 2 },
    ])
  })

  it('alter-role, and alter user counts as alter role', () => {
    const text = sql(
      "alter role authenticated set statement_timeout = '5s';",
      "alter user service_role with password 'x';",
    )
    expect(hits(text)).toEqual([
      { rule: 'alter-role', line: 1 },
      { rule: 'alter-role', line: 2 },
    ])
  })
})

describe('default-privileges', () => {
  it('RED: in schema public (also a forbidden-schema reference)', () => {
    const text = sql(
      'create table themis.ok (id int);',
      'alter default privileges in schema public grant select on tables to anon;',
    )
    expect(hits(text)).toEqual([
      { rule: 'default-privileges', line: 2 },
      { rule: 'forbidden-schema', line: 2 },
    ])
  })

  it('RED: no schema at all (applies to every schema the role creates in)', () => {
    expect(hits('alter default privileges grant select on tables to anon;')).toEqual([
      { rule: 'default-privileges', line: 1 },
    ])
  })

  it('GREEN: in schema themis, with or without for role', () => {
    const text = sql(
      'alter default privileges in schema themis revoke execute on functions from public;',
      'alter default privileges for role postgres in schema themis grant select on tables to authenticated;',
    )
    expect(hits(text)).toEqual([])
  })
})

describe('target-outside-themis', () => {
  it('RED: an unqualified create table (it would land in public via search_path)', () => {
    const text = sql('create schema if not exists themis;', '', 'create table workspaces (id int);')
    const v = checkMigrationSql(GOOD_NAME, text)
    expect(v.map(({ rule, line }) => ({ rule, line }))).toEqual([
      { rule: 'target-outside-themis', line: 3 },
    ])
    expect(v[0].message).toContain('themis.workspaces')
  })

  it('RED: unqualified DML and a target in some other schema', () => {
    const text = sql(
      'insert into workspaces (id) values (1);',
      'update workspaces set id = 2;',
      'create table hephaestus.x (id int);',
    )
    expect(hits(text)).toEqual([
      { rule: 'target-outside-themis', line: 1 },
      { rule: 'target-outside-themis', line: 2 },
      { rule: 'target-outside-themis', line: 3 },
    ])
  })

  it('GREEN: a temp table is session-local and allowed', () => {
    expect(hits('create temp table scratch (id int);')).toEqual([])
    expect(hits('create temporary table scratch (id int);')).toEqual([])
  })

  it('GREEN: themis-qualified targets, quoted or not', () => {
    const text = sql(
      'create table if not exists themis.workspaces (id int);',
      'alter table "themis"."workspaces" add column if not exists name text;',
      'insert into themis.workspaces (id) values (1);',
    )
    expect(hits(text)).toEqual([])
  })
})

describe('filename', () => {
  it.each([
    ['2026092820000_themis_short_ts.sql'], // 13 digits
    ['20260928200000_hephaestus_x.sql'], // not a themis migration
    ['20260928200000_themis_Bad-Name.SQL'], // upper case, dash, .SQL
  ])('RED on %s, reported at line 0', (name) => {
    expect(hits('create table themis.ok (id int);', name)).toEqual([{ rule: 'filename', line: 0 }])
    expect(FILENAME_RE.test(name)).toBe(false)
  })

  it('GREEN on a well-formed name', () => {
    expect(hits('create table themis.ok (id int);', '20260928200000_themis_ok_2.sql')).toEqual([])
  })
})

describe('stripComments', () => {
  it('keeps length and newlines so offsets and line numbers survive', () => {
    const src = sql('select 1; -- public.x', '/* a', 'b */ select 2;')
    const out = stripComments(src)
    expect(out).toHaveLength(src.length)
    expect(out.split('\n')).toHaveLength(3)
    expect(out).not.toContain('public')
    expect(out).toContain('select 2;')
  })

  it('does not treat -- inside a string literal as a comment', () => {
    const src = "select '-- public.x' as s;"
    expect(stripComments(src)).toBe(src)
  })

  it('reports the right line after a multi-line block comment', () => {
    const text = sql(
      '/*',
      ' header',
      ' public.x mentioned here',
      '*/',
      'create table public.y (id int);',
    )
    expect(hits(text)).toEqual([{ rule: 'forbidden-schema', line: 5 }])
  })
})

describe('formatViolation', () => {
  it('prints file:line  [rule]  message', () => {
    expect(formatViolation({ file: 'a.sql', line: 7, rule: 'drop-schema', message: 'no' })).toBe(
      'a.sql:7  [drop-schema]  no',
    )
  })
})

describe('checkMigrationsDir / runGuard', () => {
  let dir: string
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'themis-guard-'))
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    log.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  const printed = () => log.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')

  it('fails on a missing directory', () => {
    const missing = path.join(dir, 'does-not-exist')
    expect(checkMigrationsDir(missing).error).toMatch(/no such directory/)
    expect(runGuard(missing)).toBe(false)
  })

  it('fails on an empty directory (dotfiles do not count)', () => {
    writeFileSync(path.join(dir, '.gitkeep'), '')
    const r = checkMigrationsDir(dir)
    expect(r.files).toEqual([])
    expect(r.error).toMatch(/no migrations found/)
    expect(runGuard(dir)).toBe(false)
  })

  it('reports every violating file with file:line [rule] and fails', () => {
    writeFileSync(path.join(dir, GOOD_NAME), 'create table themis.ok (id int);\n')
    writeFileSync(
      path.join(dir, '20260928220000_themis_bad.sql'),
      'create table themis.ok2 (id int);\ncreate extension pgcrypto;\n',
    )
    writeFileSync(path.join(dir, 'notes.txt'), 'hello\n') // non-dot, non-migration: named wrong
    const r = checkMigrationsDir(dir)
    expect(r.error).toBeUndefined()
    expect(r.files).toEqual([GOOD_NAME, '20260928220000_themis_bad.sql', 'notes.txt'])
    expect(r.violations.map(({ file, line, rule }) => ({ file, line, rule }))).toEqual([
      { file: '20260928220000_themis_bad.sql', line: 2, rule: 'create-extension' },
      { file: 'notes.txt', line: 0, rule: 'filename' },
    ])
    expect(runGuard(dir)).toBe(false)
    expect(printed()).toContain('20260928220000_themis_bad.sql:2  [create-extension]')
    expect(printed()).toContain('MIGRATION GUARD FAILED — 2 violation(s)')
  })

  it('passes a clean directory', () => {
    writeFileSync(path.join(dir, GOOD_NAME), 'create table themis.ok (id int);\n')
    expect(runGuard(dir)).toBe(true)
    expect(printed()).toContain('PASS  migration guard: 1 migration(s)')
  })

  it('passes the real archive (supabase/migrations)', () => {
    const r = checkMigrationsDir(ARCHIVE)
    expect(r.error).toBeUndefined()
    expect(r.files.length).toBeGreaterThan(0)
    expect(r.files).toContain('20260928200000_themis_schema.sql')
    expect(r.violations).toEqual([])
    expect(runGuard(ARCHIVE)).toBe(true)
  })
})
