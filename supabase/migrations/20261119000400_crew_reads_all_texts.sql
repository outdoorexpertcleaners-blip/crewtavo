-- Field crew ("Employee") read the whole inbox in Messages.
--
-- The owner: "I would like for the employee to see all messages as well. They need this for gate
-- codes, client communication, not just on the way text." On a job the office doesn't deal with
-- the client, the crew does, and a client texts to have the truck moved so they can get out of the
-- garage. So Messages is now on field crew's (and crew leads') menus, they reply by text from the
-- business's lines (routes/messages.ts /messages/send, texts only), and the people working at a
-- client's today hear about that client's texts (services/inboundTexts.ts tellVisitPeople).
--
-- What field crew read here gains two things:
--   messages        a message with no client, as crew leads already do. Until now field crew read
--                   any client's (20261119000100_crew_sees_team.sql) but not those.
--   unknown_texts   texts from a number nobody knows yet (a client texting from a new phone), so
--                   the inbox is complete. Crew leads read them too now: they also see Messages.
--                   Deleting them stays the office's, and attaching a number to a client stays with
--                   whoever may edit clients (public.attach_unknown_texts checks that itself).
--
-- What stays as it was: the messages that carry prices or the client's own links (a quote, job,
-- invoice or autopay message the business sent) are still the office's and sales', for field crew
-- and crew leads alike; the first two cases of messages_read are unchanged. Adding to a timeline
-- (messages_insert) is unchanged: field crew add notes, and the texts they send are written by the
-- server. Subs read none of it (private.has_role never counts a sub).

-- Messages: as 20261119000100_crew_sees_team.sql, with field crew reading a message with no client
-- too. The first two cases, which keep prices and the client's links with the office, are unchanged.
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated using (
  private.is_member(company_id) and case
    when direction <> 'in' and (related_type in ('invoice', 'autopay') or (related_type is null and channel = 'note' and external_id is not null)) then
      private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'invoices')
    when direction <> 'in' and related_type in ('quote', 'job') then
      private.has_role(company_id, '{owner,admin,office,estimator}')
    else
      private.has_role(company_id, '{owner,admin,office,estimator,crew_lead,field_crew}')
  end
);

-- Texts from unknown numbers: as 20261113000310_unknown_texts.sql, read by the whole team.
drop policy if exists unknown_texts_read on public.unknown_texts;
create policy unknown_texts_read on public.unknown_texts for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator,crew_lead,field_crew}'));

-- The policies above check membership once per query (20261018000990_policy_lookups).
select private.fold_member_checks('public.messages');
select private.fold_member_checks('public.unknown_texts');

notify pgrst, 'reload schema';
