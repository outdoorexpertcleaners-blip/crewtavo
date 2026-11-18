/**
 * Paying invoices through Square (lib/square.ts, core/square.ts). The client's Pay on an invoice
 * makes a Square checkout page for what's owed, plus the tip they chose; Square's webhook (or the
 * invoice page being opened again) books the payment here once it's gone through.
 *
 * Only one page is payable at a time: a new amount takes the old page down in Square first. A
 * payment that still comes in on an old page is booked all the same (the money was received), and
 * processor_ref (Square's payment id) is unique, so no payment is booked twice.
 */
import { squareBooking, type SquarePayment } from "@crewtavo/core/square";
import type { Env } from "../env";
import { dbError, HttpError } from "../lib/http";
import { companySquare, createSquareLink, deleteSquareLink, squareOrderPayments, SquareProblem, type SquareAccount } from "../lib/square";
import type { Db } from "../lib/supabase";

const cents = (n: number | string | null | undefined) => Math.round(Number(n ?? 0) * 100);
/** A page older than this is made again, so a client never pays from a stale one. */
const PAGE_DAYS = 7;

const call = (account: SquareAccount) => ({ environment: account.settings.environment, token: account.token, locationId: account.settings.location_id! });

/** Whether this company takes invoice payments through Square. */
export async function squareOn(env: Env, companyId: string): Promise<boolean> {
  return Boolean(await companySquare(env, companyId).catch(() => null));
}

/**
 * Books a Square payment on its invoice, when it's one of ours and has gone through. Square's fee
 * can come a moment after the payment does: it's filled in then. Whether anything changed.
 */
export async function settleSquarePayment(admin: Db, companyId: string, payment: SquarePayment): Promise<boolean> {
  if (!payment.order_id) return false;
  const { data: row, error } = await admin.from("square_checkouts").select("id, invoice_id, tip_cents, status, payment_id").eq("company_id", companyId).eq("order_id", payment.order_id).maybeSingle();
  if (error) throw dbError(error);
  if (!row) return false;
  const booking = squareBooking(payment, row.tip_cents);
  if (!booking) return false;
  const { data: invoice } = row.invoice_id
    ? await admin.from("invoices").select("id, number, client_id, status").eq("company_id", companyId).eq("id", row.invoice_id).maybeSingle()
    : { data: null };
  if (!invoice) return false;
  const { data: had } = await admin.from("payments").select("id, fee_amount").eq("processor_ref", payment.id).maybeSingle();
  if (had) {
    if (Number(had.fee_amount) !== booking.fee) await admin.from("payments").update({ fee_amount: booking.fee }).eq("id", had.id);
  } else if (booking.amount !== 0 || booking.tip !== 0) {
    // A void invoice stays void: the money is the client's, with a note saying which invoice it was for.
    const voided = invoice.status === "void";
    const { error: insertError } = await admin.from("payments").insert({
      company_id: companyId, invoice_id: voided ? null : invoice.id, client_id: invoice.client_id,
      // payments.amount can't be 0: a payment that was only a tip is booked as the tip.
      amount: booking.amount !== 0 ? booking.amount : booking.tip, tip_amount: booking.amount !== 0 ? booking.tip : 0,
      method: booking.method, processor: "square", processor_ref: payment.id, fee_amount: booking.fee,
      received_at: payment.updated_at ?? payment.created_at ?? new Date().toISOString(), recorded_by: null,
      notes: voided ? `Paid through Square for invoice #${invoice.number}, which is void` : null,
    });
    if (insertError && insertError.code !== "23505") throw dbError(insertError);
  }
  if (row.status !== "paid" || row.payment_id !== payment.id) await admin.from("square_checkouts").update({ status: "paid", payment_id: payment.id }).eq("id", row.id);
  return true;
}

/** Asks Square about this invoice's open checkout pages and books what was paid on them. */
export async function syncSquareInvoice(env: Env, admin: Db, companyId: string, invoiceId: string): Promise<void> {
  const account = await companySquare(env, companyId);
  if (!account) return;
  const { data: open, error } = await admin.from("square_checkouts").select("order_id").eq("company_id", companyId).eq("invoice_id", invoiceId).eq("status", "open").limit(20);
  if (error) throw dbError(error);
  for (const row of open ?? []) {
    try {
      for (const payment of await squareOrderPayments(call(account), row.order_id)) await settleSquarePayment(admin, companyId, payment);
    } catch (problem) {
      if (!(problem instanceof SquareProblem)) throw problem;
    }
  }
}

/**
 * The Square page to pay this invoice (what's owed plus the tip), made when there's no current one
 * for that amount. `returnUrl` is the invoice page, where Square sends the client back.
 */
export async function squareCheckout(env: Env, admin: Db, companyId: string, invoiceId: string, tipCents: number, returnUrl: string): Promise<string> {
  const account = await companySquare(env, companyId);
  if (!account) throw new HttpError(501, "Online payments aren't set up.");
  // Paid a moment ago on a page that's still open: booked first, so it isn't asked for twice.
  await syncSquareInvoice(env, admin, companyId, invoiceId);
  const { data: invoice, error } = await admin
    .from("invoices")
    .select("id, number, status, balance_due, client:clients(email)")
    .eq("company_id", companyId)
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) throw dbError(error);
  if (!invoice) throw new HttpError(404, "Invoice not found.");
  if (invoice.status === "void") throw new HttpError(409, "This invoice was cancelled, so it can't be paid.");
  if (invoice.status === "written_off") throw new HttpError(409, "This invoice isn't owed anymore.");
  if (invoice.status === "draft") throw new HttpError(409, "This invoice isn't ready yet.");
  const owed = cents(invoice.balance_due);
  if (owed <= 0) throw new HttpError(409, "This invoice is already paid.");
  if (owed + tipCents < 100) throw new HttpError(409, "What's left on this invoice is too small to pay online. Contact us to pay it.");

  const { data: open } = await admin.from("square_checkouts").select("id, link_id, url, amount_cents, tip_cents, environment, created_at").eq("company_id", companyId).eq("invoice_id", invoiceId).eq("status", "open");
  const fresh = (open ?? []).find(
    (r) => r.amount_cents === owed + tipCents && r.tip_cents === tipCents && r.environment === account.settings.environment && Date.now() - Date.parse(r.created_at) < PAGE_DAYS * 86_400_000,
  );
  if (fresh) return fresh.url;
  // Another amount (or an old page): taken down first, so only what's owed now can be paid.
  for (const old of open ?? []) {
    if (old.environment === account.settings.environment) {
      try {
        await deleteSquareLink(call(account), old.link_id);
      } catch (problem) {
        if (problem instanceof SquareProblem) throw new HttpError(502, "Online payments aren't working right now. Try again in a few minutes, or contact us to pay.");
        throw problem;
      }
    }
    await admin.from("square_checkouts").update({ status: "replaced" }).eq("id", old.id);
  }
  const { data: company } = await admin.from("companies").select("currency").eq("id", companyId).maybeSingle();
  const client = invoice.client as { email: string | null } | null;
  let link;
  try {
    link = await createSquareLink(call(account), {
      key: crypto.randomUUID(), invoiceId, companyId, number: String(invoice.number), amountCents: owed, tipCents,
      currency: (company?.currency || "USD").toUpperCase(), returnUrl, email: client?.email ?? null,
    });
  } catch (problem) {
    if (problem instanceof SquareProblem) {
      console.error("Square checkout failed", problem.message);
      throw new HttpError(502, "Online payments aren't working right now. Try again in a few minutes, or contact us to pay.");
    }
    throw problem;
  }
  const { error: saveError } = await admin.from("square_checkouts").insert({
    company_id: companyId, invoice_id: invoiceId, environment: account.settings.environment, link_id: link.id, order_id: link.order_id, url: link.url, amount_cents: owed + tipCents, tip_cents: tipCents,
  });
  if (saveError) throw dbError(saveError);
  return link.url;
}
