/**
 * The second brand's mailbox (lib/notify.ts sendEmail, LIGHTS_MAILBOX): a client's email about
 * Christmas lights goes from the lights mailbox when one is connected, under the brand's name and
 * with replies to that mailbox. Everything else (washing, or no brand: invites, codes, notices), and
 * lights emails while it isn't connected, go from the main sender. A lights mailbox whose sign-in is
 * refused hands the email to the main sender and shows on Settings → Email.
 * fetch is stubbed: Resend answers, and the database is a few tables filtered by every eq.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encryptJson } from "../src/lib/crypto";
import { LIGHTS_MAILBOX, MAIN_MAILBOX, sendEmail } from "../src/lib/notify";
import type { Db } from "../src/lib/supabase";
import { brandFor } from "../src/services/brand";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
};

type Row = Record<string, any>;
/** Fake keys only: Resend is stubbed. */
const MAIN_KEY = "re_fake_main";
const LIGHTS_KEY = "re_fake_lights";

interface Sent { key: string; from: string; reply_to?: string; to: string[] }

async function world(co: string, options: { lights?: boolean; lightsName?: string | null; lightsRefuses?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    companies: [{ id: co, name: "Outdoor Expert Cleaners LLC", settings: { big_proposal: { brands: { lights: { name: "Outdoor Expert Lighting LLC." } } } } }],
    integrations: [{ company_id: co, provider: MAIN_MAILBOX, status: "connected", settings: { preset: "resend", kind: "resend", from_email: "wash@example.test", from_name: null } }],
    integration_secrets: [{ company_id: co, provider: MAIN_MAILBOX, ciphertext: await encryptJson(env, { api_key: MAIN_KEY }) }],
  };
  if (options.lights) {
    tables.integrations!.push({ company_id: co, provider: LIGHTS_MAILBOX, status: "connected", settings: { preset: "resend", kind: "resend", from_email: "lights@example.test", from_name: options.lightsName ?? null } });
    tables.integration_secrets!.push({ company_id: co, provider: LIGHTS_MAILBOX, ciphertext: await encryptJson(env, { api_key: LIGHTS_KEY }) });
  }
  const sent: Sent[] = [];
  const updates: Array<{ path: string; filters: Record<string, string>; body: Row }> = [];
  const rpcs: Array<{ path: string; body: Row }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    if (url.host === "api.resend.com") {
      const key = new Headers(init?.headers).get("authorization")!.replace("Bearer ", "");
      sent.push({ key, from: body.from, reply_to: body.reply_to, to: body.to });
      if (key === LIGHTS_KEY && options.lightsRefuses) return Response.json({ message: "API key is invalid" }, { status: 401 });
      return Response.json({ id: `email-${sent.length}` });
    }
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    if (path.startsWith("rpc/")) {
      rpcs.push({ path, body });
      return Response.json(null);
    }
    const filters: Record<string, string> = {};
    for (const [k, v] of url.searchParams) if (v.startsWith("eq.")) filters[k] = v.slice(3);
    const rows = (tables[path] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => String(r[k]) === v));
    if ((init?.method ?? "GET") === "PATCH") {
      updates.push({ path, filters, body });
      for (const r of rows) Object.assign(r, body);
    }
    return new Headers(init?.headers).get("accept")?.includes("vnd.pgrst.object") ? (rows[0] ? Response.json(rows[0]) : Response.json({ code: "PGRST116", message: "no rows" }, { status: 406 })) : Response.json(rows);
  });
  return { sent, updates, tables, rpcs };
}

const message = { to: "ann@client.test", subject: "Your quote", text: "Here it is.", replyTo: "office@example.test", fromName: "Outdoor Expert Cleaners LLC" };

afterEach(() => vi.unstubAllGlobals());

describe("which mailbox a client's email goes from", () => {
  it("a Christmas lights email goes from the lights mailbox, under the brand's name, with replies to it", async () => {
    const co = crypto.randomUUID();
    const { sent } = await world(co, { lights: true });
    expect(await sendEmail(env, { ...message, brand: "lights" }, co)).toMatchObject({ sent: true });
    expect(sent).toEqual([{ key: LIGHTS_KEY, from: '"Outdoor Expert Lighting" <lights@example.test>', reply_to: "lights@example.test", to: ["ann@client.test"] }]);
  });

  it("uses the sender name typed for the lights mailbox over the brand's", async () => {
    const co = crypto.randomUUID();
    const { sent } = await world(co, { lights: true, lightsName: "OE Lighting" });
    await sendEmail(env, { ...message, brand: "lights" }, co);
    expect(sent[0]).toMatchObject({ key: LIGHTS_KEY, from: '"OE Lighting" <lights@example.test>' });
  });

  it("a Christmas lights email goes from the main sender while the lights mailbox isn't connected", async () => {
    const co = crypto.randomUUID();
    const { sent } = await world(co);
    expect(await sendEmail(env, { ...message, brand: "lights" }, co)).toMatchObject({ sent: true });
    expect(sent).toEqual([{ key: MAIN_KEY, from: '"Outdoor Expert Cleaners LLC" <wash@example.test>', reply_to: "office@example.test", to: ["ann@client.test"] }]);
  });

  it("washing, and emails with no brand (invites, codes, office notices), stay on the main sender", async () => {
    const co = crypto.randomUUID();
    const { sent } = await world(co, { lights: true });
    await sendEmail(env, { ...message, brand: "washing" }, co);
    await sendEmail(env, message, co);
    await sendEmail(env, { ...message, brand: null }, co);
    expect(sent.map((s) => [s.key, s.reply_to])).toEqual([[MAIN_KEY, "office@example.test"], [MAIN_KEY, "office@example.test"], [MAIN_KEY, "office@example.test"]]);
  });

  it("a lights mailbox whose sign-in is refused hands the email to the main sender, and shows on Settings", async () => {
    const co = crypto.randomUUID();
    const { sent, updates } = await world(co, { lights: true, lightsRefuses: true });
    expect(await sendEmail(env, { ...message, brand: "lights" }, co)).toMatchObject({ sent: true });
    expect(sent.map((s) => s.key)).toEqual([LIGHTS_KEY, MAIN_KEY]);
    expect(updates).toEqual([{ path: "integrations", filters: { company_id: co, provider: LIGHTS_MAILBOX }, body: expect.objectContaining({ status: "error" }) }]);
  });

  it("Settings' test of the lights mailbox never goes from the main sender", async () => {
    const co = crypto.randomUUID();
    const { sent } = await world(co);
    expect(await sendEmail(env, { ...message, brand: "lights" }, co, { only: true })).toMatchObject({ sent: false });
    const refused = crypto.randomUUID();
    const second = await world(refused, { lights: true, lightsRefuses: true });
    expect(await sendEmail(env, { ...message, brand: "lights" }, refused, { only: true })).toMatchObject({ sent: false });
    expect([...sent, ...second.sent].map((s) => s.key)).toEqual([LIGHTS_KEY]);
  });
});

describe("the bell's \"emails aren't going out\" (note_sending) is about the main sender", () => {
  it("a lights email that went doesn't clear it, and a refused lights sign-in doesn't raise it", async () => {
    const co = crypto.randomUUID();
    const { rpcs } = await world(co, { lights: true });
    await sendEmail(env, { ...message, brand: "lights" }, co);
    expect(rpcs).toEqual([]);
    const refused = crypto.randomUUID();
    const second = await world(refused, { lights: true, lightsRefuses: true });
    await sendEmail(env, { ...message, brand: "lights" }, refused, { only: true });
    expect(second.rpcs).toEqual([]);
  });

  it("the main sender taking a refused lights email reports how the main sender did", async () => {
    const co = crypto.randomUUID();
    const { rpcs } = await world(co, { lights: true, lightsRefuses: true });
    await sendEmail(env, { ...message, brand: "lights" }, co);
    expect(rpcs).toEqual([{ path: "rpc/note_sending", body: expect.objectContaining({ p_company: co, p_ok: true }) }]);
  });
});

describe("which brand an invoice or job is about (services/brand.ts brandFor)", () => {
  /** A stand-in database: each table answers the one row given, and quotes the client's latest. */
  const db = (rows: Record<string, unknown>) =>
    ({
      from: (table: string) => {
        const chain: Record<string, unknown> = new Proxy({}, { get: (_, key) => (key === "maybeSingle" ? async () => ({ data: rows[table] ?? null, error: null }) : () => chain) });
        return chain;
      },
    }) as unknown as Db;
  const lightsQuote = { brand: null, lines: [{ name: "Christmas lights install" }] };
  const washQuote = { brand: null, lines: [{ name: "House Washing" }] };

  it("an invoice: its job's quote, else Christmas lights lines, else washing for any other lines", async () => {
    expect(await brandFor(db({ invoices: { job: { quote: lightsQuote, lines: [] }, lines: [{ name: "Install" }] } }), "co", { subject: "invoice", id: "i1" })).toBe("lights");
    expect(await brandFor(db({ invoices: { job: null, lines: [{ name: "Christmas lights takedown" }] } }), "co", { subject: "invoice", id: "i1" })).toBe("lights");
    expect(await brandFor(db({ invoices: { job: null, lines: [{ name: "House Washing" }] }, quotes: lightsQuote }), "co", { subject: "invoice", id: "i1", clientId: "c1" })).toBe("washing");
    // Nothing on it says: the client's latest quote.
    expect(await brandFor(db({ invoices: { job: null, lines: [] }, quotes: lightsQuote }), "co", { subject: "invoice", id: "i1", clientId: "c1" })).toBe("lights");
  });

  it("a job: its quote, else Christmas lights lines, else the client's latest quote", async () => {
    expect(await brandFor(db({ jobs: { quote: washQuote, lines: [] }, quotes: lightsQuote }), "co", { subject: "job", id: "j1", clientId: "c1" })).toBe("washing");
    expect(await brandFor(db({ jobs: { quote: null, lines: [{ name: "Christmas lights install" }] } }), "co", { subject: "job", id: "j1" })).toBe("lights");
    expect(await brandFor(db({ jobs: { quote: null, lines: [{ name: "Gutter cleaning" }] }, quotes: lightsQuote }), "co", { subject: "job", id: "j1", clientId: "c1" })).toBe("lights");
  });
});
