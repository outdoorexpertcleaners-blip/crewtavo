-- The team sees what each job is priced at (the owner: "Do not hide pricing").
--
-- Until now a job's line items, with their prices, were the office's and sales' only
-- (20261017001200_crew_job_privacy.sql); the crew read the work through job_scope, which leaves
-- prices out. Outdoor Expert's techs quote and talk price with clients on site, so crew leads and
-- field crew read every job's lines too: the visit screen's Scope of work shows each service's price
-- and the job's total. Still the office's: invoices and payments, job costs and profit
-- (job_financials), finance reports and everyone's pay. Subs are unchanged: they read their own
-- visits' work through job_scope, never what the client pays.
drop policy if exists job_line_items_read on public.job_line_items;
create policy job_line_items_read on public.job_line_items for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator,crew_lead,field_crew}'));

