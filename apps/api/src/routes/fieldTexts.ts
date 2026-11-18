/**
 * Texting a client from the field, inside the app (not the phone's own texting app), so the text
 * goes from the business's Quo line and is kept on the client's timeline:
 *
 *   GET  /field/text-lines        the lines a text can go from (Wash line, Lighting line), names only
 *   POST /field/text              a text to a client the person can read, from the line they picked
 *   GET  /visits/:id/on-my-way    whether the On my way text went out, for the crew's phone
 *
 * For the whole team (field crew included), never a sub: a sub's way to reach a client is the office's
 * call (visit_contact). The client is read as the person (row-level security), so nobody texts a
 * client they can't see. A client who texted STOP, or a number that did, isn't texted; the first
 * text a number gets says how to stop them (services/stopLine.ts). While Quo is test only, only the
 * test numbers are texted (lib/notify.ts quoOut), whatever is picked here.
 */
import { STAFF } from "@crewtavo/core";
import { quoNumberAllowed } from "@crewtavo/core/quo";
import { textsOff } from "@crewtavo/core/marketing";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { dbError, HttpError, must, param, readJson, uuid } from "../lib/http";
import { allow } from "../lib/limit";
import { sendSms } from "../lib/notify";
import { companyQuo } from "../lib/quo";
import { adminClient, type Db } from "../lib/supabase";
import { brandFor } from "../services/brand";
import { textWithStopLine } from "../services/stopLine";
import { noteRefusedText, numberStopped, numberStoppedRefusal, textsOffRefusal } from "../services/textsOff";

export const fieldTexts = new Hono<AppEnv>();

/** Texts one person can send from the field in an hour: plenty for a day's visits, not a flood. */
export const FIELD_TEXTS_PER_HOUR = 40;

/**
 * The Quo lines, by brand, for the From switch, and which one it starts on: the visit's brand (its
 * job's quote, else its request), else the client's. Empty without Quo: a text goes the one way there is.
 */
fieldTexts.get("/field/text-lines", requireUser, requireCompany(STAFF), async (c) => {
  const { db, companyId } = c.var;
  const account = await companyQuo(c.env, companyId).catch(() => null);
  const lines = account ? (["washing", "lights"] as const).flatMap((brand) => (account.settings.lines[brand] ? [{ brand, name: account.settings.lines[brand]!.name }] : [])) : [];
  const ids = z.object({ visit_id: uuid.optional(), client_id: uuid.optional() }).safeParse({ visit_id: c.req.query("visit_id") || undefined, client_id: c.req.query("client_id") || undefined });
  const { visit_id: visitId, client_id: clientId } = ids.success ? ids.data : {};
  // Only for a visit or client the person can read.
  const readable = visitId ? Boolean((await db.from("visits").select("id").eq("id", visitId).eq("company_id", companyId).maybeSingle()).data) : true;
  const known = clientId ? Boolean((await db.from("clients").select("id").eq("id", clientId).eq("company_id", companyId).maybeSingle()).data) : true;
  const brand = lines.length && readable && known && (visitId || clientId)
    ? await brandFor(adminClient(c.env), companyId, visitId ? { subject: "visit", id: visitId, clientId } : { clientId })
    : null;
  return c.json({ lines, test_only: account?.settings.test_only ?? false, brand: brand ?? "washing" });
});

fieldTexts.post("/field/text", requireUser, requireCompany(STAFF), async (c) => {
  const body = await readJson(
    c,
    z.object({
      client_id: uuid,
      visit_id: uuid.optional(),
      // The line picked (Wash or Lighting); left out, the visit's brand, else the client's.
      brand: z.enum(["washing", "lights"]).optional(),
      body: z.string().trim().min(1).max(1600),
    }),
  );
  const { db, companyId, userId } = c.var;
  const admin = adminClient(c.env);
  // As the person: a client (or visit) they can't read is not found.
  const client = must(await db.from("clients").select("id, display_name, phone, email, sms_opt_out_at").eq("id", body.client_id).eq("company_id", companyId).maybeSingle(), "Client not found.");
  if (body.visit_id) must(await db.from("visits").select("id").eq("id", body.visit_id).eq("company_id", companyId).maybeSingle(), "Visit not found.");
  // Only the client's own phone: a crew doesn't type in numbers to text from the business's line.
  const to = client.phone?.trim() ?? "";
  if (!to) throw new HttpError(400, `${client.display_name} has no phone number.`);
  if (textsOff(client)) throw new HttpError(400, textsOffRefusal(client.display_name));
  if (await numberStopped(admin, companyId, to)) throw new HttpError(400, numberStoppedRefusal(to));
  if (!(await allow(c.env, `field-text:${userId}`, FIELD_TEXTS_PER_HOUR, 3600))) throw new HttpError(429, "That's a lot of texts in an hour. Wait a bit, or ask the office.");
  const brand = body.brand ?? (await brandFor(admin, companyId, body.visit_id ? { subject: "visit", id: body.visit_id, clientId: client.id } : { clientId: client.id }));
  const result = await textWithStopLine(admin, companyId, to, body.body, (text) => sendSms(c.env, { to, body: text, ...(brand ? { brand } : {}) }, companyId));
  await noteRefusedText(admin, client, to, result, companyId);
  // Kept on the client's timeline either way, under the line it went from, with who sent it. Written
  // by the server: the field crew reads messages but doesn't write the business's texts itself.
  const { data: row, error } = await admin
    .from("messages")
    .insert({
      company_id: companyId, client_id: client.id, channel: "sms", direction: "out", body: body.body, status: result.sent ? "sent" : "failed",
      external_id: result.id ?? null, line: result.line ?? null, sent_by: userId,
      ...(body.visit_id ? { related_type: "visit", related_id: body.visit_id } : {}),
      recipients: [{ to, name: client.display_name, ...(result.sent ? {} : { failed: true }) }],
    })
    .select("id")
    .single();
  if (error) throw dbError(error);
  if (!result.sent) throw new HttpError(502, `${result.reason ?? "It wasn't sent."} It's saved as not sent on the client's timeline.`);
  return c.json({ id: row.id, sent: true, to, line: result.line ?? null });
});

/** Why an On my way text didn't go, in a word the phone says in its own language. */
export type OnMyWayWhy = "test_mode" | "no_phone" | "opted_out" | "off" | "other";

export interface OnMyWayText {
  /** none: not on the way; off: no text rule is on; waiting: about to go; sent; not_sent (why). */
  state: "none" | "off" | "waiting" | "sent" | "not_sent";
  /** The client's first name, for "Text sent to Jane". */
  to?: string | null;
  line?: "washing" | "lights" | null;
  why?: OnMyWayWhy;
  /** The engine's own words, when `why` is "other". */
  detail?: string | null;
}

/**
 * Whether the text the On my way tap starts went out, for the crew's phone: the latest "on the way"
 * for the visit, the run of the rule that texts about it, and the text it left on the client's
 * timeline. Why one didn't go is worked out from the client and Quo's test list, not read from the
 * engine's sentence, so the phone can say it plainly.
 */
fieldTexts.get("/visits/:id/on-my-way", requireUser, requireCompany(STAFF), async (c) => {
  const visitId = param(c, "id");
  const { db, companyId } = c.var;
  must(await db.from("visits").select("id").eq("id", visitId).eq("company_id", companyId).maybeSingle(), "Visit not found.");
  return c.json(await onMyWayText(c.env, adminClient(c.env), companyId, visitId));
});

export async function onMyWayText(env: Env, admin: Db, companyId: string, visitId: string, now = Date.now()): Promise<OnMyWayText> {
  const { data: event } = await admin
    .from("activity")
    .select("id, created_at")
    .eq("company_id", companyId)
    .eq("subject_type", "visit")
    .eq("subject_id", visitId)
    .eq("verb", "visit.en_route")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!event) return { state: "none" };
  const { data: rules } = await admin.from("automation_rules").select("id, enabled, actions").eq("company_id", companyId).eq("trigger", "visit.en_route");
  const texting = (rules ?? []).filter((r) => r.enabled && Array.isArray(r.actions) && (r.actions as Array<{ type?: string }>).some((a) => a.type === "send_sms"));
  if (!texting.length) return { state: "off", why: "off" };
  const { data: runs } = await admin.from("automation_runs").select("status, error, result").eq("company_id", companyId).eq("activity_id", event.id).in("rule_id", texting.map((r) => r.id));
  const run = (runs ?? [])[0];
  // The run is made with the event; two minutes on without one, it isn't coming.
  if (!run) return Date.parse(event.created_at) > now - 120_000 ? { state: "waiting" } : { state: "none" };
  if (run.status === "pending" || run.status === "running") return { state: "waiting" };
  const { data: sent } = await admin
    .from("messages")
    .select("line, status, client:clients(display_name)")
    .eq("company_id", companyId)
    .eq("channel", "sms")
    .eq("related_type", "visit")
    .eq("related_id", visitId)
    .gte("created_at", event.created_at)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const name = (sent?.client as { display_name?: string } | null)?.display_name ?? null;
  const first = name ? name.trim().split(/\s+/)[0]! : null;
  if (run.status === "done" && sent && sent.status !== "failed") return { state: "sent", to: first, line: (sent.line as OnMyWayText["line"]) ?? null };
  return { state: "not_sent", ...(await whyNotSent(env, admin, companyId, visitId, run)) };
}

/** Why the visit's client wasn't texted: no phone, they said stop, Quo's test list, else the run's own words. */
async function whyNotSent(env: Env, admin: Db, companyId: string, visitId: string, run: { error: string | null; result: unknown }): Promise<Pick<OnMyWayText, "why" | "detail">> {
  const results = Array.isArray(run.result) ? (run.result as Array<{ type?: string; ok?: boolean; detail?: string }>) : [];
  const detail = run.error ?? results.find((r) => r.type === "send_sms" && (!r.ok || r.detail))?.detail ?? null;
  const { data: visit } = await admin
    .from("visits")
    .select("job:jobs(client:clients(phone, sms_opt_out_at)), request:requests(client:clients(phone, sms_opt_out_at))")
    .eq("company_id", companyId)
    .eq("id", visitId)
    .maybeSingle();
  const rel = visit as unknown as { job: { client: { phone: string | null; sms_opt_out_at: string | null } | null } | null; request: { client: { phone: string | null; sms_opt_out_at: string | null } | null } | null } | null;
  const client = rel?.job?.client ?? rel?.request?.client ?? null;
  if (client && !client.phone?.trim()) return { why: "no_phone" };
  if (client && (textsOff(client) || (await numberStopped(admin, companyId, client.phone)))) return { why: "opted_out" };
  const quo = await companyQuo(env, companyId).catch(() => null);
  if (quo && client && !quoNumberAllowed(quo.settings, client.phone)) return { why: "test_mode" };
  return { why: "other", detail };
}
