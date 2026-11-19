/**
 * Settings → Email's second mailbox, for the Christmas lights brand (routes/email.ts /email/lights):
 * connected like the main one (signs in, sends a real test, then saves it with the app password
 * encrypted), tested through itself, and disconnected, by admins only. The password never comes
 * back to the browser, and the main mailbox is left alone. Stand-ins for the Supabase clients keep
 * what the database was asked; the mail server is a stand-in too; the person's password is taken as right.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encryptJson } from "../src/lib/crypto";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  writes: [] as Array<{ table: string; op: "upsert" | "delete"; row?: Row; filters?: Record<string, unknown> }>,
  smtp: [] as Array<{ settings: Record<string, unknown>; message: Record<string, any> | null }>,
  rpcs: [] as string[],
}));
vi.mock("../src/lib/supabase", () => {
  const client = () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "viewer" } }, error: null }) },
    rpc: async (fn: string) => (state.rpcs.push(fn), { data: fn === "rate_limit_hit" ? true : null, error: null }),
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let deleting = false;
      const rows = () => (state.tables[table] ?? []).filter((row) => Object.entries(filters).every(([k, v]) => row[k] === v));
      const result = () => {
        const found = rows();
        if (deleting) {
          state.writes.push({ table, op: "delete", filters: { ...filters } });
          state.tables[table] = (state.tables[table] ?? []).filter((row) => !found.includes(row));
        }
        return { data: found, error: null };
      };
      const builder: Record<string, unknown> = {
        eq: (column: string, value: unknown) => ((filters[column] = value), chain),
        upsert: (row: Row) => (state.writes.push({ table, op: "upsert", row }), chain),
        delete: () => ((deleting = true), chain),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      // Anything else the route chains on (select, order, insert...) changes nothing here.
      const chain: Record<string, unknown> = new Proxy(builder, { get: (target, key) => (key in target ? target[key as string] : () => chain) });
      return chain;
    },
  });
  const user = client();
  const admin = client();
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
vi.mock("../src/lib/auth", async (original) => ({
  ...(await original<typeof import("../src/lib/auth")>()),
  confirmPassword: async () => ({ email: "will@oe.test", full_name: "Will Owner" }),
}));
vi.mock("../src/lib/smtp", async (original) => ({
  ...(await original<typeof import("../src/lib/smtp")>()),
  smtpSend: async (settings: Record<string, unknown>, message: Record<string, any> | null) => {
    state.smtp.push({ settings, message });
    return { id: message ? "<1@example.test>" : "" };
  },
}));
const { app } = await import("../src/app");

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
} as Env;
const CO = "00000000-0000-4000-8000-0000000000e1";
/** An obvious stand-in for a Gmail app password. */
const APP_PASSWORD = "fakeapppass0000";
const SETTINGS = { big_proposal: { brands: { lights: { name: "Outdoor Expert Lighting LLC." } } } };

function seed(role = "owner", extra: Record<string, Row[]> = {}) {
  state.tables = {
    profiles: [{ user_id: "viewer", email: "will@oe.test", full_name: "Will Owner", phone: null }],
    memberships: [{ company_id: CO, user_id: "viewer", active: true, role, role_id: null, company: { id: CO, name: "Outdoor Expert Cleaners LLC", slug: "oe", trade_preset: "cleaning", timezone: "America/New_York", settings: SETTINGS } }],
    companies: [{ id: CO, name: "Outdoor Expert Cleaners LLC", email: "office@oe.test", settings: SETTINGS, trade_preset: "cleaning" }],
    integrations: [{ company_id: CO, provider: "email", status: "connected", settings: { preset: "gmail", kind: "smtp", host: "smtp.gmail.com", port: 465, security: "tls", username: "wash@oe.test", from_email: "wash@oe.test", from_name: null }, last_error: null, connected_at: null, account_label: "wash@oe.test" }],
    integration_secrets: [],
    ...extra,
  };
  vi.stubGlobal("fetch", async () => Response.json([]));
}

const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, { method, headers: { Authorization: "Bearer token", "X-Company-Id": CO, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }, env);

async function lightsConnected() {
  return {
    integrations: [
      ...state.tables.integrations!,
      { company_id: CO, provider: "email_lights", status: "connected", settings: { preset: "gmail", kind: "smtp", host: "smtp.gmail.com", port: 465, security: "tls", username: "lights@oe.test", from_email: "lights@oe.test", from_name: null }, last_error: null, connected_at: null, account_label: "lights@oe.test" },
    ],
    integration_secrets: [{ company_id: CO, provider: "email_lights", ciphertext: await encryptJson(env, { password: APP_PASSWORD }) }],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  state.tables = {};
  state.writes = [];
  state.smtp = [];
  state.rpcs = [];
});

describe("connecting the Christmas lights mailbox", () => {
  const connect = () => call("PUT", "/email/lights", { preset: "gmail", from_email: "lights@oe.test", password: "fake app pass 0000", current_password: "hunter2hunter2" });

  it("signs in, sends its test from the brand's name, and saves it apart from the main mailbox, the password encrypted", async () => {
    seed();
    const res = await connect();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(APP_PASSWORD);
    expect(JSON.parse(text)).toEqual({ connected: true, test_sent_to: "will@oe.test" });
    // The sign-in check, then the test, with the spaces Google shows taken out of the app password.
    expect(state.smtp.map((s) => [s.settings.username, s.settings.password, s.message?.from ?? null])).toEqual([
      ["lights@oe.test", APP_PASSWORD, null],
      ["lights@oe.test", APP_PASSWORD, { name: "Outdoor Expert Lighting", email: "lights@oe.test" }],
    ]);
    expect(state.smtp[1]!.message!.replyTo).toBe("lights@oe.test");
    expect(state.writes.map((w) => [w.table, w.op, w.row?.provider])).toEqual([["integrations", "upsert", "email_lights"], ["integration_secrets", "upsert", "email_lights"]]);
    const saved = state.writes[1]!.row!;
    expect(String(saved.ciphertext)).not.toContain(APP_PASSWORD);
    expect(JSON.stringify(state.writes[0]!.row)).not.toContain(APP_PASSWORD);
    // The bell's "emails aren't going out" is about the main sender: connecting this one doesn't clear it.
    expect(state.rpcs).not.toContain("note_sending");
  });

  it("is for admins only", async () => {
    seed("office");
    expect((await connect()).status).toBe(403);
    expect((await call("DELETE", "/email/lights", { current_password: "hunter2hunter2" })).status).toBe(403);
    expect((await call("POST", "/email/lights/test", {})).status).toBe(403);
    expect(state.writes).toEqual([]);
    expect(state.smtp).toEqual([]);
  });
});

describe("the lights mailbox on Settings → Email", () => {
  it("is shown with the brand's name, never its password", async () => {
    seed("owner");
    Object.assign(state.tables, await lightsConnected());
    const res = await call("GET", "/email");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(APP_PASSWORD);
    expect(text).not.toContain("ciphertext");
    const body = JSON.parse(text);
    expect(body.lights).toMatchObject({ from_email: "lights@oe.test", status: "connected" });
    expect(body.lights).not.toHaveProperty("password");
    expect(body.lights_name).toBe("Outdoor Expert Lighting");
    expect(body.mailbox).toMatchObject({ from_email: "wash@oe.test" });
  });

  it("sends its test through itself, and refuses when it isn't connected", async () => {
    seed();
    const missing = await call("POST", "/email/lights/test", {});
    expect(missing.status).toBe(400);
    expect(state.smtp).toEqual([]);
    Object.assign(state.tables, await lightsConnected());
    const res = await call("POST", "/email/lights/test", {});
    expect(res.status).toBe(200);
    expect(state.smtp.map((s) => [s.settings.username, s.message?.from])).toEqual([["lights@oe.test", { name: "Outdoor Expert Lighting", email: "lights@oe.test" }]]);
  });

  it("disconnects only the lights mailbox", async () => {
    seed();
    Object.assign(state.tables, await lightsConnected());
    const res = await call("DELETE", "/email/lights", { current_password: "hunter2hunter2" });
    expect(res.status).toBe(200);
    expect(state.writes).toEqual([{ table: "integrations", op: "delete", filters: { company_id: CO, provider: "email_lights" } }]);
    expect(state.tables.integrations!.map((r) => r.provider)).toEqual(["email"]);
  });
});
