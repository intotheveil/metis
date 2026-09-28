-- Themis decision core: decisions, options, criteria, scores (PLAN P1.5, spec §2/§6/§7).
--
-- Every object lives in schema `themis` (ADR-0002). Idempotent-safe: the gate applies the whole
-- archive twice, so tables use `if not exists`, triggers `create or replace trigger`, and every
-- policy is dropped before it is created.
--
-- The DB stores INPUTS only: weights (0–5) and scores (1–5). No computed score, rank or verdict is
-- stored or derived here — that math lives only in src/lib/decision.ts (CLAUDE.md §11).
--
-- Tenant integrity: every child row carries its own `workspace_id` and a COMPOSITE foreign key
-- (decision_id, workspace_id) -> decisions(id, workspace_id), so a child can never point into
-- another workspace's decision, whatever workspace_id the client writes. Scores go one step
-- further: (option_id, decision_id) and (criterion_id, decision_id) pin both ends of a score to
-- the SAME decision.
--
-- Defensibility (spec §2): every row has `created_by` (defaulted from auth.uid(), never
-- client-writable) and `updated_at` (bumped by themis.touch_updated_at()). The lifecycle columns
-- (status, frozen, approved_by/at, lineage_id, revision) are NOT client-writable: they change only
-- through the P4.2 SECURITY DEFINER RPCs (submit/approve/reject/archive/new_revision), so an editor
-- cannot self-approve, unfreeze, or forge a revision into someone else's lineage. P4.2 also adds
-- the `decision_frozen` triggers on every child table; here a frozen decision already cannot be
-- updated or deleted through RLS.
--
-- Recursion rule (P1.4): no policy subqueries themis.memberships; membership is asked only through
-- themis.is_member / themis.has_role.

-- === tables ======================================================================================

create table if not exists themis.decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references themis.workspaces (id) on delete cascade,
  -- All revisions of one decision share a lineage; a new decision starts its own.
  lineage_id uuid not null default gen_random_uuid(),
  revision int not null default 1 check (revision >= 1),
  -- A draft may be saved before its question is written (P0 matrix import, P2.13).
  question text not null default '' check (char_length(question) <= 1000),
  -- Must match `Methodology` and `Scale` in src/lib/decision.ts exactly (asserted by the tests).
  methodology text not null check (methodology in ('waterfall', 'agile', 'yolo')),
  scale text not null check (scale in ('small', 'mid', 'enterprise')),
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'approved', 'rejected', 'archived')),
  frozen boolean not null default false,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target of the children's composite FKs.
  constraint decisions_id_workspace_id_key unique (id, workspace_id),
  constraint decisions_lineage_id_revision_key unique (lineage_id, revision),
  -- Only an approved decision is frozen, and an approval always has a time (spec §2.2).
  constraint decisions_frozen_needs_approval check (not frozen or approved_at is not null),
  constraint decisions_approved_needs_time check (status <> 'approved' or approved_at is not null)
);

create index if not exists decisions_workspace_id_idx on themis.decisions (workspace_id);

create table if not exists themis.options (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  decision_id uuid not null,
  name text not null default '' check (char_length(name) <= 200),
  -- Display order (rows created in one statement share created_at).
  position smallint not null default 0 check (position >= 0),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint options_decision_fkey foreign key (decision_id, workspace_id)
    references themis.decisions (id, workspace_id) on delete cascade,
  -- Target of scores' (option_id, decision_id) FK.
  constraint options_id_decision_id_key unique (id, decision_id)
);

create index if not exists options_decision_idx on themis.options (decision_id, workspace_id);

create table if not exists themis.criteria (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  decision_id uuid not null,
  name text not null default '' check (char_length(name) <= 200),
  -- Importance 0 (ignored) … 5 (decisive); an input, never a computed value.
  weight smallint not null default 3 check (weight between 0 and 5),
  position smallint not null default 0 check (position >= 0),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint criteria_decision_fkey foreign key (decision_id, workspace_id)
    references themis.decisions (id, workspace_id) on delete cascade,
  constraint criteria_id_decision_id_key unique (id, decision_id)
);

create index if not exists criteria_decision_idx on themis.criteria (decision_id, workspace_id);

create table if not exists themis.scores (
  workspace_id uuid not null,
  decision_id uuid not null,
  option_id uuid not null,
  criterion_id uuid not null,
  -- 1 (poor) … 5 (excellent). An unscored cell has no row.
  value smallint not null check (value between 1 and 5),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One score per cell; also the upsert target.
  constraint scores_pkey primary key (option_id, criterion_id),
  constraint scores_decision_fkey foreign key (decision_id, workspace_id)
    references themis.decisions (id, workspace_id) on delete cascade,
  constraint scores_option_fkey foreign key (option_id, decision_id)
    references themis.options (id, decision_id) on delete cascade,
  constraint scores_criterion_fkey foreign key (criterion_id, decision_id)
    references themis.criteria (id, decision_id) on delete cascade
);

create index if not exists scores_decision_idx on themis.scores (decision_id, workspace_id);
create index if not exists scores_criterion_idx on themis.scores (criterion_id, decision_id);

-- === updated_at ==================================================================================

create or replace trigger decisions_touch_updated_at before update on themis.decisions
  for each row execute function themis.touch_updated_at();
create or replace trigger options_touch_updated_at before update on themis.options
  for each row execute function themis.touch_updated_at();
create or replace trigger criteria_touch_updated_at before update on themis.criteria
  for each row execute function themis.touch_updated_at();
create or replace trigger scores_touch_updated_at before update on themis.scores
  for each row execute function themis.touch_updated_at();

-- === RLS =========================================================================================
-- Members read. editor|admin|owner write. viewer reads only.

alter table themis.decisions enable row level security;
alter table themis.options enable row level security;
alter table themis.criteria enable row level security;
alter table themis.scores enable row level security;

-- decisions: a frozen (approved) decision cannot be edited or deleted; edits make a new revision.
drop policy if exists decisions_select on themis.decisions;
create policy decisions_select on themis.decisions
  for select to authenticated
  using (themis.is_member(workspace_id));

drop policy if exists decisions_insert on themis.decisions;
create policy decisions_insert on themis.decisions
  for insert to authenticated
  with check (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

drop policy if exists decisions_update on themis.decisions;
create policy decisions_update on themis.decisions
  for update to authenticated
  using (themis.has_role(workspace_id, array['owner', 'admin', 'editor']) and not frozen)
  with check (themis.has_role(workspace_id, array['owner', 'admin', 'editor']) and not frozen);

drop policy if exists decisions_delete on themis.decisions;
create policy decisions_delete on themis.decisions
  for delete to authenticated
  using (themis.has_role(workspace_id, array['owner', 'admin', 'editor']) and not frozen);

-- options
drop policy if exists options_select on themis.options;
create policy options_select on themis.options
  for select to authenticated
  using (themis.is_member(workspace_id));

drop policy if exists options_insert on themis.options;
create policy options_insert on themis.options
  for insert to authenticated
  with check (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

drop policy if exists options_update on themis.options;
create policy options_update on themis.options
  for update to authenticated
  using (themis.has_role(workspace_id, array['owner', 'admin', 'editor']))
  with check (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

drop policy if exists options_delete on themis.options;
create policy options_delete on themis.options
  for delete to authenticated
  using (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

-- criteria
drop policy if exists criteria_select on themis.criteria;
create policy criteria_select on themis.criteria
  for select to authenticated
  using (themis.is_member(workspace_id));

drop policy if exists criteria_insert on themis.criteria;
create policy criteria_insert on themis.criteria
  for insert to authenticated
  with check (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

drop policy if exists criteria_update on themis.criteria;
create policy criteria_update on themis.criteria
  for update to authenticated
  using (themis.has_role(workspace_id, array['owner', 'admin', 'editor']))
  with check (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

drop policy if exists criteria_delete on themis.criteria;
create policy criteria_delete on themis.criteria
  for delete to authenticated
  using (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

-- scores
drop policy if exists scores_select on themis.scores;
create policy scores_select on themis.scores
  for select to authenticated
  using (themis.is_member(workspace_id));

drop policy if exists scores_insert on themis.scores;
create policy scores_insert on themis.scores
  for insert to authenticated
  with check (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

drop policy if exists scores_update on themis.scores;
create policy scores_update on themis.scores
  for update to authenticated
  using (themis.has_role(workspace_id, array['owner', 'admin', 'editor']))
  with check (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

drop policy if exists scores_delete on themis.scores;
create policy scores_delete on themis.scores
  for delete to authenticated
  using (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

-- === grants ======================================================================================
-- Nothing to anon, nothing to PUBLIC. authenticated gets exactly the verbs its policies admit,
-- column-limited: ids, workspace_id/decision_id (the tenancy keys), created_by and the lifecycle
-- columns are never client-writable. service_role (BYPASSRLS, server-side only) gets full DML.

revoke all on table themis.decisions, themis.options, themis.criteria, themis.scores
  from public, anon;

grant select, delete on table themis.decisions, themis.options, themis.criteria, themis.scores
  to authenticated;

grant insert (workspace_id, question, methodology, scale) on table themis.decisions
  to authenticated;
grant update (question, methodology, scale) on table themis.decisions to authenticated;

grant insert (workspace_id, decision_id, name, position) on table themis.options to authenticated;
grant update (name, position) on table themis.options to authenticated;

grant insert (workspace_id, decision_id, name, weight, position) on table themis.criteria
  to authenticated;
grant update (name, weight, position) on table themis.criteria to authenticated;

grant insert (workspace_id, decision_id, option_id, criterion_id, value) on table themis.scores
  to authenticated;
grant update (value) on table themis.scores to authenticated;

grant select, insert, update, delete
  on table themis.decisions, themis.options, themis.criteria, themis.scores
  to service_role;
