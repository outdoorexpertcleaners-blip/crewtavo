/**
 * The time clock as the owner keeps it, copied from his own "OEC Time Clock" page by the Clock
 * screen (apps/web/src/features/clock): someone is on Pressure washing, Christmas lights or Shop /
 * other, or on a break, and a break never counts as hours worked. Pay runs in 14-day periods that
 * start on a Monday. Platform-free, so the sums, the period and the checks on "Fix times" are the
 * same wherever they're shown, and tested here.
 *
 * Time recorded before these kinds existed keeps its own (on a visit, driving, other work...): it's
 * counted as Shop / other, so a day's total is never short.
 */
import { msg } from "./i18n";
import { entrySpan, MAX_ENTRY_HOURS, mondayOf } from "./pay";
import { addDays, localDate, parseZonedTime } from "./time";

/** What the clock offers, in the order the owner's page shows them. */
export const CLOCK_KINDS = ["washing", "lights", "shop", "break"] as const;
export type ClockKind = (typeof CLOCK_KINDS)[number];
/** The kinds that are hours worked: everything but a break. */
export const WORK_KINDS = ["washing", "lights", "shop"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** Each kind's name on the clock and in the timesheet (shown with t()). */
export const CLOCK_KIND_LABELS: Record<ClockKind, string> = {
  washing: msg("Pressure washing"),
  lights: msg("Christmas lights"),
  shop: msg("Shop / other"),
  break: msg("Break (unpaid)"),
};

/** Which of the four a time entry's category counts as. Anything older is Shop / other. */
export function clockKind(category: string): ClockKind {
  return category === "washing" || category === "lights" || category === "break" ? category : "shop";
}

// ---------------------------------------------------------------------------------------------
// Pay periods and weeks
// ---------------------------------------------------------------------------------------------

/** The Monday the owner's pay periods count from, and how long each is. */
export const PAY_PERIOD_ANCHOR = "2026-09-28";
export const PAY_PERIOD_DAYS = 14;

const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/** The first day of the pay period a date is in (YYYY-MM-DD): the anchor plus whole periods, before it too. */
export function payPeriodStart(date: string, anchor = PAY_PERIOD_ANCHOR): string {
  const days = dayNumber(date) - dayNumber(anchor);
  return addDays(anchor, Math.floor(days / PAY_PERIOD_DAYS) * PAY_PERIOD_DAYS);
}

/** The days of the period starting on `start`, in order. */
export const periodDays = (start: string, length = PAY_PERIOD_DAYS) => Array.from({ length }, (_, i) => addDays(start, i));

/** Weeks start on Monday. */
export const weekStart = (date: string) => mondayOf(date);

// ---------------------------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------------------------

/** A stretch of time as the clock keeps it: a time entry's own columns. Running while `ended_at` is null. */
export interface ClockBlock {
  category: string;
  started_at: string;
  ended_at: string | null;
}

/** Hours on each kind, and the total worked (breaks left out). */
export interface Tally {
  washing: number;
  lights: number;
  shop: number;
  break: number;
  total: number;
}

export const emptyTally = (): Tally => ({ washing: 0, lights: 0, shop: 0, break: 0, total: 0 });

/** How long a block is, in hours. One still running counts up to `now`. */
export const blockHours = (block: ClockBlock, now = Date.now()) => Math.max(0, ((block.ended_at ? Date.parse(block.ended_at) : now) - Date.parse(block.started_at)) / 3_600_000);

/** The hours in some blocks, by kind. A break is kept apart and never part of the total. */
export function tally(blocks: readonly ClockBlock[], now = Date.now()): Tally {
  const out = emptyTally();
  for (const block of blocks) {
    const kind = clockKind(block.category);
    const hours = blockHours(block, now);
    out[kind] += hours;
    if (kind !== "break") out.total += hours;
  }
  return out;
}

/** Tallies added together (a week's days, a period's weeks). */
export function sumTallies(tallies: readonly Tally[]): Tally {
  const out = emptyTally();
  for (const t of tallies) for (const key of Object.keys(out) as Array<keyof Tally>) out[key] += t[key];
  return out;
}

/** Each day's tally, by the day a block started on in the company's time zone. Days with nothing are all zero. */
export function tallyByDay(blocks: readonly ClockBlock[], days: readonly string[], timeZone: string, now = Date.now()): Record<string, Tally> {
  const out: Record<string, Tally> = Object.fromEntries(days.map((d) => [d, emptyTally()]));
  const byDay = new Map<string, ClockBlock[]>();
  for (const block of blocks) {
    const day = localDate(new Date(block.started_at), timeZone);
    if (!(day in out)) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), block]);
  }
  for (const [day, list] of byDay) out[day] = tally(list, now);
  return out;
}

/** Hours as the timesheet writes them: two places, and a dash for none. */
export const hoursCell = (hours: number) => (hours >= 0.005 ? hours.toFixed(2) : "–");

/** "3h 05m" (or "45m"), as the clock says how long. */
export function hoursAndMinutes(hours: number): string {
  const minutes = Math.max(0, Math.floor(hours * 60 + 1e-9));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

// ---------------------------------------------------------------------------------------------
// Fix times: a person's blocks for one day, typed in
// ---------------------------------------------------------------------------------------------

/** One row of Fix times: the kind, and clock times ("07:42"). An empty end means still working. */
export interface FixRow {
  kind: string;
  start: string;
  end: string;
}

export interface FixedBlock {
  /** Which row it came from. */
  row: number;
  kind: string;
  startAt: Date;
  endAt: Date | null;
}

/** Why a day's rows can't be saved (shown with t()). */
export const FIX_PROBLEMS = {
  start: msg("Every block needs a start time."),
  long: msg("A block can't be longer than 16 hours."),
  future: msg("That start time hasn't happened yet."),
  dayOver: msg("Add an end time. That day is over."),
  open: msg("Only the last block can be left without an end time."),
  overlap: msg("Two blocks overlap. Change the times so they don't."),
} as const;

export type FixResult = { ok: true; blocks: FixedBlock[] } | { ok: false; problem: string; row?: number };

/**
 * A day's rows as blocks of time, or why they can't be: every block has a start; an end before
 * the start is past midnight (the next day); none is longer than 16 hours or starts in the future;
 * only the last one (by start) may be left open, and only on today; and none overlap. The blocks
 * come back in the order they start.
 */
export function checkFixTimes(rows: readonly FixRow[], options: { date: string; today: string; timeZone: string; now?: Date }): FixResult {
  const now = options.now ?? new Date();
  const blocks: FixedBlock[] = [];
  for (const [row, r] of rows.entries()) {
    if (!r.start) return { ok: false, problem: FIX_PROBLEMS.start, row };
    if (!r.end) {
      const startAt = parseZonedTime(options.date, r.start, options.timeZone);
      if (!startAt) return { ok: false, problem: FIX_PROBLEMS.start, row };
      blocks.push({ row, kind: r.kind, startAt, endAt: null });
      continue;
    }
    const span = entrySpan(options.date, r.start, r.end, options.timeZone);
    if (!span) return { ok: false, problem: FIX_PROBLEMS.start, row };
    if ((span.endAt.getTime() - span.startAt.getTime()) / 3_600_000 > MAX_ENTRY_HOURS) return { ok: false, problem: FIX_PROBLEMS.long, row };
    blocks.push({ row, kind: r.kind, startAt: span.startAt, endAt: span.endAt });
  }
  blocks.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  for (const b of blocks) if (b.startAt.getTime() > now.getTime()) return { ok: false, problem: FIX_PROBLEMS.future, row: b.row };
  const open = blocks.filter((b) => !b.endAt);
  if (open.length && options.date !== options.today) return { ok: false, problem: FIX_PROBLEMS.dayOver, row: open[0]!.row };
  if (open.length > 1 || (open.length === 1 && blocks.at(-1) !== open[0])) return { ok: false, problem: FIX_PROBLEMS.open, row: open[0]!.row };
  if (open.length && (now.getTime() - open[0]!.startAt.getTime()) / 3_600_000 > MAX_ENTRY_HOURS) return { ok: false, problem: FIX_PROBLEMS.long, row: open[0]!.row };
  for (let i = 1; i < blocks.length; i++) {
    const before = blocks[i - 1]!;
    if (blocks[i]!.startAt.getTime() < (before.endAt ?? now).getTime()) return { ok: false, problem: FIX_PROBLEMS.overlap, row: blocks[i]!.row };
  }
  return { ok: true, blocks };
}

// ---------------------------------------------------------------------------------------------
// The period's spreadsheet
// ---------------------------------------------------------------------------------------------

export interface TimesheetCsvRow {
  person: string;
  date: string;
  washing: string;
  lights: string;
  shop: string;
  total: string;
}

/** One row per person per day they worked, in the order given: hours with two places. */
export function timesheetCsvRows(people: ReadonlyArray<{ name: string; days: ReadonlyArray<{ date: string; tally: Tally }> }>): TimesheetCsvRow[] {
  return people.flatMap((p) =>
    p.days
      .filter((d) => d.tally.total >= 0.005)
      .map((d) => ({ person: p.name, date: d.date, washing: d.tally.washing.toFixed(2), lights: d.tally.lights.toFixed(2), shop: d.tally.shop.toFixed(2), total: d.tally.total.toFixed(2) })),
  );
}
