/**
 * The owner's time clock (src/timeclock.ts): the 14-day pay periods counted from Monday Sep 28,
 * hours by kind with breaks left out and a running clock counted to now, the checks on Fix times,
 * and the period's spreadsheet.
 */
import { describe, expect, it } from "vitest";
import { checkFixTimes, clockKind, FIX_PROBLEMS, hoursAndMinutes, hoursCell, payPeriodStart, periodDays, sumTallies, tally, tallyByDay, timesheetCsvRows, weekStart } from "../src/timeclock";

const TZ = "America/New_York";

describe("pay periods", () => {
  it("are 14 days from Monday Sep 28, 2026", () => {
    expect(payPeriodStart("2026-09-28")).toBe("2026-09-28");
    expect(payPeriodStart("2026-10-11")).toBe("2026-09-28");
    expect(payPeriodStart("2026-10-12")).toBe("2026-10-12");
    expect(payPeriodStart("2026-11-18")).toBe("2026-11-09");
    expect(payPeriodStart("2026-11-22")).toBe("2026-11-09");
    expect(payPeriodStart("2026-11-23")).toBe("2026-11-23");
  });

  it("go back before the anchor too", () => {
    expect(payPeriodStart("2026-09-27")).toBe("2026-09-14");
    expect(payPeriodStart("2026-09-14")).toBe("2026-09-14");
  });

  it("aren't thrown by daylight saving or a new year", () => {
    // Clocks go back on Nov 1, 2026.
    expect(payPeriodStart("2026-11-01")).toBe("2026-10-26");
    expect(payPeriodStart("2027-01-04")).toBe("2027-01-04");
    expect(periodDays("2026-12-21")).toEqual(Array.from({ length: 14 }, (_, i) => (i < 11 ? `2026-12-${21 + i}` : `2027-01-0${i - 10}`)));
  });

  it("weeks start on Monday", () => {
    expect(weekStart("2026-11-18")).toBe("2026-11-16");
    expect(weekStart("2026-11-22")).toBe("2026-11-16");
    expect(weekStart("2026-11-16")).toBe("2026-11-16");
  });
});

describe("hours", () => {
  const block = (category: string, start: string, end: string | null) => ({ category, started_at: `2026-11-18T${start}:00Z`, ended_at: end ? `2026-11-18T${end}:00Z` : null });

  it("sorts them by kind and leaves breaks out of the total", () => {
    const day = tally([block("washing", "12:00", "15:00"), block("break", "15:00", "15:30"), block("lights", "15:30", "17:00"), block("shop", "17:00", "17:15")]);
    expect(day).toEqual({ washing: 3, lights: 1.5, shop: 0.25, break: 0.5, total: 4.75 });
  });

  it("counts a clock still running up to now", () => {
    const now = Date.parse("2026-11-18T14:30:00Z");
    expect(tally([block("washing", "12:00", null)], now)).toMatchObject({ washing: 2.5, total: 2.5 });
    expect(tally([block("break", "14:00", null)], now)).toMatchObject({ break: 0.5, total: 0 });
  });

  it("counts older kinds of time as Shop / other", () => {
    expect(["visit", "drive", "assessment", "other", "shop"].map(clockKind)).toEqual(["shop", "shop", "shop", "shop", "shop"]);
    expect(tally([block("visit", "12:00", "13:00"), block("drive", "13:00", "13:30")])).toMatchObject({ shop: 1.5, total: 1.5 });
  });

  it("puts each block on the day it started, in the company's time zone", () => {
    // 11:30 PM Nov 17 in New York is 04:30 Nov 18 UTC.
    const late = { category: "washing", started_at: "2026-11-18T04:30:00Z", ended_at: "2026-11-18T06:00:00Z" };
    const days = tallyByDay([late, block("lights", "14:00", "16:00")], ["2026-11-17", "2026-11-18", "2026-11-19"], TZ);
    expect(days["2026-11-17"]).toMatchObject({ washing: 1.5, total: 1.5 });
    expect(days["2026-11-18"]).toMatchObject({ lights: 2, total: 2 });
    expect(days["2026-11-19"]!.total).toBe(0);
    expect(sumTallies(Object.values(days))).toMatchObject({ washing: 1.5, lights: 2, total: 3.5 });
  });

  it("writes hours as the timesheet and the clock show them", () => {
    expect(hoursCell(0)).toBe("–");
    expect(hoursCell(3.383)).toBe("3.38");
    expect(hoursAndMinutes(3.3834)).toBe("3h 23m");
    expect(hoursAndMinutes(1.0833)).toBe("1h 04m");
    expect(hoursAndMinutes(0.75)).toBe("45m");
  });
});

describe("Fix times", () => {
  const now = new Date("2026-11-18T20:00:00Z"); // 3:00 PM in New York
  const check = (rows: Array<[string, string, string]>, date = "2026-11-18") =>
    checkFixTimes(rows.map(([kind, start, end]) => ({ kind, start, end })), { date, today: "2026-11-18", timeZone: TZ, now });

  it("turns a day's rows into blocks, in the order they start", () => {
    const result = check([["lights", "11:05", "14:00"], ["washing", "07:42", "11:05"], ["break", "14:00", ""]]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blocks.map((b) => [b.kind, b.startAt.toISOString(), b.endAt?.toISOString() ?? null])).toEqual([
      ["washing", "2026-11-18T12:42:00.000Z", "2026-11-18T16:05:00.000Z"],
      ["lights", "2026-11-18T16:05:00.000Z", "2026-11-18T19:00:00.000Z"],
      ["break", "2026-11-18T19:00:00.000Z", null],
    ]);
  });

  it("needs a start on every block", () => {
    expect(check([["washing", "", "11:00"]])).toEqual({ ok: false, problem: FIX_PROBLEMS.start, row: 0 });
  });

  it("reads an end before the start as past midnight", () => {
    const result = check([["shop", "20:00", "01:30"]], "2026-11-16");
    expect(result.ok && result.blocks[0]!.endAt!.toISOString()).toBe("2026-11-17T06:30:00.000Z");
  });

  it("allows 16 hours at most in a block", () => {
    expect(check([["washing", "06:00", "22:00"]], "2026-11-16").ok).toBe(true);
    expect(check([["washing", "06:00", "22:01"]], "2026-11-16")).toMatchObject({ ok: false, problem: FIX_PROBLEMS.long });
  });

  it("leaves only the last block open, and only today", () => {
    expect(check([["washing", "07:00", ""], ["lights", "09:00", "10:00"]])).toMatchObject({ ok: false, problem: FIX_PROBLEMS.open, row: 0 });
    expect(check([["washing", "07:00", ""], ["lights", "09:00", ""]])).toMatchObject({ ok: false, problem: FIX_PROBLEMS.open });
    expect(check([["washing", "07:00", "09:00"], ["lights", "09:00", ""]]).ok).toBe(true);
    expect(check([["washing", "15:10", ""]], "2026-11-17")).toMatchObject({ ok: false, problem: FIX_PROBLEMS.dayOver, row: 0 });
  });

  it("turns away overlaps and times that haven't happened", () => {
    expect(check([["washing", "07:00", "10:00"], ["lights", "09:30", "11:00"]])).toMatchObject({ ok: false, problem: FIX_PROBLEMS.overlap, row: 1 });
    expect(check([["washing", "07:00", "10:00"], ["lights", "10:00", "11:00"]]).ok).toBe(true);
    // Now is 3:00 PM there: a block from 4:00 hasn't happened yet.
    expect(check([["washing", "16:00", "17:00"]])).toMatchObject({ ok: false, problem: FIX_PROBLEMS.future });
  });

  it("is happy with nothing at all (every block removed)", () => {
    expect(check([])).toEqual({ ok: true, blocks: [] });
  });
});

describe("the period's spreadsheet", () => {
  it("has a row per person per day worked, breaks left out", () => {
    const worked = { washing: 3.25, lights: 0, shop: 0.5, break: 1, total: 3.75 };
    const onlyBreak = { washing: 0, lights: 0, shop: 0, break: 0.5, total: 0 };
    expect(timesheetCsvRows([{ name: "Ray", days: [{ date: "2026-11-16", tally: worked }, { date: "2026-11-17", tally: onlyBreak }] }])).toEqual([
      { person: "Ray", date: "2026-11-16", washing: "3.25", lights: "0.00", shop: "0.50", total: "3.75" },
    ]);
  });
});
