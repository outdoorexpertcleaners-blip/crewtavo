-- Field crew ("Employee") see the scope of work on every job, not only their own visits'.
--
-- They see the whole team's schedule (20261119000100_crew_sees_team.sql) and need to know what each
-- job is: the services and their descriptions from the estimate. job_scope gives exactly that and
-- never a price (no unit_price, no totals, discount lines left out), so field crew are added to the
-- roles that read any job's. Otherwise as 20261025002003_sub_field_app.sql: subs still read only
-- their own visits' jobs.
create or replace function public.job_scope(p_job uuid)
returns table (id uuid, name text, description text, quantity numeric, unit text, sort integer)
language sql stable security definer set search_path = '' as $$
  select li.id, li.name, li.description, li.quantity, li.unit, li.sort
  from public.job_line_items li
  join public.jobs j on j.id = li.job_id
  where li.job_id = p_job
    and li.unit_price >= 0 -- discount lines are about money, not work
    and (private.has_role(j.company_id, '{owner,admin,office,estimator,crew_lead,field_crew}')
         or (private.is_member(j.company_id) and private.crew_sees_job(j.id))
         or (j.company_id = any (private.sub_companies()) and private.crew_sees_job(j.id)))
  order by li.sort, li.name
$$;
