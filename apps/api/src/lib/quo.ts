/**
 * Quo (formerly OpenPhone): the business's phone system, for texting from its own lines
 * (core/quo.ts says which line and which numbers). Quo's public API, version 2026-03-30:
 * https://www.quo.com/docs. The API key is sent as the Authorization header as it is, with the
 * Quo-Api-Version header on every request.
 *
 * The company connects it on Apps → Quo: its API key and webhook signing key are kept AES-encrypted
 * in integration_secrets (provider "quo"), its lines and test numbers in integrations.settings.
 * In practice mode there's no key and nothing here talks to Quo.
 *
 * Quo signs what it posts to the webhook (Standard Webhooks): HMAC-SHA256 over
 * "{webhook-id}.{webhook-timestamp}.{raw body}" with the key it gave when the webhook was made
 * ("whsec_" + base64), base64 in the webhook-signature header as "v1,<sig>" (several, space separated).
 */
import { quoSettings, type QuoLine, type QuoSettings } from "@crewtavo/core/quo";
import type { Env } from "../env";
import { decryptJson, safeEqual } from "./crypto";
import { reportError } from "./monitoring";
import { adminClient } from "./supabase";

const API = "https://api.quo.com";
const VERSION = "2026-03-30";
const TIMEOUT_MS = 15_000;
const CACHE_MS = 60_000;
/** How far Quo's signing time may be from ours. */
const TOLERANCE_S = 300;

type FetchLike = typeof fetch;

export interface QuoAccount {
  settings: QuoSettings;
  /** Null in practice mode. */
  apiKey: string | null;
  webhookKey: string | null;
  status: string;
}

interface QuoSecret {
  api_key?: string;
  extra?: { webhook_key?: string };
}

const cache = new Map<string, { at: number; value: QuoAccount | null }>();
export const forgetQuo = (companyId?: string) => (companyId ? cache.delete(companyId) : cache.clear());

/** The company's Quo, when it set one up (practice or connected). Cached for a minute. */
export async function companyQuo(env: Env, companyId: string): Promise<QuoAccount | null> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const admin = adminClient(env);
  const [row, secret] = await Promise.all([
    admin.from("integrations").select("provider, status, settings").eq("company_id", companyId).eq("provider", "quo").maybeSingle(),
    admin.from("integration_secrets").select("provider, ciphertext").eq("company_id", companyId).eq("provider", "quo").maybeSingle(),
  ]);
  let value: QuoAccount | null = null;
  if (row.data && row.data.provider === "quo" && row.data.status !== "disconnected") {
    const settings = quoSettings(row.data.settings);
    let kept: QuoSecret = {};
    if (secret.data?.provider === "quo") {
      try {
        kept = await decryptJson<QuoSecret>(env, secret.data.ciphertext);
      } catch (error) {
        reportError(error, { feature: "quo" });
      }
    }
    if (settings.practice || kept.api_key) value = { settings, apiKey: settings.practice ? null : (kept.api_key ?? null), webhookKey: kept.extra?.webhook_key ?? null, status: row.data.status };
  }
  cache.set(companyId, { at: Date.now(), value });
  return value;
}

/** Why Quo can't be used, in words for the person setting it up. */
export class QuoProblem extends Error {}

const headers = (apiKey: string) => ({ Authorization: apiKey, "Quo-Api-Version": VERSION, "Content-Type": "application/json" });

async function call(apiKey: string, path: string, init: RequestInit = {}, fetcher: FetchLike = fetch): Promise<Response | null> {
  return fetcher(`${API}${path}`, { ...init, headers: { ...headers(apiKey), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
}

/** Quo's own words about a refusal, when it gave any. */
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string; title?: string; errors?: Array<{ message?: string }> };
  return body.message ?? body.errors?.[0]?.message ?? body.title ?? "";
}

/** The workspace's lines, read with the key (free), to check it and to pick a line per brand. */
export async function quoLines(apiKey: string, fetcher: FetchLike = fetch): Promise<QuoLine[]> {
  const lines: QuoLine[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const res = await call(apiKey, `/phone-numbers?limit=50${after ? `&after=${encodeURIComponent(after)}` : ""}`, {}, fetcher);
    if (!res) throw new QuoProblem("Couldn't reach Quo to check the key. Try again in a minute.");
    if (res.status === 401 || res.status === 403) throw new QuoProblem("Quo didn't accept that API key. Copy it again from Quo: Settings → API.");
    if (!res.ok) throw new QuoProblem(`Quo couldn't check the key right now (error ${res.status}). Try again in a minute.`);
    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: string; phoneNumber?: string; name?: string }>; nextCursor?: string | null };
    for (const n of body.data ?? []) if (n.id && n.phoneNumber) lines.push({ id: n.id, number: n.phoneNumber, name: n.name || n.phoneNumber });
    after = body.nextCursor ?? null;
    if (!after) break;
  }
  return lines;
}

/** One text from a line. Quo's id for it, or why it wasn't sent. */
export async function postQuoMessage(apiKey: string, line: QuoLine, message: { to: string; body: string }, fetcher: FetchLike = fetch): Promise<{ sent: boolean; id?: string; reason?: string; status?: number }> {
  const res = await call(apiKey, "/messages", { method: "POST", body: JSON.stringify({ from: line.id, to: [message.to], content: message.body }) }, fetcher);
  if (!res) return { sent: false, reason: "Couldn't reach Quo. Try again." };
  if (!res.ok) {
    const words = await refusal(res);
    const why = res.status === 402 ? "Quo's prepaid texting credit has run out (Quo: Settings → Billing)" : res.status === 401 ? "Quo didn't accept the API key" : `Quo refused it (${res.status}${words ? `: ${words}` : ""})`;
    return { sent: false, status: res.status, reason: `${why}.` };
  }
  const body = (await res.json().catch(() => ({}))) as { data?: { id?: string } };
  return { sent: true, id: body.data?.id };
}

/**
 * Asks Quo to post incoming texts (and calls, for later) on these lines to `url`. Quo's id for the
 * webhook and the key it signs with.
 */
export async function createQuoWebhook(apiKey: string, url: string, lineIds: string[], fetcher: FetchLike = fetch): Promise<{ id: string; key: string }> {
  const res = await call(apiKey, "/webhooks", { method: "POST", body: JSON.stringify({ url, events: ["message.received"], resourceIds: lineIds.length ? lineIds : ["*"], label: "Crewtavo (test)" }) }, fetcher);
  if (!res) throw new QuoProblem("Couldn't reach Quo to set that up. Try again in a minute.");
  if (!res.ok) {
    const words = await refusal(res);
    throw new QuoProblem(`Quo couldn't set it up (error ${res.status}${words ? `: ${words}` : ""}).`);
  }
  const body = (await res.json().catch(() => ({}))) as { data?: { id?: string; key?: string } };
  if (!body.data?.id || !body.data.key) throw new QuoProblem("Quo set it up but didn't say how it signs. Try again.");
  return { id: body.data.id, key: body.data.key };
}

/** Removes the webhook from Quo (when Quo is disconnected here). Quietly does nothing when it's already gone. */
export async function deleteQuoWebhook(apiKey: string, id: string, fetcher: FetchLike = fetch): Promise<void> {
  await call(apiKey, `/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" }, fetcher);
}

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

/** The signature Quo puts on a delivery, base64. */
export async function quoSignature(key: string, id: string, timestamp: string, rawBody: string): Promise<string> {
  const secret = fromBase64(key.startsWith("whsec_") ? key.slice("whsec_".length) : key);
  const hmac = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`)));
  return btoa(String.fromCharCode(...mac));
}

/** Whether a delivery was signed by Quo with this key, and recently. */
export async function quoSigned(key: string, h: { id?: string | null; timestamp?: string | null; signature?: string | null }, rawBody: string, now = Date.now()): Promise<boolean> {
  if (!h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > TOLERANCE_S) return false;
  let expected: string;
  try {
    expected = await quoSignature(key, h.id, h.timestamp, rawBody);
  } catch {
    return false;
  }
  return h.signature.split(" ").some((part) => {
    const [v, sig] = part.split(",", 2);
    return v === "v1" && Boolean(sig) && safeEqual(sig!, expected);
  });
}
