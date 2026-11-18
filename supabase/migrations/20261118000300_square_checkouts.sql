-- Square: each checkout page (Square payment link) made when a client presses Pay on an invoice
-- (apps/api services/square.ts). The payment is booked from Square's payment once it's completed,
-- found by the link's order. Only the server writes here.

create table public.square_checkouts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  invoice_id uuid,
  environment text not null check (environment in ('sandbox', 'production')),
  link_id text not null,
  order_id text not null unique,
  url text not null,
  amount_cents integer not null check (amount_cents > 0),
  tip_cents integer not null default 0 check (tip_cents >= 0),
  status text not null default 'open' check (status in ('open', 'paid', 'replaced')),
  payment_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, invoice_id) references public.invoices (company_id, id) on delete set null (invoice_id)
);
create index square_checkouts_invoice_idx on public.square_checkouts (invoice_id) where status = 'open';
select private.add_touch_triggers(array['square_checkouts']);

comment on table public.square_checkouts is 'Square checkout pages for paying invoices, and the payment that paid each (services/square.ts).';

alter table public.square_checkouts enable row level security;
create policy square_checkouts_read on public.square_checkouts for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
select private.fold_member_checks('public.square_checkouts');
