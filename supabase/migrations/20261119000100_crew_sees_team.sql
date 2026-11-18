-- Field crew ("Employee") see the whole team's schedule and look up any client.
--
-- Until now field crew read only their own work: the visits they're on, and the jobs, clients,
-- properties, contacts and texts behind them (20261017001300_field_crew_scope.sql,
-- 20261112000110_crew_contacts.sql). The owner wants them to see the whole team's day (to look
-- at, not to change) and to look up any client: how to reach them, their properties, and their
-- past texts and notes. So field crew now read, like crew leads:
--
--   visits            every visit on the schedule (VISIT_FIELDS in apps/api/src/services/schedule.ts)
--   jobs              every job, for the title, number and client on a visit. The jobs table holds no
--                     money: what a job is worth lives in job_financials (20261017001400), which
--                     stays the office's and sales'. Its other columns are settings (pricing,
--                     invoice_schedule, autopay: how it's billed, never an amount).
--   clients           every client, and their properties and other contacts
--   messages          every client's texts, emails and notes, except the ones that carry prices or
--                     the client's own links: messages about a quote, job, invoice or autopay that
--                     the business sent stay with the office, as they are for crew leads.
--
-- And they can add a note to any client's timeline (the Notes box on a client's page), as they
-- could for the clients they work for; other messages are as before.
--
-- What stays as it was:
--   - Changing a visit: only the people on it, and only its status and notes (visits_update_assigned).
--   - Gate, lockbox and alarm codes (property_access): only the people on a visit there, on the day.
--   - Files and news (attachments, activity): their own work's (20261112000110_crew_contacts.sql).
--   - Everything about money or how the business is run: quotes, job_line_items, job_financials,
--     invoices, payments, services, sequences and sequence_runs, and requests (the leads list).
--   - Crew leads and up, as before; subs read their own visits through their own policies
--     (20261025002003_sub_field_app.sql): private.has_role and private.is_member never count a sub.
--
-- One column to know about: visits.price (20261113000100), a snow visit's own price when a storm is
-- billed by depth. Crew leads already read it, and field crew read it on their own visits; it can't
-- be closed to field crew alone with a column grant (grants are for everyone signed in), so it's
-- left as it is. Outdoor Expert doesn't run the Snow app, so no visit has one, and the schedule and
-- field screens never ask for it.

-- Visits: the whole team's schedule.
drop policy if exists visits_read on public.visits;
create policy visits_read on public.visits for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead,field_crew}')
);

-- Jobs: every job's title, number and client (no money: see above).
drop policy if exists jobs_read on public.jobs;
create policy jobs_read on public.jobs for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead,field_crew}')
);

-- Clients, their properties and their other contacts: the whole customer list.
drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead,field_crew}')
);
drop policy if exists properties_read on public.properties;
create policy properties_read on public.properties for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead,field_crew}')
);
drop policy if exists client_contacts_read on public.client_contacts;
create policy client_contacts_read on public.client_contacts for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead,field_crew}')
);

-- Messages: as 20261101000100_autopay.sql, with field crew reading any client's (not only the
-- clients they work for). The first two cases, which keep prices and the client's links with the
-- office, are unchanged; a message with no client (a text from a number nobody knows yet) stays
-- with crew leads and up.
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated using (
  private.is_member(company_id) and case
    when direction <> 'in' and (related_type in ('invoice', 'autopay') or (related_type is null and channel = 'note' and external_id is not null)) then
      private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'invoices')
    when direction <> 'in' and related_type in ('quote', 'job') then
      private.has_role(company_id, '{owner,admin,office,estimator}')
    else
      private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
      or (client_id is not null and private.has_role(company_id, '{field_crew}'))
  end
);

-- Adding to a timeline: as 20261017001300_field_crew_scope.sql, plus a note on any client's.
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated with check (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and client_id is not null and private.crew_sees_client(client_id))
  or (client_id is not null and channel = 'note' and direction = 'internal' and related_type is null and external_id is null
      and private.has_role(company_id, '{field_crew}'))
);

-- The policies above check membership once per query (20261018000990_policy_lookups).
select private.fold_member_checks('public.visits');
select private.fold_member_checks('public.jobs');
select private.fold_member_checks('public.clients');
select private.fold_member_checks('public.properties');
select private.fold_member_checks('public.client_contacts');
select private.fold_member_checks('public.messages');

notify pgrst, 'reload schema';
