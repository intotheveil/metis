-- Themis onboarding RPCs: bootstrap_me(), import_local_decision() (PLAN P2.5, spec §5a, ADR-0002).
--
-- Every object lives in schema `themis` (ADR-0002). Idempotent-safe: the gate applies the whole
-- archive twice, so both functions are `create or replace` and the grants are re-runnable.
--
-- Both are SECURITY DEFINER with `search_path = ''` and fully-qualified names. They run as the
-- function owner, so they can do the writes P1.4/P1.5 keep away from clients (a workspace and its
-- first owner membership; a whole decision graph in one call). The caller is ONLY ever `auth.uid()`:
-- neither function takes a user id, so nobody can act in someone else's name.
--
-- EXECUTE: Postgres grants every new function to PUBLIC, and the bootstrap's schema-level default
-- revoke is a no-op (DECISIONS.md B2). So each function revokes EXECUTE from public, anon and
-- service_role explicitly and grants it to authenticated only. db:gate fails on any themis function
-- that PUBLIC or anon can execute.
--
-- Concurrency: each function takes a transaction-scoped advisory lock in the TWO-int4 keyspace
-- (class = hashtext of the function name), which never collides with the bigint keyspace another
-- tenant of the shared project may use. Two tabs calling at once therefore serialize instead of
-- creating two personal workspaces or two copies of one import.

-- === bootstrap_me() ==============================================================================
-- The substitute for a trigger on the shared auth.users (ADR-0002 rule 5): the client calls it after
-- every sign-in. Idempotent: it creates the caller's themis.profiles row and a personal workspace
-- with an `owner` membership only when they are absent, and returns the personal workspace id.
--
-- "Personal workspace" = the oldest workspace the caller CREATED and still OWNS. A workspace the
-- caller was only invited into does not count, so an invited user still gets one of their own; a
-- later team workspace the caller creates does not replace it (the oldest wins).

create or replace function themis.bootstrap_me()
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  me uuid := auth.uid();
  ws uuid;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('themis.bootstrap_me'),
    pg_catalog.hashtext(me::text)
  );

  insert into themis.profiles (user_id) values (me)
    on conflict (user_id) do nothing;

  select w.id
    into ws
    from themis.workspaces w
    join themis.memberships m
      on m.workspace_id = w.id and m.user_id = me and m.role = 'owner'
   where w.created_by = me
   order by w.created_at, w.id
   limit 1;

  if ws is null then
    insert into themis.workspaces (name, created_by) values ('Personal', me)
      returning id into ws;
    insert into themis.memberships (workspace_id, user_id, role) values (ws, me, 'owner');
  end if;

  return ws;
end;
$fn$;

-- === import_local_decision(ws, payload) ==========================================================
-- Saves the signed-out P0 matrix (P2.13) as a decision in `ws`. Requires editor|admin|owner in `ws`.
-- ATOMIC: one call inserts the decision, its options, criteria and scores, or raises and leaves
-- nothing behind (a function runs inside the caller's statement).
--
-- payload (the decision.ts shapes; unknown keys are ignored):
--   {
--     "client_import_id": "<uuid>",                   required; the dedupe key
--     "question":    "<text>",                        optional, default ''
--     "methodology": "waterfall" | "agile" | "yolo",  required (the decisions CHECK decides)
--     "scale":       "small" | "mid" | "enterprise",  required (the decisions CHECK decides)
--     "criteria": [{ "id": "<client id>", "name": "<text>", "weight": 0..5 }, …],   ≤ 100
--     "options":  [{ "id": "<client id>", "name": "<text>" }, …],                  ≤ 100
--     "scores":   { "<option client id>": { "<criterion client id>": 1..5 } }      optional
--   }
-- Client ids are strings (1..64 chars) unique within their list; a score naming an unknown id is
-- refused, never dropped. Weights and scores must be integral JSON numbers: 3.5 is refused, not
-- rounded (a smallint cast would round it silently). Array order becomes `position`.
--
-- Dedupe: the import writes ONE audit_log row (entity 'decision', action 'import_local', after =
-- {client_import_id, counts}). A later call with the same client_import_id into the same workspace
-- returns that decision's id and writes nothing, as long as the decision still exists. The key is
-- scoped to the workspace, so it can never reveal a decision of a workspace the caller cannot write.

create or replace function themis.import_local_decision(ws uuid, payload jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  me uuid := auth.uid();
  max_items constant int := 100;
  cid uuid;
  dec uuid;
  crits jsonb;
  opts jsonb;
  scores jsonb;
  item jsonb;
  k text;
  num numeric;
  new_id uuid;
  crit_ids jsonb := '{}'::jsonb;
  opt_ids jsonb := '{}'::jsonb;
  o_key text;
  o_val jsonb;
  c_key text;
  c_val jsonb;
  n_scores int := 0;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if ws is null or not themis.has_role(ws, array['owner', 'admin', 'editor']) then
    raise exception 'not_authorized: editor, admin or owner of the workspace required'
      using errcode = '42501';
  end if;

  if payload is null or pg_catalog.jsonb_typeof(payload) <> 'object' then
    raise exception 'invalid_payload: payload must be a JSON object' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(payload -> 'client_import_id') is distinct from 'string'
     or (payload ->> 'client_import_id')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_payload: client_import_id must be a uuid string' using errcode = '22023';
  end if;
  cid := (payload ->> 'client_import_id')::uuid;

  -- Serialize imports of the same key, then look for an earlier one.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('themis.import_local_decision'),
    pg_catalog.hashtext(ws::text || ':' || cid::text)
  );
  select a.entity_id
    into dec
    from themis.audit_log a
    join themis.decisions d on d.id = a.entity_id and d.workspace_id = ws
   where a.workspace_id = ws
     and a.entity = 'decision'
     and a.action = 'import_local'
     and a.after ->> 'client_import_id' = cid::text
   order by a.at desc
   limit 1;
  if dec is not null then
    return dec;
  end if;

  -- Shape of the rest of the payload.
  if pg_catalog.jsonb_typeof(payload -> 'methodology') is distinct from 'string'
     or pg_catalog.jsonb_typeof(payload -> 'scale') is distinct from 'string' then
    raise exception 'invalid_payload: methodology and scale must be strings' using errcode = '22023';
  end if;
  if payload ? 'question' and pg_catalog.jsonb_typeof(payload -> 'question') <> 'string' then
    raise exception 'invalid_payload: question must be a string' using errcode = '22023';
  end if;
  crits := coalesce(payload -> 'criteria', '[]'::jsonb);
  opts := coalesce(payload -> 'options', '[]'::jsonb);
  scores := coalesce(payload -> 'scores', '{}'::jsonb);
  if pg_catalog.jsonb_typeof(crits) <> 'array' or pg_catalog.jsonb_typeof(opts) <> 'array' then
    raise exception 'invalid_payload: criteria and options must be arrays' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(crits) > max_items
     or pg_catalog.jsonb_array_length(opts) > max_items then
    raise exception 'invalid_payload: at most % criteria and % options', max_items, max_items
      using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(scores) = 'null' then
    scores := '{}'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(scores) <> 'object' then
    raise exception 'invalid_payload: scores must be an object' using errcode = '22023';
  end if;

  insert into themis.decisions (workspace_id, question, methodology, scale, created_by)
  values (ws, coalesce(payload ->> 'question', ''), payload ->> 'methodology', payload ->> 'scale', me)
  returning id into dec;

  -- Criteria (weight 0..5, integral).
  for i in 0 .. pg_catalog.jsonb_array_length(crits) - 1 loop
    item := crits -> i;
    if pg_catalog.jsonb_typeof(item) is distinct from 'object'
       or pg_catalog.jsonb_typeof(item -> 'id') is distinct from 'string'
       or pg_catalog.jsonb_typeof(item -> 'name') is distinct from 'string' then
      raise exception 'invalid_payload: criteria[%] needs a string id and name', i
        using errcode = '22023';
    end if;
    k := item ->> 'id';
    if pg_catalog.char_length(k) not between 1 and 64 or crit_ids ? k then
      raise exception 'invalid_payload: criteria[%] id is empty, too long or repeated', i
        using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(item -> 'weight') is distinct from 'number' then
      raise exception 'invalid_payload: criteria[%] weight must be a number', i using errcode = '22023';
    end if;
    num := (item -> 'weight')::numeric;
    if num <> pg_catalog.trunc(num) or num < 0 or num > 5 then
      raise exception 'invalid_payload: criteria[%] weight must be an integer 0..5', i
        using errcode = '22023';
    end if;
    insert into themis.criteria (workspace_id, decision_id, name, weight, position, created_by)
    values (ws, dec, item ->> 'name', num::smallint, i, me)
    returning id into new_id;
    crit_ids := crit_ids || pg_catalog.jsonb_build_object(k, new_id);
  end loop;

  -- Options.
  for i in 0 .. pg_catalog.jsonb_array_length(opts) - 1 loop
    item := opts -> i;
    if pg_catalog.jsonb_typeof(item) is distinct from 'object'
       or pg_catalog.jsonb_typeof(item -> 'id') is distinct from 'string'
       or pg_catalog.jsonb_typeof(item -> 'name') is distinct from 'string' then
      raise exception 'invalid_payload: options[%] needs a string id and name', i
        using errcode = '22023';
    end if;
    k := item ->> 'id';
    if pg_catalog.char_length(k) not between 1 and 64 or opt_ids ? k then
      raise exception 'invalid_payload: options[%] id is empty, too long or repeated', i
        using errcode = '22023';
    end if;
    insert into themis.options (workspace_id, decision_id, name, position, created_by)
    values (ws, dec, item ->> 'name', i, me)
    returning id into new_id;
    opt_ids := opt_ids || pg_catalog.jsonb_build_object(k, new_id);
  end loop;

  -- Scores (1..5, integral), keyed by the client ids above.
  for o_key, o_val in select e.key, e.value from pg_catalog.jsonb_each(scores) e loop
    if not opt_ids ? o_key then
      raise exception 'invalid_payload: scores name an unknown option id' using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(o_val) <> 'object' then
      raise exception 'invalid_payload: scores of an option must be an object' using errcode = '22023';
    end if;
    for c_key, c_val in select e.key, e.value from pg_catalog.jsonb_each(o_val) e loop
      if not crit_ids ? c_key then
        raise exception 'invalid_payload: scores name an unknown criterion id' using errcode = '22023';
      end if;
      if pg_catalog.jsonb_typeof(c_val) <> 'number' then
        raise exception 'invalid_payload: a score must be a number' using errcode = '22023';
      end if;
      num := c_val::numeric;
      if num <> pg_catalog.trunc(num) or num < 1 or num > 5 then
        raise exception 'invalid_payload: a score must be an integer 1..5' using errcode = '22023';
      end if;
      insert into themis.scores (workspace_id, decision_id, option_id, criterion_id, value, created_by)
      values (ws, dec, (opt_ids ->> o_key)::uuid, (crit_ids ->> c_key)::uuid, num::smallint, me);
      n_scores := n_scores + 1;
    end loop;
  end loop;

  -- Provenance + the dedupe key (audit_log is append-only; see the header).
  insert into themis.audit_log (workspace_id, actor, entity, entity_id, action, before, after)
  values (
    ws, me, 'decision', dec, 'import_local', null,
    pg_catalog.jsonb_build_object(
      'client_import_id', cid,
      'criteria', pg_catalog.jsonb_array_length(crits),
      'options', pg_catalog.jsonb_array_length(opts),
      'scores', n_scores
    )
  );

  return dec;
end;
$fn$;

-- === EXECUTE: authenticated only =================================================================

revoke execute on function themis.bootstrap_me() from public, anon, service_role;
revoke execute on function themis.import_local_decision(uuid, jsonb) from public, anon, service_role;
grant execute on function themis.bootstrap_me() to authenticated;
grant execute on function themis.import_local_decision(uuid, jsonb) to authenticated;
