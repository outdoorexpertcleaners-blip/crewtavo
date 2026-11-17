import { describe, expect, it } from "vitest";
import { parseTestNumbers, quoBrandOf, quoIncomingText, quoLineFor, quoNumberAllowed, quoSettings } from "../src/quo";

const wash = { id: "PNwash", number: "+14044349990", name: "Main Wash Line" };
const lights = { id: "PNlights", number: "+14703007296", name: "Main Lighting Line" };

describe("Quo settings", () => {
  it("are test only unless they say otherwise", () => {
    expect(quoSettings(null)).toEqual({ practice: false, test_only: true, test_numbers: [], lines: {}, webhook_id: null });
    expect(quoSettings({ test_only: "no" }).test_only).toBe(true);
    expect(quoSettings({ test_only: false }).test_only).toBe(false);
  });

  it("keep only well-formed lines", () => {
    expect(quoSettings({ lines: { washing: wash, lights: { id: 5 } } }).lines).toEqual({ washing: wash });
  });
});

describe("test numbers", () => {
  it("are read as typed, without repeats", () => {
    expect(parseTestNumbers("(470) 555-0101\n470-555-0101, +1 470 555 0102")).toEqual(["+14705550101", "+14705550102"]);
    expect(parseTestNumbers([])).toEqual([]);
  });

  it("say what's wrong", () => {
    expect(() => parseTestNumbers("call me")).toThrow(/isn't a phone number/);
    expect(() => parseTestNumbers(Array.from({ length: 11 }, (_, i) => `470555${String(1000 + i)}`))).toThrow(/Up to 10/);
  });

  it("are the only numbers a test-only Crewtavo texts or hears from", () => {
    const s = { test_only: true, test_numbers: ["+14705550101"] };
    expect(quoNumberAllowed(s, "(470) 555-0101")).toBe(true);
    expect(quoNumberAllowed(s, "+14045551234")).toBe(false);
    expect(quoNumberAllowed(s, null)).toBe(false);
    expect(quoNumberAllowed({ test_only: false, test_numbers: [] }, "+14045551234")).toBe(true);
    expect(quoNumberAllowed({ test_only: true, test_numbers: [] }, "+14045551234")).toBe(false);
  });
});

describe("which line", () => {
  it("is the brand's, else whichever is set", () => {
    expect(quoLineFor({ lines: { washing: wash, lights } }, "lights")).toBe(lights);
    expect(quoLineFor({ lines: { washing: wash, lights } }, "washing")).toBe(wash);
    expect(quoLineFor({ lines: { washing: wash, lights } })).toBe(wash);
    expect(quoLineFor({ lines: { lights } }, "washing")).toBe(lights);
    expect(quoLineFor({ lines: {} }, "washing")).toBeNull();
  });

  it("a line is for", () => {
    expect(quoBrandOf({ lines: { washing: wash, lights } }, "PNlights")).toBe("lights");
    expect(quoBrandOf({ lines: { washing: wash } }, "PNother")).toBeNull();
  });
});

describe("a text that came in", () => {
  const event = (over: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) => ({
    id: "EV1",
    type: "message.received",
    data: {
      resource: { id: "AC1", direction: "incoming", text: "Yes please book me", status: "received", ...over },
      context: { orgId: "OR1", phoneNumberId: "PNwash", senderIdentifier: "+14705550101", recipientIdentifiers: ["+14044349990"], ...ctx },
    },
  });

  it("is read from a message.received event", () => {
    expect(quoIncomingText(event())).toEqual({ id: "AC1", from: "+14705550101", text: "Yes please book me", phoneNumberId: "PNwash" });
    expect(quoIncomingText(event({}, { senderIdentifier: { phoneNumber: "+14705550101" } }))?.from).toBe("+14705550101");
  });

  it("is nothing for other events, outgoing texts or senders without a number", () => {
    expect(quoIncomingText({ ...event(), type: "call.completed" })).toBeNull();
    expect(quoIncomingText(event({ direction: "outgoing" }))).toBeNull();
    expect(quoIncomingText(event({}, { senderIdentifier: null }))).toBeNull();
    expect(quoIncomingText(null)).toBeNull();
  });
});
