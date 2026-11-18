/**
 * Field actions that work without signal: each is a plain function of its variables (no screen
 * state), registered by name, so a queued action can still be sent after the app was closed.
 * See lib/offline.ts.
 */
import { t } from "@/lib/i18n";
import type { QueryClient } from "@tanstack/react-query";
import { api, supabase, unwrap } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { clockLost, showClockTap, startedBefore, type ClockChange } from "./clockTaps";
import { clockTravel, clockVisit, jobBrand, type ClockPlace } from "./fieldData";
import type { Brand } from "@crewtavo/core/pipeline";

export interface VisitStatusChange {
  companyId: string;
  userId: string;
  visitId: string;
  jobId: string | null;
  status: string;
  /** When it was tapped. For Complete, also when the visit was finished (visitStatusBody). */
  at: string;
  /** Where the phone was, when the tap starts or stops the clock or is On my way (useStatusTap). */
  place?: ClockPlace;
  /**
   * Whether Start and Complete clock this person in and out, decided at the tap (useStatusTap): the
   * queued send only has what was saved with it. False for a sub the office doesn't keep hours for.
   * A tap saved before this was recorded clocks, as it always did.
   */
  clock?: boolean;
  /** Tapped by a sub: if the office has since taken them off the clock, the visit still moves on. */
  sub?: boolean;
  /**
   * On the whole-day clock, decided at the tap like `clock` (fieldData.onDayClock): On my way starts
   * their clock on travel, and Complete moves it back to travel instead of stopping it.
   */
  day?: boolean;
  /**
   * A team member's brand clock (fieldData.statusChange): their clock goes on the job's brand,
   * washing or lights, instead of "On a visit" or Driving. Taps saved before it existed clock as before.
   */
  brandClock?: boolean;
  /** The job's brand, when the phone knew it at the tap; otherwise it's asked for as the tap is sent. */
  brand?: Brand;
}

/**
 * The status last tapped for a visit on this phone while that tap is still waiting to send (no
 * signal, or queued behind an earlier action). What the server says is older than that, so screens
 * show this instead; otherwise the crew would be offered a step they've already taken, and tapping
 * it would queue a step backwards.
 */
export function pendingVisitStatus(queryClient: QueryClient, visitId: string): string | undefined {
  const waiting = queryClient
    .getMutationCache()
    .findAll({ mutationKey: ["visit-status"], status: "pending" })
    .map((m) => m.state.variables as VisitStatusChange | undefined)
    .filter((v) => v?.visitId === visitId);
  return waiting.at(-1)?.status;
}

/**
 * The last checklist or notes save made on this phone for a visit that hasn't gone yet, like
 * pendingVisitStatus: the visit's screen shows it rather than the older copy the server has.
 */
export function pendingVisitSave<V extends { visitId: string }>(queryClient: QueryClient, key: "checklist-save" | "visit-notes", visitId: string): V | undefined {
  return queryClient
    .getMutationCache()
    .findAll({ mutationKey: [key], status: "pending" })
    .map((m) => m.state.variables as V | undefined)
    .filter((v): v is V => v?.visitId === visitId)
    .at(-1);
}

/** Like pendingVisitSave, for each of a visit's checklists: the last save waiting for each, by its response's id. */
export function pendingChecklistSaves(queryClient: QueryClient, visitId: string): Map<string, ChecklistSave> {
  const waiting = queryClient
    .getMutationCache()
    .findAll({ mutationKey: ["checklist-save"], status: "pending" })
    .map((m) => m.state.variables as ChecklistSave | undefined)
    .filter((v): v is ChecklistSave => v?.visitId === visitId);
  return new Map(waiting.map((v) => [v.responseId, v]));
}

/** Show a tapped status at once, on My day and on the visit's own screen alike, and what it does to the clock on the clock cards. */
export function showVisitStatus(queryClient: QueryClient, change: VisitStatusChange) {
  const title = queryClient.getQueryData<{ title?: string } | null>(["field-visit", change.visitId])?.title
    ?? queryClient.getQueriesData<{ today: Array<{ id: string; title?: string }> }>({ queryKey: ["field"] }).flatMap(([, day]) => day?.today ?? []).find((v) => v.id === change.visitId)?.title;
  queryClient.setQueriesData<{ today: Array<{ id: string; status: string }> }>({ queryKey: ["field"] }, (old) => old && { ...old, today: old.today.map((v) => (v.id === change.visitId ? { ...v, status: change.status } : v)) });
  queryClient.setQueryData<{ status: string } | null>(["field-visit", change.visitId], (old) => old && { ...old, status: change.status });
  showClockTap(queryClient, { key: "visit-status", change, title });
}

/**
 * What a status tap sends. A Complete says when it was tapped, so one that waited for signal is
 * dated when the work was done, not when it went out: autopay goes by that date. The server keeps
 * it only with Complete, and not from the future or more than a few days back.
 */
const visitStatusBody = (v: Pick<VisitStatusChange, "status" | "at" | "place">) => ({
  status: v.status,
  forward_only: true,
  ...(v.status === "completed" && { completed_at: v.at }),
  // On my way: where the phone is, only to time the drive for the client's text. The server keeps the time, not the place.
  ...(v.status === "en_route" && v.place && "lat" in v.place && { from: { lat: v.place.lat, lng: v.place.lng } }),
});

export async function setVisitStatus(v: VisitStatusChange) {
  // The visit's status is shared, but each person's clock is their own: when the visit has moved on
  // (a crewmate finished it first), this person still clocks in and out as they tapped. Only a
  // cancelled visit doesn't start a clock, and someone without a clock (a sub, mostly) has none.
  const clocks = v.clock !== false;
  // The whole-day clock: travel is on it (never a sub's, whatever the tap says).
  const day = clocks && v.day === true && !v.sub;
  let clockOff = false as boolean;
  let travel = false as boolean;
  // The brand clock: the job's brand in place of "On a visit" and Driving (asked for now if the tap didn't know it).
  const brandClock = clocks && v.brandClock === true && !v.sub;
  const clock = async (action: "start" | "stop" | "travel" | "travel from visit") => {
    try {
      // A brand the server can't say (an older server) is washing, rather than time not kept at all.
      const work = brandClock ? (v.brand ?? (await jobBrand(v.jobId).catch((): Brand => "washing"))) : null;
      if (action === "start" || action === "stop") await clockVisit(v.companyId, v.userId, { id: v.visitId, job_id: v.jobId }, action, v.at, v.place, work ?? "visit");
      else travel = await clockTravel(v.companyId, v.userId, v.at, v.place, action === "travel" ? undefined : v.visitId, work ? { category: work, jobId: v.jobId } : undefined);
    } catch (error) {
      // A sub whose clock the office turned off after this phone last heard (the database refuses
      // their time now): the visit moved on, and there's simply no clock.
      if (!(v.sub && clockRefused(error))) throw error;
      clockOff = true;
    }
  };
  // Their own clock stops (or, on the whole-day clock, moves to travel) before the visit is
  // finished, with where the phone was: finishing a visit does the same to every clock still running
  // on it (20261113000600_finished_visits_end_their_clocks.sql), and those have no place.
  if (clocks && v.status === "completed") await clock(day ? "travel from visit" : "stop");
  // As the company it was tapped in, even if the app has switched company since. Forward only: a
  // tap sent again after later ones went out (the app closed before it heard back) is skipped.
  const result = await api.patch<{ skipped?: boolean; status?: string }>(`/visits/${v.visitId}`, visitStatusBody(v), { companyId: v.companyId });
  const cancelled = Boolean(result.skipped) && result.status === "cancelled";
  // On the whole-day brand clock Start visit goes onto the job's brand like On my way, not onto the
  // visit, so it keeps running through the visit and after it.
  if (clocks && v.status === "in_progress" && !cancelled) await clock(day && brandClock ? "travel" : "start");
  // On my way starts the day's clock. Not when the visit had already moved on: that's this tap sent
  // again after the ones that followed it, and their time since is already there.
  if (day && v.status === "en_route" && !result.skipped) await clock("travel");
  return { skipped: Boolean(result.skipped), visitStatus: result.status, ...(clockOff && { clockOff }), ...(travel && { travel }) };
}

/** The database turning a clock down: row-level security on time entries. */
export const clockRefused = (error: unknown) => /row-level security|permission/i.test(error instanceof Error ? error.message : String(error));

/** What a status tap's confirmation says, once the server has it (a toast: no closing period). */
export function statusSaved(result: { skipped: boolean; visitStatus?: string; clockOff?: boolean; travel?: boolean } | undefined, change: VisitStatusChange): string {
  const clocks = change.clock !== false && !result?.clockOff;
  if (result?.skipped) return result.visitStatus === "cancelled" ? t("The office cancelled this visit") : clocks ? t("Your crew already moved this visit on, your time is saved") : t("This visit had already moved on");
  // On the whole-day clock (`travel`: their clock is on travel now) the drive is on the clock too.
  if (change.status === "en_route") return result?.travel ? t("On your way, your clock is running") : t("On your way");
  if (change.status === "in_progress") return clocks ? t("Visit started, your clock is running") : t("Visit started");
  return result?.travel ? t("Visit completed, your clock keeps running") : t("Visit completed");
}

/**
 * A clock tap from the clock card or the crew clock: start, switch or stop, for the person or for
 * the people a crew lead clocks together, dated when it was tapped. `lost` is whoever it changed
 * nothing for because a clock that began after the tap is running (clockTaps.clockLost).
 *
 * Sent late, after a spell with no signal, it still can't leave two clocks running or stop a clock
 * that started after it:
 *   - Stop ends only clocks that began before the tap, in one statement.
 *   - Start ends what was running before the tap (with where the phone was) and adds the new clock
 *     under the id the phone made for it, so the same tap sent twice adds it once.
 *   - When something newer happened meanwhile (the office or a crew lead started a clock for them
 *     after the tap), the newer clock wins. If the person's time at the tap is already on record
 *     the tap changes nothing; if not, it's saved up to where the newer clock began, which the
 *     database does for any clock that arrives late (20261112000410_one_running_clock.sql).
 * Safe to send twice.
 */
export async function setClock(v: ClockChange): Promise<{ lost: string[] }> {
  const db = supabase();
  const running = async (who: string[]) =>
    who.length ? unwrap(await db.from("time_entries").select("id, user_id, visit_id, category, started_at").eq("company_id", v.companyId).in("user_id", who).is("ended_at", null)) : [];
  // Made by the phone at a property (the clock at the property): marked so on the clocks it starts and stops.
  const stopped = { ended_at: v.at, out_place: v.place, ...(v.geofence && { geofence_out: true }) };
  if (!v.target) {
    const stop = db.from("time_entries").update(stopped).eq("company_id", v.companyId).in("user_id", v.who).is("ended_at", null).lt("started_at", v.at);
    unwrap(await (v.fromVisit ? stop.eq("visit_id", v.fromVisit) : stop));
    // Still on the clock: one that began after this Stop was tapped. Leaving a property leaves any other clock as it is.
    return { lost: [...new Set((await running(v.who)).filter((entry) => !v.fromVisit || entry.visit_id === v.fromVisit).map((entry) => entry.user_id))] };
  }
  const { target } = v;
  const ids = v.entryIds ?? {};
  // Sent before (the app closed before it heard back): those clocks are already there.
  const sent = Object.values(ids).length ? unwrap(await db.from("time_entries").select("id").in("id", Object.values(ids))).map((entry) => entry.id) : [];
  let who = v.who.filter((id) => !ids[id] || !sent.includes(ids[id]!));
  const open = await running(who);
  if (v.fromVisit) {
    // Leaving a property: only whoever's clock is still on that visit moves to travel.
    who = who.filter((id) => open.some((entry) => entry.user_id === id && entry.visit_id === v.fromVisit && startedBefore(entry, v.at)));
  }
  // The phone never ends a break by itself.
  if (v.geofence) who = who.filter((id) => !open.some((entry) => entry.user_id === id && entry.category === "break" && startedBefore(entry, v.at)));
  // Nor does it move a clock that's running on another visit, the shop or other work onto a visit
  // (arriving at a property): only a clock that's off, or on driving, starts there by itself.
  if (v.geofence && target.visit && !v.fromVisit) who = who.filter((id) => !open.some((entry) => entry.user_id === id && entry.category !== "drive" && startedBefore(entry, v.at)));
  // Already on that visit's clock (their own Start, or a crew lead clocked them in): left as it is.
  if (target.visit) who = who.filter((id) => !open.some((entry) => entry.user_id === id && entry.visit_id === target.visit!.id));
  const lost = who.filter((id) => open.some((entry) => entry.user_id === id && !startedBefore(entry, v.at)));
  if (lost.length) {
    // The newer clock wins. Whoever's time at the tap is already on record gets nothing more from it.
    const covered = unwrap(await db.from("time_entries").select("user_id").eq("company_id", v.companyId).in("user_id", lost).lte("started_at", v.at).gt("ended_at", v.at)).map((entry) => entry.user_id);
    who = who.filter((id) => !covered.includes(id));
  }
  if (!who.length) return { lost };
  unwrap(await db.from("time_entries").update(stopped).eq("company_id", v.companyId).in("user_id", who).is("ended_at", null).lt("started_at", v.at));
  try {
    unwrap(
      await db.from("time_entries").insert(
        who.map((user_id) => ({
          ...(ids[user_id] && { id: ids[user_id] }),
          company_id: v.companyId, user_id, category: target.category, visit_id: target.visit?.id ?? null, job_id: target.visit?.jobId ?? null, started_at: v.at, in_place: v.place,
          ...(v.geofence && { geofence_in: true }),
        })),
      ),
    );
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "23505")) throw error;
    // Already there under these ids: this very tap got through a moment ago (sent twice at once).
    const made = who.map((id) => ids[id]).filter((id): id is string => Boolean(id));
    const there = made.length === who.length ? unwrap(await db.from("time_entries").select("id").in("id", made)) : [];
    if (there.length < who.length) throw error;
  }
  return { lost };
}

export interface ChecklistSave {
  companyId: string;
  visitId: string;
  /** Made on the phone, so saving twice offline updates one row instead of adding two. */
  responseId: string;
  templateId: string | null;
  /**
   * Left out when the checklist is only marked done with nothing of this phone's waiting: the
   * answers saved stay as they are, a crewmate's from another phone included.
   */
  answers?: Record<string, unknown>;
  completedAt: string | null;
}

export async function saveChecklist(v: ChecklistSave) {
  unwrap(
    await supabase()
      .from("checklist_responses")
      .upsert({ id: v.responseId, company_id: v.companyId, visit_id: v.visitId, template_id: v.templateId, ...(v.answers && { answers: v.answers as never }), completed_at: v.completedAt }),
  );
}

export interface VisitNotesSave {
  visitId: string;
  notes: string | null;
  /** Where the notes were written; notes queued before it was recorded go to the company on screen. */
  companyId?: string;
}

export async function saveVisitNotes(v: VisitNotesSave) {
  await api.patch(`/visits/${v.visitId}`, { notes: v.notes }, { companyId: v.companyId });
}

export interface PhotoShareChange {
  attachmentId: string;
  shareable: boolean;
  /** Where it was tapped. */
  companyId: string;
}

/** OK to share on a photo, or not (set_photo_shareable): safe to send twice. */
export async function setPhotoShareable(v: PhotoShareChange) {
  unwrap(await supabase().rpc("set_photo_shareable", { p_attachment: v.attachmentId, p_shareable: v.shareable }));
}

export interface JobLineAdd {
  visitId: string;
  jobId: string;
  /** Made on the phone, so sending it twice adds one line (add_field_line). */
  lineId: string;
  serviceId: string;
  quantity: number;
  /** The item's name and unit, to show it on the visit while it waits: not sent, the server uses the price list's. */
  name: string;
  unit: string;
  /**
   * The job repeats, so this is extra work on this visit alone (the server decides the same): it
   * shows with the visit's extra work while it waits, not in the job's list. Not sent.
   */
  extra?: boolean;
}

/** Work added on site: the item and how many, never a price (the office's applies). Safe to send twice. */
export async function addJobLine(v: JobLineAdd) {
  unwrap(await supabase().rpc("add_field_line", { p_visit: v.visitId, p_service: v.serviceId, p_quantity: v.quantity, p_id: v.lineId }));
}

/** Everything added on this phone that hasn't gone yet. */
const pendingLineAdds = (queryClient: QueryClient): JobLineAdd[] =>
  queryClient
    .getMutationCache()
    .findAll({ mutationKey: ["job-line-add"], status: "pending" })
    .map((m) => m.state.variables as JobLineAdd | undefined)
    .filter((v): v is JobLineAdd => Boolean(v));

/** Lines added on this phone for a job that haven't gone yet, so its list of work shows them meanwhile. */
export const pendingJobLines = (queryClient: QueryClient, jobId: string): JobLineAdd[] => pendingLineAdds(queryClient).filter((v) => v.jobId === jobId && !v.extra);

/** Extra work added on this phone for a visit of a repeating job that hasn't gone yet. */
export const pendingVisitExtras = (queryClient: QueryClient, visitId: string): JobLineAdd[] => pendingLineAdds(queryClient).filter((v) => v.visitId === visitId && v.extra === true);

/** A line waiting on this phone as the job's list of work (job_scope) shows it: last, as the server adds it. */
export const waitingScopeLine = (v: JobLineAdd) => ({ id: v.lineId, name: v.name, description: null, quantity: v.quantity, unit: v.unit, sort: Number.MAX_SAFE_INTEGER });

/** A team member's name as this phone has it (the crew clock's list), for a note about their clock. */
function teamName(queryClient: QueryClient, userId: string): string {
  for (const [, options] of queryClient.getQueriesData<{ team?: Array<{ user_id: string; profile?: { full_name?: string | null } | null }> }>({ queryKey: ["dispatch-options"] })) {
    const name = options?.team?.find((t) => t.user_id === userId)?.profile?.full_name;
    if (name) return name;
  }
  return t("A crew member");
}

/**
 * Field actions wait for signal ("online" mode): with none, React Query pauses them and lib/offline.ts
 * keeps them on the phone. Every other save fails at once instead (lib/queryClient.ts).
 */
const WAIT_FOR_SIGNAL = { networkMode: "online" } as const;

export function registerFieldActions(queryClient: QueryClient) {
  queryClient.setMutationDefaults(["visit-status"], {
    ...WAIT_FOR_SIGNAL,
    mutationFn: async (v: VisitStatusChange) => {
      const result = await setVisitStatus(v);
      // Their clock was turned off: what this phone knows about them (GET /me) is out of date.
      if (result.clockOff) void queryClient.invalidateQueries({ queryKey: ["me"] });
      return result;
    },
  });
  queryClient.setMutationDefaults(["clock"], {
    ...WAIT_FOR_SIGNAL,
    mutationFn: async (v: ClockChange) => {
      const result = await setClock(v);
      // Said here, not by the screen: a tap sent after the app was closed has no screen to say it.
      const lost = clockLost(result, v, (id) => teamName(queryClient, id));
      if (lost) toast.info(lost.title, { description: lost.body, duration: 10_000 });
      return result;
    },
  });
  queryClient.setMutationDefaults(["checklist-save"], { ...WAIT_FOR_SIGNAL, mutationFn: (v: ChecklistSave) => saveChecklist(v) });
  queryClient.setMutationDefaults(["visit-notes"], { ...WAIT_FOR_SIGNAL, mutationFn: (v: VisitNotesSave) => saveVisitNotes(v) });
  queryClient.setMutationDefaults(["photo-share"], { ...WAIT_FOR_SIGNAL, mutationFn: (v: PhotoShareChange) => setPhotoShareable(v) });
  queryClient.setMutationDefaults(["job-line-add"], { ...WAIT_FOR_SIGNAL, mutationFn: (v: JobLineAdd) => addJobLine(v) });
}
