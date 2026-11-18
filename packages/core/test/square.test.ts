import { describe, expect, it } from "vitest";
import { squareApiBase, squareBooking, squareMethod, squareSettings, squareWebhookPayment } from "../src/square";

describe("Square settings", () => {
  it("are sandbox unless they say production", () => {
    expect(squareSettings(null)).toEqual({ environment: "sandbox", location_id: null, location_name: null, webhook_id: null, webhook_url: null });
    expect(squareSettings({ environment: "live" }).environment).toBe("sandbox");
    expect(squareSettings({ environment: "production", location_id: " L1 " })).toMatchObject({ environment: "production", location_id: "L1" });
  });

  it("talk to the sandbox or production server", () => {
    expect(squareApiBase("sandbox")).toBe("https://connect.squareupsandbox.com");
    expect(squareApiBase("production")).toBe("https://connect.squareup.com");
  });
});

describe("Square webhooks", () => {
  it("read the payment from payment events only", () => {
    const payment = { id: "P1", status: "COMPLETED", order_id: "O1" };
    expect(squareWebhookPayment({ type: "payment.updated", data: { object: { payment } } })).toEqual(payment);
    expect(squareWebhookPayment({ type: "refund.updated", data: { object: { payment } } })).toBeNull();
    expect(squareWebhookPayment({ type: "payment.updated", data: { object: {} } })).toBeNull();
    expect(squareWebhookPayment("nope")).toBeNull();
  });
});

describe("booking a Square payment", () => {
  it("waits until it has gone through", () => {
    expect(squareBooking({ id: "P1", status: "APPROVED", amount_money: { amount: 5000 } }, 0)).toBeNull();
  });

  it("splits the invoice's money from the tips, and keeps Square's fee", () => {
    expect(
      squareBooking({ id: "P1", status: "COMPLETED", amount_money: { amount: 55000 }, tip_money: { amount: 300 }, processing_fee: [{ amount_money: { amount: 1600 } }, { amount_money: { amount: 10 } }], source_type: "CARD" }, 5000),
    ).toEqual({ amount: 500, tip: 53, fee: 16.1, method: "card" });
  });

  it("never books more tip than was paid", () => {
    expect(squareBooking({ id: "P1", status: "COMPLETED", amount_money: { amount: 100 } }, 500)).toMatchObject({ amount: 0, tip: 1 });
  });

  it("names the way it was paid", () => {
    expect(squareMethod("CARD")).toBe("card");
    expect(squareMethod("BANK_ACCOUNT")).toBe("ach");
    expect(squareMethod("CASH")).toBe("cash");
    expect(squareMethod("WALLET")).toBe("other");
    expect(squareMethod(null)).toBe("other");
  });
});
