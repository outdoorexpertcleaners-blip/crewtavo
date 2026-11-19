-- Outdoor Expert's copy is a modified version of Crewtavo, so it doesn't call itself Crewtavo where a
-- person reads it (NOTICE: a modified version may only say truthfully that it's based on Crewtavo).
-- The database writes some of those words itself: the refusals an AI assistant meets, the offers a
-- sub is told about, chat mentions from the app, credits given outside the app, and a few errors.
-- Each function below is its newest definition, unchanged but for "Crewtavo" becoming "the app"
-- (in the same words as the code: packages/core/src/assistants.ts, subOffers.ts, marketing.ts).

-- hooks.before_request, as in 20261112000530_assistants_off_everywhere.sql.
create or replace function hooks.before_request() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_method text := current_setting('request.method', true);
  v_path text := coalesce(current_setting('request.path', true), '');
  v_table text := ltrim(v_path, '/');
  v_area text;
  v_level text;
  v_switch jsonb;
  -- Taking someone off a crew or a visit, or a machine off a visit, is a change, not deleting.
  v_delete boolean := v_method = 'DELETE' and ltrim(v_path, '/') not in ('crew_members', 'visit_assignees', 'visit_equipment');
begin
  if private.assistant_client() is null then return; end if;
  v_switch := private.assistant_switch();
  if v_path = '/rpc/assistant_switch' then
    perform set_config('transaction_read_only', 'on', true);
    return;
  end if;
  if v_switch ->> 'state' = 'off' then
    raise exception using errcode = 'PT403', message = format(
      'AI assistants are turned off for %s. An owner or admin can turn them on in the app, under Settings → AI assistants.', v_switch ->> 'company');
  end if;
  if v_method in ('GET', 'HEAD') then
    perform set_config('transaction_read_only', 'on', true);
    return;
  end if;
  if v_path like '/rpc/%' then
    -- A function that writes for its area, or one that answers but can't write. One that removes
    -- something for good (merging two clients deletes one) needs what deleting a row needs.
    v_area := private.assistant_rpc_area(substr(v_path, 6));
    v_delete := v_area is not null and private.assistant_rpc_deletes(substr(v_path, 6));
    if v_delete and not private.assistant_may_change(v_area, true) and private.assistant_may_change(v_area, false) then
      raise exception using errcode = 'PT403',
        message = 'This assistant can''t delete things. Only an assistant with full access can, in the app, under Settings → AI assistants.';
    end if;
    if v_area is null or not private.assistant_may_change(v_area, v_delete) then
      perform set_config('transaction_read_only', 'on', true);
    end if;
    return;
  end if;
  v_area := private.assistant_table_area(v_table);
  if v_area is not null and private.assistant_may_change(v_area, v_delete) then return; end if;
  select a.level into v_level from public.assistant_connections a
  where a.user_id = (select auth.uid()) and a.client_id = private.assistant_client();
  raise exception using errcode = 'PT403', message = case
    when v_switch ->> 'state' = 'read_only' then format(
      'Assistants can only look things up for %s, not make changes. An owner or admin can change this in the app, under Settings → AI assistants.', v_switch ->> 'company')
    when v_area is null then 'An AI assistant can''t change this. Do it in the app itself.'
    when v_level = 'full_no_money' and private.assistant_money_area(v_area) then
      'This assistant can''t change money: quotes, invoices, payments, pay or promo codes. To let it, give it Full access in the app, under Settings → AI assistants.'
    when v_delete and v_level = 'areas' then
      'This assistant can''t delete things. Only an assistant with full access can, in the app, under Settings → AI assistants.'
    else format('This assistant can''t change %s. To let it, choose what it can change in the app, under Settings → AI assistants.', case v_area
      when 'clients' then 'clients and properties' when 'records' then 'requests and notes' when 'jobs' then 'jobs'
      when 'schedule' then 'the schedule' when 'time' then 'clocks and timesheets' when 'quotes' then 'quotes'
      when 'invoices' then 'invoices and payments' when 'pay' then 'pay' when 'company' then 'company details'
      when 'prices' then 'the price list' when 'crews' then 'crews' when 'checklists' then 'checklists'
      when 'booking' then 'booking forms' when 'guides' then 'guides' when 'team' then 'people and roles'
      when 'templates' then 'document styles and contract terms' when 'marketing' then 'campaigns, reviews and social posts'
      when 'promos' then 'promo codes' else 'automations' end)
  end;
end $$;

-- private.assistant_invoice_guard, as in 20261112000530_assistants_off_everywhere.sql.
create or replace function private.assistant_invoice_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.assistant_client() is null then return new; end if;
  if new.status in ('void', 'written_off') and new.status is distinct from old.status and not private.assistant_may_change('invoices', true) then
    raise exception 'This assistant can''t void or write off an invoice. Only an assistant with full access can, in the app, under Settings → AI assistants.'
      using errcode = '42501';
  end if;
  return new;
end $$;

-- private.assistant_pay_rate_guard, as in 20261019002000_assistant_more_areas.sql.
create or replace function private.assistant_pay_rate_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.assistant_client() is null then return new; end if;
  if ((tg_op = 'INSERT' and new.labor_rate is not null) or (tg_op = 'UPDATE' and new.labor_rate is distinct from old.labor_rate))
    and not private.assistant_may_change('pay', false) then
    raise exception 'This assistant can''t change pay rates. To let it, give it the Pay area or Full access in the app, under Settings → AI assistants.' using errcode = '42501';
  end if;
  return new;
end $$;

-- private.assistant_payment_guard, as in 20261106000100_client_merge.sql.
create or replace function private.assistant_payment_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.assistant_client() is null then return coalesce(new, old); end if;
  if tg_op = 'UPDATE' and private.merging_clients(old.client_id, new.client_id) and to_jsonb(new) - 'client_id' = to_jsonb(old) - 'client_id' then
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'An AI assistant can''t delete a payment. Do it in the app itself.' using errcode = '42501';
  end if;
  if new.amount < 0 then
    raise exception 'An AI assistant can''t record a refund. Do it in the app itself.' using errcode = '42501';
  end if;
  return new;
end $$;

-- private.chat_notify_mentions, as in 20261019001600_team_chat.sql.
create or replace function private.chat_notify_mentions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_where text;
  v_text text;
begin
  if not (new.mention_all or cardinality(new.mention_users) > 0 or cardinality(new.mention_roles) > 0) then return null; end if;
  select case when c.kind = 'announcement' then c.name else '#' || c.name end into v_where from public.chat_channels c where c.id = new.channel_id;
  v_name := coalesce((select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.user_id = new.author_id), 'The app');
  v_text := nullif(left(regexp_replace(private.chat_plain(new.company_id, new.body), '\s+', ' ', 'g'), 140), '');
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select new.company_id, m.user_id, 'chat',
    case when m.user_id = any (new.mention_users) or coalesce(m.role_id::text, m.role::text) = any (new.mention_roles)
      then v_name || ' mentioned you in ' || v_where
      else v_name || ' posted in ' || v_where end,
    coalesce(v_text, 'Sent a photo'),
    '/chat/' || new.channel_id || '?message=' || new.id
  from public.memberships m
  where m.company_id = new.company_id and m.active and m.user_id is distinct from new.author_id
    and (new.mention_all or m.user_id = any (new.mention_users) or coalesce(m.role_id::text, m.role::text) = any (new.mention_roles))
    and (private.chat_rights(new.channel_id, m.user_id)).can_see;
  return null;
end $$;

-- private.sub_offer_told, as in 20261025004001_sub_offers.sql.
create or replace function private.sub_offer_told(p public.job_pay, p_event text, p_change boolean, p_offered numeric default null, p_was numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_job text := (select j.title from public.jobs j where j.id = p.job_id);
  v_sub text := (select s.name from public.subcontractors s where s.id = p.subcontractor_id);
  v_offered numeric := coalesce(p_offered, p.total);
  v_was numeric := case when p_change then coalesce(p_was, (p.accepted_snapshot ->> 'total')::numeric) end;
  v_price text := private.money_short(v_offered);
  v_agreed text := private.money_short((p.accepted_snapshot ->> 'total')::numeric);
  v_mine text := '/field/jobs/' || p.id;
  v_job_page text := '/jobs/' || p.job_id;
  -- In the title too, as a text carries only the title.
  v_by text := case when p.respond_by is not null then 'Answer by ' || private.local_time_words(p.company_id, p.respond_by) || '.' end;
  v_data jsonb := jsonb_build_object('job_pay_id', p.id, 'subcontractor_id', p.subcontractor_id, 'sub_name', v_sub, 'total', v_offered,
    'change', p_change, 'round', p.offer_round) || case when p_change then jsonb_build_object('was', v_was) else '{}'::jsonb end;
begin
  if p_event = 'sent' then
    if p_change then
      perform private.tell_sub(p.company_id, p.subcontractor_id,
        concat_ws(' ', format('New price for %s: %s (was %s).', v_job, v_price, private.money_short(v_was)), v_by, 'Open the app to accept or decline.'),
        'If you don''t accept it, the price you agreed stands.', v_mine);
      perform private.emit(p.company_id, 'sub_offer.sent', 'job', p.job_id, format('New price for %s sent to %s (%s, was %s)', v_job, v_sub, v_price, private.money_short(v_was)),
        v_data || jsonb_build_object('insurance_warning', p.insurance_warning is not null));
    else
      perform private.tell_sub(p.company_id, p.subcontractor_id, concat_ws(' ', private.sub_offer_line(p.id) || '.', v_by, 'Open the app to accept or decline.'),
        'New job offer.', v_mine);
      perform private.emit(p.company_id, 'sub_offer.sent', 'job', p.job_id, format('%s offered to %s (%s)', v_job, v_sub, v_price),
        v_data || jsonb_build_object('insurance_warning', p.insurance_warning is not null));
    end if;
  elsif p_event = 'accepted' then
    perform private.emit(p.company_id, 'sub_offer.accepted', 'job', p.job_id,
      case when p_change then format('%s accepted the new price for %s (%s, was %s)', v_sub, v_job, v_price, private.money_short(v_was)) else format('%s accepted %s (%s)', v_sub, v_job, v_price) end, v_data);
    perform private.tell_subs_office(p.company_id,
      case when p_change then format('%s accepted the new price for %s', v_sub, v_job) else format('%s accepted %s', v_sub, v_job) end,
      case when p_change then format('Now %s.', v_price) else format('%s. They''re on its visits now.', v_price) end, v_job_page);
  elsif p_event = 'declined' then
    perform private.emit(p.company_id, 'sub_offer.declined', 'job', p.job_id,
      case when p_change then format('%s declined the new price for %s (%s)', v_sub, v_job, v_price) else format('%s declined %s (%s)', v_sub, v_job, v_price) end
        || coalesce(': ' || p.decline_reason, ''),
      v_data || jsonb_build_object('reason', p.decline_reason));
    perform private.tell_subs_office(p.company_id,
      case when p_change then format('%s declined the new price for %s', v_sub, v_job) else format('%s declined %s', v_sub, v_job) end,
      concat_ws(' ', '“' || p.decline_reason || '”',
        case when p_change then format('The price they agreed (%s) stands.', v_agreed) else 'You can offer it to another sub from the job.' end), v_job_page);
  elsif p_event = 'expired' then
    perform private.emit(p.company_id, 'sub_offer.expired', 'job', p.job_id,
      case when p_change then format('The new price for %s (%s) ran out before %s answered', v_job, v_price, v_sub) else format('%s didn''t answer the offer for %s in time', v_sub, v_job) end,
      v_data);
    perform private.tell_subs_office(p.company_id,
      case when p_change then format('The new price for %s ran out', v_job) else format('%s didn''t answer in time: %s', v_sub, v_job) end,
      case when p_change then format('%s didn''t answer. The price they agreed (%s) stands.', v_sub, v_agreed)
        else 'The offer ran out. You can offer it again, or to another sub, from the job.' end, v_job_page);
  elsif p_event = 'withdrawn' then
    perform private.tell_sub(p.company_id, p.subcontractor_id,
      case when p_change then format('The new price for %s was withdrawn', v_job) else format('The offer for %s was withdrawn', v_job) end,
      case when p_change then format('The price you agreed (%s) stands.', v_agreed) else 'You don''t need to do anything.' end, v_mine);
  elsif p_event = 'agreed' then
    -- The office agreed an offer for them (they said yes on the phone): it's theirs at that price.
    perform private.tell_sub(p.company_id, p.subcontractor_id,
      case when p_change then format('Your price for %s is now %s (was %s)', v_job, v_price, private.money_short(v_was))
        else format('%s is yours at %s', v_job, v_price) end,
      case when p_change then 'The office agreed the new price with you.' else 'The office agreed it with you. It''s on My day.' end, v_mine);
  end if;
end $$;

-- private.unearn_referral, as in 20261031000100_referral_credits.sql.
create or replace function private.unearn_referral(p_referral uuid, p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.referrals;
  v_referrer uuid;
  v_next uuid;
  c record;
  v_used numeric;
  v_used_on bigint;
  v_number bigint;
  v_friend text;
begin
  select referrer_client_id into v_referrer from public.referrals where id = p_referral;
  if not found then return; end if;
  perform pg_advisory_xact_lock(hashtext('referral_credit:' || v_referrer::text));
  select * into r from public.referrals where id = p_referral for update;
  if not found or r.earned_invoice_id is distinct from p_invoice or r.reward_status not in ('earned', 'applied') then
    return;
  end if;
  select i.id into v_next from public.invoices i
   where i.client_id = r.referred_client_id and i.id <> p_invoice and i.status = 'paid' and i.kind in ('standard', 'visits')
     and coalesce(private.referral_base(i.id), 0) > 0
   order by i.issued_on, i.number limit 1;
  if v_next is not null then
    update public.referrals set earned_invoice_id = v_next where id = r.id;
    return;
  end if;

  v_used := r.given_amount;
  for c in
    select rc.id, rc.amount, rc.invoice_id, i.number from public.referral_credits rc join public.invoices i on i.id = rc.invoice_id
     where rc.referral_id = r.id order by rc.invoice_id
  loop
    perform 1 from public.invoices where id = c.invoice_id for update skip locked;
    if found and private.referral_credits_changeable(c.invoice_id) then
      delete from public.referral_credits where id = c.id;
    else
      v_used := v_used + c.amount;
      v_used_on := coalesce(v_used_on, c.number);
    end if;
  end loop;

  select number into v_number from public.invoices where id = p_invoice;
  v_friend := coalesce(nullif(trim(r.referred_name), ''), private.client_name(r.referred_client_id));
  if v_used <= 0 then
    update public.referrals
       set reward_status = 'pending', reward_amount = 0, earned_at = null, earned_invoice_id = null, applied_at = null
     where id = r.id;
    perform private.emit(r.company_id, 'referral.unpaid', 'client', r.referrer_client_id,
      format('%s''s invoice #%s isn''t paid anymore, so %s''s %s referral credit waits for them to pay again.',
        v_friend, v_number, private.client_name(r.referrer_client_id), private.money(r.reward_amount)),
      jsonb_build_object('referral_id', r.id, 'friend_name', r.referred_name, 'credit', r.reward_amount, 'friend_invoice_id', p_invoice, 'kept', 0));
  else
    update public.referrals set auto_apply = false where id = r.id;
    perform private.emit(r.company_id, 'referral.unpaid', 'client', r.referrer_client_id,
      format('%s''s invoice #%s isn''t paid anymore, but %s of %s''s %s referral credit is used already (%s). Anything left is kept off invoices until you decide.',
        v_friend, v_number, private.money(v_used), private.client_name(r.referrer_client_id), private.money(r.reward_amount),
        case when v_used_on is not null then format('on invoice #%s', v_used_on) else 'given outside the app' end),
      jsonb_build_object('referral_id', r.id, 'friend_name', r.referred_name, 'credit', r.reward_amount, 'friend_invoice_id', p_invoice, 'kept', v_used));
  end if;
end $$;

-- public.claim_backup, as in 20261112000200_backups.sql.
create or replace function public.claim_backup(p_kind text, p_since timestamptz default null, p_tries integer default 3) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  -- Two servers asking at the same moment take turns.
  perform pg_advisory_xact_lock(hashtext('crewtavo:backup'));
  update public.backups
     set status = 'failed', finished_at = now(), error = 'The app restarted before this backup finished.'
   where status = 'running' and heartbeat_at < now() - interval '10 minutes';
  if exists (select 1 from public.backups where status = 'running') then
    return null;
  end if;
  if p_kind = 'nightly' then
    if exists (select 1 from public.backups where status = 'ok' and started_at >= coalesce(p_since, '-infinity')) then
      return null;
    end if;
    if (select count(*) from public.backups where kind = 'nightly' and status = 'failed' and started_at >= coalesce(p_since, '-infinity')) >= p_tries then
      return null;
    end if;
  end if;
  insert into public.backups (kind) values (p_kind) returning id into v_id;
  return v_id;
end $$;

-- public.claim_social_posts, as in 20261031000440_social_post_fixes.sql.
create or replace function public.claim_social_posts(p_limit integer default 1, p_hold_seconds integer default 300, p_post uuid default null)
returns table (id uuid, company_id uuid, claim uuid)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  r record;
  v_claim uuid;
begin
  for r in
    select p.id from public.social_posts p
     where p.status = 'posting' and coalesce(p.locked_until, '-infinity') < now()
       and (p_post is null or p.id = p_post)
       and exists (select 1 from public.social_post_networks n where n.post_id = p.id and n.status = 'sending')
     for update of p skip locked
  loop
    update public.social_post_networks
       set status = 'unknown', error = 'The app stopped partway, so it may have posted.', error_kind = null
     where post_id = r.id and status = 'sending';
    update public.social_posts set claim = null, locked_until = null where id = r.id;
    perform private.finish_social_post(r.id);
  end loop;

  for r in
    select p.id, p.company_id from public.social_posts p
      join public.companies co on co.id = p.company_id
     where co.settings -> 'marketing' -> 'enabled' = 'true'::jsonb
       and (p_post is null or p.id = p_post)
       and p.stop_kind is null
       and ((p.status = 'scheduled' and p.scheduled_for <= now())
         or (p.status = 'posting' and coalesce(p.locked_until, '-infinity') < now()
             and exists (select 1 from public.social_post_networks n where n.post_id = p.id and n.status in ('waiting', 'retry')
                           and coalesce(n.next_attempt_at, '-infinity') <= now())))
     order by coalesce(p.scheduled_for, p.created_at), p.id
     limit least(greatest(coalesce(p_limit, 1), 1), 25)
     for update of p skip locked
  loop
    v_claim := gen_random_uuid();
    update public.social_posts
       set status = 'posting', started_at = coalesce(started_at, now()), claim = v_claim,
           locked_until = now() + make_interval(secs => greatest(coalesce(p_hold_seconds, 300), 30))
     where id = r.id;
    insert into public.social_post_networks (post_id, company_id, network)
    select r.id, r.company_id, x from public.social_posts p, unnest(p.networks) x where p.id = r.id
    on conflict do nothing;
    id := r.id;
    company_id := r.company_id;
    claim := v_claim;
    return next;
  end loop;
end $$;

-- public.create_company, as in 20261025002002_sub_sign_ins.sql.
create or replace function public.create_company(p_name text, p_trade_preset text default 'general', p_timezone text default 'America/New_York')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_base text := trim(both '-' from regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'));
  v_slug text;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if exists (select 1 from auth.users u where u.id = v_user and u.raw_app_meta_data ? 'crewtavo_sub')
     and not exists (select 1 from public.memberships m where m.user_id = v_user and m.role <> 'subcontractor') then
    raise exception 'This sign-in is for your work with another business. To run your own business, use a different email address.' using errcode = '42501';
  end if;
  -- One business per instance when it's set up that way (one at a time, so two sign-ups at once
  -- can't both be first).
  if exists (select 1 from private.instance where single_company) then
    perform pg_advisory_xact_lock(hashtextextended('create_company', 0));
    if exists (select 1 from public.companies) then
      raise exception 'This app already has a business. Ask its owner to invite you.' using errcode = '42501';
    end if;
  end if;
  if length(v_base) < 2 then
    v_base := 'company';
  end if;
  v_slug := left(v_base, 50);
  while exists (select 1 from public.companies where slug = v_slug) loop
    v_slug := left(v_base, 50) || '-' || substr(md5(random()::text), 1, 5);
  end loop;

  insert into public.companies (name, slug, trade_preset, timezone)
  values (p_name, v_slug, coalesce(p_trade_preset, 'general'), coalesce(p_timezone, 'America/New_York'))
  returning id into v_id;

  insert into public.memberships (company_id, user_id, role) values (v_id, v_user, 'owner');
  return v_id;
end $$;

-- public.referral_no_reward, as in 20261031000100_referral_credits.sql.
create or replace function public.referral_no_reward(p_referral uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.referrals;
begin
  r := private.office_referral(p_referral, 'marketing');
  perform pg_advisory_xact_lock(hashtext('referral_credit:' || r.referrer_client_id::text));
  select * into r from public.referrals where id = p_referral for update;
  if r.reward_status not in ('pending', 'earned') then
    raise exception 'This referral''s credit can''t be taken away now' using errcode = '22023';
  end if;
  if exists (select 1 from public.referral_credits where referral_id = r.id) then
    raise exception 'Part of this credit is on an invoice. Take it off the invoice first' using errcode = '22023';
  end if;
  if r.given_amount > 0 then
    raise exception 'Part of this credit was given outside the app already' using errcode = '22023';
  end if;
  update public.referrals set reward_status = 'none', no_reward_reason = 'by_hand' where id = r.id;
end $$;

-- public.storage_overview, as in 20261028000400_storage_limits.sql.
create or replace function public.storage_overview(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
set plan_cache_mode = force_custom_plan set jit = off set enable_sort = off as $$
declare
  v_me uuid := (select auth.uid());
  v_office boolean;
  v_storage jsonb;
  v_used bigint;
  v_trash bigint;
  v_files bigint;
  v_mine bigint;
  v_people jsonb;
  v_areas jsonb;
  v_out jsonb;
begin
  if not private.is_member(p_company) then
    raise exception 'Only the team can see how much storage is used.' using errcode = '42501';
  end if;
  v_office := private.has_role(p_company, '{owner,admin}');
  select private.storage_of(c.settings) into v_storage from public.companies c where c.id = p_company;

  -- One look through the company's files, each with who added it (a plan file the server stored: who
  -- added it) and whether it's in the Trash, added up by area, person and Trash: a handful of rows,
  -- however many files there are. The Trash is joined on the path (a path is in it once at most), so
  -- its paths are hashed however many there are, a big Trash in batches on disk. (Asking "o.name in
  -- (the Trash's paths)" for each file hashes them only while they fit in memory, and past that
  -- compares every file with every path in the Trash, which takes minutes for a big company.)
  with marked as materialized (
    select x.area, x.uploader, x.trashed, sum(x.bytes)::bigint as bytes, count(*) as files
    from (
      select case when split_part(o.name, '/', 3) = '' then 'other' else split_part(o.name, '/', 2) end as area,
        coalesce(o.owner, case when split_part(o.name, '/', 2) = 'plans' then (select f.created_by from public.plan_files f where f.path = o.name) end) as uploader,
        t.id is not null or d.id is not null as trashed,
        private.storage_object_bytes(o.metadata) as bytes
      from storage.objects o
      left join public.trashed_files t on t.path = o.name and t.company_id = p_company
      left join public.plan_files d on d.path = o.name and d.company_id = p_company and d.deleted_at is not null
      where o.bucket_id = 'files' and o.name collate "C" >= p_company::text || '/' and o.name collate "C" < p_company::text || '0'
    ) x
    group by x.area, x.uploader, x.trashed
  ), people as materialized (
    select m.uploader, sum(m.bytes)::bigint as bytes from marked m where not m.trashed group by m.uploader
  )
  select
    coalesce((select sum(m.bytes) from marked m), 0)::bigint,
    coalesce((select sum(m.bytes) from marked m where m.trashed), 0)::bigint,
    coalesce((select sum(m.files) from marked m), 0)::bigint,
    coalesce((select p.bytes from people p where p.uploader = v_me), 0)::bigint,
    case when v_office then (
      select coalesce(jsonb_agg(jsonb_build_object('user_id', x.user_id, 'name', x.name, 'role', x.role, 'role_name', x.role_name,
          'used_bytes', x.used, 'limit_bytes', x.limit_bytes, 'limit_source', x.limit_source) order by x.kind, x.used desc, lower(x.name)), '[]')
      from (
        select 1 as kind, l.user_id, coalesce(nullif(pr.full_name, ''), pr.email, 'Someone') as name, l.role::text as role,
          coalesce(cr.name, private.storage_level_label(l.role::text)) as role_name, coalesce(u.bytes, 0) as used, l.limit_bytes, l.limit_source
        from private.storage_member_limits(p_company) l
        left join public.profiles pr on pr.user_id = l.user_id
        left join public.company_roles cr on cr.id = l.role_id
        left join people u on u.uploader = l.user_id
        where l.active
        union all
        select 2, u.uploader, coalesce(nullif(pr.full_name, ''), pr.email, 'Someone no longer on the team'), null::text, null::text, u.bytes, null::bigint, null::text
        from people u
        left join public.profiles pr on pr.user_id = u.uploader
        where u.uploader is not null and u.bytes > 0
          and not exists (select 1 from public.memberships m where m.company_id = p_company and m.user_id = u.uploader and m.active)
        union all
        select 3, null::uuid, 'Uploaded by the app', null::text, null::text, u.bytes, null::bigint, null::text
        from people u where u.uploader is null and u.bytes > 0
      ) x)
    end,
    case when v_office then (
      select coalesce(jsonb_agg(jsonb_build_object('area', a.area, 'bytes', a.bytes) order by a.bytes desc, a.area), '[]')
      from (
        select m.area, sum(m.bytes)::bigint as bytes from marked m where not m.trashed group by m.area
        union all
        select 'trash', sum(m.bytes)::bigint from marked m where m.trashed having count(*) > 0
      ) a)
    end
  into v_used, v_trash, v_files, v_mine, v_people, v_areas;

  select jsonb_build_object(
    'used_bytes', v_used, 'trash_bytes', v_trash, 'files', v_files,
    'limit_bytes', private.storage_company_limit(v_storage), 'limit_mode', private.storage_limit_mode(v_storage),
    'default_bytes', private.storage_bytes(v_storage -> 'default_bytes'),
    'default_basis', case when jsonb_typeof(v_storage -> 'default_basis') = 'string' then v_storage ->> 'default_basis' end,
    'me', jsonb_build_object('used_bytes', v_mine, 'limit_bytes', l.limit_bytes, 'limit_source', l.limit_source))
  into v_out
  from (select 1) one
  left join private.storage_member_limits(p_company) l on l.user_id = v_me;

  if v_office then
    v_out := v_out || jsonb_build_object('by_person', v_people, 'by_area', v_areas, 'roles', (
      select coalesce(jsonb_agg(jsonb_build_object('role_key', a.role_key, 'name', coalesce(cr.name, private.storage_level_label(a.role_key)), 'limit_bytes', a.limit_bytes)
          order by cr.id is not null, array_position(array['admin', 'office', 'estimator', 'crew_lead', 'field_crew'], a.role_key), lower(cr.name)), '[]')
      from public.storage_allowances a
      left join public.company_roles cr on cr.company_id = a.company_id and cr.id::text = a.role_key
      where a.company_id = p_company and a.role_key is not null));
  end if;
  return v_out;
end $$;
