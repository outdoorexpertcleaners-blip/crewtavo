/**
 * A text that came in (the Twilio webhook, routes/messages.ts), filed where the office will see it.
 *
 * Whose it is goes by the number it came from, as the last 10 digits (services/textsOff.ts phoneKey):
 *   1. a client's own phone: it goes on that client's timeline, as it always did;
 *   2. else a contact's phone (client_contacts): on the contact's client's timeline, saying which
 *      contact sent it (messages.from_name);
 *   3. else nobody's: it's kept in unknown_texts for the company the number texted, the office hears
 *      on the bell, and Messages lists it under "Unknown numbers" until someone attaches the number
 *      to a client (public.attach_unknown_texts), which moves its texts onto that client's timeline.
 * The office is told each time (the people who get new-message notifications: owners, admins and
 * the office). So are the people working at the client's today (tellVisitPeople): on a job the crew
 * deals with the client directly, so "Can you move the truck?" reaches whoever is in the driveway.
 *
 * STOP and START are honoured for the number itself (sms_stops), whoever's it is, and for a
 * client's own phone on the client too (clients.sms_opt_out_at). From a number nobody knows they
 * are honoured and not kept as a message.
 *
 * Words that plainly ask to stop without being the keyword ("please stop texting me": `phrase`,
 * core asksToStopTexts) turn texts off the same way. Twilio did nothing about those, so the stop is
 * kept as a phrase with what was texted, the text is always filed where the office reads it (from a
 * number nobody knows too), and the office is told what they wrote and that texts are off.
 *
 * `companies` says which companies the text can be for: the ones on the Twilio account that signed
 * it. Null is the server's own number, which every company without its own account shares; there
 * a number nobody knows can only be filed when the instance has one company.
 *
 * Unknown numbers can't flood an instance: each number keeps UNKNOWN_PER_NUMBER texts a day and a
 * company UNKNOWN_PER_COMPANY, and the office hears about a number once an hour.
 */
import { phoneMatchKey } from "@crewtavo/core/recipients";
import { STAFF } from "@crewtavo/core/roles";
import { localDate } from "@crewtavo/core/time";
import type { Db } from "../lib/supabase";
import { noteSequenceReply } from "./sequences";
import { clearStop, noteStop, phoneKey, type StopDetails } from "./textsOff";

export interface InboundText {
  /** The number as Twilio gave it ("+15405550163"). */
  from: string;
  body: string;
  /** Twilio's MessageSid. */
  sid: string | null;
  /** STOP or START, when the text is one (what Twilio acted on, else the words). */
  keyword: "stop" | "start" | null;
  /** The "stop" is words that ask for it, not the keyword itself: Twilio hasn't stopped the number. */
  phrase?: boolean;
  /** The business's line it came in to, when it came through Quo (core/quo.ts quoBrandOf). */
  line?: "washing" | "lights" | null;
}

/** As many texts from one unknown number as a company keeps in a day, and from all unknown numbers. */
export const UNKNOWN_PER_NUMBER = 20;
export const UNKNOWN_PER_COMPANY = 300;
/** A contact's number kept under several clients files its text under this many of them at most. */
const CONTACT_CLIENTS = 5;
/** On the server's shared number, a STOP from a number nobody knows is recorded for this many companies at most. */
const SHARED_COMPANIES = 100;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

type Notice = { title: string; body: string; link: string };

/** The bell, for the people who hear about new messages: the company's owners, admins and office. Says who was told. */
async function tellOffice(admin: Db, companyId: string, notice: Notice): Promise<string[]> {
  const { data: office } = await admin.from("memberships").select("user_id").eq("company_id", companyId).eq("active", true).in("role", ["owner", "admin", "office"]);
  if (!office?.length) return [];
  await admin.from("notifications").insert(office.map((m) => ({ company_id: companyId, user_id: m.user_id, kind: "client", title: notice.title.slice(0, 300), body: notice.body, link: notice.link })));
  return office.map((m) => m.user_id);
}

/** A visit as tellVisitPeople reads it: whose it is (its job's client, else its request's), and who's on it. */
export interface TodaysVisit {
  crew_id: string | null;
  status: string;
  job: { client_id: string | null } | null;
  request: { client_id: string | null } | null;
  assignees: Array<{ user_id: string }> | null;
}

/** The people on the client's visits that aren't cancelled: those listed, else the crew's members. */
function peopleOnVisits(visits: readonly TodaysVisit[], crewMembers: ReadonlyArray<{ crew_id: string; user_id: string }>, clientId: string): string[] {
  const people = new Set<string>();
  for (const visit of visits) {
    if (visit.status === "cancelled" || (visit.job?.client_id ?? visit.request?.client_id) !== clientId) continue;
    const listed = (visit.assignees ?? []).map((a) => a.user_id);
    const onIt = listed.length ? listed : crewMembers.filter((m) => visit.crew_id && m.crew_id === visit.crew_id).map((m) => m.user_id);
    for (const id of onIt) people.add(id);
  }
  return [...people];
}

/**
 * Who on the team hears about a client's text because they're working at the client's today: the
 * people listed on each of the client's visits that isn't cancelled, or, on a visit with nobody
 * listed, its crew's members (the rule private.assigned_to_visit uses). Only the team as it is now
 * (an active member, never a sub), never someone already told as the office, and never the person
 * whose own phone sent it.
 */
export function visitPeopleToTell(input: {
  visits: readonly TodaysVisit[];
  crewMembers: ReadonlyArray<{ crew_id: string; user_id: string }>;
  clientId: string;
  /** The active members among the candidates, with their profile's phone. */
  team: ReadonlyArray<{ user_id: string; role: string; phone?: string | null }>;
  told: readonly string[];
  /** The number the text came from. */
  from: string;
}): string[] {
  const sender = phoneKey(input.from);
  return peopleOnVisits(input.visits, input.crewMembers, input.clientId).filter((id) => {
    const member = input.team.find((m) => m.user_id === id);
    if (!member || !(STAFF as readonly string[]).includes(member.role)) return false;
    if (input.told.includes(id)) return false;
    return !(sender && member.phone && phoneKey(member.phone) === sender);
  });
}

/**
 * The bell (and the phone's push, by their choices) for the people working at the client's today,
 * as visitPeopleToTell picks them. Never in the way of filing the text: a problem is logged.
 */
export async function tellVisitPeople(admin: Db, companyId: string, clientId: string, notice: Notice, told: readonly string[], from: string, now = new Date()): Promise<string[]> {
  try {
    const { data: company } = await admin.from("companies").select("timezone").eq("id", companyId).maybeSingle();
    const today = localDate(now, company?.timezone || "UTC");
    const { data: rows, error } = await admin
      .from("visits")
      .select("crew_id, status, job:jobs(client_id), request:requests(client_id), assignees:visit_assignees(user_id)")
      .eq("company_id", companyId)
      .eq("scheduled_on", today)
      .neq("status", "cancelled")
      .limit(1000);
    if (error) throw new Error(error.message);
    const visits = (rows ?? []) as unknown as TodaysVisit[];
    const theirs = visits.filter((v) => (v.job?.client_id ?? v.request?.client_id) === clientId);
    if (!theirs.length) return [];
    const crewIds = [...new Set(theirs.filter((v) => !(v.assignees ?? []).length && v.crew_id).map((v) => v.crew_id!))];
    const crewMembers = crewIds.length ? ((await admin.from("crew_members").select("crew_id, user_id").eq("company_id", companyId).in("crew_id", crewIds).limit(1000)).data ?? []) : [];
    const people = peopleOnVisits(theirs, crewMembers, clientId);
    if (!people.length) return [];
    const [{ data: members }, { data: profiles }] = await Promise.all([
      admin.from("memberships").select("user_id, role").eq("company_id", companyId).eq("active", true).in("user_id", people).limit(1000),
      admin.from("profiles").select("user_id, phone").in("user_id", people).limit(1000),
    ]);
    const team = (members ?? []).map((m) => ({ ...m, phone: (profiles ?? []).find((p) => p.user_id === m.user_id)?.phone ?? null }));
    const tell = visitPeopleToTell({ visits: theirs, crewMembers, clientId, team, told, from });
    if (!tell.length) return [];
    await admin.from("notifications").insert(tell.map((user_id) => ({ company_id: companyId, user_id, kind: "client", title: notice.title.slice(0, 300), body: notice.body, link: notice.link })));
    return tell;
  } catch (error) {
    console.error(`Couldn't tell the people at the client's today about their text: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** Files the text, and returns the companies whose automations should look at it. */
export async function receiveText(admin: Db, text: InboundText, companies: readonly string[] | null): Promise<string[]> {
  const from = phoneKey(text.from);
  const { body, keyword } = text;
  const phrase = keyword === "stop" && text.phrase === true;
  // How a stop is kept: the keyword, or the words they used instead.
  const stopped: StopDetails = phrase ? { source: "phrase", how: "text", note: body } : { source: "keyword" };
  const theirWords = `“${body.trim().slice(0, 160)}”`;
  // Match the sender by phone number (last 10 digits), across the companies the text can be for.
  let clientRows = admin.from("clients").select("id, company_id, phone, display_name").not("phone", "is", null).ilike("phone", `%${from.slice(-4)}%`);
  let contactRows = admin.from("client_contacts").select("id, company_id, client_id, name, phone").not("phone", "is", null).ilike("phone", `%${from.slice(-4)}%`);
  if (companies) {
    clientRows = clientRows.in("company_id", [...companies]);
    contactRows = contactRows.in("company_id", [...companies]);
  }
  const [{ data: candidates }, { data: others }] = await Promise.all([clientRows.limit(50), contactRows.limit(50)]);
  const clients = (candidates ?? []).filter((cl) => phoneKey(cl.phone) === from);
  const contacts = (others ?? []).filter((contact) => phoneKey(contact.phone) === from);
  const touched = new Set<string>();

  for (const client of clients) {
    touched.add(client.company_id);
    // Their running sequences hear they replied (services/sequences.ts).
    await noteSequenceReply(admin, client.company_id, client.id);
    await admin.from("messages").insert({
      company_id: client.company_id, client_id: client.id, channel: "sms", direction: "in", status: "received",
      body, external_id: text.sid, sent_by: null, from_phone: text.from, ...(text.line ? { line: text.line } : {}),
    });
    // Texts off from now, or back on: only a change is news (a YES that's an ordinary reply isn't).
    let changed = false;
    if (keyword === "stop") {
      const { data } = await admin.from("clients").update({ sms_opt_out_at: new Date().toISOString() }).eq("id", client.id).is("sms_opt_out_at", null).select("id");
      changed = Boolean(data?.length);
      // The number itself, too: a contact kept under it isn't texted either (sms_stops).
      await noteStop(admin, client.company_id, text.from, stopped);
    } else if (keyword === "start") {
      const { data } = await admin.from("clients").update({ sms_opt_out_at: null }).eq("id", client.id).not("sms_opt_out_at", "is", null).select("id");
      changed = Boolean(data?.length);
      await clearStop(admin, client.company_id, text.from);
    }
    const notice = changed && phrase
      ? { title: `${client.display_name} asked to stop texts`, body: `They texted ${theirWords}, so the app won't text them. If that isn't what they meant, you can turn texts back on from their page, only if they ask.` }
      : changed && keyword === "stop"
      ? { title: `${client.display_name} turned off texts`, body: "They texted STOP. The app won't text them until they text START." }
      : changed
        ? { title: `${client.display_name} turned texts back on`, body: `They texted ${body.trim().slice(0, 20).toUpperCase()}, so the app can text them again.` }
        : { title: "New text from a client", body: body.slice(0, 200) };
    const told = await tellOffice(admin, client.company_id, { ...notice, link: `/messages?client=${client.id}` });
    // An ordinary text (not STOP or START) reaches the people working there today too.
    if (!keyword) await tellVisitPeople(admin, client.company_id, client.id, { title: `New text from ${client.display_name}`, body: body.slice(0, 200), link: `/messages?client=${client.id}` }, told, text.from);
  }

  // A contact's phone, in a company where it isn't also a client's own: on each of those clients'
  // timelines (one message a client), saying which contact sent it.
  const filed = new Map<string, Set<string>>();
  for (const contact of contacts) {
    if (clients.some((cl) => cl.company_id === contact.company_id)) {
      // Filed under the client above. A STOP there covered the number for this company.
      continue;
    }
    const under = filed.get(contact.company_id) ?? new Set<string>();
    filed.set(contact.company_id, under);
    if (under.has(contact.client_id) || under.size >= CONTACT_CLIENTS) continue;
    const first = under.size === 0;
    under.add(contact.client_id);
    touched.add(contact.company_id);
    await noteSequenceReply(admin, contact.company_id, contact.client_id);
    await admin.from("messages").insert({
      company_id: contact.company_id, client_id: contact.client_id, channel: "sms", direction: "in", status: "received",
      body, external_id: text.sid, sent_by: null, from_phone: text.from, from_name: contact.name.slice(0, 200), ...(text.line ? { line: text.line } : {}),
    });
    // STOP or START is about the number, once for the company; the office hears once too.
    let changed = false;
    if (first && keyword === "stop") changed = await noteStop(admin, contact.company_id, text.from, stopped);
    else if (first && keyword === "start") changed = await clearStop(admin, contact.company_id, text.from);
    else if (keyword) continue;
    const notice = changed && phrase
      ? { title: `${contact.name} asked to stop texts`, body: `They texted ${theirWords} from ${text.from}, so the app won't text that number. If that isn't what they meant, you can turn its texts back on from the client's page, only if they ask.` }
      : changed && keyword === "stop"
      ? { title: `${contact.name} turned off texts`, body: `They texted STOP from ${text.from}. The app won't text that number until they text START.` }
      : changed
        ? { title: `${contact.name} turned texts back on`, body: `They texted ${body.trim().slice(0, 20).toUpperCase()} from ${text.from}, so the app can text that number again.` }
        : { title: `New text from ${contact.name}`, body: body.slice(0, 200) };
    const told = await tellOffice(admin, contact.company_id, { ...notice, link: `/messages?client=${contact.client_id}` });
    if (!keyword) await tellVisitPeople(admin, contact.company_id, contact.client_id, { title: `New text from ${contact.name}`, body: body.slice(0, 200), link: `/messages?client=${contact.client_id}` }, told, text.from);
  }
  if (touched.size) return [...touched];

  // Nobody's number.
  if (keyword) {
    // Honoured for the number, for every company it could have been texting.
    const all = companies ?? ((await admin.from("companies").select("id").limit(SHARED_COMPANIES)).data ?? []).map((row) => row.id);
    for (const company of all) await (keyword === "stop" ? noteStop(admin, company, text.from, stopped) : clearStop(admin, company, text.from));
    // The keyword isn't a message. Words that ask to stop are, so the office can read what came.
    if (!phrase) return [];
  }
  const company = await unknownsCompany(admin, companies);
  if (!company) {
    console.warn("A text from a number nobody knows came to a number several companies share, so it couldn't be filed.");
    return [];
  }
  const key = phoneMatchKey(text.from);
  if (!key) return [];
  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  const count = async (sinceMs: number, number: boolean) => {
    let rows = admin.from("unknown_texts").select("id", { count: "exact", head: true }).eq("company_id", company).gte("created_at", since(sinceMs));
    if (number) rows = rows.eq("phone_key", key);
    const { count: found, error } = await rows;
    if (error) throw new Error(`Couldn't count texts from unknown numbers: ${error.message}`);
    return found ?? 0;
  };
  const [today, lastHour, everyone] = await Promise.all([count(DAY_MS, true), count(HOUR_MS, true), count(DAY_MS, false)]);
  if (today >= UNKNOWN_PER_NUMBER || everyone >= UNKNOWN_PER_COMPANY) return [];
  const { error } = await admin.from("unknown_texts").insert({ company_id: company, from_phone: text.from.slice(0, 40), phone_key: key, body, external_id: text.sid });
  if (error) throw new Error(`Couldn't keep a text from an unknown number: ${error.message}`);
  // Once an hour for a number, however much it texts.
  if (phrase) await tellOffice(admin, company, { title: "An unknown number asked to stop texts", body: `${text.from} texted ${theirWords}, so the app won't text it.`, link: `/messages?unknown=${key}` });
  else if (!lastHour) await tellOffice(admin, company, { title: "New text from an unknown number", body: `${text.from}: ${body.slice(0, 180)}`, link: `/messages?unknown=${key}` });
  return [];
}

/** The company a text from a number nobody knows is kept for: the one the number belongs to, or the instance's only company. */
async function unknownsCompany(admin: Db, companies: readonly string[] | null): Promise<string | null> {
  if (companies) return companies.length === 1 ? companies[0]! : null;
  const { data } = await admin.from("companies").select("id").limit(2);
  return data?.length === 1 ? data[0]!.id : null;
}
