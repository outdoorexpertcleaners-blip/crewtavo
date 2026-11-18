-- The time clock as Outdoor Expert keeps it: what someone is working on is the brand (Pressure
-- washing or Christmas lights), the shop, or a break. It copies the owner's own time clock page,
-- where those four are the only choices and a break is never paid.
--
--   time_entries.category   Gains 'washing' and 'lights'. The older kinds ('visit', 'assessment',
--                           'drive', 'other') stay valid, so time already on record keeps its kind;
--                           the field app just no longer offers them (Timesheets and the Clock count
--                           them as Shop / other).
--
--   time_entries.added_by_hand
--                           True for time typed in on the Clock's "Fix times" rather than clocked
--                           with a tap. The record of changes (time_entry_changes) already tells an
--                           edited entry apart, but not time a person added for themselves, which
--                           isn't a change (the entry is its own record). Together they're the "•"
--                           the Clock shows for times changed by hand.
--
--   public.job_brand(job)   Which brand a job is, for the field app: On my way and Start visit
--                           put the clock on that brand. The crew can't read quotes or job lines
--                           (no prices), so this answers just the word, to whoever can see the job,
--                           as job_scope does. The quote's brand when the office set one, else
--                           'lights' when the quote's or job's lines or the job's title name
--                           Christmas-light work (the words core proposalBrand looks for), else
--                           'washing'.
--
--   Breaks                  A company that never chose how breaks are paid is set to "Never paid"
--                           (settings.clock.breaks = 'unpaid', Settings → Company), so the Pay tab
--                           counts hours the way the Clock does. One that chose stays as it is.
--
-- The bell's note about someone else changing your time names the two new kinds too.

alter table public.time_entries drop constraint time_entries_category_check;
alter table public.time_entries add constraint time_entries_category_check
  check (category in ('visit', 'assessment', 'drive', 'shop', 'break', 'other', 'washing', 'lights'));

alter table public.time_entries add column added_by_hand boolean not null default false;
comment on column public.time_entries.added_by_hand is 'Typed in on the Clock''s Fix times rather than clocked with a tap';
-- Readable like the other columns (20261018000700_time_entry_pay_privacy.sql: each new one needs its own grant).
grant select (added_by_hand) on public.time_entries to authenticated;

-- ---------------------------------------------------------------------------------------------
-- A job's brand
-- ---------------------------------------------------------------------------------------------

-- Anyone's job, for the database's own use. The words are core proposalBrand's (packages/core/src/proposal.ts).
create function private.job_brand_of(p_job uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    q.brand,
    case when j.title ~* w.words
           or exists (select 1 from public.quote_line_items qi where qi.quote_id = j.quote_id and qi.name ~* w.words)
           or exists (select 1 from public.job_line_items li where li.job_id = j.id and li.name ~* w.words)
         then 'lights' else 'washing' end)
  from public.jobs j
  cross join (select '\m(roofline|lighting|lights?|christmas|holiday|wreaths?|garlands?|cedar|tree wrap)\M'::text as words) w
  left join public.quotes q on q.id = j.quote_id and q.company_id = j.company_id
  where j.id = p_job
$$;
revoke all on function private.job_brand_of(uuid) from public;

-- For the field app: null for a job the caller can't see (who sees a job as job_scope says).
create function public.job_brand(p_job uuid) returns text
language sql stable security definer set search_path = '' as $$
  select private.job_brand_of(j.id) from public.jobs j
  where j.id = p_job
    and (private.has_role(j.company_id, '{owner,admin,office,estimator,crew_lead}')
         or (private.is_member(j.company_id) and private.crew_sees_job(j.id)))
$$;
revoke all on function public.job_brand(uuid) from public, anon;
grant execute on function public.job_brand(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Breaks aren't paid, where nobody chose otherwise
-- ---------------------------------------------------------------------------------------------

update public.companies
set settings = coalesce(settings, '{}'::jsonb)
  || jsonb_build_object('clock', case when jsonb_typeof(settings -> 'clock') = 'object' then settings -> 'clock' else '{}'::jsonb end || '{"breaks": "unpaid"}'::jsonb)
where settings -> 'clock' ->> 'breaks' is null;

-- ---------------------------------------------------------------------------------------------
-- The bell names the new kinds (20261113001800_time_entry_changes.sql, with 'washing' and 'lights')
-- ---------------------------------------------------------------------------------------------

create or replace function private.time_entry_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.time_entries := coalesce(new, old);
  v_by uuid := (select auth.uid());
  v_reasons jsonb := coalesce(nullif(current_setting('crewtavo.time_change_reasons', true), ''), '{}')::jsonb;
  v_given boolean;
  v_reason text;
  v_stack text;
  v_source text;
  v_edit boolean;
  v_tz text;
  v_body text;
begin
  -- Why, if this write said: once, for this entry.
  v_given := v_reasons ? v_row.id::text;
  if v_given then
    v_reason := nullif(v_reasons ->> v_row.id::text, '');
    perform set_config('crewtavo.time_change_reasons', (v_reasons - v_row.id::text)::text, true);
  end if;

  if tg_op = 'INSERT' then
    -- Their own clock-in, or time they added for themselves: the entry is the record.
    if v_by is not null and v_by = new.user_id then
      return null;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.started_at is not distinct from old.started_at and new.ended_at is not distinct from old.ended_at
       and new.category is not distinct from old.category and new.visit_id is not distinct from old.visit_id
       and new.job_id is not distinct from old.job_id and new.notes is not distinct from old.notes then
      return null;
    end if;
  elsif not exists (select 1 from public.companies c where c.id = old.company_id) then
    -- The whole company is being deleted, and its records with it.
    return null;
  end if;

  -- What did it. The database's own writers are known by being on the way here.
  get diagnostics v_stack = pg_context;
  v_source := case
    when v_stack ~ '\mfinished_visit_clock\M' then 'finished_visit'
    when v_stack ~ '\m(clock_upkeep|stop_doubled_clocks)\M' then 'auto_stop'
    when v_stack ~ '\mone_running_clock\M' then 'next_clock'
    when v_stack ~ '\m(end_sub_clocks|sub_clock_off_visit)\M' then 'sub_off_clock'
    when tg_op = 'UPDATE' and new.geofence_out and not old.geofence_out then 'geofence'
    when tg_op = 'INSERT' and new.geofence_in then 'geofence'
    -- Its visit or job was deleted, and came off the entry with it (the foreign keys' set null).
    when tg_op = 'UPDATE' and ((old.visit_id is not null and new.visit_id is null and not exists (select 1 from public.visits v where v.id = old.visit_id))
                               or (old.job_id is not null and new.job_id is null and not exists (select 1 from public.jobs j where j.id = old.job_id))) then 'system'
    when private.assistant_client() is not null then 'assistant'
    when v_by is null or pg_trigger_depth() > 1 then 'system'
    else 'person'
  end;

  -- The clock running its course: a running clock stopped or moved, its start as it was, by a tap
  -- or by the database. Anything Timesheets sends as an edit (a reason, even an empty one) is one.
  v_edit := not (tg_op = 'UPDATE' and not v_given and old.ended_at is null and new.started_at is not distinct from old.started_at);

  insert into public.time_entry_changes (company_id, entry_id, user_id, action, changed_by, source, reason,
    old_started_at, new_started_at, old_ended_at, new_ended_at, old_category, new_category,
    old_visit_id, new_visit_id, old_job_id, new_job_id, old_notes, new_notes, edit, entry_started_at)
  values (v_row.company_id, v_row.id, v_row.user_id,
    case tg_op when 'INSERT' then 'added' when 'UPDATE' then 'changed' else 'deleted' end, v_by, v_source, v_reason,
    old.started_at, new.started_at, old.ended_at, new.ended_at, old.category, new.category,
    old.visit_id, new.visit_id, old.job_id, new.job_id, old.notes, new.notes, v_edit, v_row.started_at);

  -- Told on the bell when someone else edits their time (its times or its type) or deletes it. A
  -- tap that stops their running clock (the crew clock, the office stopping it for them) is
  -- recorded above and not announced, and neither is a change to the note, visit or job alone.
  if v_by is not null and v_by <> v_row.user_id and v_source in ('person', 'assistant')
     and (tg_op = 'DELETE'
          or (tg_op = 'UPDATE' and v_edit and (v_given
                or new.started_at is distinct from old.started_at or new.ended_at is distinct from old.ended_at
                or new.category is distinct from old.category)))
     and exists (select 1 from public.memberships m where m.company_id = v_row.company_id and m.user_id = v_row.user_id and m.active) then
    select coalesce(c.timezone, 'UTC') into v_tz from public.companies c where c.id = v_row.company_id;
    v_body := case
      when old.ended_at is null then format('It was running since %s.', to_char(old.started_at at time zone v_tz, 'FMHH12:MI AM'))
      else format('It was %s to %s.', to_char(old.started_at at time zone v_tz, 'FMHH12:MI AM'), to_char(old.ended_at at time zone v_tz, 'FMHH12:MI AM'))
    end;
    if tg_op = 'UPDATE' then
      v_body := v_body || E'\n' || case
        when new.ended_at is null then format('It''s now running since %s.', to_char(new.started_at at time zone v_tz, 'FMHH12:MI AM'))
        else format('It''s now %s to %s.', to_char(new.started_at at time zone v_tz, 'FMHH12:MI AM'), to_char(new.ended_at at time zone v_tz, 'FMHH12:MI AM'))
      end;
      if new.category is distinct from old.category then
        v_body := v_body || E'\n' || format('It''s now marked as %s.', case new.category
          when 'visit' then 'a visit' when 'assessment' then 'an assessment' when 'drive' then 'driving'
          when 'shop' then 'shop time' when 'break' then 'a break' when 'washing' then 'pressure washing'
          when 'lights' then 'Christmas lights' else 'other work' end);
      end if;
    end if;
    if v_reason is not null then
      -- One line, whatever they typed: the bell reads a body line by line.
      v_body := v_body || E'\n' || format('Why: %s', regexp_replace(v_reason, '\s+', ' ', 'g'));
    end if;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    values (v_row.company_id, v_row.user_id, 'time',
      left(format(case when tg_op = 'DELETE' then '%s deleted your time on %s' else '%s changed your time on %s' end,
        coalesce(nullif((select p.full_name from public.profiles p where p.user_id = v_by), ''), 'Someone'),
        to_char(old.started_at at time zone v_tz, 'Dy Mon FMDD')), 300),
      v_body, '/timesheets');
  end if;
  return null;
end $$;

notify pgrst, 'reload schema';
