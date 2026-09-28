-- Themis AI ledger, billing mirror, audit log and plans: ai_runs, subscriptions, usage_monthly,
-- audit_log, plans + seed (PLAN P1.7, spec §2.3/§4/§6/§7).
--
-- Every object lives in schema `themis` (ADR-0002). Idempotent-safe: the gate applies the whole
-- archive twice, so tables use `if not exists`, triggers `create or replace trigger`, functions
-- `create or replace`, every policy is dropped before it is created, and the plans seed is
-- `on conflict do nothing`.
--
-- SERVER-SIDE WRITES ONLY (spec §7.3/§7.4). ai_runs, subscriptions and usage_monthly are written
-- only by service_role (the themis-* Edge Functions and the P3.2/P4.9 service-only RPCs). Members
-- may READ their own workspace's rows, and nothing else: no client INSERT/UPDATE/DELETE policy and
-- no client write grant exists on any of them. A client that could write usage_monthly could reset
-- its own AI quota; one that could write subscriptions could grant itself Team.
--
-- audit_log is APPEND-ONLY. Only admin|owner read it, no client writes it (the P4.2 SECURITY DEFINER
-- triggers do), service_role may only INSERT, and an UPDATE raises for every role, the owner
-- included. Rows leave only with their workspace (on delete cascade), which no API role can trigger
-- on audit_log directly (no DELETE grant).
--
-- plans is static reference data, not tenant data: anon and authenticated may SELECT it (the
-- pricing page, spec §6) and nobody but a migration writes it. Its seed is the spec §4 PROPOSAL,
-- UNCONFIRMED: P3.12 measures the real per-run cost, CHECKPOINT P4-PRICING confirms the values, and
-- P4.9 updates them in a NEW migration (this file is never edited). The € cost ceilings are not in
-- the spec at all; they are builder placeholders (DECISIONS.md P1.7).
--
-- Tenant integrity (the P1.5 pattern): ai_runs carries its own workspace_id and a COMPOSITE foreign
-- key (decision_id, workspace_id) -> decisions(id, workspace_id), so a run can never point into
-- another workspace's decision. Tables with no parent decision reference workspaces(id) directly.
--
-- Recursion rule (P1.4): no policy subqueries themis.memberships; membership is asked only through
-- themis.is_member / themis.has_role.

-- === plans (reference data; created first: subscriptions.plan references it) ====================

create table if not exists themis.plans (
  key text primary key check (key in ('free', 'pro', 'team')),
  -- null = unlimited.
  active_decisions integer check (active_decisions is null or active_decisions >= 0),
  -- Exactly one quota basis per plan: a flat monthly pool, or a per-seat pool (Team, pooled).
  ai_runs_month integer check (ai_runs_month is null or ai_runs_month >= 0),
  ai_runs_per_seat integer check (ai_runs_per_seat is null or ai_runs_per_seat >= 0),
  -- The per-workspace monthly € hard stop, regardless of run count (spec §4 "AI cost control").
  ai_cost_ceiling_eur numeric(10, 4) not null check (ai_cost_ceiling_eur >= 0),
  -- null = unlimited.
  members_max integer check (members_max is null or members_max >= 1),
  pdf_footer boolean not null,
  pdf_logo boolean not null,
  min_seats integer not null default 1 check (min_seats >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plans_one_quota_basis check ((ai_runs_month is null) <> (ai_runs_per_seat is null))
);

comment on table themis.plans is
  'Plan limits. Seeded with the THEMIS_SPEC §4 PROPOSAL values: UNCONFIRMED until CHECKPOINT P4-PRICING; P4.9 sets the confirmed values in a new migration. The ai_cost_ceiling_eur values are builder placeholders (not in the spec).';

-- Spec §4 proposal. Free: 3 active decisions, 10 runs/month, 1 member, PDF with footer.
-- Pro: unlimited decisions, 200 runs/month, 1 member, clean PDF. Team: unlimited, 500 runs per
-- seat pooled, unlimited members, clean PDF + workspace logo, 3 seats minimum.
-- Ceilings (€ per workspace per month) are PLACEHOLDERS: Free 1, Pro 10, Team 60.
insert into themis.plans (key, active_decisions, ai_runs_month, ai_runs_per_seat,
  ai_cost_ceiling_eur, members_max, pdf_footer, pdf_logo, min_seats)
values
  ('free', 3, 10, null, 1.0000, 1, true, false, 1),
  ('pro', null, 200, null, 10.0000, 1, false, false, 1),
  ('team', null, null, 500, 60.0000, null, false, true, 3)
on conflict (key) do nothing;

-- === tenant tables ==============================================================================

-- One AI analyst run (spec §2.3: the AI cites its inputs). The exact snapshot sent, the model id,
-- the output, the tokens and the € cost are stored; `accepted` records which suggestions the user
-- accepted or dismissed (the report cites them).
create table if not exists themis.ai_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  decision_id uuid not null,
  -- The four P3 kinds plus the P4.6 SWOT draft (P4.6 adds no migration, so it is admitted now).
  kind text not null check (
    kind in ('challenge', 'missing_criteria', 'stress_test', 'explain', 'swot_draft')
  ),
  model text not null check (char_length(model) between 1 and 100),
  -- reserved: quota taken, model not yet answered; succeeded / failed: settled (P3.2/P3.7).
  status text not null default 'reserved' check (status in ('reserved', 'succeeded', 'failed')),
  input_snapshot jsonb not null check (jsonb_typeof(input_snapshot) = 'object'),
  output jsonb,
  tokens_in integer not null default 0 check (tokens_in >= 0),
  tokens_out integer not null default 0 check (tokens_out >= 0),
  cost_eur numeric(10, 4) not null default 0 check (cost_eur >= 0),
  accepted jsonb not null default '[]'::jsonb check (jsonb_typeof(accepted) = 'array'),
  -- The Edge Function sets this to the caller (auth.uid() is null under the service key).
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_runs_decision_fkey foreign key (decision_id, workspace_id)
    references themis.decisions (id, workspace_id) on delete cascade
);

create index if not exists ai_runs_decision_idx on themis.ai_runs (decision_id, workspace_id);
create index if not exists ai_runs_workspace_created_idx on themis.ai_runs (workspace_id, created_at);

-- The Stripe mirror (spec §5: Stripe is the source of truth; the webhook mirrors it here). One row
-- per workspace; a workspace with no row is on `free` (P3.2 effective_plan).
create table if not exists themis.subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references themis.workspaces (id) on delete cascade,
  stripe_customer_id text unique check (stripe_customer_id is null or stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  stripe_subscription_id text unique check (
    stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'
  ),
  plan text not null default 'free' references themis.plans (key),
  seats integer not null default 1 check (seats >= 1),
  -- Stripe's subscription statuses, verbatim.
  status text not null check (
    status in ('trialing', 'active', 'incomplete', 'incomplete_expired', 'past_due', 'canceled',
      'unpaid', 'paused')
  ),
  period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The AI quota ledger, one row per workspace per UTC month (P3.2 locks it `for update`).
create table if not exists themis.usage_monthly (
  workspace_id uuid not null references themis.workspaces (id) on delete cascade,
  -- The first day of the month.
  month date not null check (extract(day from month) = 1),
  ai_runs integer not null default 0 check (ai_runs >= 0),
  ai_cost_eur numeric(10, 4) not null default 0 check (ai_cost_eur >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, month)
);

-- Who changed what, when (spec §2.1). Append-only; written by the P4.2 triggers.
create table if not exists themis.audit_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references themis.workspaces (id) on delete cascade,
  actor uuid default auth.uid() references auth.users (id) on delete set null,
  entity text not null check (char_length(entity) between 1 and 64),
  entity_id uuid,
  action text not null check (char_length(action) between 1 and 64),
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);

create index if not exists audit_log_workspace_at_idx on themis.audit_log (workspace_id, at);
create index if not exists audit_log_entity_idx on themis.audit_log (entity, entity_id);

-- === triggers ===================================================================================

create or replace trigger plans_touch_updated_at before update on themis.plans
  for each row execute function themis.touch_updated_at();
create or replace trigger ai_runs_touch_updated_at before update on themis.ai_runs
  for each row execute function themis.touch_updated_at();
create or replace trigger subscriptions_touch_updated_at before update on themis.subscriptions
  for each row execute function themis.touch_updated_at();
create or replace trigger usage_monthly_touch_updated_at before update on themis.usage_monthly
  for each row execute function themis.touch_updated_at();

-- audit_log is append-only for EVERY role (grants alone would not stop the owner or a future
-- careless grant). Deletes are left to the workspace cascade; no API role holds DELETE.
create or replace function themis.audit_log_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log_append_only' using errcode = '42501';
end;
$$;

revoke execute on function themis.audit_log_append_only() from public, anon, authenticated;

create or replace trigger audit_log_no_update before update on themis.audit_log
  for each row execute function themis.audit_log_append_only();

-- === RLS ========================================================================================

alter table themis.plans enable row level security;
alter table themis.ai_runs enable row level security;
alter table themis.subscriptions enable row level security;
alter table themis.usage_monthly enable row level security;
alter table themis.audit_log enable row level security;

-- plans: everyone reads (reference data); nobody writes through the API.
drop policy if exists plans_select on themis.plans;
create policy plans_select on themis.plans
  for select to anon, authenticated
  using (true);

-- ai_runs, subscriptions, usage_monthly: members read their workspace's rows. No write policy:
-- only service_role (BYPASSRLS) writes.
drop policy if exists ai_runs_select on themis.ai_runs;
create policy ai_runs_select on themis.ai_runs
  for select to authenticated
  using (themis.is_member(workspace_id));

drop policy if exists subscriptions_select on themis.subscriptions;
create policy subscriptions_select on themis.subscriptions
  for select to authenticated
  using (themis.is_member(workspace_id));

drop policy if exists usage_monthly_select on themis.usage_monthly;
create policy usage_monthly_select on themis.usage_monthly
  for select to authenticated
  using (themis.is_member(workspace_id));

-- audit_log: admin|owner read; no client write policy.
drop policy if exists audit_log_select on themis.audit_log;
create policy audit_log_select on themis.audit_log
  for select to authenticated
  using (themis.has_role(workspace_id, array['owner', 'admin']));

-- === grants =====================================================================================
-- Nothing to PUBLIC. anon: SELECT on plans only. authenticated: SELECT only, on all five.
-- service_role (BYPASSRLS, server-side only): SELECT on plans (a migration changes plans), full DML
-- on the billing/AI tables, SELECT + INSERT on audit_log (append-only).

revoke all on table themis.plans, themis.ai_runs, themis.subscriptions, themis.usage_monthly,
  themis.audit_log from public, anon, authenticated, service_role;

grant select on table themis.plans to anon, authenticated, service_role;

grant select on table themis.ai_runs, themis.subscriptions, themis.usage_monthly, themis.audit_log
  to authenticated;

grant select, insert, update, delete
  on table themis.ai_runs, themis.subscriptions, themis.usage_monthly
  to service_role;

grant select, insert on table themis.audit_log to service_role;
