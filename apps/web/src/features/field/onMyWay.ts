/**
 * What the crew's phone says after On my way: whether the client was texted, from which line, or
 * why not, from GET /api/visits/:id/on-my-way (routes/fieldTexts.ts). No React here, so it's tested
 * on its own (test/onMyWay.test.ts).
 */
import { t } from "@/lib/i18n";

export type Line = "washing" | "lights";

export interface OnMyWayText {
  state: "none" | "off" | "waiting" | "sent" | "not_sent";
  to?: string | null;
  line?: Line | null;
  why?: "test_mode" | "no_phone" | "opted_out" | "off" | "other";
  detail?: string | null;
}

/** How long the phone keeps asking while the text is on its way. The server sends it within seconds. */
export const ON_MY_WAY_POLL_MS = 3000;
export const ON_MY_WAY_POLL_FOR_MS = 90_000;

/** The line's name as the team says it. */
export const lineName = (line: Line) => (line === "lights" ? t("Lighting line") : t("Wash line"));

/** The sentence under the visit, and its tone; null when there's nothing to say (not on the way). */
export function onMyWayWords(text: OnMyWayText | null | undefined): { tone: "good" | "warn" | "wait"; text: string } | null {
  if (!text || text.state === "none") return null;
  if (text.state === "waiting") return { tone: "wait", text: t("Texting the client that you're on your way…") };
  if (text.state === "off") return { tone: "warn", text: t("No text went out: the On my way text is turned off. Ask the office.") };
  if (text.state === "sent") {
    const name = text.to || t("the client");
    if (text.line === "lights") return { tone: "good", text: t("Text sent to {name} from the Lighting line", { name }) };
    if (text.line === "washing") return { tone: "good", text: t("Text sent to {name} from the Wash line", { name }) };
    return { tone: "good", text: t("Text sent to {name}", { name }) };
  }
  switch (text.why) {
    case "test_mode": return { tone: "warn", text: t("Not texted: texts are in test mode, so only the test numbers get them.") };
    case "no_phone": return { tone: "warn", text: t("Not texted: the client has no phone number.") };
    case "opted_out": return { tone: "warn", text: t("Not texted: the client asked not to get texts.") };
    case "off": return { tone: "warn", text: t("No text went out: the On my way text is turned off. Ask the office.") };
    default: return { tone: "warn", text: text.detail ? t("The text didn't go out: {reason}", { reason: text.detail }) : t("The text didn't go out.") };
  }
}
