/**
 * Sequences (core/sequences.ts): GoHighLevel-style workflows, run every minute (tasks.ts).
 *
 * 1. Start: what happened since the company's cursor (activity: a lead came in, a quote was sent, a
 *    job was completed) starts each enabled sequence for that trigger whose brand matches, once per
 *    record. A company's first pass only sets its cursor, so turning sequences on starts nothing
 *    for the past.
 * 2. Replies: a client who texted back (services/inboundTexts.ts noteSequenceReply sets reply_at)
 *    is handled by the sequence's on_reply: hot (stop, lead to Hot Inbound Lead, tell the office),
 *    pause (hold until resumed, tell the office) or stop.
 * 3. Steps: each run that's due goes through its steps until the next wait. Before each step the
 *    record is checked (core stillGoing): an answered quote or a lead moved on ends the run.
 *
 * Texts go through sendSms with the run's brand, so from that brand's Quo line, and while Quo is
 * test only, to the test numbers only. A client who asked not to be texted isn't. The office's
 * alerts go to the alert number (settings.sequence_alert_phone) by text and to the office in the app.
 */
import { phoneE164 } from "@crewtavo/core/phone";
import { quoteBrand, requestBrand, type Brand } from "@crewtavo/core/pipeline";
import {
  fillSequence, inHours, nextInWindow, PAUSED_ALERT, RESPONDED_ALERT, sendWindow, sequenceSteps, stillGoing, waitWords,
  type OnReply, type SequenceStep, type SequenceTrigger, type SequenceVars,
} from "@crewtavo/core/sequences";
import { addDays, localDate } from "@crewtavo/core/time";
import type { Env } from "../env";
import { reportError } from "../lib/monitoring";
import { sendSms } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";
import { textWithStopLine } from "./stopLine";
import { noteRefusedText, numberStopped, textsOffTo } from "./textsOff";

const TRIGGERS: SequenceTrigger[] = ["request.created", "quote.sent", "job.completed"];
/** Steps done for one run in one go, so a loop of go-tos can't run forever. */
const MAX_STEPS = 25;
/** A paused follow-up nobody resumes ends after 30 days, as GoHighLevel's did. */
const PAUSE_DAYS = 30;

interface SequenceRow { id: string; company_id: string; name: string; brand: string | null; trigger: string; on_reply: string; send_window: unknown; steps: unknown; enabled: boolean }
interface RunRow { id: string; company_id: string; sequence_id: string; client_id: string | null; subject_type: string; subject_id: string; brand: string | null; step: number; status: string; next_at: string; reply_at: string | null; paused_at: string | null; log: unknown }
interface Company { id: string; name: string; timezone: string; settings: Record<string, unknown> }

const asBrand = (b: string | null | undefined): Brand | null => (b === "washing" || b === "lights" ? b : null);
const logOf = (raw: unknown): Array<{ at: string; note: string }> => (Array.isArray(raw) ? (raw as Array<{ at: string; note: string }>).slice(-60) : []);

/** Run the sequences: start new runs, act on replies, do what's due. */
export async function processSequences(env: Env, options: { companyId?: string; now?: Date } = {}) {
  const admin = adminClient(env);
  const now = options.now ?? new Date();
  const tally = { started: 0, replies: 0, steps: 0, ended: 0, failed: 0 };
  let companies = admin.from("sequences").select("company_id").eq("enabled", true);
  if (options.companyId) companies = companies.eq("company_id", options.companyId);
  const { data: enabled } = await companies.limit(1000);
  for (const companyId of new Set((enabled ?? []).map((r) => r.company_id))) {
    try {
      tally.started += await startNew(admin, companyId);
    } catch (error) {
      tally.failed++;
      reportError(error, { feature: "sequences" });
    }
  }
  // Replies first: a client who texted back shouldn't get the next text a minute later.
  let replies = admin.from("sequence_runs").select("*").eq("status", "active").not("reply_at", "is", null);
  if (options.companyId) replies = replies.eq("company_id", options.companyId);
  for (const run of ((await replies.limit(100)).data ?? []) as RunRow[]) {
    try {
      await handleReply(env, admin, run, now);
      tally.replies++;
    } catch (error) {
      tally.failed++;
      reportError(error, { feature: "sequences" });
    }
  }
  // Paused too long: ended.
  const stale = new Date(now.getTime() - PAUSE_DAYS * 86_400_000).toISOString();
  await admin.from("sequence_runs").update({ status: "done", ended_reason: `Paused for ${PAUSE_DAYS} days and not resumed` }).eq("status", "paused").lt("paused_at", stale);
  let due = admin.from("sequence_runs").select("*").eq("status", "active").is("reply_at", null).lte("next_at", now.toISOString()).order("next_at");
  if (options.companyId) due = due.eq("company_id", options.companyId);
  for (const run of ((await due.limit(50)).data ?? []) as RunRow[]) {
    try {
      const r = await advance(env, admin, run, now);
      tally.steps += r.steps;
      if (r.ended) tally.ended++;
    } catch (error) {
      tally.failed++;
      reportError(error, { feature: "sequences" });
      await admin.from("sequence_runs").update({ next_at: new Date(now.getTime() + 15 * 60_000).toISOString(), log: [...logOf(run.log), { at: now.toISOString(), note: `Failed, trying again in 15 minutes: ${(error as Error).message}`.slice(0, 300) }] }).eq("id", run.id);
    }
  }
  return tally;
}

/** Starts the company's sequences for what happened since its cursor. How many runs started. */
async function startNew(admin: Db, companyId: string): Promise<number> {
  const { data: cursor } = await admin.from("sequence_cursors").select("last_activity_id").eq("company_id", companyId).maybeSingle();
  if (!cursor) {
    // First pass: start from now, never from the past.
    const { data: newest } = await admin.from("activity").select("id").eq("company_id", companyId).order("id", { ascending: false }).limit(1).maybeSingle();
    await admin.from("sequence_cursors").upsert({ company_id: companyId, last_activity_id: newest?.id ?? 0 });
    return 0;
  }
  const { data: events } = await admin
    .from("activity").select("id, verb, subject_type, subject_id")
    .eq("company_id", companyId).gt("id", cursor.last_activity_id).in("verb", TRIGGERS).order("id").limit(200);
  if (!events?.length) return 0;
  const { data: sequences } = await admin.from("sequences").select("id, brand, trigger").eq("company_id", companyId).eq("enabled", true);
  let started = 0;
  for (const event of events) {
    const matching = (sequences ?? []).filter((s) => s.trigger === event.verb);
    if (!matching.length || !event.subject_id) continue;
    const who = await subjectOf(admin, companyId, event.subject_type, event.subject_id);
    if (!who) continue;
    for (const s of matching) {
      if (s.brand && who.brand !== s.brand) continue;
      const { error } = await admin.from("sequence_runs").insert({
        company_id: companyId, sequence_id: s.id, client_id: who.clientId, subject_type: event.subject_type, subject_id: event.subject_id, brand: who.brand,
        log: [{ at: new Date().toISOString(), note: "Started" }],
      });
      // The same record twice (a quote sent again): it's already going, or went.
      if (!error) started++;
    }
  }
  await admin.from("sequence_cursors").update({ last_activity_id: events[events.length - 1]!.id }).eq("company_id", companyId);
  return started;
}

/** The client and brand of what a run is about. */
async function subjectOf(admin: Db, companyId: string, type: string, id: string): Promise<{ clientId: string | null; brand: Brand } | null> {
  if (type === "request") {
    const { data } = await admin.from("requests").select("client_id, brand, title").eq("company_id", companyId).eq("id", id).maybeSingle();
    return data ? { clientId: data.client_id, brand: requestBrand(data) } : null;
  }
  if (type === "quote") {
    const { data } = await admin.from("quotes").select("client_id, brand, lines:quote_line_items(name)").eq("company_id", companyId).eq("id", id).maybeSingle();
    return data ? { clientId: data.client_id, brand: quoteBrand(data) } : null;
  }
  if (type === "job") {
    const { data } = await admin.from("jobs").select("client_id, quote:quotes!jobs_company_id_quote_id_fkey(brand, lines:quote_line_items(name))").eq("company_id", companyId).eq("id", id).maybeSingle();
    return data ? { clientId: data.client_id, brand: data.quote ? quoteBrand(data.quote) : "washing" } : null;
  }
  return null;
}

/** Where the record a run is about stands, for core stillGoing. */
async function standing(admin: Db, run: RunRow): Promise<{ status?: string | null; stage?: string | null } | null> {
  const table = run.subject_type === "request" ? "requests" : run.subject_type === "quote" ? "quotes" : "jobs";
  if (table === "requests") return (await admin.from("requests").select("status, stage").eq("id", run.subject_id).maybeSingle()).data;
  return (await admin.from(table).select("status").eq("id", run.subject_id).maybeSingle()).data;
}

async function companyOf(admin: Db, companyId: string): Promise<Company> {
  const { data } = await admin.from("companies").select("id, name, timezone, settings").eq("id", companyId).single();
  return { id: data!.id, name: data!.name, timezone: data!.timezone || "America/New_York", settings: (data!.settings ?? {}) as Record<string, unknown> };
}

async function varsFor(admin: Db, company: Company, clientId: string | null): Promise<{ vars: SequenceVars; client: { id: string; display_name: string; phone: string | null; email: string | null; sms_opt_out_at: string | null } | null }> {
  const [client, owner] = await Promise.all([
    clientId ? admin.from("clients").select("id, display_name, phone, email, sms_opt_out_at").eq("id", clientId).maybeSingle() : Promise.resolve({ data: null }),
    admin.from("memberships").select("user_id").eq("company_id", company.id).eq("role", "owner").eq("active", true).limit(1).maybeSingle(),
  ]);
  const c = client.data as { id: string; display_name: string; phone: string | null; email: string | null; sms_opt_out_at: string | null } | null;
  const ownerName = owner.data ? ((await admin.from("profiles").select("full_name").eq("user_id", owner.data.user_id).maybeSingle()).data?.full_name ?? "") : "";
  return {
    client: c,
    vars: {
      first_name: (c?.display_name || "").trim().split(/\s+/)[0] ?? "",
      name: c?.display_name ?? "",
      email: c?.email ?? "",
      phone: c?.phone ?? "",
      owner_first_name: ownerName.trim().split(/\s+/)[0] ?? "",
      company: company.name,
      review_link: typeof company.settings.review_url === "string" ? company.settings.review_url : "",
    },
  };
}

/** Text the office's alert number and tell the office in the app. */
async function alertOffice(env: Env, admin: Db, company: Company, run: RunRow, title: string, body: string) {
  const phone = phoneE164(typeof company.settings.sequence_alert_phone === "string" ? company.settings.sequence_alert_phone : "");
  const sent: string[] = [];
  if (phone) {
    const result = await sendSms(env, { to: phone, body, brand: asBrand(run.brand) }, company.id);
    sent.push(result.sent ? "texted the alert number" : `couldn't text the alert number (${result.reason ?? "not sent"})`);
  }
  const { data: office } = await admin.from("memberships").select("user_id").eq("company_id", company.id).eq("active", true).in("role", ["owner", "admin", "office"]);
  const link = run.subject_type === "request" ? `/requests/${run.subject_id}` : run.subject_type === "quote" ? `/quotes/${run.subject_id}` : `/jobs/${run.subject_id}`;
  if (office?.length) {
    await admin.from("notifications").insert(office.map((m) => ({ company_id: company.id, user_id: m.user_id, kind: run.subject_type, title: title.slice(0, 300), body: body.slice(0, 2000), link })));
    sent.push(`notified ${office.length} in the app`);
  }
  return sent.join(", ") || "nobody to alert";
}

async function handleReply(env: Env, admin: Db, run: RunRow, now: Date) {
  const { data: seq } = await admin.from("sequences").select("*").eq("id", run.sequence_id).maybeSingle();
  const company = await companyOf(admin, run.company_id);
  const { vars } = await varsFor(admin, company, run.client_id);
  const mode = ((seq as SequenceRow | null)?.on_reply ?? "stop") as OnReply;
  const log = logOf(run.log);
  if (mode === "hot") {
    if (run.subject_type === "request") await admin.from("requests").update({ stage: "hot" }).eq("id", run.subject_id).in("status", ["new", "assessment_scheduled", "assessment_complete"]);
    const told = await alertOffice(env, admin, company, run, `Lead responded - ${vars.first_name || vars.name}`, fillSequence(RESPONDED_ALERT, vars));
    await admin.from("sequence_runs").update({ status: "stopped", reply_at: null, ended_reason: "They replied: moved to Hot Inbound Lead", log: [...log, { at: now.toISOString(), note: `They replied. Moved to Hot Inbound Lead; ${told}.` }] }).eq("id", run.id);
  } else if (mode === "pause") {
    const told = await alertOffice(env, admin, company, run, `Follow-up paused - ${vars.name}`, fillSequence(PAUSED_ALERT, vars));
    await admin.from("sequence_runs").update({ status: "paused", reply_at: null, paused_at: now.toISOString(), log: [...log, { at: now.toISOString(), note: `They replied. Paused; ${told}.` }] }).eq("id", run.id);
  } else {
    await admin.from("sequence_runs").update({ status: "stopped", reply_at: null, ended_reason: "They replied", log: [...log, { at: now.toISOString(), note: "They replied. Stopped." }] }).eq("id", run.id);
  }
}

/** Do a run's steps until the next wait. */
async function advance(env: Env, admin: Db, run: RunRow, now: Date): Promise<{ steps: number; ended: boolean }> {
  const { data: seqRow } = await admin.from("sequences").select("*").eq("id", run.sequence_id).maybeSingle();
  const seq = seqRow as SequenceRow | null;
  const log = logOf(run.log);
  const end = async (status: "done" | "stopped", why: string) => {
    await admin.from("sequence_runs").update({ status, ended_reason: why, log: [...log, { at: now.toISOString(), note: why }] }).eq("id", run.id);
    return { steps: 0, ended: true };
  };
  if (!seq) return end("stopped", "The sequence was deleted");
  if (!seq.enabled) return end("stopped", "The sequence was turned off");
  const steps = sequenceSteps(seq.steps);
  const window = sendWindow(seq.send_window);
  const company = await companyOf(admin, run.company_id);
  const tz = company.timezone;
  const { vars, client } = await varsFor(admin, company, run.client_id);
  let step = run.step;
  let done = 0;
  for (let i = 0; i < MAX_STEPS; i++) {
    const going = stillGoing(seq.trigger as SequenceTrigger, await standing(admin, run));
    if (!going.going) {
      await admin.from("sequence_runs").update({ status: "stopped", step, ended_reason: going.why, log: [...log, { at: now.toISOString(), note: going.why ?? "Stopped" }] }).eq("id", run.id);
      return { steps: done, ended: true };
    }
    const s: SequenceStep | undefined = steps[step];
    if (!s || s.kind === "end") {
      await admin.from("sequence_runs").update({ status: "done", step, ended_reason: "Finished", log: [...log, { at: now.toISOString(), note: "Finished" }] }).eq("id", run.id);
      return { steps: done, ended: true };
    }
    if (s.kind === "wait") {
      const after = nextInWindow(new Date(now.getTime() + s.minutes * 60_000), s.window, tz);
      log.push({ at: now.toISOString(), note: `Waiting ${waitWords(s.minutes)}${s.window ? ", then for the next opening" : ""}` });
      await admin.from("sequence_runs").update({ step: step + 1, next_at: after.toISOString(), log }).eq("id", run.id);
      return { steps: done + 1, ended: false };
    }
    if (s.kind === "text") {
      // Outside the sequence's sending window: the text waits for its next opening.
      const at = nextInWindow(now, window, tz);
      if (at.getTime() > now.getTime()) {
        await admin.from("sequence_runs").update({ step, next_at: at.toISOString(), log: [...log, { at: now.toISOString(), note: "Outside the sending window: waiting for it to open" }] }).eq("id", run.id);
        return { steps: done, ended: false };
      }
      log.push({ at: now.toISOString(), note: await textClient(env, admin, company, run, client, fillSequence(s.body, vars)) });
    } else if (s.kind === "alert") {
      log.push({ at: now.toISOString(), note: `Alert: ${await alertOffice(env, admin, company, run, `${seq.name}: ${vars.name}`, fillSequence(s.body, vars))}` });
    } else if (s.kind === "task") {
      const due = addDays(localDate(now, tz), s.days);
      const { error } = await admin.from("visits").insert({ company_id: company.id, kind: "task", title: fillSequence(s.title, vars).slice(0, 200) || seq.name, scheduled_on: due, status: "scheduled", notes: `Created by the sequence “${seq.name}”.` });
      log.push({ at: now.toISOString(), note: error ? `Couldn't make the task: ${error.message}` : `Made a task for ${due}` });
    } else if (s.kind === "stage") {
      if (run.subject_type === "request") await admin.from("requests").update({ stage: s.stage }).eq("id", run.subject_id);
      log.push({ at: now.toISOString(), note: `Moved the lead to ${s.stage}` });
    } else if (s.kind === "hours") {
      if (!inHours(now, s.start, s.end, tz)) {
        log.push({ at: now.toISOString(), note: `Outside ${s.start}-${s.end}: going to step ${s.otherwise + 1}` });
        step = s.otherwise;
        done++;
        continue;
      }
    } else if (s.kind === "goto") {
      step = s.step;
      done++;
      continue;
    }
    step++;
    done++;
    await admin.from("sequence_runs").update({ step, log }).eq("id", run.id);
  }
  // Too many steps at once (a loop of go-tos): try again in a minute rather than spin.
  await admin.from("sequence_runs").update({ step, next_at: new Date(now.getTime() + 60_000).toISOString(), log }).eq("id", run.id);
  return { steps: done, ended: false };
}

async function textClient(
  env: Env, admin: Db, company: Company, run: RunRow,
  client: { id: string; display_name: string; phone: string | null; email: string | null; sms_opt_out_at: string | null } | null, body: string,
): Promise<string> {
  if (!client) return "Not texted: there's no client";
  if (!client.phone) return `Not texted: ${client.display_name} has no phone number`;
  if (textsOffTo(client, client.phone)) return `Not texted: ${client.display_name} asked not to be texted`;
  if (await numberStopped(admin, company.id, client.phone)) return `Not texted: ${client.phone} texted STOP`;
  const brand = asBrand(run.brand);
  let line: "washing" | "lights" | undefined;
  const result = await textWithStopLine(admin, company.id, client.phone, body, async (text) => {
    const r = await sendSms(env, { to: client.phone!, body: text, brand }, company.id);
    line = r.line;
    return r;
  });
  await noteRefusedText(admin, client, client.phone, result, company.id);
  await admin.from("messages").insert({
    company_id: company.id, client_id: client.id, channel: "sms", direction: "out", body, status: result.sent ? "sent" : "failed",
    external_id: result.id ?? null, sent_by: null, ...(line ? { line } : {}),
    recipients: [{ to: client.phone, name: client.display_name, ...(result.sent ? {} : { failed: true }) }],
  });
  return result.sent ? `Texted ${client.display_name}` : `Text to ${client.display_name} didn't go: ${result.reason ?? "unknown"}`;
}

/**
 * A client texted back: their running sequences act on it at the next minute (processSequences).
 * Called for each client a text was filed under (services/inboundTexts.ts).
 */
export async function noteSequenceReply(admin: Db, companyId: string, clientId: string) {
  await admin.from("sequence_runs").update({ reply_at: new Date().toISOString() }).eq("company_id", companyId).eq("client_id", clientId).eq("status", "active");
}

/** The office pauses, resumes or stops one client's run. Resuming sends the next text right away. */
export async function changeRun(admin: Db, companyId: string, runId: string, action: "pause" | "resume" | "stop", who: string) {
  const { data: run } = await admin.from("sequence_runs").select("*").eq("company_id", companyId).eq("id", runId).maybeSingle();
  if (!run) throw new Error("That sequence run isn't here anymore.");
  const r = run as RunRow;
  const now = new Date();
  const log = logOf(r.log);
  if (action === "stop") {
    if (r.status === "done" || r.status === "stopped") return r;
    return (await admin.from("sequence_runs").update({ status: "stopped", reply_at: null, ended_reason: `Stopped by ${who}`, log: [...log, { at: now.toISOString(), note: `Stopped by ${who}` }] }).eq("id", runId).select("*").single()).data;
  }
  if (action === "pause") {
    if (r.status !== "active") throw new Error("Only a running sequence can be paused.");
    return (await admin.from("sequence_runs").update({ status: "paused", paused_at: now.toISOString(), log: [...log, { at: now.toISOString(), note: `Paused by ${who}` }] }).eq("id", runId).select("*").single()).data;
  }
  if (r.status !== "paused") throw new Error("Only a paused sequence can be resumed.");
  // Skip what's left of the wait it was in, as GoHighLevel's resume tag went straight to the next text.
  const { data: seq } = await admin.from("sequences").select("steps").eq("id", r.sequence_id).maybeSingle();
  const steps = sequenceSteps(seq?.steps);
  let step = r.step;
  while (steps[step]?.kind === "wait") step++;
  return (await admin.from("sequence_runs").update({ status: "active", paused_at: null, reply_at: null, step, next_at: now.toISOString(), log: [...log, { at: now.toISOString(), note: `Resumed by ${who}` }] }).eq("id", runId).select("*").single()).data;
}
