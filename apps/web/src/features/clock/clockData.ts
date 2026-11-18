/**
 * What the Clock screen reads and writes: someone's time for a week or a pay period, the team's
 * running clocks, punches (the same offline-safe clock taps as the clock card: clockTaps.ts and
 * fieldActions.setClock), and saving a day's blocks from Fix times.
 *
 * "Changed by hand" (the • on the timesheet) is time typed in on Fix times (time_entries.added_by_hand)
 * or any edit on record for it (time_entry_changes with `edit`: time added for someone, a start moved,
 * a finished entry changed, an entry deleted). A tap, and the clock simply running its course, isn't:
 * nor is the office punching someone in, though the record keeps that as time added for them.
 */
import { localDate, zonedTimeToUtc } from "@crewtavo/core/time";
import type { FixedBlock } from "@crewtavo/core/timeclock";
import { onlineManager, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase, unwrap } from "@/lib/api";
import { addDaysIso } from "@/lib/format";
import { t } from "@/lib/i18n";
import { FIELD_SCOPE } from "@/lib/offline";
import { everyRow } from "@/lib/paging";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { clockChange, clockSaved, showClockTap, type ClockChange, type ClockTarget } from "../field/clockTaps";
import { clockPlace, onDayClock, type ClockPlace } from "../field/fieldData";
import { loadWeekEdits, type TimeChange } from "../timesheets/timeChanges";

/** A time entry as the Clock shows it. */
export interface ClockEntry {
  id: string;
  user_id: string;
  category: string;
  started_at: string;
  ended_at: string | null;
  approved_at: string | null;
  added_by_hand: boolean;
}

const COLUMNS = "id, user_id, category, started_at, ended_at, approved_at, added_by_hand";

/** The instants a run of days starts and ends at, in the company's zone. */
export const daysSpan = (from: string, days: number, timeZone: string) => [zonedTimeToUtc(from, "00:00", timeZone).toISOString(), zonedTimeToUtc(addDaysIso(from, days), "00:00", timeZone).toISOString()] as const;

/**
 * Time that started in a run of days, oldest first: one person's, or the whole company's (whoever
 * the database lets the reader see). Read a page at a time: a period of a busy team is more than
 * the database sends at once.
 */
export async function loadTime({ companyId, userId, from, days, timeZone }: { companyId: string; userId?: string; from: string; days: number; timeZone: string }): Promise<ClockEntry[]> {
  const [start, end] = daysSpan(from, days, timeZone);
  const rows = await everyRow(
    () => {
      const q = supabase().from("time_entries").select(COLUMNS).eq("company_id", companyId).gte("started_at", start).lt("started_at", end);
      return userId ? q.eq("user_id", userId) : q;
    },
    { order: "started_at" },
  );
  return rows as unknown as ClockEntry[];
}

/** The edits on record for time that started in a run of days (the • on the timesheet). */
export async function loadEdits(companyId: string, from: string, days: number, timeZone: string): Promise<TimeChange[]> {
  const [start, end] = daysSpan(from, days, timeZone);
  return loadWeekEdits(companyId, start, end);
}

/** The days (YYYY-MM-DD, in the company's zone) that have time changed by hand, by person: "<user>|<day>". */
export function handEditedDays(entries: readonly ClockEntry[], edits: readonly TimeChange[], timeZone: string): Set<string> {
  const days = new Set<string>();
  for (const e of entries) if (e.added_by_hand) days.add(`${e.user_id}|${localDate(new Date(e.started_at), timeZone)}`);
  for (const c of edits) {
    // A clock started running for someone else (the office's or a crew lead's punch buttons) is on
    // record as an added entry, but it's a tap, not time typed in. Time added for someone by hand
    // always has an end (Timesheets), or is marked added_by_hand (Fix times).
    if (c.action === "added" && !c.new_ended_at) continue;
    // Where the entry starts now, or started before it was deleted.
    const at = c.new_started_at ?? c.old_started_at;
    if (at) days.add(`${c.user_id}|${localDate(new Date(at), timeZone)}`);
  }
  return days;
}

// ---------------------------------------------------------------------------------------------
// Punches
// ---------------------------------------------------------------------------------------------

/**
 * Clock someone in, switch them or clock them out: a clock tap like the clock card's, saved on the
 * phone with when it was tapped and sent when there's signal, and kept to one running clock by the
 * database. Someone's own tap carries where the phone was (where the company keeps that); the
 * office punching for someone else sends none, since that's where the office is, not the person.
 */
export function usePunch(nameOf?: (userId: string) => string) {
  const session = useSession();
  const queryClient = useQueryClient();
  const day = onDayClock(session);
  const action = useMutation({
    mutationKey: ["clock"],
    scope: FIELD_SCOPE,
    meta: { success: (result: { lost: string[] }, change: ClockChange) => clockSaved(result, change, { day, nameOf }) },
    onMutate: (change: ClockChange) => {
      if (!onlineManager.isOnline()) toast.info(t("Saved on this phone"), { description: t("It sends when you have signal.") });
      showClockTap(queryClient, { key: "clock", change });
    },
    onSettled: () => {
      for (const k of ["running-timer", "time", "field", "field-visit", "crew-clock"]) void queryClient.invalidateQueries({ queryKey: [k] });
    },
  });
  // Whose punch is on its way (finding where the phone is comes first, and the tap is dated before it).
  const [locating, setLocating] = useState<string | null>(null);
  const punch = async (userId: string, target: ClockTarget | null) => {
    const at = new Date().toISOString();
    let place: ClockPlace | undefined;
    if (userId === session.userId) {
      setLocating(userId);
      place = await clockPlace(session);
      setLocating(null);
    }
    action.mutate(clockChange(session, [userId], target, place, at));
  };
  // A tap waiting for signal isn't busy: the buttons are free for the next.
  const busy = (userId: string) => locating === userId || (action.isPending && !action.isPaused && Boolean(action.variables?.who.includes(userId)));
  return { punch, busy };
}

// ---------------------------------------------------------------------------------------------
// Fix times
// ---------------------------------------------------------------------------------------------

/** A Fix times row as it's edited: the entry it came from, if any, and its kind and clock times. */
export interface FixDraft {
  /** The entry it shows, or none for a block added here. */
  id?: string;
  kind: string;
  start: string;
  end: string;
}

/** What saving a day's rows does to its entries, in an order the one-running-clock rule is happy with. */
export interface FixWrites {
  deletes: string[];
  updates: Array<{ id: string; category: string; started_at: string; ended_at: string | null }>;
  inserts: Array<{ category: string; started_at: string; ended_at: string | null }>;
}

const sameInstant = (a: string | null, b: string | null) => (a == null || b == null ? a == b : Date.parse(a) === Date.parse(b));

/**
 * The writes that make a day's entries match its checked blocks (core checkFixTimes): entries left
 * out are deleted, ones that changed are updated, and blocks added here are inserted. Deletes go
 * first, then the finished blocks, and the one still running last, so a clock is never set running
 * while another of theirs still runs past it.
 */
export function fixTimesWrites(loaded: readonly ClockEntry[], drafts: readonly FixDraft[], blocks: readonly FixedBlock[]): FixWrites {
  const kept = new Set(drafts.map((d) => d.id).filter((id): id is string => Boolean(id)));
  const writes: FixWrites = { deletes: loaded.filter((e) => !kept.has(e.id)).map((e) => e.id), updates: [], inserts: [] };
  const open = (b: { ended_at: string | null }) => (b.ended_at ? 0 : 1);
  for (const block of blocks) {
    const id = drafts[block.row]?.id;
    const row = { category: block.kind, started_at: block.startAt.toISOString(), ended_at: block.endAt?.toISOString() ?? null };
    const before = id ? loaded.find((e) => e.id === id) : undefined;
    if (!before) writes.inserts.push(row);
    else if (before.category !== row.category || !sameInstant(before.started_at, row.started_at) || !sameInstant(before.ended_at, row.ended_at)) writes.updates.push({ id: before.id, ...row });
  }
  writes.updates.sort((a, b) => open(a) - open(b));
  writes.inserts.sort((a, b) => open(a) - open(b));
  return writes;
}

/**
 * Save a day's writes. Edits go with an empty reason, so the record of changes knows they were
 * edits (the • on the timesheet) rather than the clock running its course, and the person whose time
 * it is gets told when it's someone else. Added time is marked as typed in.
 */
export async function saveFixTimes(companyId: string, userId: string, writes: FixWrites) {
  const db = supabase();
  for (const id of writes.deletes) unwrap(await db.rpc("delete_time_entry", { p_entry: id, p_reason: "" }));
  for (const u of writes.updates) {
    unwrap(await db.from("time_entries").update({ category: u.category, started_at: u.started_at, ended_at: u.ended_at, auto_stopped_at: null, change_reason: "" }).eq("id", u.id));
  }
  for (const i of writes.inserts) unwrap(await db.from("time_entries").insert({ ...i, company_id: companyId, user_id: userId, added_by_hand: true }));
}
