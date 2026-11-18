/**
 * Square, for taking invoice payments (apps/api lib/square.ts does the talking). The business
 * connects its own Square account with an access token from Square's Developer Dashboard: Sandbox
 * (test money, nothing is charged) or Production. A client's Pay on an invoice opens a Square
 * checkout page (a payment link) for what's owed, and the payment is booked here once Square says
 * it went through.
 */

export type SquareEnvironment = "sandbox" | "production";

export interface SquareSettings {
  environment: SquareEnvironment;
  location_id: string | null;
  location_name: string | null;
  /** Square's id for the webhook subscription that tells us about payments, once made. */
  webhook_id: string | null;
  /** The exact address that subscription posts to: Square signs with it, so it's kept as made. */
  webhook_url: string | null;
}

const text = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** integrations.settings for Square, whatever is stored. Sandbox unless it says production. */
export function squareSettings(raw: unknown): SquareSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    environment: s.environment === "production" ? "production" : "sandbox",
    location_id: text(s.location_id, 60),
    location_name: text(s.location_name),
    webhook_id: text(s.webhook_id, 100),
    webhook_url: text(s.webhook_url, 500),
  };
}

export const squareApiBase = (environment: SquareEnvironment) => (environment === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com");

/** Where the business finds its token and its payments. */
export const squareDashboard = (environment: SquareEnvironment) => (environment === "production" ? "https://squareup.com/dashboard/sales/transactions" : "https://developer.squareup.com/apps");

export interface SquareMoney {
  amount?: number | null;
  currency?: string | null;
}

/** The parts of a Square Payment this app reads. */
export interface SquarePayment {
  id: string;
  status?: string | null;
  order_id?: string | null;
  amount_money?: SquareMoney | null;
  tip_money?: SquareMoney | null;
  processing_fee?: Array<{ amount_money?: SquareMoney | null }> | null;
  source_type?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** The payment a payment.created / payment.updated webhook is about, or null for anything else. */
export function squareWebhookPayment(event: unknown): SquarePayment | null {
  if (!event || typeof event !== "object") return null;
  const e = event as { type?: unknown; data?: { object?: { payment?: unknown } } };
  if (e.type !== "payment.created" && e.type !== "payment.updated") return null;
  const p = e.data?.object?.payment as SquarePayment | undefined;
  return p && typeof p.id === "string" ? p : null;
}

const cents = (m: SquareMoney | null | undefined) => (typeof m?.amount === "number" && Number.isFinite(m.amount) ? Math.round(m.amount) : 0);

/** This app's payment method for a Square payment (payments.method allows card, ach, cash, check, other). */
export function squareMethod(sourceType: string | null | undefined): "card" | "ach" | "cash" | "other" {
  if (sourceType === "CARD") return "card";
  if (sourceType === "BANK_ACCOUNT") return "ach";
  if (sourceType === "CASH") return "cash";
  return "other";
}

/**
 * How a completed Square payment is booked on the invoice, in dollars: what it paid of the invoice,
 * the tip (the one the client chose on the invoice page, sent to Square as its own line, plus any
 * Square added on its page), and Square's fee. Null while it hasn't gone through.
 */
export function squareBooking(payment: SquarePayment, tipCents: number): { amount: number; tip: number; fee: number; method: ReturnType<typeof squareMethod> } | null {
  if (payment.status !== "COMPLETED") return null;
  const paid = cents(payment.amount_money);
  const ourTip = Math.min(Math.max(0, Math.round(tipCents) || 0), paid);
  const fee = (payment.processing_fee ?? []).reduce((sum, f) => sum + cents(f.amount_money), 0);
  return { amount: (paid - ourTip) / 100, tip: (ourTip + cents(payment.tip_money)) / 100, fee: fee / 100, method: squareMethod(payment.source_type) };
}
