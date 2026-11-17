/**
 * Quo (formerly OpenPhone) as the business's phone system: which of its lines a text goes from, the
 * test-number guard, and reading what Quo sends when a text comes in (API version 2026-03-30).
 *
 * Two lines, one per brand: the washing line and the Christmas-lights line. A text about a brand
 * goes from that brand's line; with only one line set, everything goes from it.
 *
 * Test only (`test_only`, on until the business goes live): Crewtavo texts only the numbers on the
 * test list, and a text that comes in from any other number is dropped without being kept, so a
 * test Crewtavo connected to the real Quo account never texts a customer or keeps their words.
 *
 * Practice (`practice`): no Quo account at all. Texts are "sent" without leaving Crewtavo and the
 * office can pretend a test number texted back, to try everything before connecting the real one.
 */
import { phoneE164 } from "./phone";
import { phoneMatchKey } from "./recipients";
import type { Brand } from "./pipeline";

export interface QuoLine {
  /** Quo's id for the number ("PN…"). */
  id: string;
  /** The number in E.164. */
  number: string;
  /** Its name in Quo ("Main Wash Line"). */
  name: string;
}

/** Non-secret, in integrations.settings (provider "quo"). The API key and webhook key are in integration_secrets. */
export interface QuoSettings {
  practice: boolean;
  test_only: boolean;
  /** The numbers a test-only Crewtavo may text and hear from, in E.164. */
  test_numbers: string[];
  lines: Partial<Record<Brand, QuoLine>>;
  /** Quo's id for the webhook that sends incoming texts here, once it's set up. */
  webhook_id?: string | null;
}

export const QUO_TEST_NUMBERS_MAX = 10;

/** The settings as kept, with anything missing filled in safely (test only unless it says otherwise). */
export function quoSettings(raw: unknown): QuoSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<QuoSettings>;
  const lines: QuoSettings["lines"] = {};
  for (const brand of ["washing", "lights"] as const) {
    const l = r.lines?.[brand];
    if (l && typeof l.id === "string" && typeof l.number === "string") lines[brand] = { id: l.id, number: l.number, name: typeof l.name === "string" ? l.name : l.number };
  }
  return {
    practice: r.practice === true,
    test_only: r.test_only !== false,
    test_numbers: Array.isArray(r.test_numbers) ? r.test_numbers.filter((n): n is string => typeof n === "string") : [],
    lines,
    webhook_id: typeof r.webhook_id === "string" ? r.webhook_id : null,
  };
}

/**
 * The test numbers as typed (one per line, or separated by commas), in E.164, without repeats. Throws
 * with what to fix when one isn't a phone number or there are too many.
 */
export function parseTestNumbers(input: string | readonly string[]): string[] {
  const parts = (typeof input === "string" ? input.split(/[\n,;]+/) : [...input]).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const e164 = phoneE164(part);
    if (!e164) throw new Error(`"${part}" isn't a phone number. Type it with its area code, like (470) 555-0101.`);
    if (!out.includes(e164)) out.push(e164);
  }
  if (out.length > QUO_TEST_NUMBERS_MAX) throw new Error(`Up to ${QUO_TEST_NUMBERS_MAX} test numbers.`);
  return out;
}

/** Whether Crewtavo may text this number, or keep a text from it: any number once it's live, else only test numbers. */
export function quoNumberAllowed(settings: Pick<QuoSettings, "test_only" | "test_numbers">, phone: string | null | undefined): boolean {
  const key = phoneMatchKey(phone);
  if (!key) return false;
  if (!settings.test_only) return true;
  return settings.test_numbers.some((n) => phoneMatchKey(n) === key);
}

/** The line a text about this brand goes from: that brand's, else whichever line is set. Null when none is. */
export function quoLineFor(settings: Pick<QuoSettings, "lines">, brand?: Brand | null): QuoLine | null {
  return (brand ? settings.lines[brand] : null) ?? settings.lines.washing ?? settings.lines.lights ?? null;
}

/** The brand a line is for, by its Quo id. */
export function quoBrandOf(settings: Pick<QuoSettings, "lines">, phoneNumberId: string | null | undefined): Brand | null {
  if (!phoneNumberId) return null;
  return settings.lines.washing?.id === phoneNumberId ? "washing" : settings.lines.lights?.id === phoneNumberId ? "lights" : null;
}

/** A text that came in, as Crewtavo files it. */
export interface QuoIncomingText {
  id: string;
  from: string;
  text: string;
  phoneNumberId: string | null;
}

const identifier = (v: unknown): string | null => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["phoneNumber", "identifier", "value", "number"]) if (typeof o[k] === "string") return o[k] as string;
  }
  return null;
};

/**
 * A `message.received` event's text: who sent it (data.context.senderIdentifier), what it says
 * (data.resource.text) and which line it came to. Null for any other event, an outgoing message, or
 * one that isn't from a phone number.
 */
export function quoIncomingText(event: unknown): QuoIncomingText | null {
  const e = (event && typeof event === "object" ? event : {}) as { type?: unknown; data?: { resource?: Record<string, unknown>; context?: Record<string, unknown> } };
  if (e.type !== "message.received") return null;
  const resource = e.data?.resource ?? {};
  const context = e.data?.context ?? {};
  if (resource.direction && resource.direction !== "incoming") return null;
  const from = phoneE164(identifier(context.senderIdentifier) ?? "");
  const text = typeof resource.text === "string" ? resource.text : "";
  if (!from) return null;
  return { id: typeof resource.id === "string" ? resource.id : "", from, text, phoneNumberId: typeof context.phoneNumberId === "string" ? context.phoneNumberId : null };
}
