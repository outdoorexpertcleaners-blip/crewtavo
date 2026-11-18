/**
 * Quo (lib/quo.ts, routes/quo.ts): texts go from the brand's line, only to test numbers while it's
 * test only, and nowhere at all in practice mode; Quo's webhook signature is checked. fetch is
 * stubbed: the database answers from the rows each test gives, and Quo's API records what it's sent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encryptJson } from "../src/lib/crypto";
import { sendSms } from "../src/lib/notify";
import { forgetQuo, quoSignature, quoSigned } from "../src/lib/quo";

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

type Row = Record<string, any>;
const wash = { id: "PNwash", number: "+14044349990", name: "Main Wash Line" };
const lights = { id: "PNlights", number: "+14703007296", name: "Main Lighting Line" };

function serve(rows: { integrations: Row[]; integration_secrets: Row[] }) {
  const quo: Array<{ path: string; body: any; headers: Headers }> = [];
  let twilio = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host === "api.quo.com") {
      quo.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) });
      return Response.json({ data: { id: "AC-sent" } }, { status: 202 });
    }
    if (url.host === "api.twilio.com") {
      twilio++;
      return Response.json({ sid: "SM1" });
    }
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    if (path.startsWith("rpc/")) return Response.json(null);
    const eq = (k: string) => url.searchParams.get(k)?.replace("eq.", "");
    const found = ((rows as Record<string, Row[]>)[path] ?? []).filter((r) => r.company_id === eq("company_id") && (!eq("provider") || r.provider === eq("provider")));
    return new Headers(init?.headers).get("accept")?.includes("vnd.pgrst.object") ? (found[0] ? Response.json(found[0]) : Response.json({ code: "PGRST116", message: "no rows" }, { status: 406 })) : Response.json(found);
  });
  return { quo, twilio: () => twilio };
}

async function withQuo(settings: Row, apiKey: string | null = "quo-key") {
  const co = crypto.randomUUID();
  forgetQuo(co);
  return {
    co,
    rows: {
      integrations: [{ company_id: co, provider: "quo", status: "connected", settings }],
      integration_secrets: apiKey ? [{ company_id: co, provider: "quo", ciphertext: await encryptJson(env, { api_key: apiKey }) }] : [],
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("a text through Quo", () => {
  it("goes from the brand's line, with the key and API version", async () => {
    const { co, rows } = await withQuo({ test_numbers: ["+14705550101"], lines: { washing: wash, lights } });
    const { quo, twilio } = serve(rows);
    expect(await sendSms(env, { to: "(470) 555-0101", body: "Your lights quote", brand: "lights" }, co)).toEqual({ sent: true, id: "AC-sent", line: "lights" });
    expect(quo).toHaveLength(1);
    expect(quo[0]!.path).toBe("/messages");
    expect(quo[0]!.body).toEqual({ from: "PNlights", to: ["+14705550101"], content: "Your lights quote" });
    expect(quo[0]!.headers.get("authorization")).toBe("quo-key");
    expect(quo[0]!.headers.get("quo-api-version")).toBe("2026-03-30");
    expect(twilio()).toBe(0);
  });

  it("isn't sent at all to a number that isn't a test number", async () => {
    const { co, rows } = await withQuo({ test_numbers: ["+14705550101"], lines: { washing: wash } });
    const { quo, twilio } = serve(rows);
    const result = await sendSms(env, { to: "+14045551234", body: "Hi" }, co);
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/test mode/);
    expect(quo).toHaveLength(0);
    expect(twilio()).toBe(0);
  });

  it("never leaves Crewtavo in practice mode", async () => {
    const { co, rows } = await withQuo({ practice: true, test_numbers: ["+14705550101"], lines: { washing: { id: "practice-washing", number: "", name: "Wash line (practice)" } } }, null);
    const { quo, twilio } = serve(rows);
    const result = await sendSms(env, { to: "+14705550101", body: "Hi" }, co);
    expect(result.sent).toBe(true);
    expect(result.id).toMatch(/^practice-/);
    expect(quo).toHaveLength(0);
    expect(twilio()).toBe(0);
  });

  it("is left to Twilio when the company has no Quo", async () => {
    const co = crypto.randomUUID();
    const { quo, twilio } = serve({ integrations: [], integration_secrets: [] });
    expect((await sendSms(env, { to: "+14045551234", body: "Hi" }, co)).sent).toBe(true);
    expect(quo).toHaveLength(0);
    expect(twilio()).toBe(1);
  });
});

describe("Quo's webhook signature", () => {
  const key = `whsec_${btoa("a signing key of some length")}`;
  const body = JSON.stringify({ type: "message.received" });
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);

  it("is accepted when Quo signed it recently", async () => {
    const sig = await quoSignature(key, "msg_1", ts, body);
    expect(await quoSigned(key, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, body, now)).toBe(true);
    expect(await quoSigned(key, { id: "msg_1", timestamp: ts, signature: `v1,bm9wZQ== v1,${sig}` }, body, now)).toBe(true);
  });

  it("is refused when anything differs, is missing, or is old", async () => {
    const sig = await quoSignature(key, "msg_1", ts, body);
    expect(await quoSigned(key, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, `${body} `, now)).toBe(false);
    expect(await quoSigned(key, { id: "msg_2", timestamp: ts, signature: `v1,${sig}` }, body, now)).toBe(false);
    expect(await quoSigned(`whsec_${btoa("another key")}`, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, body, now)).toBe(false);
    expect(await quoSigned(key, { id: "msg_1", timestamp: ts, signature: `v2,${sig}` }, body, now)).toBe(false);
    expect(await quoSigned(key, { id: "msg_1", timestamp: ts, signature: null }, body, now)).toBe(false);
    expect(await quoSigned(key, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, body, now + 10 * 60_000)).toBe(false);
  });
});
