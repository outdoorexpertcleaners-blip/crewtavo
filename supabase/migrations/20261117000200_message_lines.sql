-- Which of the business's phone lines a text went out on or came in to (Quo: one line per brand,
-- core/quo.ts), so Messages can show each line's conversations as Quo's inboxes do. Null for texts
-- that didn't go through Quo, emails and notes.
alter table public.messages
  add column line text check (line in ('washing', 'lights'));
