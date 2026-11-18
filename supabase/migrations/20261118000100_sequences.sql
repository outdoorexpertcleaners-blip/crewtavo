-- Sequences: GoHighLevel-style workflows. A list of steps (wait, text, alert the office, make a task,
-- move the lead, a business-hours fork, go to a step) that a client goes through one at a time,
-- started by something that happens: a lead comes in (request.created), a quote is sent
-- (quote.sent) or a job is completed (job.completed). One per brand (washing or lights) or for both.
--
-- The steps are core/sequences.ts SequenceStep, read back defensively; the engine is
-- apps/api/src/services/sequences.ts, run every minute (tasks.ts "sequences"). What happens when the
-- client texts back is the sequence's own (on_reply): the lead turns hot (its texts stop, the lead
-- moves to Hot Inbound Lead and the office hears), the follow-up pauses until someone resumes it,
-- or it just stops.
--
-- sequence_runs: each client going through a sequence, where they are and what has happened, at
-- most once per sequence and record. The engine writes them; the office reads them and pauses,
-- resumes or stops one through the API (routes/sequences.ts).
--
-- sequence_cursors: the newest activity each company's sequences have started from, so each event
-- starts its sequences once, and a company that turns sequences on doesn't start them for the past.

create table public.sequences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  brand text check (brand in ('washing', 'lights')),
  trigger text not null check (trigger in ('request.created', 'quote.sent', 'job.completed')),
  on_reply text not null default 'stop' check (on_reply in ('hot', 'pause', 'stop')),
  send_window jsonb check (send_window is null or jsonb_typeof(send_window) = 'object'),
  steps jsonb not null default '[]' check (jsonb_typeof(steps) = 'array' and pg_column_size(steps) <= 100000),
  enabled boolean not null default false,
  template_key text,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create index sequences_company_idx on public.sequences (company_id, trigger) where enabled;
select private.add_touch_triggers(array['sequences']);

comment on table public.sequences is 'GoHighLevel-style workflows: steps a client goes through one at a time (core/sequences.ts).';
comment on column public.sequences.send_window is 'When its texts may go: {days: [0-6, Sunday 0], start: "HH:MM", end: "HH:MM"} in the company''s time zone. Null: any time.';
comment on column public.sequences.on_reply is 'When the client texts back: hot (stop, lead to Hot Inbound Lead, tell the office), pause (until resumed), stop.';

alter table public.sequences enable row level security;
create policy sequences_read on public.sequences for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
create policy sequences_insert on public.sequences for insert to authenticated
  with check (private.has_role(company_id, '{owner,admin,office}'));
create policy sequences_update on public.sequences for update to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'))
  with check (private.has_role(company_id, '{owner,admin,office}'));
create policy sequences_delete on public.sequences for delete to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
select private.fold_member_checks('public.sequences');

create table public.sequence_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  sequence_id uuid not null,
  client_id uuid,
  subject_type text not null check (subject_type in ('request', 'quote', 'job')),
  subject_id uuid not null,
  brand text check (brand in ('washing', 'lights')),
  step integer not null default 0,
  status text not null default 'active' check (status in ('active', 'paused', 'done', 'stopped')),
  next_at timestamptz not null default now(),
  -- The client texted back and the engine hasn't acted on it yet.
  reply_at timestamptz,
  paused_at timestamptz,
  ended_reason text,
  log jsonb not null default '[]' check (jsonb_typeof(log) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sequence_id, subject_id),
  foreign key (company_id, sequence_id) references public.sequences (company_id, id) on delete cascade,
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade
);
create index sequence_runs_due_idx on public.sequence_runs (next_at) where status = 'active';
create index sequence_runs_client_idx on public.sequence_runs (client_id) where status in ('active', 'paused');
create index sequence_runs_subject_idx on public.sequence_runs (subject_id);
select private.add_touch_triggers(array['sequence_runs']);

comment on table public.sequence_runs is 'A client going through a sequence: the step they''re at, when it''s next due, and what happened.';

alter table public.sequence_runs enable row level security;
create policy sequence_runs_read on public.sequence_runs for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator}'));
select private.fold_member_checks('public.sequence_runs');

create table public.sequence_cursors (
  company_id uuid primary key references public.companies (id) on delete cascade,
  last_activity_id bigint not null default 0,
  updated_at timestamptz not null default now()
);
comment on table public.sequence_cursors is 'The newest activity a company''s sequences have started from (services/sequences.ts).';
alter table public.sequence_cursors enable row level security;
