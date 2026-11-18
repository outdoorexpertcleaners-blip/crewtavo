/**
 * Square's public API (https://developer.squareup.com/reference/square), for invoice payments
 * (core/square.ts, services/square.ts). The business connects its own Square account on Apps →
 * Square with an access token from Square's Developer Dashboard, Sandbox or Production. The token
 * and the webhook's signature key are kept AES-encrypted in integration_secrets (provider
 * "square"), the environment and location in integrations.settings.
 *
 * Square signs each webhook delivery: base64 HMAC-SHA256, keyed with the subscription's signature
 * key, over the notification URL followed by the raw body, in x-square-hmacsha256-signature.
 */
import { squareApiBase, squareSettings, type SquareEnvironment, type SquarePayment, type SquareSettings } from "@crewtavo/core/square";
import type { Env } from "../env";
import { decryptJson, safeEqual } from "./crypto";
import { reportError } from "./monitoring";
import { adminClient } from "./supabase";

const VERSION = "2025-01-23";
const TIMEOUT_MS = 15_000;
const CACHE_MS = 60_000;

type FetchLike = typeof fetch;

export interface SquareAccount {
  settings: SquareSettings;
  token: string;
  webhookKey: string | null;
}

interface SquareSecret {
  api_key?: string;
  extra?: { webhook_key?: string };
}

const cache = new Map<string, { at: number; value: SquareAccount | null }>();
export const forgetSquare = (companyId?: string) => (companyId ? cache.delete(companyId) : cache.clear());

/** The company's connected Square account (with a location picked), or null. Cached for a minute. */
export async function companySquare(env: Env, companyId: string): Promise<SquareAccount | null> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const admin = adminClient(env);
  const [row, secret] = await Promise.all([
    admin.from("integrations").select("provider, status, settings").eq("company_id", companyId).eq("provider", "square").maybeSingle(),
    admin.from("integration_secrets").select("provider, ciphertext").eq("company_id", companyId).eq("provider", "square").maybeSingle(),
  ]);
  let value: SquareAccount | null = null;
  if (row.data?.provider === "square" && row.data.status === "connected" && secret.data?.provider === "square") {
    try {
      const kept = await decryptJson<SquareSecret>(env, secret.data.ciphertext);
      const settings = squareSettings(row.data.settings);
      if (kept.api_key && settings.location_id) value = { settings, token: kept.api_key, webhookKey: kept.extra?.webhook_key ?? null };
    } catch (error) {
      reportError(error, { feature: "square" });
    }
  }
  cache.set(companyId, { at: Date.now(), value });
  return value;
}

/** Why Square can't do something, in words for the person using it. */
export class SquareProblem extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

interface Call {
  environment: SquareEnvironment;
  token: string;
  fetcher?: FetchLike;
}

async function call<T>(s: Call, method: string, path: string, body?: unknown): Promise<T> {
  const res = await (s.fetcher ?? fetch)(`${squareApiBase(s.environment)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${s.token}`, "Square-Version": VERSION, "Content-Type": "application/json", Accept: "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!res) throw new SquareProblem("Couldn't reach Square. Try again in a minute.");
  const json = (await res.json().catch(() => ({}))) as T & { errors?: Array<{ detail?: string; code?: string }> };
  if (!res.ok) {
    if (res.status === 401) throw new SquareProblem(`Square didn't accept the access token. Copy the ${s.environment === "sandbox" ? "Sandbox" : "Production"} access token again from Square's Developer Dashboard.`, 401);
    const words = json.errors?.[0]?.detail ?? json.errors?.[0]?.code ?? "";
    throw new SquareProblem(`Square refused it (error ${res.status}${words ? `: ${words}` : ""}).`, res.status);
  }
  return json;
}

export interface SquareLocation {
  id: string;
  name: string;
  currency: string | null;
}

/** The account's active locations, read with the token (to check it, and to pick where payments go). */
export async function squareLocations(s: Call): Promise<SquareLocation[]> {
  const body = await call<{ locations?: Array<{ id?: string; name?: string; status?: string; currency?: string }> }>(s, "GET", "/v2/locations");
  return (body.locations ?? []).filter((l) => l.id && l.status !== "INACTIVE").map((l) => ({ id: l.id!, name: l.name || l.id!, currency: l.currency ?? null }));
}

export interface SquareLink {
  id: string;
  url: string;
  order_id: string;
}

/**
 * A Square checkout page for one invoice: a line for the invoice and one for the tip the client
 * chose, the invoice's ids on the order, and back to the invoice page when they're done.
 */
export async function createSquareLink(
  s: Call & { locationId: string },
  input: { key: string; invoiceId: string; companyId: string; number: string; amountCents: number; tipCents: number; currency: string; returnUrl: string; email?: string | null },
): Promise<SquareLink> {
  const money = (amount: number) => ({ amount, currency: input.currency });
  const body = await call<{ payment_link?: { id?: string; url?: string; order_id?: string } }>(s, "POST", "/v2/online-checkout/payment-links", {
    idempotency_key: input.key,
    order: {
      location_id: s.locationId,
      reference_id: input.invoiceId,
      line_items: [
        { name: `Invoice #${input.number}`, quantity: "1", base_price_money: money(input.amountCents) },
        ...(input.tipCents > 0 ? [{ name: "Tip", quantity: "1", base_price_money: money(input.tipCents) }] : []),
      ],
      metadata: { crewtavo_invoice_id: input.invoiceId, crewtavo_company_id: input.companyId, tip_cents: String(input.tipCents) },
    },
    checkout_options: { redirect_url: input.returnUrl, ask_for_shipping_address: false, allow_tipping: false },
    ...(input.email ? { pre_populated_data: { buyer_email: input.email } } : {}),
  });
  const link = body.payment_link;
  if (!link?.id || !link.url || !link.order_id) throw new SquareProblem("Square made the payment page but didn't say where it is. Try again.");
  return { id: link.id, url: link.url, order_id: link.order_id };
}

/** Takes a checkout page down, so an old amount can't be paid. Quietly does nothing when it's gone. */
export async function deleteSquareLink(s: Call, id: string): Promise<void> {
  await call(s, "DELETE", `/v2/online-checkout/payment-links/${encodeURIComponent(id)}`).catch((error) => {
    if (!(error instanceof SquareProblem && error.status === 404)) throw error;
  });
}

/** The payments on an order (a checkout page's), as Square has them now. */
export async function squareOrderPayments(s: Call, orderId: string): Promise<SquarePayment[]> {
  const body = await call<{ order?: { tenders?: Array<{ payment_id?: string; id?: string }> } }>(s, "GET", `/v2/orders/${encodeURIComponent(orderId)}`);
  const ids = (body.order?.tenders ?? []).map((t) => t.payment_id ?? t.id).filter((id): id is string => Boolean(id));
  return Promise.all(ids.map((id) => squarePayment(s, id)));
}

export async function squarePayment(s: Call, id: string): Promise<SquarePayment> {
  const body = await call<{ payment?: SquarePayment }>(s, "GET", `/v2/payments/${encodeURIComponent(id)}`);
  if (!body.payment?.id) throw new SquareProblem("Square didn't find that payment.", 404);
  return body.payment;
}

/** Asks Square to post payment changes to `url`. Square's id for the subscription and the key it signs with. */
export async function createSquareWebhook(s: Call, url: string): Promise<{ id: string; key: string }> {
  const body = await call<{ subscription?: { id?: string; signature_key?: string } }>(s, "POST", "/v2/webhooks/subscriptions", {
    idempotency_key: crypto.randomUUID(),
    subscription: { name: "Outdoor Expert app (payments)", event_types: ["payment.created", "payment.updated"], notification_url: url, api_version: VERSION },
  });
  if (!body.subscription?.id || !body.subscription.signature_key) throw new SquareProblem("Square set it up but didn't say how it signs. Try again.");
  return { id: body.subscription.id, key: body.subscription.signature_key };
}

export async function deleteSquareWebhook(s: Call, id: string): Promise<void> {
  await call(s, "DELETE", `/v2/webhooks/subscriptions/${encodeURIComponent(id)}`).catch(() => undefined);
}

/** The signature Square puts on a delivery to `url`, base64. */
export async function squareSignature(key: string, url: string, rawBody: string): Promise<string> {
  const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(url + rawBody)));
  return btoa(String.fromCharCode(...mac));
}

/** Whether a delivery to `url` was signed by Square with this key. */
export async function squareSigned(key: string, url: string, signature: string | null | undefined, rawBody: string): Promise<boolean> {
  if (!signature) return false;
  return safeEqual(signature, await squareSignature(key, url, rawBody));
}
