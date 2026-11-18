/**
 * What the crew's phone says after On my way (features/field/onMyWay.ts): the client was texted, to
 * whom and from which line, or plainly why not, in English or Spanish.
 */
import { setLocale } from "@crewtavo/core/i18n";
import { installSpanish } from "@crewtavo/core/i18n/es";
import { afterEach, describe, expect, it } from "vitest";
import { onMyWayWords } from "../src/features/field/onMyWay";

afterEach(() => setLocale("en"));

describe("the On my way note", () => {
  it("says the text went, to whom and from which line", () => {
    expect(onMyWayWords({ state: "sent", to: "Jane", line: "washing" })).toEqual({ tone: "good", text: "Text sent to Jane from the Wash line" });
    expect(onMyWayWords({ state: "sent", to: "Jane", line: "lights" })).toEqual({ tone: "good", text: "Text sent to Jane from the Lighting line" });
    expect(onMyWayWords({ state: "sent", to: null, line: null })?.text).toBe("Text sent to the client");
  });

  it("says why it didn't go", () => {
    expect(onMyWayWords({ state: "not_sent", why: "test_mode" })?.text).toBe("Not texted: texts are in test mode, so only the test numbers get them.");
    expect(onMyWayWords({ state: "not_sent", why: "no_phone" })?.text).toBe("Not texted: the client has no phone number.");
    expect(onMyWayWords({ state: "not_sent", why: "opted_out" })?.text).toBe("Not texted: the client asked not to get texts.");
    expect(onMyWayWords({ state: "off", why: "off" })?.tone).toBe("warn");
    expect(onMyWayWords({ state: "not_sent", why: "other", detail: "Couldn't reach Quo. Try again." })?.text).toBe("The text didn't go out: Couldn't reach Quo. Try again.");
  });

  it("says it's on its way, and nothing before the tap", () => {
    expect(onMyWayWords({ state: "waiting" })?.tone).toBe("wait");
    expect(onMyWayWords({ state: "none" })).toBeNull();
    expect(onMyWayWords(undefined)).toBeNull();
  });

  it("speaks Spanish for a crew that chose it", () => {
    installSpanish();
    setLocale("es");
    expect(onMyWayWords({ state: "sent", to: "Jane", line: "lights" })?.text).toBe("Mensaje enviado a Jane desde la línea de luces");
  });
});
