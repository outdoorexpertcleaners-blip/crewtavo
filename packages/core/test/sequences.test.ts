import { describe, expect, it } from "vitest";
import { fillSequence, inHours, inWindow, nextInWindow, SEQUENCE_TEMPLATES, sendWindow, sequenceStep, sequenceSteps, stillGoing, waitWords } from "../src/sequences";

const NY = "America/New_York";
// Tuesday Nov 17, 2026, 14:00 in New York (EST, UTC-5).
const tue2pm = new Date("2026-11-17T19:00:00Z");

describe("a sequence's steps", () => {
  it("are kept safe", () => {
    expect(sequenceStep({ kind: "wait", minutes: "90" })).toEqual({ kind: "wait", minutes: 90, window: null });
    expect(sequenceStep({ kind: "wait", minutes: -5 })).toEqual({ kind: "wait", minutes: 0, window: null });
    expect(sequenceStep({ kind: "text", body: "x".repeat(2000) })).toMatchObject({ kind: "text" });
    expect((sequenceStep({ kind: "text", body: "x".repeat(2000) }) as { body: string }).body).toHaveLength(1600);
    expect(sequenceStep({ kind: "stage", stage: "won" })).toEqual({ kind: "stage", stage: "hot" });
    expect(sequenceStep({ kind: "hours", start: "7am" })).toEqual({ kind: "hours", start: "07:00", end: "20:00", otherwise: 0 });
    expect(sequenceStep({ kind: "rm -rf" })).toEqual({ kind: "end" });
    expect(sequenceSteps("nope")).toEqual([]);
  });

  it("windows need days and a start before the end", () => {
    expect(sendWindow({ days: [6, 1, 1], start: "09:00", end: "19:00" })).toEqual({ days: [1, 6], start: "09:00", end: "19:00" });
    expect(sendWindow({ days: [], start: "09:00", end: "19:00" })).toBeNull();
    expect(sendWindow({ days: [1], start: "19:00", end: "09:00" })).toBeNull();
    expect(sendWindow(null)).toBeNull();
  });
});

describe("time where the business is", () => {
  const monSat = { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "19:00" };

  it("knows business hours", () => {
    expect(inHours(tue2pm, "07:00", "20:00", NY)).toBe(true);
    expect(inHours(new Date("2026-11-18T02:00:00Z"), "07:00", "20:00", NY)).toBe(false); // 9pm
    expect(inHours(new Date("2026-11-17T12:00:00Z"), "07:00", "20:00", NY)).toBe(true); // 7:00 sharp
  });

  it("knows a window, and its next opening", () => {
    expect(inWindow(tue2pm, monSat, NY)).toBe(true);
    expect(nextInWindow(tue2pm, monSat, NY)).toBe(tue2pm);
    // Tuesday 9pm → Wednesday 9am.
    expect(nextInWindow(new Date("2026-11-18T02:00:00Z"), monSat, NY).toISOString()).toBe("2026-11-18T14:00:00.000Z");
    // Saturday 8pm → Monday 9am (no Sundays).
    expect(nextInWindow(new Date("2026-11-22T01:00:00Z"), monSat, NY).toISOString()).toBe("2026-11-23T14:00:00.000Z");
    // Tuesday 6am → Tuesday 9am.
    expect(nextInWindow(new Date("2026-11-17T11:00:00Z"), monSat, NY).toISOString()).toBe("2026-11-17T14:00:00.000Z");
    expect(nextInWindow(tue2pm, null, NY)).toBe(tue2pm);
  });
});

describe("the words", () => {
  it("fill in what's known and leave the rest empty", () => {
    expect(fillSequence("Hey {{first_name}}! This is {{ owner_first_name }} with {{company}}{{nope}}", { first_name: "Jane", owner_first_name: "Will" })).toBe("Hey Jane! This is Will with {{nope}}");
  });

  it("say how long a wait is", () => {
    expect(waitWords(10)).toBe("10 minutes");
    expect(waitWords(60)).toBe("1 hour");
    expect(waitWords(120)).toBe("2 hours");
    expect(waitWords(1440)).toBe("1 day");
    expect(waitWords(4320)).toBe("3 days");
  });
});

describe("whether a run goes on", () => {
  it("stops a lead's texts once it moves on", () => {
    expect(stillGoing("request.created", { status: "new", stage: null }).going).toBe(true);
    expect(stillGoing("request.created", { status: "new", stage: "inbound" }).going).toBe(true);
    expect(stillGoing("request.created", { status: "new", stage: "hot" }).going).toBe(false);
    expect(stillGoing("request.created", { status: "quoted" }).going).toBe(false);
  });

  it("stops a follow-up once the quote is answered", () => {
    expect(stillGoing("quote.sent", { status: "sent" }).going).toBe(true);
    expect(stillGoing("quote.sent", { status: "changes_requested" }).going).toBe(true);
    for (const status of ["approved", "converted", "lost", "draft"]) expect(stillGoing("quote.sent", { status }).going).toBe(false);
    expect(stillGoing("job.completed", { status: "completed" }).going).toBe(true);
    expect(stillGoing("quote.sent", null).going).toBe(false);
  });
});

describe("the GoHighLevel templates", () => {
  it("are one of each workflow for each brand", () => {
    expect(SEQUENCE_TEMPLATES.map((t) => t.key)).toEqual(["dialing-washing", "dialing-lights", "follow-up-washing", "follow-up-lights", "review-washing", "review-lights"]);
  });

  it("only jump to steps they have, and keep their own words", () => {
    for (const t of SEQUENCE_TEMPLATES) {
      for (const s of t.steps) {
        if (s.kind === "goto") expect(s.step).toBeLessThan(t.steps.length);
        if (s.kind === "hours") expect(s.otherwise).toBeLessThan(t.steps.length);
      }
      expect(sequenceSteps(t.steps)).toEqual(t.steps);
    }
  });

  it("speak for their own brand", () => {
    const texts = (key: string) => SEQUENCE_TEMPLATES.find((t) => t.key === key)!.steps.flatMap((s) => (s.kind === "text" ? [s.body] : []));
    expect(texts("follow-up-lights").join(" ")).toContain("Outdoor Expert Lighting");
    expect(texts("follow-up-washing").join(" ")).not.toContain("Lighting");
    expect(texts("follow-up-washing")).toHaveLength(4);
    expect(texts("review-lights")[0]).toContain("{{review_link}}");
  });
});
