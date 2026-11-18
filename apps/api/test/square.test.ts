import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSquareLink, squareLocations, SquareProblem, squareSigned } from "../src/lib/square";

const URL_ = "https://example.test/api/webhooks/square/00000000-0000-0000-0000-000000000001";

describe("Square webhook signatures", () => {
  const body = JSON.stringify({ type: "payment.updated", data: { object: { payment: { id: "P1" } } } });
  const good = createHmac("sha256", "sig-key").update(URL_ + body).digest("base64");

  it("accept Square's: HMAC-SHA256 over the address and the raw body, base64", async () => {
    expect(await squareSigned("sig-key", URL_, good, body)).toBe(true);
  });

  it("refuse anything else", async () => {
    expect(await squareSigned("other-key", URL_, good, body)).toBe(false);
    expect(await squareSigned("sig-key", `${URL_}x`, good, body)).toBe(false);
    expect(await squareSigned("sig-key", URL_, good, `${body} `)).toBe(false);
    expect(await squareSigned("sig-key", URL_, null, body)).toBe(false);
  });
});

describe("Square's API", () => {
  it("makes a checkout page for an invoice, with the tip on its own line", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ payment_link: { id: "L1", url: "https://sandbox.square.link/u/abc", order_id: "O1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const link = await createSquareLink(
      { environment: "sandbox", token: "tok", locationId: "LOC", fetcher },
      { key: "k1", invoiceId: "inv", companyId: "co", number: "12", amountCents: 45000, tipCents: 500, currency: "USD", returnUrl: "https://app.test/i/abc", email: "a@b.test" },
    );
    expect(link).toEqual({ id: "L1", url: "https://sandbox.square.link/u/abc", order_id: "O1" });
    expect(seen[0]!.url).toBe("https://connect.squareupsandbox.com/v2/online-checkout/payment-links");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const sent = JSON.parse(String(seen[0]!.init.body));
    expect(sent.order.location_id).toBe("LOC");
    expect(sent.order.reference_id).toBe("inv");
    expect(sent.order.line_items).toEqual([
      { name: "Invoice #12", quantity: "1", base_price_money: { amount: 45000, currency: "USD" } },
      { name: "Tip", quantity: "1", base_price_money: { amount: 500, currency: "USD" } },
    ]);
    expect(sent.checkout_options.redirect_url).toBe("https://app.test/i/abc");
    expect(sent.pre_populated_data).toEqual({ buyer_email: "a@b.test" });
  });

  it("says plainly when the token isn't accepted", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ errors: [{ code: "UNAUTHORIZED" }] }), { status: 401 })) as unknown as typeof fetch;
    await expect(squareLocations({ environment: "production", token: "bad", fetcher })).rejects.toThrow(SquareProblem);
    await expect(squareLocations({ environment: "production", token: "bad", fetcher })).rejects.toThrow(/Production access token/);
  });
});
