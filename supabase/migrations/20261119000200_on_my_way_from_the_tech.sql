-- The on-my-way text as the owner wants it, from the person on the way and the brand of the job:
-- "Hi Jane, this is Mike with Outdoor Expert Cleaners. I'm on my way and should be there in about 20
-- minutes." Sent from that brand's Quo line (services/brand.ts brandFor, by the visit's job and
-- quote). The words come from three template tokens the API fills in (services/automations.ts):
--   {{tech.first_name}}  whoever tapped On my way (the event's actor). When it isn't known the text
--                        reads "this is Outdoor Expert Cleaners" (core renderTemplate tidies it).
--   {{brand.name}}       the brand's name on its Big Proposal letterhead, else the company's name.
--   {{eta_there}}        " and should be there in about 20 minutes", or nothing, so it ends
--                        "I'm on my way." when the arrival time isn't known.
--
-- The starter gets the new words, and so do rules still word for word an old starter; one a business
-- changed stays as they wrote it. The rule is switched on for the companies there are now: while Quo
-- is test only it texts nobody but the test numbers (lib/notify.ts quoOut).

-- As in 20261105000210_on_my_way_eta.sql, with the on_my_way text from the person on the way and
-- the job's brand.
create or replace function private.install_default_automations(p_company uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare office jsonb := '["owner", "admin", "office"]';
begin
  insert into public.automation_rules (company_id, template_key, name, description, trigger, delay_minutes, conditions, actions, enabled)
  values
    (p_company, 'notify_quote_approved', 'Tell the office when a quote is approved',
     'A notification for the office as soon as a client approves.', 'quote.approved', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'Quote #{{number}} approved',
       'body', '{{client.name}} approved “{{title}}” ({{total}}).')), true),
    (p_company, 'notify_changes_requested', 'Tell the office when a client asks for changes',
     null, 'quote.changes_requested', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'Changes requested on quote #{{number}}',
       'body', '{{client.name}} wants changes to “{{title}}”.')), true),
    (p_company, 'notify_range_accepted', 'Tell the office when a client says yes to a price range',
     'A notification to book the site visit.', 'quote.range_accepted', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', '["owner", "admin", "office", "estimator"]'::jsonb,
       'title', '{{client.name}} wants a visit', 'body', 'They said yes to the price range for “{{title}}”. Book the site visit.')), true),
    (p_company, 'notify_new_request', 'Tell the office about new online requests',
     'Requests from your booking forms and the Client Hub.', 'request.created', 0,
     jsonb_build_array(jsonb_build_object('field', 'source', 'op', 'in', 'value', jsonb_build_array('web_form', 'hub', 'referral'))),
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'New request from {{client.name}}',
       'body', '{{title}}')), true),
    (p_company, 'notify_invoice_paid', 'Tell the office when an invoice is paid',
     null, 'invoice.paid', 0, jsonb_build_array(jsonb_build_object('field', 'amount_paid', 'op', 'gte', 'value', 0.01)),
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'Invoice #{{number}} paid',
       'body', '{{client.name}} paid {{total}}.')), true),
    (p_company, 'quote_followup', 'Follow up on quotes after 3 days',
     'Emails the client if they haven''t answered a quote three days after you send it.', 'quote.sent', 4320,
     jsonb_build_array(jsonb_build_object('field', 'status', 'op', 'equals', 'value', 'sent')),
     jsonb_build_array(jsonb_build_object('type', 'send_email',
       'subject', 'Following up on your quote from {{company.name}}',
       'body', E'Hi {{client.first_name}},\n\nJust checking whether you had any questions about quote #{{number}} ({{total}}). You can review and approve it here:\n\n{{link}}\n\nThanks,\n{{company.name}}')), true),
    (p_company, 'invoice_overdue', 'Remind clients when an invoice is past due',
     null, 'invoice.overdue', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'send_email',
       'subject', 'Reminder: invoice #{{number}} from {{company.name}} is past due',
       'body', E'Hi {{client.first_name}},\n\nThis is a friendly reminder that invoice #{{number}} has a balance of {{balance}}. You can view and pay it here:\n\n{{link}}\n\nThank you,\n{{company.name}}')), true),
    (p_company, 'visit_reminder', 'Remind clients the day before a visit',
     'Sent the day before each scheduled visit or assessment.', 'visit.reminder', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'send_email',
       'subject', 'Reminder: {{company.name}} is coming {{date}}',
       'body', E'Hi {{client.first_name}},\n\nThis is a reminder that {{company.name}} is scheduled to visit {{address}} on {{date}}{{time}}.\n\nQuestions? Reply to this email or call {{company.phone}}.')), false),
    (p_company, 'on_my_way', 'Text the client when the crew is on the way',
     'Sent when a crew taps “On my way” in the app.', 'visit.en_route', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'send_sms',
       'body', 'Hi {{client.first_name}}, this is {{tech.first_name}} with {{brand.name}}. I''m on my way{{eta_there}}.')), false),
    (p_company, 'review_after_job', 'Ask for a Google review after a job',
     'Sends your review link a day after a job is completed.', 'job.completed', 1440,
     jsonb_build_array(jsonb_build_object('field', 'kind', 'op', 'not_equals', 'value', 'recurring')),
     jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', 'email')), false),
    (p_company, 'review_recurring', 'Ask for a Google review on recurring work',
     'Sends your review link a day after a recurring job reaches the visit you chose in Marketing, once for each job.', 'job.recurring_third_visit', 1440, '[]',
     jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', 'email')), false),
    (p_company, 'referral_after_job', 'Ask for referrals after a job',
     'Emails your referral link a week after a job is completed.', 'job.completed', 10080,
     jsonb_build_array(jsonb_build_object('field', 'kind', 'op', 'not_equals', 'value', 'recurring')),
     jsonb_build_array(jsonb_build_object('type', 'request_referral')), false),
    (p_company, 'reengage_past_clients', 'Re-engage past clients',
     'Emails clients a year after their last visit, once each time they go quiet.', 'client.inactive', 0,
     jsonb_build_array(jsonb_build_object('field', 'days_since_visit', 'op', 'gte', 'value', 365)),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'It''s been a while, {{client.first_name}}',
       'body', E'Hi {{client.first_name}},\n\nIt''s been a while since we last worked together, and we''d love to help again. If anything around the property needs attention, you can ask for a visit online:\n\n{{link}}\n\nOr just reply to this email and we''ll get you on the schedule.\n\nThanks,\n{{company.name}}\n{{company.phone}}')), false),
    (p_company, 'win_back_lost_quotes', 'Win back lost quotes',
     'Emails the client 30 days after a quote is marked lost, if it still is.', 'quote.lost', 43200,
     jsonb_build_array(jsonb_build_object('field', 'status', 'op', 'equals', 'value', 'lost')),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'Still thinking about {{title}}?',
       'body', E'Hi {{client.first_name}},\n\nA while ago we sent you a quote for {{title}}. If the timing wasn''t right, or you''d like us to take another look at the price or the work, you can ask us for a fresh quote online:\n\n{{link}}\n\nOr just reply to this email and we''ll take another look.\n\nThanks,\n{{company.name}}\n{{company.phone}}')), false)
  on conflict (company_id, template_key) do nothing;
end $$;

-- Rules still word for word a starter (the first one, or the one with the arrival time) get the new words.
update public.automation_rules
   set actions = jsonb_build_array(jsonb_build_object('type', 'send_sms',
                   'body', 'Hi {{client.first_name}}, this is {{tech.first_name}} with {{brand.name}}. I''m on my way{{eta_there}}.'))
 where template_key = 'on_my_way' and trigger = 'visit.en_route'
   and actions in (
     jsonb_build_array(jsonb_build_object('type', 'send_sms',
       'body', 'Hi {{client.first_name}}, this is {{company.name}}. Our crew is on the way to {{address}} now.')),
     jsonb_build_array(jsonb_build_object('type', 'send_sms',
       'body', 'Hi {{client.first_name}}, this is {{company.name}}. Our crew is on the way to {{address}} now{{eta}}.')));

-- On for every company there is now (the owner's call): Quo's test-only mode keeps it to test numbers.
update public.automation_rules set enabled = true
 where template_key = 'on_my_way' and trigger = 'visit.en_route' and not enabled;

notify pgrst, 'reload schema';
