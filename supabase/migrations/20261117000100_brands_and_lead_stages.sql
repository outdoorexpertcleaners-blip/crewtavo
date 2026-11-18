-- Brands and lead stages, for a business that sells under two names from one account (Outdoor
-- Expert Cleaners and Outdoor Expert Lighting) and works its leads in GoHighLevel-style stages.
--
-- requests.brand / quotes.brand: 'washing' or 'lights'. Null means "work it out": a quote's brand
-- then comes from its lines (core proposalBrand: a Christmas-lights service makes it lights), and a
-- request's from its quotes, else washing. The office sets it by hand only to override that.
--
-- requests.stage: where a lead sits before it has a quote, as the office moved it on the sales board
-- (core pipeline.ts): 'inbound', 'hot', 'reached_out', 'estimate_booked', 'remote_quote'. Null
-- means it's where its status puts it (new → inbound; an assessment booked or done →
-- estimate_booked). Quotes need no stage of their own: their status says where they are.

alter table public.requests
  add column brand text check (brand in ('washing', 'lights')),
  add column stage text check (stage in ('inbound', 'hot', 'reached_out', 'estimate_booked', 'remote_quote'));

alter table public.quotes
  add column brand text check (brand in ('washing', 'lights'));
