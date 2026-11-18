-- A lead form's brand and lead source, for a business that sells under two names (Outdoor Expert
-- Cleaners and Outdoor Expert Lighting) and tags each lead with where it came from, as its
-- GoHighLevel forms did.
--
-- intake_forms.brand: the request a form makes is that brand's (requests.brand), so its sales-board
-- pipeline and its workflows are that brand's. Null: worked out as before (core requestBrand).
-- intake_forms.lead_source: what a new client's lead source is set to ("Website"). A link to the form
-- can say otherwise (?source=Facebook), for the same form behind an ad.

alter table public.intake_forms
  add column brand text check (brand in ('washing', 'lights')),
  add column lead_source text check (length(lead_source) <= 60);
