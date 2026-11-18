/**
 * The Clock screen (features/clock): what saving Fix times writes, which days show "•" for times
 * changed by hand, and how the clock cards show a brand-clock tap before it's sent (clockTaps.ts).
 */
import { checkFixTimes } from "@crewtavo/core/timeclock";
import { describe, expect, it } from "vitest";
import { fixTimesWrites, handEditedDays, type ClockEntry, type FixDraft } from "../src/features/clock/clockData";
import { clockAfter, type ShownClock } from "../src/features/field/clockTaps";
import type { TimeChange } from "../src/features/timesheets/timeChanges";

const TZ = "America/New_York";
const entry = (id: string, category: string, start: string, end: string | null, extra: Partial<ClockEntry> = {}): ClockEntry => ({
  id, user_id: "ray", category, started_at: `2026-11-18T${start}:00.000Z`, ended_at: end ? `2026-11-18T${end}:00.000Z` : null, approved_at: null, added_by_hand: false, ...extra,
});

describe("saving Fix times", () => {
  const now = new Date("2026-11-18T21:00:00Z"); // 4:00 PM in New York
  const writes = (loaded: ClockEntry[], drafts: FixDraft[]) => {
    const checked = checkFixTimes(drafts, { date: "2026-11-18", today: "2026-11-18", timeZone: TZ, now });
    if (!checked.ok) throw new Error(checked.problem);
    return fixTimesWrites(loaded, drafts, checked.blocks);
  };

  it("changes only what changed, deletes what was taken out and adds what's new", () => {
    // 7:42–11:05 washing, 11:05–2:00 lights, and a break from 2:00 still running.
    const loaded = [entry("a", "washing", "12:42", "16:05"), entry("b", "lights", "16:05", "19:00"), entry("c", "break", "19:00", null)];
    const result = writes(loaded, [
      { id: "a", kind: "washing", start: "07:42", end: "11:05" },
      { id: "b", kind: "lights", start: "11:05", end: "13:30" },
      { kind: "shop", start: "13:30", end: "14:00" },
    ]);
    expect(result).toEqual({
      deletes: ["c"],
      updates: [{ id: "b", category: "lights", started_at: "2026-11-18T16:05:00.000Z", ended_at: "2026-11-18T18:30:00.000Z" }],
      inserts: [{ category: "shop", started_at: "2026-11-18T18:30:00.000Z", ended_at: "2026-11-18T19:00:00.000Z" }],
    });
  });

  it("sets the clock running last, after the finished blocks", () => {
    const loaded = [entry("a", "washing", "12:00", null)];
    const result = writes(loaded, [
      { id: "a", kind: "washing", start: "08:00", end: "" },
      { kind: "shop", start: "07:00", end: "08:00" },
    ]);
    expect(result.updates).toEqual([{ id: "a", category: "washing", started_at: "2026-11-18T13:00:00.000Z", ended_at: null }]);
    expect(result.inserts).toEqual([{ category: "shop", started_at: "2026-11-18T12:00:00.000Z", ended_at: "2026-11-18T13:00:00.000Z" }]);
    // Ending a running block, and starting a new one running after it.
    const ended = writes([entry("a", "washing", "12:00", null)], [{ id: "a", kind: "washing", start: "07:00", end: "12:00" }, { kind: "lights", start: "12:00", end: "" }]);
    expect(ended.updates[0]!.ended_at).toBe("2026-11-18T17:00:00.000Z");
    expect(ended.inserts).toEqual([{ category: "lights", started_at: "2026-11-18T17:00:00.000Z", ended_at: null }]);
  });

  it("writes nothing when nothing changed", () => {
    const loaded = [entry("a", "visit", "12:00", "13:00")];
    expect(writes(loaded, [{ id: "a", kind: "visit", start: "07:00", end: "08:00" }])).toEqual({ deletes: [], updates: [], inserts: [] });
  });
});

describe("times changed by hand", () => {
  const change = (c: Partial<TimeChange>): TimeChange => ({
    id: "x", entry_id: "e", user_id: "ray", action: "changed", changed_by: "boss", source: "person", reason: null, old_started_at: null, new_started_at: null, old_ended_at: null, new_ended_at: null,
    old_category: null, new_category: null, old_visit_id: null, new_visit_id: null, old_job_id: null, new_job_id: null, old_notes: null, new_notes: null, changed_at: "2026-11-19T12:00:00Z", ...c,
  });

  it("are time typed in on Fix times, and any edit on record, on the day the time is on", () => {
    const days = handEditedDays(
      [entry("a", "washing", "12:00", "13:00"), entry("b", "lights", "14:00", "15:00", { added_by_hand: true, user_id: "sam" })],
      // A start moved to the evening before (in New York), and an entry deleted.
      [change({ new_started_at: "2026-11-17T23:30:00Z", old_started_at: "2026-11-18T12:00:00Z" }), change({ action: "deleted", user_id: "lee", old_started_at: "2026-11-16T15:00:00Z" })],
      TZ,
    );
    expect([...days].sort()).toEqual(["lee|2026-11-16", "ray|2026-11-17", "sam|2026-11-18"]);
  });

  it("aren't the office punching someone in, but are time the office added with an end", () => {
    const days = handEditedDays(
      [],
      [
        change({ action: "added", user_id: "ray", new_started_at: "2026-11-18T13:00:00Z", new_ended_at: null }),
        change({ action: "added", user_id: "sam", new_started_at: "2026-11-18T13:00:00Z", new_ended_at: "2026-11-18T15:00:00Z" }),
      ],
      TZ,
    );
    expect([...days]).toEqual(["sam|2026-11-18"]);
  });
});

describe("a brand-clock tap on the clock cards", () => {
  const running = (category: string, at: string, visit?: string): ShownClock => ({ id: `e-${at}`, category, started_at: `2026-11-18T${at}:00Z`, visit: visit ? { id: visit, title: "Smith" } : null });
  const tap = (status: string, at: string, extra: object = {}) => ({
    key: "visit-status" as const,
    change: { companyId: "c1", userId: "ray", visitId: "v1", jobId: "j1", status, at: `2026-11-18T${at}:00Z`, clock: true, brandClock: true, ...extra },
    title: "Smith",
  });

  it("shows On my way and Start visit on the job's brand on the whole-day clock, and keeps it through Complete", () => {
    expect(clockAfter(null, tap("en_route", "08:00", { day: true, brand: "lights" }), "ray")).toMatchObject({ category: "lights", visit: null });
    const washing = running("washing", "08:00");
    expect(clockAfter(washing, tap("in_progress", "09:00", { day: true, brand: "washing" }), "ray")).toBe(washing);
    expect(clockAfter(running("break", "08:30"), tap("in_progress", "09:00", { day: true, brand: "washing" }), "ray")).toMatchObject({ category: "washing", started_at: "2026-11-18T09:00:00Z" });
    expect(clockAfter(washing, tap("completed", "12:00", { day: true }), "ray")).toBe(washing);
    // Not knowing the brand yet, it shows washing.
    expect(clockAfter(null, tap("en_route", "08:00", { day: true }), "ray")).toMatchObject({ category: "washing" });
  });

  it("puts it on the visit on visits only, and Complete stops it", () => {
    const started = clockAfter(null, tap("in_progress", "09:00", { brand: "lights" }), "ray");
    expect(started).toMatchObject({ category: "lights", visit: { id: "v1", title: "Smith" } });
    expect(clockAfter(started, tap("completed", "12:00"), "ray")).toBeNull();
    // A crewmate on the visit's clock is stopped by finishing it; anyone else is left alone.
    expect(clockAfter(running("washing", "09:05", "v1"), tap("completed", "12:00"), "sam")).toBeNull();
    expect(clockAfter(running("washing", "09:05"), tap("completed", "12:00"), "sam")).toMatchObject({ category: "washing" });
  });
});
