-- Database tests for texts from unknown numbers (20261113000310_unknown_texts.sql): the server
-- keeps them, the whole team reads them (field crew too since 20261119000400_crew_reads_all_texts.sql),
-- the office deletes them, and attaching a number to a client (as their phone, or as a new
-- contact) moves its texts onto that client's timeline.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_ut;
grant usage on schema t_ut to authenticated, service_role;
create function t_ut.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t_ut.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
create function t_ut.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on all functions in schema t_ut to authenticated, service_role;

-- Uma owns Umber Unknown Lawn, Oren is in its office, Esme estimates and Finn is field crew.
-- Nell owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('07e70000-0000-0000-0000-000000000001', 'uma@umber-unknown.test', '{"full_name": "Uma Umber"}'),
  ('07e70000-0000-0000-0000-000000000002', 'oren@umber-unknown.test', '{"full_name": "Oren Office"}'),
  ('07e70000-0000-0000-0000-000000000003', 'esme@umber-unknown.test', '{"full_name": "Esme Estimator"}'),
  ('07e70000-0000-0000-0000-000000000004', 'finn@umber-unknown.test', '{"full_name": "Finn Field"}'),
  ('07e70000-0000-0000-0000-000000000009', 'nell@north-unknown.test', '{"full_name": "Nell North"}');
\set uma '07e70000-0000-0000-0000-000000000001'
\set oren '07e70000-0000-0000-0000-000000000002'
\set esme '07e70000-0000-0000-0000-000000000003'
\set finn '07e70000-0000-0000-0000-000000000004'
\set nell '07e70000-0000-0000-0000-000000000009'

begin;
set local role authenticated;
select t_ut.as_user(:'nell');
select public.create_company('North Unknown Co', 'general') as other \gset
select t_ut.as_user(:'uma');
select public.create_company('Umber Unknown Lawn', 'general') as co \gset
commit;
begin;
set local role service_role;
insert into public.memberships (company_id, user_id, role) values (:'co', :'oren', 'office'), (:'co', :'esme', 'estimator'), (:'co', :'finn', 'field_crew');
commit;
insert into public.clients (company_id, display_name, phone) values (:'co', 'Ada Asked', '(540) 555-0141') returning id as ada \gset
insert into public.clients (company_id, display_name) values (:'co', 'Bo Both') returning id as bo \gset
insert into public.clients (company_id, display_name) values (:'other', 'Cy Elsewhere') returning id as cy \gset

-- The webhook (the server) keeps texts from three numbers; one of them texted STOP earlier.
insert into public.unknown_texts (company_id, from_phone, phone_key, body, external_id, created_at) values
  (:'co', '+15405550163', '5405550163', 'Do you plow driveways?', 'SM1', now() - interval '2 hours'),
  (:'co', '+15405550163', '5405550163', 'This is Ada''s husband', 'SM2', now() - interval '1 hour'),
  (:'co', '+15405550177', '5405550177', 'New number, it''s Bo', 'SM3', now() - interval '30 minutes'),
  (:'co', '+15405550188', '5405550188', 'Wrong number?', 'SM4', now()),
  (:'other', '+15405550163', '5405550163', 'For the other business', 'SM5', now());
insert into public.sms_stops (company_id, phone_key, phone, stopped_at) values (:'co', '5405550177', '+15405550177', '2026-11-01 12:00+00');
select t_ut.expect_error(format($q$insert into public.unknown_texts (company_id, from_phone, phone_key, body) values (%L, '+15405550163', '+15405550163', 'x')$q$, :'co'),
  'a number is kept by its last 10 digits');

\o
\echo 'Who reads and deletes'
\o /dev/null

begin;
set local role authenticated;
select t_ut.as_user(:'oren');
select t_ut.check((select count(*) = 4 from public.unknown_texts), 'the office reads its company''s texts from unknown numbers');
select t_ut.expect_error(format($q$insert into public.unknown_texts (company_id, from_phone, phone_key, body) values (%L, '+15405550199', '5405550199', 'made up')$q$, :'co'),
  'and can''t make one up');
select t_ut.expect_error($q$update public.unknown_texts set body = 'changed'$q$, 'or change one');
select t_ut.as_user(:'esme');
select t_ut.check((select count(*) = 4 from public.unknown_texts), 'an estimator reads them too');
delete from public.unknown_texts where phone_key = '5405550188';
select t_ut.check((select count(*) = 4 from public.unknown_texts), 'but doesn''t delete them');
select t_ut.as_user(:'finn');
-- The whole team reads them since 20261119000400_crew_reads_all_texts.sql (a client texting the crew
-- from a new phone), but attaching and deleting stay as they were.
select t_ut.check((select count(*) = 4 from public.unknown_texts), 'field crew read them too');
delete from public.unknown_texts where phone_key = '5405550188';
select t_ut.check((select count(*) = 4 from public.unknown_texts), 'but don''t delete them');
select t_ut.expect_error(format($q$select public.attach_unknown_texts(%L, '+15405550163', %L, 'contact', 'Hal')$q$, :'co', :'ada'), 'or attach a number');
select t_ut.as_user(:'nell');
select t_ut.check((select count(*) = 1 and bool_and(body = 'For the other business') from public.unknown_texts), 'another business reads only its own');
select t_ut.expect_error(format($q$select public.attach_unknown_texts(%L, '+15405550163', %L, 'contact', 'Hal')$q$, :'co', :'ada'), 'and can''t attach this one''s');
select t_ut.check(not has_function_privilege('anon', 'public.attach_unknown_texts(uuid, text, uuid, text, text)', 'execute'), 'nor can anyone signed out');
rollback;

\o
\echo 'Messages with no client, for field crew'
\o /dev/null

-- 20261119000400_crew_reads_all_texts.sql: field crew read a message with no client, as crew leads
-- do, but a quote the business sent stays with the office and sales, as before.
begin;
insert into public.messages (company_id, client_id, channel, direction, status, body, related_type) values
  (:'co', null, 'sms', 'in', 'received', 'From nobody yet', null),
  (:'co', null, 'email', 'out', 'sent', 'Your quote ($900.00): https://ops.test/hub/SIGNED', 'quote');
set local role authenticated;
select t_ut.as_user(:'finn');
select t_ut.check((select count(*) = 1 and bool_and(body = 'From nobody yet') from public.messages where company_id = :'co' and client_id is null), 'field crew read a message with no client, but not a quote we sent');
select t_ut.as_user(:'esme');
select t_ut.check((select count(*) = 2 from public.messages where company_id = :'co' and client_id is null), 'an estimator reads both');
rollback;

\o
\echo 'Attaching a number to a client'
\o /dev/null

begin;
set local role authenticated;
select t_ut.as_user(:'esme');
select t_ut.expect_error(format($q$select public.attach_unknown_texts(%L, '+15405550163', %L, 'contact', '  ')$q$, :'co', :'ada'), 'a contact needs a name');
select t_ut.expect_error(format($q$select public.attach_unknown_texts(%L, '+15405550163', %L, 'owner', 'Hal')$q$, :'co', :'ada'), 'it''s their phone or a contact');
select t_ut.expect_error(format($q$select public.attach_unknown_texts(%L, '+15405550163', %L, 'contact', 'Hal')$q$, :'co', :'cy'), 'the client is this company''s');
select t_ut.expect_error(format($q$select public.attach_unknown_texts(%L, '540-555-0100', %L, 'contact', 'Hal')$q$, :'co', :'ada'), 'and the number has texted');
-- Ada's husband, however the number is written.
select public.attach_unknown_texts(:'co', '(540) 555-0163', :'ada', 'contact', ' Hal Asked ') as moved \gset
select t_ut.check(:moved = 2, 'attaching as a contact says how many texts moved');
select t_ut.check((select count(*) = 1 and bool_and(name = 'Hal Asked' and phone = '+15405550163' and not notify_email and not notify_sms)
  from public.client_contacts where company_id = :'co' and client_id = :'ada'), 'the contact is made with the number, not ticked for reminders');
select t_ut.check((select count(*) = 2 and bool_and(channel = 'sms' and direction = 'in' and status = 'received' and from_phone = '+15405550163' and from_name = 'Hal Asked' and sent_by is null)
  and min(body) = 'Do you plow driveways?' and bool_and(created_at < now() - interval '30 minutes')
  from public.messages where company_id = :'co' and client_id = :'ada'), 'its texts are on the client''s timeline, from the contact, at the times they came');
select t_ut.check((select phone = '(540) 555-0141' and sms_opt_out_at is null from public.clients where id = :'ada'), 'and the client''s own phone is as it was');
select t_ut.check((select count(*) = 0 from public.unknown_texts where company_id = :'co' and phone_key = '5405550163'), 'the number isn''t unknown anymore');
-- Bo's new phone, which texted STOP before anyone knew whose it was.
select t_ut.as_user(:'oren');
select public.attach_unknown_texts(:'co', '+15405550177', :'bo', 'phone') as moved \gset
select t_ut.check(:moved = 1, 'attaching as the client''s phone moves its texts too');
select t_ut.check((select phone = '+15405550177' and sms_opt_out_at = '2026-11-01 12:00+00' from public.clients where id = :'bo'),
  'the client has the number, and a STOP it sent still stands');
select t_ut.check((select count(*) = 1 and bool_and(from_name is null and body = 'New number, it''s Bo') from public.messages where company_id = :'co' and client_id = :'bo'),
  'its texts read as the client''s own');
select t_ut.check((select count(*) = 0 from public.client_contacts where client_id = :'bo'), 'and no contact is made');
-- Only attaching carries a STOP across: nobody signed in sets or clears one by hand, as before.
update public.clients set sms_opt_out_at = null where id = :'bo';
update public.clients set sms_opt_out_at = now() where id = :'ada';
select t_ut.check((select sms_opt_out_at = '2026-11-01 12:00+00' from public.clients where id = :'bo') and (select sms_opt_out_at is null from public.clients where id = :'ada'),
  'and nobody signed in clears or sets a client''s STOP by hand');
commit;

select t_ut.check((select count(*) = 1 and bool_and(phone_key = '5405550188') from public.unknown_texts where company_id = :'co'), 'the other numbers stay where they were');
select t_ut.check((select count(*) = 1 from public.unknown_texts where company_id = :'other'), 'and another business''s texts from the same number are untouched');

begin;
set local role authenticated;
select t_ut.as_user(:'oren');
delete from public.unknown_texts where phone_key = '5405550188';
commit;
select t_ut.check((select count(*) = 0 from public.unknown_texts where company_id = :'co'), 'the office deletes texts it doesn''t want');

-- Left as it was found, for the tests after this one.
delete from public.companies where id in (:'co', :'other');
set client_min_messages = warning;
drop schema t_ut cascade;
reset client_min_messages;

\o
\echo 'All unknown texts tests passed.'
