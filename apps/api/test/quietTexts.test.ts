/**
 * Quiet hours for a rule's text to a client (services/automations.ts quietTexts): between 9pm and
 * 8am in the company's time zone the run waits for 8am, with what it had done so far. "On my way"
 * and an answer to something the client just did go at any hour. A visit booked, moved or cancelled
 * that would be old news by 8am goes by email when it can: the rule's own email has told them, or the
 * text's words go by email instead; with no email it's texted after all. PostgREST is a stand-in answering over fetch, sending is mocked,
 * and the clock is the test's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  emailReady: vi.fn(async () => true),
  sendEmail: vi.fn(async () => ({ sent: true, id: "email-1" })),
  sendSms: vi.fn(async () => ({ sent: true, id: "sms-1" })),
}));

const notify = await import("../src/lib/notify");
const { executeRun, quietTexts, staleByMorning } = await import("../src/services/automations");
const { WaitUntil } = await import("../src/services/reviews");
const { adminClient } = await import("../src/lib/supabase");
const sendSms = vi.mocked(notify.sendSms);
const sendEmail = vi.mocked(notify.sendEmail);

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_AUTH_TOKEN: "twilio-token",
  TWILIO_FROM_NUMBER: "+15405550000",
};
const CO = "00000000-0000-4000-8000-0000000000c1";
const ANA_ID = "00000000-0000-4000-8000-0000000000a1";
const NY = "America/New_York";
// 10:40pm on October 28 in New York, and the 8am after it.
const LATE = "2026-10-29T02:40:00Z";
const MORNING = "2026-10-29T12:00:00.000Z";

type Row = Record<string, any>;
interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: any;
}

/** PostgREST over fetch: GETs answer from `tables` (filtered by eq. and in.), functions from `rpc`. Every call is kept. */
function serve(world: { tables?: Record<string, Row[]>; rpc?: Record<string, (body: any) => unknown> } = {}) {
  const calls: Call[] = [];
  const tables = world.tables ?? {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    const text = typeof init?.body === "string" ? init.body : "";
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path, params: url.searchParams, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    if (path.startsWith("rpc/")) {
      const fn = world.rpc?.[path.slice(4)];
      return Response.json(fn ? (fn(call.body) ?? null) : true);
    }
    if (call.method === "GET") {
      let rows = tables[path] ?? [];
      for (const [column, filter] of url.searchParams) {
        if (!rows.some((r) => column in r)) continue;
        if (filter.startsWith("eq.")) rows = rows.filter((r) => String(r[column]) === filter.slice(3));
        else if (filter.startsWith("in.(")) rows = rows.filter((r) => filter.slice(4, -1).split(",").map((v) => v.replace(/^"|"$/g, "")).includes(String(r[column])));
      }
      return Response.json(rows);
    }
    return Response.json([]);
  });
  return calls;
}
const rpcCalls = (calls: Call[], fn: string) => calls.filter((c) => c.path === `rpc/${fn}`).map((c) => c.body);
const at = (iso: string) => vi.setSystemTime(new Date(iso));

const ANA: Row = {
  id: ANA_ID, company_id: CO, display_name: "Ana Smith", email: "ana@example.com", phone: "(540) 555-0100", tags: [], status: "active", lead_source: null,
  review_opt_out: false, marketing_opt_out: false, sms_opt_out_at: null, reviewed_at: null,
};
const company: Row = {
  id: CO, name: "Acme Lawn", phone: "555-0100", email: "office@acme.example", website: null, timezone: NY, currency: "USD", trade_preset: "lawn_care",
  address: { line1: "1 Main St", city: "Radford", region: "VA", postal_code: "24141" }, settings: {},
};
/** A visit on October 30 at 10am in New York: well after the morning the texts wait for. */
const visit: Row = { id: "visit-1", company_id: CO, title: "Mowing", kind: "job", status: "scheduled", scheduled_on: "2026-10-30", starts_at: "2026-10-30T14:00:00Z", eta_at: null, job_id: "job-1", property_id: null, property: null, job: { client_id: ANA_ID, kind: "one_off" }, request: null };
/** One tomorrow at 7am: before 8am, so news of it can't wait. */
const early: Row = { ...visit, scheduled_on: "2026-10-29", starts_at: "2026-10-29T11:00:00Z" };
const text = { type: "send_sms", body: "Hi {{client.first_name}}, this is {{company.name}}. Your {{title}} visit is booked for {{date}}{{time}}." };
const email = { type: "send_email", subject: "Your visit is booked", body: "Hi {{client.first_name}}, your visit is booked for {{date}}{{time}}." };
const rule = (over: Row = {}) => ({ id: "rule-1", company_id: CO, name: "Tell clients when a visit is booked", trigger: "visit.scheduled", enabled: true, delay_minutes: 0, conditions: [], actions: [text], run_count: 0, ...over });
const run = (over: Row = {}) => ({ id: 7, company_id: CO, rule_id: "rule-1", subject_type: "visit", subject_id: "visit-1", activity_id: null, result: [], claim_token: "claim-1", ...over });
const engine = (theRule: Row, tables: Record<string, Row[]> = {}) =>
  serve({ tables: { companies: [company], automation_rules: [theRule], visits: [visit], clients: [ANA], sms_told: [{ company_id: CO, phone_key: "5405550100" }], ...tables }, rpc: { visit_notice_is_repeat: () => false } });
const finished = (calls: Call[]) => rpcCalls(calls, "finish_automation_run");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(LATE) });
  sendSms.mockClear().mockImplementation(async () => ({ sent: true, id: "sms-1" }));
  sendEmail.mockClear().mockImplementation(async () => ({ sent: true, id: "email-1" }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("when a rule's text waits", () => {
  const ctx = (trigger: string, over: Row = {}) => ({ trigger, delayed: false, company: { timezone: NY } as never, ...over });

  it("is between 9pm and 8am in the company's time zone, until 8am", () => {
    for (const [now, waits] of [["2026-10-29T00:59:00Z", false], ["2026-10-29T01:00:00Z", true], ["2026-10-29T08:00:00Z", true], ["2026-10-29T11:59:00Z", true], ["2026-10-29T12:00:00Z", false], ["2026-10-29T18:00:00Z", false]] as const) {
      const check = () => quietTexts(ctx("visit.reminder"), new Date(now));
      if (waits) expect(check, now).toThrow(WaitUntil);
      else expect(check(), now).toBeNull();
    }
    try {
      quietTexts(ctx("invoice.overdue"), new Date(LATE));
    } catch (wait) {
      expect([(wait as InstanceType<typeof WaitUntil>).until.toISOString(), (wait as Error).message]).toEqual([MORNING, "Quiet hours: texts to clients wait until 8am"]);
    }
    // After midnight it's the same morning's 8am.
    expect(() => quietTexts(ctx("visit.completed"), new Date("2026-10-29T06:30:00Z"))).toThrow(expect.objectContaining({ until: new Date(MORNING) }));
    // By the company's own clock: 10:40pm in New York is 7:40pm in Los Angeles.
    expect(quietTexts(ctx("visit.reminder", { company: { timezone: "America/Los_Angeles" } }), new Date(LATE))).toBeNull();
  });

  it("isn't for on-my-way, or for an answer to what the client just did", () => {
    const late = new Date(LATE);
    expect(quietTexts(ctx("visit.en_route"), late)).toBeNull();
    expect(quietTexts(ctx("visit.en_route", { delayed: true }), late)).toBeNull();
    for (const trigger of ["request.created", "quote.approved", "quote.changes_requested", "quote.range_accepted", "visit.reschedule_requested", "visit.cancel_requested"]) {
      expect(quietTexts(ctx(trigger), late), trigger).toBeNull();
      // With a delay on the rule it's a follow-up, which waits like any other.
      expect(() => quietTexts(ctx(trigger, { delayed: true }), late), trigger).toThrow(WaitUntil);
    }
    for (const trigger of ["visit.reminder", "visit.started", "visit.completed", "quote.sent", "invoice.sent", "invoice.overdue", "invoice.paid", "payment.received", "job.completed", "client.inactive", "quote.lost", "autopay.failed"]) {
      expect(() => quietTexts(ctx(trigger), late), trigger).toThrow(WaitUntil);
    }
  });

  it("knows a visit notice that would be old news by morning", () => {
    const morning = new Date(MORNING);
    const co = { timezone: NY } as never;
    const on = (scheduled_on: string | null, starts_at: string | null) => ({ status: "scheduled", scheduled_on, starts_at });
    // Tomorrow at 7am is before 8am; at 8am it's too late as well; at 9am it isn't.
    expect(staleByMorning({ company: co, visit: on("2026-10-29", "2026-10-29T11:00:00Z") }, "visit.scheduled", morning)).toBe(true);
    expect(staleByMorning({ company: co, visit: on("2026-10-29", "2026-10-29T12:00:00Z") }, "visit.rescheduled", morning)).toBe(true);
    expect(staleByMorning({ company: co, visit: on("2026-10-29", "2026-10-29T13:00:00Z") }, "visit.scheduled", morning)).toBe(false);
    // An anytime visit tomorrow can still be told at 8am.
    expect(staleByMorning({ company: co, visit: on("2026-10-29", null) }, "visit.scheduled", morning)).toBe(false);
    // A cancelled one goes by when it was to be.
    const gone = { status: "cancelled", scheduled_on: null, starts_at: null };
    expect(staleByMorning({ company: co, visit: gone, was: { scheduled_on: "2026-10-29", starts_at: "2026-10-29T11:00:00Z" } }, "visit.cancelled", morning)).toBe(true);
    expect(staleByMorning({ company: co, visit: gone, was: { scheduled_on: "2026-10-30", starts_at: "2026-10-30T14:00:00Z" } }, "visit.cancelled", morning)).toBe(false);
    expect(() => quietTexts({ trigger: "visit.scheduled", company: co, visit: on("2026-10-30", "2026-10-30T14:00:00Z") }, new Date(LATE))).toThrow(WaitUntil);
    expect(quietTexts({ trigger: "visit.scheduled", company: co, visit: on("2026-10-29", "2026-10-29T11:00:00Z") }, new Date(LATE))).toBe("stale");
  });
});

describe("a rule that texts a client at 10:40pm", () => {
  it("emails right away and holds the text until 8am, then sends only the text", async () => {
    const calls = engine(rule({ actions: [email, text] }));
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("waiting");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendSms).not.toHaveBeenCalled();
    expect(rpcCalls(calls, "postpone_automation_run")).toEqual([{
      p_id: 7, p_token: "claim-1", p_until: MORNING, p_result: [{ type: "send_email", ok: true, detail: "Emailed ana@example.com" }], p_note: "Quiet hours: texts to clients wait until 8am",
    }]);
    expect(finished(calls)).toEqual([]);

    at(MORNING);
    const again = engine(rule({ actions: [email, text] }));
    const result = rpcCalls(calls, "postpone_automation_run")[0].p_result;
    expect(await executeRun(env, adminClient(env), run({ result }), env.APP_URL!)).toBe("done");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendSms.mock.calls.map((c) => c[1].body)).toEqual(["Hi Ana, this is Acme Lawn. Your Mowing visit is booked for Friday, October 30 at 10:00 AM."]);
    expect(finished(again)[0].p_result.map((r: Row) => [r.type, r.detail])).toEqual([["send_email", "Emailed ana@example.com"], ["send_sms", "Texted (540) 555-0100"]]);
  });

  it("sends an on-my-way text at any hour", async () => {
    const calls = engine(rule({ trigger: "visit.en_route", actions: [{ type: "send_sms", body: "Our crew is on the way." }] }));
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(rpcCalls(calls, "postpone_automation_run")).toEqual([]);
  });

  it("doesn't text late about a visit that's before 8am: the rule's email has told them", async () => {
    const calls = engine(rule({ actions: [email, text] }), { visits: [early] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendSms).not.toHaveBeenCalled();
    expect(rpcCalls(calls, "postpone_automation_run")).toEqual([]);
    expect(finished(calls)[0].p_result).toEqual([
      { type: "send_email", ok: true, detail: "Emailed ana@example.com" },
      { type: "send_sms", ok: true, skipped: true, detail: "Not texted: it's quiet hours (9pm to 8am) and the visit is before 8am. This rule's email tells them" },
    ]);
  });

  it("texts after all when the rule's email couldn't tell them, for want of an address", async () => {
    const calls = engine(rule({ actions: [email, text] }), { visits: [early], clients: [{ ...ANA, email: null }] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("failed");
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(finished(calls)[0].p_result).toEqual([
      { type: "send_email", ok: false, detail: "Ana Smith has no email address." },
      { type: "send_sms", ok: true, detail: `Texted ${ANA.phone}, in quiet hours: the visit is before 8am and there was no email to tell them by` },
    ]);
  });

  it("sends the text's words by email instead when the rule only texts", async () => {
    const calls = engine(rule(), { visits: [early] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(sendSms).not.toHaveBeenCalled();
    expect(sendEmail.mock.calls.map((c) => [c[1].to, c[1].subject])).toEqual([["ana@example.com", "Your visit with Acme Lawn is booked"]]);
    expect(sendEmail.mock.calls[0]![1].text).toContain("Hi Ana, this is Acme Lawn. Your Mowing visit is booked for Thursday, October 29 at 7:00 AM.");
    expect(finished(calls)[0].p_result).toEqual([
      { type: "send_sms", ok: true, detail: "Emailed ana@example.com instead of texting: it's quiet hours (9pm to 8am) and the visit is before 8am" },
    ]);
  });

  it("texts after all when there's no email address to use instead", async () => {
    const calls = engine(rule(), { visits: [early], clients: [{ ...ANA, email: null }] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(finished(calls)[0].p_result).toEqual([
      { type: "send_sms", ok: true, detail: `Texted ${ANA.phone}, in quiet hours: the visit is before 8am and there was no email to tell them by` },
    ]);
  });

  it("holds an autopay invite by text until 8am", async () => {
    const invite = (channel: string) => rule({ trigger: "job.completed", actions: [{ type: "invite_autopay", channel }] });
    const job = { id: "job-1", company_id: CO, number: 12, title: "Spring cleanup", status: "completed", kind: "one_off", autopay: false, financials: { contract_total: 400 }, client_id: ANA_ID, property_id: null, property: null, lines: [] };
    const calls = engine(invite("sms"), { jobs: [job] });
    expect(await executeRun(env, adminClient(env), run({ subject_type: "job", subject_id: "job-1" }), env.APP_URL!)).toBe("waiting");
    expect(rpcCalls(calls, "postpone_automation_run")[0]).toMatchObject({ p_until: MORNING, p_note: "Quiet hours: texts to clients wait until 8am" });
    expect(sendSms).not.toHaveBeenCalled();
  });
});

describe("the line a rule's text goes from (services/brand.ts)", () => {
  /** The same visit, on a job from a Christmas lights quote. */
  const lightsVisit = { ...visit, job: { ...visit.job, quote: { brand: "lights", lines: [{ name: "Roofline lighting" }] }, lines: [] } };

  it("is the lighting line for a Christmas lights visit, whatever the trigger", async () => {
    at(MORNING);
    for (const trigger of ["visit.scheduled", "visit.reminder", "visit.completed"]) {
      sendSms.mockClear();
      engine(rule({ trigger }), { visits: [lightsVisit] });
      expect(await executeRun(env, adminClient(env), run(), env.APP_URL!), trigger).toBe("done");
      expect(sendSms.mock.calls.map((c) => c[1].brand), trigger).toEqual(["lights"]);
    }
  });

  it("names no brand (the wash line) for a visit nothing says is Christmas lights", async () => {
    at(MORNING);
    engine(rule());
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(sendSms.mock.calls.map((c) => c[1].brand ?? null)).toEqual([null]);
  });
});
