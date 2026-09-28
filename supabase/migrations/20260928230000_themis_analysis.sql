-- Themis analysis and collaboration: swot_items, risks, comments, approvals (PLAN P1.6,
-- spec §2/§3/§6).
--
-- Every object lives in schema `themis` (ADR-0002). Idempotent-safe: the gate applies the whole
-- archive twice, so tables use `if not exists`, triggers `create or replace trigger`, and every
-- policy is dropped before it is created.
--
-- The DB stores INPUTS only. A risk stores likelihood (1–5) and impact (1–5); its exposure
-- (likelihood × impact) and any risk-adjusted score are computed ONLY in src/lib/decision.ts
-- (P4.1, CLAUDE.md §11), never stored or derived here.
--
-- Tenant integrity (the P1.5 pattern): every row carries its own `workspace_id` and a COMPOSITE
-- foreign key (decision_id, workspace_id) -> decisions(id, workspace_id), so a row can never point
-- into another workspace's decision, whatever workspace_id the client writes. A row that names an
-- option also has (option_id, decision_id) -> options(id, decision_id), which pins the option to
-- the SAME decision (and so, through the first FK, to the same workspace). options has no
-- unique(id, workspace_id), which is why risks carry decision_id as well as option_id.
--
-- Defensibility (spec §2): every row has `created_by` (defaulted from auth.uid(), never
-- client-writable) and `updated_at` (bumped by themis.touch_updated_at()). `comments.author` and
-- `approvals.actor` are defaulted from auth.uid() the same way and are never client-writable, so a
-- comment cannot be posted, nor an approval recorded, in someone else's name.
--
-- Frozen decisions: the `decision_frozen` triggers on these child tables arrive with P4.2 (as for
-- options/criteria/scores). Approvals are ALSO recorded by the P4.2 approve()/reject() RPCs.
--
-- Recursion rule (P1.4): no policy subqueries themis.memberships; membership is asked only through
-- themis.is_member / themis.has_role.

-- === tables ======================================================================================

-- A SWOT item belongs to a decision, and optionally to one of its options (null = the whole
-- decision). Stored as rows, not free text, so a report can cite each item (spec §3).
create table if not exists themis.swot_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  decision_id uuid not null,
  option_id uuid,
  -- s = strength, w = weakness, o = opportunity, t = threat.
  quadrant text not null check (quadrant in ('s', 'w', 'o', 't')),
  text text not null default '' check (char_length(text) <= 1000),
  -- Display order within a quadrant (rows created in one statement share created_at).
  position smallint not null default 0 check (position >= 0),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint swot_items_decision_fkey foreign key (decision_id, workspace_id)
    references themis.decisions (id, workspace_id) on delete cascade,
  -- MATCH SIMPLE: a null option_id (a decision-level item) is not checked; a set one must be an
  -- option of the same decision.
  constraint swot_items_option_fkey foreign key (option_id, decision_id)
    references themis.options (id, decision_id) on delete cascade
);

create index if not exists swot_items_decision_idx on themis.swot_items (decision_id, workspace_id);
create index if not exists swot_items_option_idx on themis.swot_items (option_id, decision_id);

-- A risk belongs to one option of a decision (spec §3: risks per option).
create table if not exists themis.risks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  decision_id uuid not null,
  option_id uuid not null,
  title text not null default '' check (char_length(title) <= 200),
  -- 1 (rare / minor) … 5 (almost certain / severe). Inputs only: exposure lives in decision.ts.
  likelihood smallint not null check (likelihood between 1 and 5),
  impact smallint not null check (impact between 1 and 5),
  -- Who owns the risk: a free-text name, because the owner is often outside the workspace.
  owner text not null default '' check (char_length(owner) <= 200),
  mitigation text not null default '' check (char_length(mitigation) <= 2000),
  position smallint not null default 0 check (position >= 0),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint risks_decision_fkey foreign key (decision_id, workspace_id)
    references themis.decisions (id, workspace_id) on delete cascade,
  constraint risks_option_fkey foreign key (option_id, decision_id)
    references themis.options (id, decision_id) on delete cascade
);

create index if not exists risks_decision_idx on themis.risks (decision_id, workspace_id);
create index if not exists risks_option_idx on themis.risks (option_id, decision_id);

-- A comment on a decision. Any member (viewer included) may post; only its author edits it.
create table if not exists themis.comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  decision_id uuid not null,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  -- The identity the "only the author edits" rule keys on. Never client-writable.
  author uuid default auth.uid() references auth.users (id) on delete set null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint comments_decision_fkey foreign key (decision_id, workspace_id)
    references themis.decisions (id, workspace_id) on delete cascade
);

create index if not exists comments_decision_idx on themis.comments (decision_id, workspace_id);

-- An approve/reject verdict on a decision revision, with a mandatory reason. Append-only: nobody
-- (client-side) updates or deletes one; the approver's name and time go into the report (spec §3).
create table if not exists themis.approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  decision_id uuid not null,
  verdict text not null check (verdict in ('approved', 'rejected')),
  reason text not null check (char_length(btrim(reason)) between 1 and 2000),
  -- Who gave the verdict. Never client-writable.
  actor uuid default auth.uid() references auth.users (id) on delete set null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint approvals_decision_fkey foreign key (decision_id, workspace_id)
    references themis.decisions (id, workspace_id) on delete cascade
);

create index if not exists approvals_decision_idx on themis.approvals (decision_id, workspace_id);

-- === updated_at ==================================================================================

create or replace trigger swot_items_touch_updated_at before update on themis.swot_items
  for each row execute function themis.touch_updated_at();
create or replace trigger risks_touch_updated_at before update on themis.risks
  for each row execute function themis.touch_updated_at();
create or replace trigger comments_touch_updated_at before update on themis.comments
  for each row execute function themis.touch_updated_at();
create or replace trigger approvals_touch_updated_at before update on themis.approvals
  for each row execute function themis.touch_updated_at();

-- === RLS =========================================================================================

alter table themis.swot_items enable row level security;
alter table themis.risks enable row level security;
alter table themis.comments enable row level security;
alter table themis.approvals enable row level security;

-- swot_items: members read; editor|admin|owner write; viewer reads only.
drop policy if exists swot_items_select on themis.swot_items;
create policy swot_items_select on themis.swot_items
  for select to authenticated
  using (themis.is_member(workspace_id));

drop policy if exists swot_items_insert on themis.swot_items;
create policy swot_items_insert on themis.swot_items
  for insert to authenticated
  with check (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

drop policy if exists swot_items_update on themis.swot_items;
create policy swot_items_update on themis.swot_items
  for update to authenticated
  using (themis.has_role(workspace_id, array['owner', 'admin', 'editor']))
  with check (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

drop policy if exists swot_items_delete on themis.swot_items;
create policy swot_items_delete on themis.swot_items
  for delete to authenticated
  using (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

-- risks: members read; editor|admin|owner write; viewer reads only.
drop policy if exists risks_select on themis.risks;
create policy risks_select on themis.risks
  for select to authenticated
  using (themis.is_member(workspace_id));

drop policy if exists risks_insert on themis.risks;
create policy risks_insert on themis.risks
  for insert to authenticated
  with check (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

drop policy if exists risks_update on themis.risks;
create policy risks_update on themis.risks
  for update to authenticated
  using (themis.has_role(workspace_id, array['owner', 'admin', 'editor']))
  with check (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

drop policy if exists risks_delete on themis.risks;
create policy risks_delete on themis.risks
  for delete to authenticated
  using (themis.has_role(workspace_id, array['owner', 'admin', 'editor']));

-- comments: any member reads and posts (viewer included); only the author, while still a member,
-- edits or deletes their own comment.
drop policy if exists comments_select on themis.comments;
create policy comments_select on themis.comments
  for select to authenticated
  using (themis.is_member(workspace_id));

drop policy if exists comments_insert on themis.comments;
create policy comments_insert on themis.comments
  for insert to authenticated
  with check (themis.is_member(workspace_id) and author = auth.uid());

drop policy if exists comments_update on themis.comments;
create policy comments_update on themis.comments
  for update to authenticated
  using (themis.is_member(workspace_id) and author = auth.uid())
  with check (themis.is_member(workspace_id) and author = auth.uid());

drop policy if exists comments_delete on themis.comments;
create policy comments_delete on themis.comments
  for delete to authenticated
  using (themis.is_member(workspace_id) and author = auth.uid());

-- approvals: members read; only admin|owner insert, in their own name; nobody updates or deletes
-- (no policy and no grant for either verb).
drop policy if exists approvals_select on themis.approvals;
create policy approvals_select on themis.approvals
  for select to authenticated
  using (themis.is_member(workspace_id));

drop policy if exists approvals_insert on themis.approvals;
create policy approvals_insert on themis.approvals
  for insert to authenticated
  with check (themis.has_role(workspace_id, array['owner', 'admin']) and actor = auth.uid());

-- === grants ======================================================================================
-- Nothing to anon, nothing to PUBLIC. authenticated gets exactly the verbs its policies admit,
-- column-limited: ids, the tenancy/parent keys (workspace_id, decision_id, option_id), created_by,
-- author and actor are never client-updatable, and author/actor/created_by are never
-- client-insertable (their auth.uid() default always applies). service_role (BYPASSRLS,
-- server-side only) gets full DML.

revoke all on table themis.swot_items, themis.risks, themis.comments, themis.approvals
  from public, anon;

grant select on table themis.swot_items, themis.risks, themis.comments, themis.approvals
  to authenticated;
grant delete on table themis.swot_items, themis.risks, themis.comments to authenticated;

grant insert (workspace_id, decision_id, option_id, quadrant, text, position)
  on table themis.swot_items to authenticated;
grant update (quadrant, text, position) on table themis.swot_items to authenticated;

grant insert (workspace_id, decision_id, option_id, title, likelihood, impact, owner, mitigation,
  position) on table themis.risks to authenticated;
grant update (title, likelihood, impact, owner, mitigation, position) on table themis.risks
  to authenticated;

grant insert (workspace_id, decision_id, body) on table themis.comments to authenticated;
grant update (body) on table themis.comments to authenticated;

grant insert (workspace_id, decision_id, verdict, reason) on table themis.approvals
  to authenticated;

grant select, insert, update, delete
  on table themis.swot_items, themis.risks, themis.comments, themis.approvals
  to service_role;
