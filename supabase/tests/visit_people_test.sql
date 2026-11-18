-- Database tests for 20261113000210_visit_people.sql: who is on a visit is the people listed on it
-- or, with nobody listed, its crew's members. Field crew see and work those visits (and what's
-- behind them, with the gate code on the day); schedule notifications go to those people; a visit
-- that changes crew swaps the crews' people; and a recurring job's whole schedule changing is one
-- line each.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tvp;
grant usage on schema tvp to authenticated, service_role;
create function tvp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tvp.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- The lines of someone's schedule notifications that haven't been read, oldest first.
create function tvp.lines(p_user uuid) returns text[] language sql security definer as $$
  select coalesce(array_agg(l order by n.created_at, o), '{}')
  from public.notifications n cross join lateral unnest(string_to_array(n.body, E'\n')) with ordinality as x(l, o)
  where n.user_id = p_user and n.kind = 'schedule' and n.read_at is null
$$;
create function tvp.count(p_user uuid) returns bigint language sql security definer as $$
  select count(*) from public.notifications n where n.user_id = p_user and n.kind = 'schedule' and n.read_at is null
$$;
-- Everyone has read everything: the next change starts a new notification.
create function tvp.read_all() returns void language sql security definer as $$
  update public.notifications set read_at = now() where read_at is null and user_id::text like 'fd210000-%'
$$;
grant execute on all functions in schema tvp to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('fd210000-0000-0000-0000-000000000001', 'owner@tango.test', '{"full_name": "Tess Owner"}'),
  ('fd210000-0000-0000-0000-00000000000a', 'ann@tango.test', '{"full_name": "Ann Mower"}'),
  ('fd210000-0000-0000-0000-00000000000b', 'bob@tango.test', '{"full_name": "Bob Mower"}'),
  ('fd210000-0000-0000-0000-00000000000c', 'cy@tango.test', '{"full_name": "Cy Trees"}'),
  ('fd210000-0000-0000-0000-00000000000d', 'dee@tango.test', '{"full_name": "Dee Floater"}');
\set owner '''fd210000-0000-0000-0000-000000000001'''
\set ann '''fd210000-0000-0000-0000-00000000000a'''
\set bob '''fd210000-0000-0000-0000-00000000000b'''
\set cy '''fd210000-0000-0000-0000-00000000000c'''
\set dee '''fd210000-0000-0000-0000-00000000000d'''

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fd210000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Tango Lawn', 'general', 'America/Chicago') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', :ann, 'field_crew'), (:'co', :bob, 'field_crew'), (:'co', :cy, 'field_crew'), (:'co', :dee, 'field_crew');
insert into public.crews (company_id, name) values (:'co', 'Mowing') returning id as mowing \gset
insert into public.crews (company_id, name) values (:'co', 'Trees') returning id as trees \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'mowing', :ann), (:'co', :'mowing', :bob), (:'co', :'trees', :cy);
insert into public.clients (company_id, display_name) values (:'co', 'Mowed client') returning id as client \gset
insert into public.clients (company_id, display_name) values (:'co', 'Other client') returning id as client2 \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'client', '1 Lawn Ln') returning id as place \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'client2', '2 Other Rd') returning id as place2 \gset
insert into public.property_access (company_id, property_id, gate_code) values (:'co', :'place', '1234'), (:'co', :'place2', '9999');
insert into public.jobs (company_id, client_id, property_id, title, kind, recurrence_rule, starts_on, default_crew_id, visit_start_time, visit_duration_min)
values (:'co', :'client', :'place', 'Weekly mowing', 'recurring', 'FREQ=WEEKLY;BYDAY=MO', current_date, :'mowing', '09:00', 60) returning id as job, number as job_number \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'client2', :'place2', 'Stump') returning id as job2 \gset
-- A visit for the Mowing crew with nobody listed, one with only Dee listed, and one with no crew.
insert into public.visits (company_id, job_id, property_id, title, crew_id, scheduled_on) values (:'co', :'job', :'place', 'Mow the lawn', :'mowing', private.company_today(:'co') + 1) returning id as v_crew \gset
insert into public.visits (company_id, job_id, property_id, title, crew_id, scheduled_on) values (:'co', :'job2', :'place2', 'Grind the stump', :'mowing', private.company_today(:'co') + 1) returning id as v_listed \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'v_listed', :dee);
insert into public.visits (company_id, title, kind, scheduled_on) values (:'co', 'Supply run', 'task', private.company_today(:'co') + 1) returning id as v_none \gset
commit;

\o
\echo 'Who is on a visit'
\o /dev/null

-- ===== The rule ===================================================================================
select tvp.check((select array_agg(u order by u) from private.visit_people(:'v_crew') u) = array[:ann, :bob]::uuid[], 'with nobody listed, the crew''s members are on a visit');
select tvp.check((select array_agg(u) from private.visit_people(:'v_listed') u) = array[:dee]::uuid[], 'with someone listed, only the people listed are (the crew isn''t)');
select tvp.check((select count(*) from private.visit_people(:'v_none') u) = 0, 'no crew and nobody listed: nobody');

-- ===== New visits tell the people on them =========================================================
select tvp.check(tvp.lines(:ann) = array['You''re on Mow the lawn: ' || private.visit_when(null, private.company_today(:'co') + 1, 'America/Chicago')],
  'a new visit for a crew tells its members they''re on it, and one given to someone else instead tells them nothing');
select tvp.check(tvp.lines(:bob) = tvp.lines(:ann) and tvp.count(:bob) = 1, 'each member, once');
select tvp.check(tvp.lines(:dee) = array['You''re on Grind the stump: ' || private.visit_when(null, private.company_today(:'co') + 1, 'America/Chicago')], 'the person listed hears as before');
select tvp.check(tvp.count(:cy) = 0 and tvp.count(:owner) = 0, 'another crew and the person who made it hear nothing');

-- ===== What field crew see and work ===============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fd210000-0000-0000-0000-00000000000a", "role": "authenticated"}', true);
-- Field crew read the whole team's schedule, with every job, client and property
-- (20261119000100_crew_sees_team.sql); gate codes and changes stay with the people on a visit.
select tvp.check((select array_agg(title order by title) from public.visits) = '{"Grind the stump","Mow the lawn","Supply run"}', 'a crew member sees the whole team''s schedule');
select tvp.check((select array_agg(title order by title) from public.jobs) = '{Stump,"Weekly mowing"}' and (select array_agg(display_name order by display_name) from public.clients) = '{"Mowed client","Other client"}'
  and (select array_agg(line1 order by line1) from public.properties) = '{"1 Lawn Ln","2 Other Rd"}', 'with every job, client and property');
select tvp.check((select array_agg(gate_code) from public.property_access) = '{1234}', 'and only the gate code of their crew''s visit with nobody listed, the day before');
with x as (update public.visits set status = 'en_route' where id in (:'v_crew', :'v_listed') returning title)
select tvp.check((select array_agg(title) from x) = '{"Mow the lawn"}', 'they can start it, and not the other');
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fd210000-0000-0000-0000-00000000000d", "role": "authenticated"}', true);
select tvp.check((select array_agg(title) from public.visits) = '{"Grind the stump"}' and (select array_agg(gate_code) from public.property_access) = '{9999}', 'someone listed sees their visit, as before');
select set_config('request.jwt.claims', '{"sub": "fd210000-0000-0000-0000-00000000000c", "role": "authenticated"}', true);
select tvp.check((select count(*) from public.visits) = 3 and (select count(*) from public.clients) = 2 and (select count(*) from public.property_access) = 0, 'another crew''s member sees the schedule and the clients, and no gate code');
with x as (update public.visits set status = 'en_route' where id in (:'v_crew', :'v_listed') returning title)
select tvp.check(not exists (select 1 from x), 'and starts none of those visits');
rollback;

-- ===== Moved, cancelled and deleted visits tell the people on them ================================
select tvp.read_all();
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fd210000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.visits set scheduled_on = scheduled_on + 1 where id in (:'v_crew', :'v_listed');
commit;
select tvp.check((tvp.lines(:ann))[1] like 'Mow the lawn moved to % (was %)' and cardinality(tvp.lines(:ann)) = 1 and tvp.lines(:bob) = tvp.lines(:ann), 'a crew''s visit that moves tells its members');
select tvp.check((tvp.lines(:dee))[1] like 'Grind the stump moved to %' and cardinality(tvp.lines(:dee)) = 1 and tvp.count(:cy) = 0, 'and one with people listed tells them, not its crew');

select tvp.read_all();
update public.visits set status = 'cancelled' where id = :'v_crew';
select tvp.check((tvp.lines(:ann))[1] like 'Mow the lawn on % was cancelled' and tvp.lines(:bob) = tvp.lines(:ann), 'cancelling tells the crew');
update public.visits set status = 'scheduled' where id = :'v_crew';
select tvp.read_all();
insert into public.visits (company_id, title, kind, crew_id, scheduled_on) values (:'co', 'Edge the beds', 'task', :'mowing', private.company_today(:'co') + 3) returning id as v_gone \gset
select tvp.read_all();
delete from public.visits where id = :'v_gone';
select tvp.check((tvp.lines(:ann))[1] like 'Edge the beds on % was cancelled' and tvp.lines(:bob) = tvp.lines(:ann), 'and so does deleting it');

-- ===== Listing people on a crew's visit, and taking them off ======================================
select tvp.read_all();
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'v_crew', :ann), (:'co', :'v_crew', :dee);
select tvp.check(tvp.count(:ann) = 0, 'someone listed who was on it with their crew isn''t told again');
select tvp.check((tvp.lines(:dee))[1] like 'You''re on Mow the lawn: %', 'someone listed from outside the crew is told');
select tvp.check((tvp.lines(:bob))[1] like 'You''re off Mow the lawn (%)', 'and the rest of the crew are told they''re off it');
select tvp.read_all();
delete from public.visit_assignees where visit_id = :'v_crew' and user_id = :dee;
select tvp.check((tvp.lines(:dee))[1] like 'You''re off Mow the lawn (%)' and tvp.count(:ann) = 0 and tvp.count(:bob) = 0, 'taking one of several off tells only them');
select tvp.read_all();
delete from public.visit_assignees where visit_id = :'v_crew';
select tvp.check((tvp.lines(:bob))[1] like 'You''re on Mow the lawn: %' and tvp.count(:ann) = 0, 'taking the last one off puts the crew back on: the others hear, the one who stays doesn''t');

-- On it and off again within moments is no news.
select tvp.read_all();
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fd210000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.visits (company_id, title, kind, crew_id, scheduled_on) values (:'co', 'Trim the hedge', 'task', :'mowing', private.company_today(:'co') + 2) returning id as v_new \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'v_new', :ann);
commit;
select tvp.check((tvp.lines(:ann))[1] like 'You''re on Trim the hedge: %' and tvp.count(:bob) = 0, 'a visit made for a crew and given to one of them tells that one, and the others nothing');

-- ===== A visit that moves to another crew ========================================================
-- Nobody listed: the crews are the people on it.
select tvp.read_all();
update public.visits set crew_id = :'trees' where id = :'v_crew';
select tvp.check((tvp.lines(:ann))[1] like 'You''re off Mow the lawn (%)' and tvp.lines(:bob) = tvp.lines(:ann), 'the old crew hear they''re off it');
select tvp.check((tvp.lines(:cy))[1] like 'You''re on Mow the lawn: %' and cardinality(tvp.lines(:cy)) = 1, 'the new crew that they''re on it');
select tvp.check((select count(*) from public.visit_assignees where visit_id = :'v_crew') = 0, 'and nobody is listed, so it goes on by its crew');
-- To another crew and another day at once: one line each, not two.
select tvp.read_all();
update public.visits set crew_id = :'mowing', scheduled_on = scheduled_on + 1 where id = :'v_crew';
select tvp.check(cardinality(tvp.lines(:ann)) = 1 and (tvp.lines(:ann))[1] like 'You''re on Mow the lawn: %' and cardinality(tvp.lines(:cy)) = 1 and (tvp.lines(:cy))[1] like 'You''re off Mow the lawn (%)',
  'moved to another crew and another day at once, each person hears one thing');

-- The old crew listed, with someone picked by hand: the crew's people swap, the other stays.
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'v_crew', :ann), (:'co', :'v_crew', :bob), (:'co', :'v_crew', :dee);
select tvp.read_all();
update public.visits set crew_id = :'trees' where id = :'v_crew';
select tvp.check((select array_agg(user_id order by user_id) from public.visit_assignees where visit_id = :'v_crew') = array[:cy, :dee]::uuid[],
  'with the old crew listed, they come off and the new crew go on; someone picked by hand stays');
select tvp.check((tvp.lines(:ann))[1] like 'You''re off Mow the lawn (%)' and tvp.lines(:bob) = tvp.lines(:ann) and (tvp.lines(:cy))[1] like 'You''re on Mow the lawn: %' and tvp.count(:dee) = 0,
  'and each is told once');
-- People picked by hand, none of them on the old crew: the list stays as it is.
select tvp.read_all();
update public.visits set crew_id = :'trees' where id = :'v_listed';
select tvp.check((select array_agg(user_id) from public.visit_assignees where visit_id = :'v_listed') = array[:dee]::uuid[] and tvp.count(:cy) = 0 and tvp.count(:ann) = 0 and tvp.count(:dee) = 0,
  'a list with none of the old crew on it stays as it is, and nobody is told');
-- Someone on both crews stays on.
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'mowing', :cy);
update public.visits set crew_id = :'mowing' where id = :'v_crew';
select tvp.check((select array_agg(user_id order by user_id) from public.visit_assignees where visit_id = :'v_crew') = array[:ann, :bob, :cy, :dee]::uuid[], 'someone on both crews stays listed');
delete from public.crew_members where crew_id = :'mowing' and user_id = :cy;
delete from public.visit_assignees where visit_id = :'v_crew';

-- ===== Recurring visits ===========================================================================
-- The nightly task's (they have the date they're for): nobody hears about a year of them.
select tvp.read_all();
insert into public.visits (company_id, job_id, property_id, title, crew_id, scheduled_on, starts_at, ends_at, recurrence_key)
select :'co', :'job', :'place', 'Weekly mowing', :'mowing', d::date, private.zoned_time(d::date, '09:00', 'America/Chicago'), private.zoned_time(d::date, '10:00', 'America/Chicago'), to_char(d, 'YYYY-MM-DD')
from generate_series(private.company_today(:'co') + 7, private.company_today(:'co') + 364, interval '7 days') d;
select tvp.check((select count(*) from public.visits where job_id = :'job' and recurrence_key is not null) = 52 and tvp.count(:ann) = 0 and tvp.count(:bob) = 0, 'a year of a recurring job''s visits is made without telling anyone');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fd210000-0000-0000-0000-00000000000b", "role": "authenticated"}', true);
select tvp.check((select count(*) from public.visits where recurrence_key is not null) = 52, 'and the crew''s members see them all');
rollback;

-- ===== Someone who has left the team =============================================================
select tvp.read_all();
update public.memberships set active = false where company_id = :'co' and user_id = :bob;
update public.visits set scheduled_on = scheduled_on + 1 where id = :'v_crew';
select tvp.check((tvp.lines(:ann))[1] like 'Mow the lawn moved to %' and tvp.count(:bob) = 0, 'a crew member who has left the team isn''t told');

delete from public.companies where id = :'co';
set client_min_messages = warning;
drop schema tvp cascade;
reset client_min_messages;

\o
\echo 'All visit people tests passed (34 checks).'
