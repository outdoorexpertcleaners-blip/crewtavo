/**
 * Texting a client from the field through the business's line (routes/fieldTexts.ts), the line a
 * visit's texts go from (services/brand.ts visitBrand), the office picking the line in Messages, and
 * what the crew's phone hears about the On my way text. PostgREST is a stand-in answering over
 * fetch, and sending is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  sendSms: vi.fn(async () => ({ sent: true, id: "sms-1" })),
}));

const notify = await import("../src/lib/notify");
const { app } = await import("../src/app");
const { visitBrand } = await import("../src/services/brand");
const { onMyWayText } = await import("../src/routes/fieldTexts");
const { adminClient } = await import("../src/lib/supabase");
const sendSms = vi.mocked(notify.sendSms);

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
};
const CO = "00000000-0000-4000-8000-0000000000c1";
const JANE_ID = "00000000-0000-4000-8000-0000000000a1";
const VISIT_ID = "00000000-0000-4000-8000-0000000000d1";
const USER = "00000000-0000-4000-8000-0000000000e1";

type Row = Record<string, any>;
interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: any;
}

const JANE: Row = { id: JANE_ID, company_id: CO, display_name: "Jane Doe", email: null, phone: "(470) 555-0101", sms_opt_out_at: null };
/** A visit on a Christmas-lights job: its quote says lights. */
const LIGHTS_VISIT: Row = { id: VISIT_ID, company_id: CO, job: { quote: { brand: null, lines: [{ name: "Roofline lighting" }] }, lines: [] }, request: null };

/** PostgREST over fetch: GETs answer from `tables` (filtered by eq.), `answer` can step in first. Every call is kept. */
function serve(world: { tables?: Record<string, Row[]>; answer?: (call: Call) => unknown } = {}) {
  const calls: Call[] = [];
  const tables = world.tables ?? {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    const text = typeof init?.body === "string" ? init.body : "";
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path, params: url.searchParams, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    const own = world.answer?.(call);
    if (own !== undefined) return Response.json(own);
    if (path === "/auth/v1/user") return Response.json({ id: USER, aud: "authenticated", role: "authenticated" });
    if (path.startsWith("rpc/")) return Response.json(true);
    if (call.method === "GET") {
      let rows = tables[path] ?? [];
      for (const [column, filter] of url.searchParams) {
        if (!rows.some((r) => column in r)) continue;
        if (filter.startsWith("eq.")) rows = rows.filter((r) => String(r[column]) === filter.slice(3));
      }
      return Response.json(rows);
    }
    if (call.method === "POST" && path === "messages") return Response.json({ id: "msg-1" });
    return Response.json([]);
  });
  return calls;
}

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: USER, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
const post = (path: string, body: unknown) =>
  app.request(`/api${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Company-Id": CO, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
const member = (role: string) => ({ role, role_id: null, subcontractor_id: null });
const messageRows = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "messages").map((c) => c.body);

beforeEach(() => {
  sendSms.mockClear().mockImplementation(async (_env, message) => ({ sent: true, id: "sms-1", line: (message.brand ?? "washing") as "washing" | "lights" }));
});
afterEach(() => vi.unstubAllGlobals());

describe("a visit's brand", () => {
  it("is its job's quote's, else the request's, else the job's lighting lines", () => {
    expect(visitBrand(LIGHTS_VISIT as never)).toBe("lights");
    expect(visitBrand({ job: { quote: { brand: "washing", lines: [{ name: "Roofline lighting" }] } }, request: null })).toBe("washing");
    expect(visitBrand({ job: null, request: { brand: "lights", title: "Estimate" } })).toBe("lights");
    expect(visitBrand({ job: null, request: { brand: null, title: "Christmas lights estimate" } })).toBe("lights");
    expect(visitBrand({ job: { quote: null, lines: [{ name: "Wreaths" }] }, request: null })).toBe("lights");
  });

  it("says nothing when none of them does, so the client's latest quote decides", () => {
    expect(visitBrand({ job: { quote: null, lines: [{ name: "House wash" }] }, request: null })).toBeNull();
    expect(visitBrand({ job: null, request: null })).toBeNull();
    expect(visitBrand(null)).toBeNull();
  });
});

describe("texting a client from the field", () => {
  const world = (role = "field_crew", clients: Row[] = [JANE]) => ({ tables: { memberships: [member(role)], clients, visits: [LIGHTS_VISIT] } });

  it("lets field crew text from the line they pick, kept on the client's timeline with who sent it", async () => {
    const calls = serve(world());
    const res = await post("/field/text", { client_id: JANE_ID, visit_id: VISIT_ID, brand: "washing", body: "Running 10 minutes late" });
    expect([res.status, await res.json()]).toEqual([200, { id: "msg-1", sent: true, to: "(470) 555-0101", line: "washing" }]);
    expect(sendSms.mock.calls[0]![1]).toMatchObject({ to: "(470) 555-0101", brand: "washing" });
    expect(messageRows(calls)).toEqual([expect.objectContaining({ client_id: JANE_ID, channel: "sms", direction: "out", body: "Running 10 minutes late", line: "washing", sent_by: USER, related_type: "visit", related_id: VISIT_ID, status: "sent" })]);
  });

  it("goes from the visit's brand line when none is picked", async () => {
    serve(world());
    const res = await post("/field/text", { client_id: JANE_ID, visit_id: VISIT_ID, body: "Here now" });
    expect(res.status).toBe(200);
    expect(sendSms.mock.calls[0]![1]).toMatchObject({ brand: "lights" });
  });

  it("isn't for subs", async () => {
    serve(world("subcontractor"));
    const res = await post("/field/text", { client_id: JANE_ID, body: "Hi" });
    expect(res.status).toBe(403);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("doesn't text a client who asked not to be, or one the person can't read", async () => {
    serve(world("field_crew", [{ ...JANE, sms_opt_out_at: "2026-11-01T00:00:00Z" }]));
    const stopped = await post("/field/text", { client_id: JANE_ID, body: "Hi" });
    expect(stopped.status).toBe(400);
    serve(world("field_crew", []));
    const unseen = await post("/field/text", { client_id: JANE_ID, body: "Hi" });
    expect(unseen.status).toBe(404);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("says why a text didn't go, and keeps it as not sent", async () => {
    sendSms.mockImplementation(async () => ({ sent: false, reason: "Not sent: Quo is in test mode, so it only texts the test numbers on Apps → Quo." }));
    const calls = serve(world());
    const res = await post("/field/text", { client_id: JANE_ID, brand: "lights", body: "Hi" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/test mode/);
    expect(messageRows(calls)[0]).toMatchObject({ status: "failed", line: null });
  });
});

describe("the office picking the line in Messages", () => {
  it("sends from the line picked, not the client's brand", async () => {
    serve({ tables: { memberships: [member("office")], clients: [JANE], companies: [{ id: CO, name: "Outdoor Expert", settings: {} }] } });
    const res = await post("/messages/send", { client_id: JANE_ID, channel: "sms", body: "Your lights are booked", line: "lights" });
    expect(res.status).toBe(200);
    expect(sendSms.mock.calls[0]![1]).toMatchObject({ brand: "lights" });
  });
});

describe("what the crew's phone hears after On my way", () => {
  const NOW = Date.parse("2026-11-19T15:00:00Z");
  const event = { id: 7, company_id: CO, created_at: "2026-11-19T14:59:50Z" };
  const rule = { id: "rule-1", company_id: CO, enabled: true, actions: [{ type: "send_sms", body: "Hi" }] };
  const ask = () => onMyWayText(env, adminClient(env), CO, VISIT_ID, NOW);

  it("is that the text went, to whom and from which line", async () => {
    serve({ tables: { activity: [event], automation_rules: [rule], automation_runs: [{ status: "done", error: null, result: [] }], messages: [{ line: "lights", status: "sent", client: { display_name: "Jane Doe" } }] } });
    expect(await ask()).toEqual({ state: "sent", to: "Jane", line: "lights" });
  });

  it("is waiting while the run hasn't gone, and off when no rule texts", async () => {
    serve({ tables: { activity: [event], automation_rules: [rule], automation_runs: [{ status: "pending", error: null, result: [] }] } });
    expect(await ask()).toEqual({ state: "waiting" });
    serve({ tables: { activity: [event], automation_rules: [{ ...rule, enabled: false }] } });
    expect(await ask()).toEqual({ state: "off", why: "off" });
    serve({ tables: {} });
    expect(await ask()).toEqual({ state: "none" });
  });

  it("says why it didn't go: no phone, or they said stop", async () => {
    const failed = { status: "failed", error: "Jane Doe has no phone number.", result: [] };
    serve({ tables: { activity: [event], automation_rules: [rule], automation_runs: [failed], visits: [{ job: { client: { phone: null, sms_opt_out_at: null } }, request: null }] } });
    expect(await ask()).toEqual({ state: "not_sent", why: "no_phone" });
    serve({ tables: { activity: [event], automation_rules: [rule], automation_runs: [{ ...failed, status: "skipped" }], visits: [{ job: { client: { phone: "(470) 555-0101", sms_opt_out_at: "2026-11-01T00:00:00Z" } }, request: null }] } });
    expect(await ask()).toEqual({ state: "not_sent", why: "opted_out" });
    serve({ tables: { activity: [event], automation_rules: [rule], automation_runs: [{ status: "failed", error: "Couldn't reach Quo. Try again.", result: [] }], visits: [{ job: { client: { phone: "(470) 555-0101", sms_opt_out_at: null } }, request: null }] } });
    expect(await ask()).toEqual({ state: "not_sent", why: "other", detail: "Couldn't reach Quo. Try again." });
  });
});
