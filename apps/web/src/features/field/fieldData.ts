/** Shared helpers for the crew (field) screens. */
import { clockMode } from "@crewtavo/core/clock";
import type { Brand } from "@crewtavo/core/pipeline";
import { onlineManager, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase, unwrap } from "@/lib/api";
import { isSub, keepsTime, useSession, type Company, type Session } from "@/lib/session";
import { startedBefore, withWaitingTaps } from "./clockTaps";
import { mayUsePlace, NOT_YET } from "./locationNotice";
import type { VisitStatusChange } from "./fieldActions";

/**
 * What a clock is on. The field app offers the owner's four (core/timeclock.ts): Pressure washing
 * ("washing"), Christmas lights ("lights"), Shop / other and a break. The rest are older kinds that
 * time already on record (and a sub's clock on a visit) still has.
 */
export type TimerCategory = "visit" | "assessment" | "drive" | "shop" | "break" | "other" | "washing" | "lights";

/**
 * Where the phone was as a clock started or stopped, or why it couldn't say. Saved with the clock
 * for the office and crew leads; the person's own screens never show it.
 */
export type ClockPlace = { lat: number; lng: number; accuracy: number } | { missing: "denied" | "unavailable" | "timeout" | "unsupported" };

/** Whether the company keeps where people clock in and out (Settings → Company). On unless switched off. */
export const recordsPlaces = (company: Pick<Company, "settings">) => (company.settings?.clock as { record_location?: boolean } | undefined)?.record_location !== false;

/**
 * Where this phone is, for a clock starting or stopping. The first time, the phone asks the person.
 * A "no", or no fix within 10 seconds, is kept as the reason and the clock goes on regardless. Gives
 * up after 20 seconds even while that question is still on screen, so a clock is never held longer.
 */
export function locate(): Promise<ClockPlace> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve({ missing: "unsupported" });
  return new Promise((resolve) => {
    const stop = setTimeout(() => resolve({ missing: "timeout" }), 20_000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(stop);
        // Six places is about 10 cm; more says nothing.
        resolve({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)), accuracy: Math.round(p.coords.accuracy) });
      },
      (e) => {
        clearTimeout(stop);
        resolve({ missing: e.code === e.PERMISSION_DENIED ? "denied" : e.code === e.TIMEOUT ? "timeout" : "unavailable" });
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  });
}

/**
 * Where to say this clock tap happened: the phone's place, or nothing when the company doesn't keep
 * them. Until the person has acknowledged the notice of what's saved (locationNotice.ts) the phone
 * isn't asked where it is, and the tap says no place was found.
 */
export const clockPlace = (session: Pick<Session, "userId" | "role" | "subcontractor"> & { company: Pick<Company, "id" | "settings"> }): Promise<ClockPlace | undefined> =>
  !recordsPlaces(session.company) ? Promise.resolve(undefined) : mayUsePlace(session, "clock_location") ? locate() : Promise.resolve(NOT_YET);

/** Statuses that start or stop the person's clock on a visit (see setVisitStatus). */
export const clocksOn = (status: string) => status === "in_progress" || status === "completed";

/**
 * Whether this person is on the whole-day clock (Settings → Company → Time clock): On my way starts
 * their clock on travel, Complete visit moves it back to travel, and it runs until they stop for
 * the day. The team only: a sub's clock, when the office keeps one, runs for their visits.
 */
export const onDayClock = (session: Pick<Session, "role" | "subcontractor"> & { company: Pick<Company, "settings"> }) =>
  keepsTime(session) && !isSub(session) && clockMode(session.company.settings) === "day";

/**
 * What a status tap saves, as it was made: the time is when it was tapped, whether it clocks this
 * person in and out (not a sub without a clock), and whether they're on the whole-day clock, which
 * stay with it if it has to wait for signal. A team member's clock is the brand clock (`brandClock`):
 * it goes on the job's brand, washing or lights, never on Driving or "On a visit"; the brand is the
 * visit's when the screen knows it, else useStatusTap or the send works it out (jobBrand). `locate`: the phone's place goes with it, where the
 * company keeps where people clock in, for a tap that starts or stops the clock, and for On my way,
 * to tell the client when the crew should get there (only that time is kept, unless On my way
 * starts the whole-day clock: then it's where they clocked in).
 */
export function statusChange(
  session: Pick<Session, "role" | "subcontractor" | "userId"> & { company: Pick<Company, "id" | "settings"> },
  visit: { id: string; jobId: string | null; brand?: Brand | null },
  status: string,
  at = new Date().toISOString(),
): { change: VisitStatusChange; locate: boolean } {
  const clock = keepsTime(session);
  const brandClock = clock && !isSub(session);
  const change: VisitStatusChange = {
    companyId: session.company.id, userId: session.userId, visitId: visit.id, jobId: visit.jobId, status, at, clock, ...(isSub(session) && { sub: true }), ...(onDayClock(session) && { day: true }),
    ...(brandClock && { brandClock: true }), ...(brandClock && visit.brand && { brand: visit.brand }),
  };
  return { change, locate: ((clock && clocksOn(status)) || status === "en_route") && recordsPlaces(session.company) };
}

/**
 * Status taps on a visit, with where the phone was when the tap starts or stops the clock or is On
 * my way. Finds the place first (`locating` is the visit and status it's for, so that button can show
 * it's busy), then saves the tap as statusChange() made it.
 */
export function useStatusTap(send: (change: VisitStatusChange) => void) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [locating, setLocating] = useState<{ id: string; status: string } | null>(null);
  const tap = async (visit: { id: string; jobId: string | null; brand?: Brand | null }, status: string) => {
    const { change, locate: withPlace } = statusChange(session, visit, status);
    // The job's brand, asked for alongside the place, so the clock cards show the right one at once.
    const brand = change.brandClock && !change.brand ? brandAtTap(queryClient, visit.jobId) : null;
    if (withPlace && !mayUsePlace(session, "clock_location")) {
      // Not told yet what's saved: the tap goes through with no place, and the phone isn't asked for one.
      change.place = NOT_YET;
    } else if (withPlace) {
      setLocating({ id: visit.id, status });
      change.place = await locate();
      setLocating(null);
    }
    if (brand) {
      setLocating({ id: visit.id, status });
      const known = await brand;
      setLocating(null);
      if (known) change.brand = known;
    }
    send(change);
  };
  return { tap, locating };
}

/** A job's brand (public.job_brand: the crew reads no quotes or prices, so it's just the word). Washing when nothing says, or no job. */
export async function jobBrand(jobId: string | null): Promise<Brand> {
  if (!jobId) return "washing";
  const brand = unwrap(await supabase().rpc("job_brand", { p_job: jobId }));
  return brand === "lights" ? "lights" : "washing";
}

/**
 * A job's brand for a tap being made: as this phone last heard it, or asked for now when there's
 * signal (a few seconds at most). Undefined when it can't say yet: the tap is sent without it and
 * setVisitStatus asks once it goes, so the time is still on the right brand.
 */
async function brandAtTap(queryClient: QueryClient, jobId: string | null): Promise<Brand | undefined> {
  if (!jobId) return "washing";
  const key = ["job-brand", jobId];
  const known = queryClient.getQueryData<Brand>(key);
  if (known) return known;
  if (!onlineManager.isOnline()) return undefined;
  const asked = queryClient.fetchQuery({ queryKey: key, queryFn: () => jobBrand(jobId), staleTime: Infinity }).catch(() => undefined);
  return Promise.race([asked, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3_000))]);
}

/**
 * Start or stop the signed-in person's clock for a visit. Only one clock runs at a time. `at` is
 * when it happened, which matters when the tap was made offline and is only being sent now, and
 * `place` is where the phone was then. The clock it stops here gets the place too; one this phone
 * didn't see (started on another phone a moment ago) is stopped by the database as the new one
 * starts, which never turns the start away (20261112000410_one_running_clock.sql).
 */
export async function clockVisit(companyId: string, userId: string, visit: { id: string; job_id: string | null }, action: "start" | "stop", at = new Date().toISOString(), place?: ClockPlace, category: TimerCategory = "visit") {
  const db = supabase();
  const open = unwrap(await db.from("time_entries").select("id, visit_id, started_at").eq("user_id", userId).eq("company_id", companyId).is("ended_at", null));
  const now = at;
  if (action === "start") {
    if (open.some((entry) => entry.visit_id === visit.id)) return;
    // Their own Start sent again after they finished (the app closed before it heard back): their
    // time for it is already there.
    const recorded = unwrap(await db.from("time_entries").select("id").eq("user_id", userId).eq("company_id", companyId).eq("visit_id", visit.id).lte("started_at", now).gt("ended_at", now).limit(1));
    if (recorded.length) return;
  }
  for (const entry of open) {
    // A clock started after `at` (another queued action ran first) can't end before it began.
    if (!startedBefore(entry, now)) continue;
    unwrap(await db.from("time_entries").update({ ended_at: now, out_place: place }).eq("id", entry.id));
  }
  if (action === "start") {
    unwrap(await db.from("time_entries").insert({ company_id: companyId, user_id: userId, visit_id: visit.id, job_id: visit.job_id, category, started_at: now, in_place: place }));
  }
}

/**
 * The whole-day clock's travel (Driving, on no visit or job) for the signed-in person, from `at`.
 * Returns whether they're on travel afterwards.
 *
 * On my way: whatever they were on stops and travel starts, unless they're driving already.
 * Complete visit (`fromVisit`): only their clock on that visit moves to travel. One on a break or
 * on other work stays as it is, and no clock stays no clock: the day starts with On my way or
 * Start visit, not with finishing one. (Everyone else on the visit's clock is moved by the
 * database as the visit is finished: 20261113000610_whole_day_clock.sql.)
 *
 * On the brand clock (`work`) the same steps put them on the job's brand instead of Driving, with
 * the job: On my way and Start visit both go onto it, unless they're on it already, and Complete
 * leaves it running. It isn't tied to the visit, so finishing the visit doesn't end it.
 */
export async function clockTravel(companyId: string, userId: string, at: string, place?: ClockPlace, fromVisit?: string, work?: { category: TimerCategory; jobId: string | null }): Promise<boolean> {
  const db = supabase();
  const category = work?.category ?? "drive";
  const open = unwrap(await db.from("time_entries").select("id, visit_id, category, started_at").eq("user_id", userId).eq("company_id", companyId).is("ended_at", null));
  const driving = open.some((entry) => entry.category === category && !entry.visit_id);
  if (driving) return true;
  if (!fromVisit) {
    // Their own On my way sent again after they'd moved on (the app closed before it heard back): that travel is already there.
    const recorded = unwrap(await db.from("time_entries").select("id").eq("user_id", userId).eq("company_id", companyId).eq("category", category).eq("started_at", at).limit(1));
    if (recorded.length) return false;
  }
  const leaving = (fromVisit ? open.filter((entry) => entry.visit_id === fromVisit) : open).filter((entry) => startedBefore(entry, at));
  if (fromVisit && !leaving.length) return false;
  for (const entry of leaving) unwrap(await db.from("time_entries").update({ ended_at: at, out_place: place }).eq("id", entry.id));
  unwrap(await db.from("time_entries").insert({ company_id: companyId, user_id: userId, category, started_at: at, in_place: place, ...(work?.jobId && { job_id: work.jobId }) }));
  return true;
}

/**
 * The clock currently running for me, if any, with the taps still waiting on this phone on top
 * (clockTaps.ts): what the server says is older than those. `enabled` is false for someone without
 * a clock (a sub, mostly).
 */
export function useRunningTimer(companyId: string, userId: string, enabled = true) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["running-timer", companyId, userId],
    enabled,
    refetchInterval: 60_000,
    queryFn: async () => {
      const running =
        unwrap(
          await supabase()
            .from("time_entries")
            .select("id, category, started_at, visit:visits(id, title)")
            .eq("company_id", companyId)
            .eq("user_id", userId)
            .is("ended_at", null)
            .order("started_at", { ascending: false })
            .limit(1),
        )[0] ?? null;
      return withWaitingTaps(queryClient, companyId, userId, running);
    },
  });
}

/** "1h 05m" that ticks every 30 seconds. */
export function useElapsed(since: string | null | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return "";
  return formatDuration(now - Date.parse(since));
}

export function formatDuration(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export { CLOCK_LABELS as CATEGORY_LABELS } from "./clockTaps";
