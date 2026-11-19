/**
 * The Quo line a client's text goes from (lib/notify.ts sendSms with `brand`, services/brand.ts
 * brandFor): a quote or invoice sent by text (services/sales.ts deliver) goes from the line for its
 * brand, so a Christmas lights client hears from the lighting line, and the line it went out on is
 * kept on the timeline (messages.line) so Messages shows it under that inbox. Texts to the office and
 * to subs (notifications, sign-in codes, sub offers) never name a brand: they stay on the wash line.
 * The database is a stand-in that answers each table's query, and the texter keeps what it was given
 * and answers from the line for the brand, as Quo does.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Db } from "../src/lib/supabase";
import { deliver, sendSchema } from "../src/services/sales";

const texts = vi.hoisted(() => [] as Array<{ to: string; body: string; brand?: "washing" | "lights" | null }>);
vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  sendEmail: async () => ({ sent: true, id: "email-1" }),
  sendSms: async (_env: Env, message: { to: string; body: string; brand?: "washing" | "lights" | null }) => {
    texts.push(message);
    return { sent: true, id: `SM${texts.length}`, line: message.brand ?? "washing" };
  },
}));
vi.mock("../src/integrations/stripe", async (original) => ({ ...(await original<typeof import("../src/integrations/stripe")>()), stripeAccess: async () => null }));
const server = vi.hoisted(() => ({ tables: {} as Record<string, unknown> }));
vi.mock("../src/lib/supabase", async (original) => ({ ...(await original<typeof import("../src/lib/supabase")>()), adminClient: () => stubDb(server.tables) }));
vi.mock("../src/lib/links", async (original) => ({
  ...(await original<typeof import("../src/lib/links")>()),
  clientLinks: async (_env: Env, baseUrl: string, link: { id: string }) => ({ own: `${baseUrl}/own/${link.id}`, office: `${baseUrl}/office/${link.id}` }),
}));

const CO = "00000000-0000-4000-8000-0000000000a1";
const env = { SUPABASE_URL: "http://db.test", SUPABASE_SECRET_KEY: "test" } as Env;
const company = { name: "Outdoor Expert Cleaners", currency: "USD", email: null, phone: null, address: {}, settings: {} };
const client = { id: "client-1", display_name: "Jane Doe", email: "jane@example.com", phone: "(470) 555-0101", sms_opt_out_at: null };
const quote = { id: "quote-1", number: 12, client_id: "client-1", total: 1200, client };
const invoice = { id: "inv-1", number: 7, client_id: "client-1", total: 1200, balance_due: 1200, client };
const logged: Array<Record<string, unknown>> = [];

/** Answers each table with its rows, whatever the filters. */
function stubDb(tables: Record<string, unknown>): Db {
  const from = (table: string) => {
    const result = { data: tables[table] ?? null, error: null };
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "in", "is", "order", "limit", "update", "upsert"]) builder[name] = () => builder;
    builder.insert = (row: unknown) => {
      if (table === "messages") logged.push(row as Record<string, unknown>);
      return builder;
    };
    builder.maybeSingle = builder.single = () => Promise.resolve(result);
    builder.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
    return builder;
  };
  return { from } as unknown as Db;
}
const scope = () => ({ db: stubDb({ companies: company, clients: client }), env, companyId: CO, baseUrl: "https://ops.example.com" });

afterEach(() => {
  texts.length = logged.length = 0;
  server.tables = {};
});

describe("a quote sent by text", () => {
  it("goes from the lighting line when it's a Christmas lights quote, and is kept under that line", async () => {
    server.tables = { quotes: { brand: "lights", lines: [{ name: "Roofline lighting" }] } };
    const result = await deliver(scope(), "quote", quote, sendSchema.parse({ channel: "sms" }));
    expect(result).toMatchObject({ sent: true, sent_to: ["(470) 555-0101"] });
    expect(texts.map((t) => [t.to, t.brand])).toEqual([["(470) 555-0101", "lights"]]);
    expect(logged).toEqual([expect.objectContaining({ channel: "sms", related_type: "quote", related_id: "quote-1", line: "lights" })]);
  });

  it("goes from the wash line when it's a washing quote", async () => {
    server.tables = { quotes: { brand: null, lines: [{ name: "House Washing" }] } };
    await deliver(scope(), "quote", quote, sendSchema.parse({ channel: "sms" }));
    expect(texts.map((t) => t.brand)).toEqual(["washing"]);
    expect(logged[0]).toMatchObject({ line: "washing" });
  });

  it("keeps no line on an email", async () => {
    server.tables = { quotes: { brand: "lights", lines: [] } };
    expect(await deliver(scope(), "quote", quote, sendSchema.parse({ channel: "email" }))).toMatchObject({ sent: true });
    expect(texts).toEqual([]);
    expect(logged).toEqual([expect.objectContaining({ channel: "email", line: null })]);
  });
});

describe("an invoice sent by text", () => {
  it("for a Christmas lights job goes from the lighting line, though the job has no quote", async () => {
    server.tables = { invoices: { job: { quote: null, lines: [{ name: "Roofline lighting" }] }, lines: [{ name: "Roofline lighting" }] } };
    await deliver(scope(), "invoice", invoice, sendSchema.parse({ channel: "sms" }));
    expect(texts.map((t) => t.brand)).toEqual(["lights"]);
    expect(logged).toEqual([expect.objectContaining({ channel: "sms", related_type: "invoice", line: "lights" })]);
  });

  it("for a job from a Christmas lights quote goes from the lighting line", async () => {
    server.tables = { invoices: { job: { quote: { brand: "lights", lines: [] }, lines: [] }, lines: [{ name: "Install" }] } };
    await deliver(scope(), "invoice", invoice, sendSchema.parse({ channel: "sms" }));
    expect(texts.map((t) => t.brand)).toEqual(["lights"]);
  });

  it("for a washing job goes from the wash line", async () => {
    server.tables = { invoices: { job: { quote: null, lines: [{ name: "Driveway Cleaning" }] }, lines: [{ name: "Driveway Cleaning" }] } };
    await deliver(scope(), "invoice", invoice, sendSchema.parse({ channel: "sms" }));
    expect(texts.map((t) => t.brand)).toEqual(["washing"]);
    expect(logged[0]).toMatchObject({ line: "washing" });
  });
});

describe("texts to the office and to subs", () => {
  // Notifications to the team, sign-in codes and subs' offers and invites aren't about a client's
  // brand: they never name one, so they go from the wash line (the business's main number).
  const office = ["delivery.ts", "signInCodes.ts", "subs.ts", "subAccess.ts"];

  it.each(office)("%s never names a brand", (file) => {
    const source = readFileSync(new URL(`../src/services/${file}`, import.meta.url), "utf8");
    const calls = source.match(/sendSms\([^;]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).not.toMatch(/\bbrand\b/);
  });
});
