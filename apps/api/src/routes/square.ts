/**
 * Square on Apps → Square (lib/square.ts, services/square.ts): connecting the business's Square
 * account (Sandbox or Production access token, and the location payments go to), asking Square to
 * tell us about payments, and the webhook it posts them to. Clients pay from the invoice page's Pay
 * button (routes/public.ts).
 */
import { ADMINS } from "@crewtavo/core";
import { squareSettings, squareWebhookPayment, type SquareSettings } from "@crewtavo/core/square";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { appUrl, asJson, dbError, HttpError, readJson } from "../lib/http";
import { companySquare, createSquareWebhook, forgetSquare, squareLocations, SquareProblem, squareSigned, type SquareLocation } from "../lib/square";
import { adminClient } from "../lib/supabase";
import { loadSecret, saveSecret } from "../integrations/tokens";
import { settleSquarePayment } from "../services/square";

export const square = new Hono<AppEnv>();

/** Where Square posts this company's payment changes. */
export const squareWebhookUrl = (base: string, companyId: string) => `${base}/api/webhooks/square/${companyId}`;

/** Square on its app page: the environment, the location and whether payments are reported here. */
export function squareState(base: string, row: { status: string; settings: unknown } | undefined) {
  if (!row || row.status !== "connected") return null;
  const s = squareSettings(row.settings);
  return { environment: s.environment, location_id: s.location_id, location_name: s.location_name, webhook_set: Boolean(s.webhook_id), reachable: base.startsWith("https://") };
}

const environment = z.enum(["sandbox", "production"]);
const token = z.string().trim().max(500).regex(/^\S*$/, "Paste the token without spaces.");

function problem(error: unknown): never {
  if (error instanceof SquareProblem) throw new HttpError(400, error.message);
  throw error;
}

/** The account's locations, to pick where payments go. The token is checked with Square and not kept. */
square.post("/apps/square/locations", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ access_token: token.optional(), environment }));
  const kept = await loadSecret(c.env, adminClient(c.env), c.var.companyId, "square").catch(() => null);
  const key = body.access_token || kept?.api_key;
  if (!key) throw new HttpError(400, "Paste your Square access token.");
  try {
    return c.json({ locations: await squareLocations({ environment: body.environment, token: key }) });
  } catch (error) {
    problem(error);
  }
});

/**
 * Connects the business's Square account: its access token (checked with Square, kept encrypted,
 * never returned) and the location payments go to. Leaving the token out keeps the one saved. A new
 * token or environment is another account: payments have to be reported here again.
 */
square.put("/apps/square/account", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ access_token: token.optional(), environment, location_id: z.string().trim().min(1, "Pick a location.").max(60) }));
  const admin = adminClient(c.env);
  const kept = await loadSecret(c.env, admin, c.var.companyId, "square").catch(() => null);
  const key = body.access_token || kept?.api_key;
  if (!key) throw new HttpError(400, "Paste your Square access token.");
  let locations: SquareLocation[] = [];
  try {
    locations = await squareLocations({ environment: body.environment, token: key });
  } catch (error) {
    problem(error);
  }
  const location = locations.find((l) => l.id === body.location_id);
  if (!location) throw new HttpError(400, "That location isn't in this Square account. Pick it again.");
  const { data: before } = await admin.from("integrations").select("status, settings").match({ company_id: c.var.companyId, provider: "square" }).maybeSingle();
  const was = before && before.status === "connected" ? squareSettings(before.settings) : null;
  const same = Boolean(was) && was!.environment === body.environment && (!body.access_token || body.access_token === kept?.api_key);
  const settings: SquareSettings = {
    environment: body.environment, location_id: location.id, location_name: location.name,
    webhook_id: same ? was!.webhook_id : null, webhook_url: same ? was!.webhook_url : null,
  };
  await saveSecret(c.env, admin, c.var.companyId, "square", { api_key: key, extra: same && kept?.extra?.webhook_key ? { webhook_key: kept.extra.webhook_key } : {} });
  const { error } = await admin.from("integrations").upsert({
    company_id: c.var.companyId, provider: "square", status: "connected", account_label: `${location.name} (${body.environment === "sandbox" ? "Sandbox" : "Production"})`.slice(0, 200),
    settings: asJson(settings), connected_by: c.var.userId, connected_at: new Date().toISOString(), last_error: null,
  });
  if (error) throw dbError(error);
  forgetSquare(c.var.companyId);
  return c.json({ square: squareState(appUrl(c), { status: "connected", settings }) });
});

/**
 * Asks Square to tell us when a payment is made (a webhook subscription in the Square app). Without
 * it, a payment is still booked the next time its invoice page is opened.
 */
square.post("/apps/square/webhook", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const base = appUrl(c);
  if (!base.startsWith("https://")) throw new HttpError(400, "Square can only reach a public https address, and this app doesn't have one yet.");
  const admin = adminClient(c.env);
  const account = await companySquare(c.env, c.var.companyId);
  if (!account) throw new HttpError(409, "Connect your Square account first.");
  if (account.settings.webhook_id) return c.json({ square: squareState(base, { status: "connected", settings: account.settings }) });
  const url = squareWebhookUrl(base, c.var.companyId);
  let made;
  try {
    made = await createSquareWebhook({ environment: account.settings.environment, token: account.token }, url);
  } catch (error) {
    if (error instanceof SquareProblem) throw new HttpError(502, error.message);
    throw error;
  }
  await saveSecret(c.env, admin, c.var.companyId, "square", { api_key: account.token, extra: { webhook_key: made.key } });
  const next: SquareSettings = { ...account.settings, webhook_id: made.id, webhook_url: url };
  const { error } = await admin.from("integrations").update({ settings: asJson(next) }).match({ company_id: c.var.companyId, provider: "square" });
  if (error) throw dbError(error);
  forgetSquare(c.var.companyId);
  return c.json({ square: squareState(base, { status: "connected", settings: next }) });
});

/**
 * Square posts payment changes here. Signed with the subscription's key over the address it was made
 * with; anything else is refused. Answered 200 for payments that aren't ours, so Square doesn't retry.
 */
square.post("/webhooks/square/:company", async (c) => {
  const companyId = c.req.param("company");
  if (!/^[0-9a-f-]{36}$/i.test(companyId)) throw new HttpError(404, "Not found.");
  const raw = await c.req.text();
  const account = await companySquare(c.env, companyId).catch(() => null);
  if (!account?.webhookKey || !account.settings.webhook_url) throw new HttpError(404, "Not found.");
  if (!(await squareSigned(account.webhookKey, account.settings.webhook_url, c.req.header("x-square-hmacsha256-signature"), raw))) throw new HttpError(403, "Bad signature.");
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return c.json({ ok: true });
  }
  const payment = squareWebhookPayment(event);
  if (payment) await settleSquarePayment(adminClient(c.env), companyId, payment);
  return c.json({ ok: true });
});
