/**
 * The clock at the property (settings.clock.geofence; Settings → Company → Time clock): the phone
 * notices when the person arrives at a visit's property and when they leave it, and either asks
 * them (remind) or starts their clock itself and, on the whole-day clock, moves it to travel as
 * they leave (clock), as their own tap would.
 *
 * Crewtavo is a web app, so the phone only says where it is while Crewtavo is open on it: phones
 * pause a web page in the background. Everything here is pure (fixes in, what to do out) so the
 * browser part only finds the position and carries out what this decides (features/field/
 * geofence.ts). The position is compared on the phone and never kept by this; a tap it makes saves
 * where the phone was only when the company keeps that (settings.clock.record_location).
 *
 *   Arriving   Two fixes in a row inside the radius, each sure to within the radius. Dated at the
 *              first of them. A fix that isn't one of those starts the count again.
 *   Leaving    Fixes clearly outside the radius plus a margin (and outside the radius whatever the
 *              phone's error) for a few minutes, close together in time. Dated at the first fix
 *              outside of that run. Fixes in between neither confirm nor cancel it; a fix back
 *              inside cancels it; and after a gap (the phone was locked: they may have come back
 *              and worked on) the run starts again, so a stop is never dated from an old fix.
 *   Once       Each arrival is acted on once: the next needs leaving first.
 *   Taps win   A tap the person makes on a visit while there (Start, Stop, a timer, Complete) means
 *              they're running their own clock: the geofence only asks, for that visit, until they
 *              leave and come back.
 *   Never off  The phone never takes anyone off the clock by itself. Travel from one job site to
 *              the next during the day is working time (29 CFR 785.38), and so is a run to the
 *              supplier mid-job, and the phone can't tell those from going home. On the whole-day
 *              clock, leaving moves their clock onto travel, which is paid. On the visits-only
 *              clock there is no travel to move it onto, so it asks "Stop your clock?" and the
 *              clock runs on until they answer.
 *   One clock  The phone starts a clock by itself only when theirs is off or on driving, and only
 *              at their next visit (or one already under way, or that they're on their way to).
 *              It never moves a clock that's running on one visit, the shop or anything else onto
 *              another visit: it asks. Once it's sure they left the visit their clock was on and
 *              has moved it to travel there (the whole-day clock), and they've been at another
 *              visit's property a couple of minutes, it starts their clock on that one.
 *   One at a   Two visits at one address, or with circles that overlap: one is put to the person,
 *   time       and the other waits until that question is answered or dismissed, then gets its own.
 *
 * It all goes by when the phone notices, which is when Crewtavo is open on it: an arrival is
 * dated at the first fix there, not when they pulled in, and a departure at the first fix away.
 */
import { haversineM } from "./geo";

export type GeofenceMode = "off" | "remind" | "clock";

export const GEOFENCE_MODE_LABELS: Record<GeofenceMode, string> = {
  off: "Off",
  remind: "Remind the crew",
  clock: "Start and stop the clock",
};

/** One line under the setting for each choice. */
export const GEOFENCE_MODE_HINTS: Record<GeofenceMode, string> = {
  off: "The clock starts and stops only when someone taps.",
  remind: "When someone's phone notices them at a visit's property, it asks them to start the visit; when it notices they've left, to complete it or stop their clock.",
  clock:
    "When someone's phone notices them at their next visit's property, it starts their clock if it's off or on driving. The phone never takes anyone off the clock by itself. When it notices they've left: on the \"Whole day\" clock it moves their clock to driving, which is still paid time; on the \"Visits only\" clock it asks \"Stop your clock?\" and the clock keeps running until they answer. It never moves a running clock from one visit to another by itself: it asks. They're still asked to start and complete the visit.",
};

/** Said with either choice that's on: what a web app can and can't do, and what that does to the times. */
export const GEOFENCE_NOTE =
  "This goes by when the phone notices, and it only notices while the app is open on it: phones pause it in the background. Someone who pulls in at 8:00 and opens the app at 8:40 is at the property from 8:40, and leaving is noticed when they next open it. For exact times, have the crew tap the clock.";

export const GEOFENCE_RADIUS = { min: 100, max: 500, default: 200 } as const;

export interface Geofence {
  mode: GeofenceMode;
  /** Metres from the property's point. */
  radius: number;
}

/** The company's choice, from its settings. Off unless the office turned it on. */
export function geofence(settings: unknown): Geofence {
  const clock = (settings as { clock?: unknown } | null | undefined)?.clock;
  const saved = clock && typeof clock === "object" ? (clock as { geofence?: unknown }).geofence : null;
  const g = saved && typeof saved === "object" ? (saved as { mode?: unknown; radius?: unknown }) : {};
  const mode: GeofenceMode = g.mode === "remind" || g.mode === "clock" ? g.mode : "off";
  return { mode, radius: geofenceRadius(g.radius) };
}

/** A radius as saved, kept to 100 to 500 metres; 200 when it isn't a number. */
export function geofenceRadius(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return GEOFENCE_RADIUS.default;
  return Math.round(Math.min(GEOFENCE_RADIUS.max, Math.max(GEOFENCE_RADIUS.min, n)));
}

/** How far past the radius counts as gone: half the radius, at least 50 m. */
export const leaveMargin = (radius: number) => Math.max(50, radius / 2);
/** How long fixes have to stay outside before it counts as leaving. */
export const LEAVE_AFTER_MS = 3 * 60_000;
/** Two fixes further apart than this aren't "in a row": the person may have left and come back between (or, for fixes outside, come back and worked on). */
export const IN_A_ROW_MS = 10 * 60_000;
/** How long someone has been at another visit's property before a clock the phone stopped at the last one starts there: longer than driving past. */
export const STAYED_MS = 2 * 60_000;

/** Where the phone was: what the browser's geolocation gives, with when (milliseconds). */
export interface Fix {
  lat: number;
  lng: number;
  /** Metres, as the phone reports it. */
  accuracy: number;
  at: number;
}

/** A visit the person is on today, at a property with a point on the map. */
export interface GeofenceSite {
  visitId: string;
  lat: number;
  lng: number;
  /** The street line, for "You're at 12 Oak St". */
  place: string;
  status: string;
}

/** What the geofence knows about one visit's property. */
export interface SiteTrack {
  where: "unknown" | "inside" | "outside";
  /** Good fixes inside in a row, and when the first of them was taken. */
  inRow: number;
  firstIn: number | null;
  /** While inside: when the first fix clearly outside, of the run of them going on now, was taken. */
  outSince: number | null;
  /** The latest fix clearly outside in that run. One much later starts the run again. (Not in what a phone kept from before this.) */
  outLast?: number | null;
  /** While inside: when they arrived, as the arrival was dated. */
  arrivedAt?: number | null;
  /** Arrived, but not put to the person yet: another visit's question at the same spot came first. */
  held?: boolean;
  /** The person tapped on this visit while there (or before the phone knew where it was). */
  tapped: boolean;
}

/** Kept on the phone between fixes (and across the page reloading), per person and day. */
export interface GeofenceState {
  /** The last fix taken, so one older or the same is skipped. */
  last: number | null;
  sites: Record<string, SiteTrack>;
}

export const emptyGeofence = (): GeofenceState => ({ last: null, sites: {} });

const fresh = (): SiteTrack => ({ where: "unknown", inRow: 0, firstIn: null, outSince: null, tapped: false });

export interface GeofenceEvent {
  kind: "arrived" | "left";
  visitId: string;
  /** When: the first fix inside, or the first fix outside. */
  at: number;
  /** The person tapped on the visit while there: their clock is theirs to run. */
  tapped: boolean;
}

const distance = (fix: Pick<Fix, "lat" | "lng">, site: Pick<GeofenceSite, "lat" | "lng">) => haversineM([fix.lng, fix.lat], [site.lng, site.lat]);

/** Whether a fix is clearly inside the radius. */
export const fixInside = (fix: Fix, site: Pick<GeofenceSite, "lat" | "lng">, radius: number) => fix.accuracy <= radius && distance(fix, site) <= radius;

/** Whether a fix is clearly outside: past the margin, and past the radius even if the phone is out by its whole error. */
export function fixOutside(fix: Fix, site: Pick<GeofenceSite, "lat" | "lng">, radius: number): boolean {
  const d = distance(fix, site);
  return d > radius + leaveMargin(radius) && d - fix.accuracy > radius;
}

const usable = (fix: Fix) => [fix.lat, fix.lng, fix.accuracy, fix.at].every(Number.isFinite) && fix.accuracy >= 0 && Math.abs(fix.lat) <= 90 && Math.abs(fix.lng) <= 180;

/**
 * One fix against each visit's property: the state after it, and the arrivals and departures it
 * confirms. A fix that's older than the last one, or makes no sense, changes nothing.
 */
export function trackFix(state: GeofenceState, fix: Fix, sites: readonly GeofenceSite[], radius: number): { state: GeofenceState; events: GeofenceEvent[] } {
  if (!usable(fix) || (state.last != null && fix.at <= state.last)) return { state, events: [] };
  const events: GeofenceEvent[] = [];
  const next: Record<string, SiteTrack> = { ...state.sites };
  for (const site of sites) {
    if (![site.lat, site.lng].every(Number.isFinite)) continue;
    const t: SiteTrack = { ...(next[site.visitId] ?? fresh()) };
    const inside = fixInside(fix, site, radius);
    const outside = fixOutside(fix, site, radius);
    if (inside) {
      // The last good fix inside was a while ago: this one starts a new run.
      const stale = t.inRow > 0 && t.firstIn != null && state.last != null && fix.at - state.last > IN_A_ROW_MS;
      if (t.inRow === 0 || stale) {
        t.inRow = 1;
        t.firstIn = fix.at;
      } else {
        t.inRow += 1;
      }
      t.outSince = null;
      t.outLast = null;
      if (t.where !== "inside" && t.inRow >= 2) {
        t.where = "inside";
        t.arrivedAt = t.firstIn ?? fix.at;
        t.held = false;
        events.push({ kind: "arrived", visitId: site.visitId, at: t.arrivedAt, tapped: t.tapped });
      }
    } else {
      t.inRow = 0;
      t.firstIn = null;
      if (outside) {
        if (t.where === "inside") {
          const lastOut = t.outLast ?? t.outSince;
          // The first fix outside, or the first in a while: the phone was locked in between, and
          // they may have come back and worked on. This one starts the run, so a departure is
          // never dated from the old fix (hours of work would come off their clock).
          if (t.outSince == null || lastOut == null || fix.at - lastOut > IN_A_ROW_MS) {
            t.outSince = fix.at;
            t.outLast = fix.at;
          } else if (fix.at - t.outSince >= LEAVE_AFTER_MS) {
            events.push({ kind: "left", visitId: site.visitId, at: t.outSince, tapped: t.tapped });
            t.where = "outside";
            t.outSince = null;
            t.outLast = null;
            t.arrivedAt = null;
            t.held = false;
            // Gone: next time they come, the geofence acts again.
            t.tapped = false;
          } else {
            t.outLast = fix.at;
          }
        } else {
          t.where = "outside";
          t.tapped = false;
        }
      }
    }
    next[site.visitId] = t;
  }
  return { state: { last: fix.at, sites: next }, events };
}

/**
 * The person tapped on these visits themselves (a status tap, or a clock tap while their clock was
 * on one of them). While they're there, or the phone doesn't know yet, the geofence leaves those
 * visits' clocks to them until they leave and come back. A tap made on the way there changes nothing:
 * arriving is coming back.
 */
export function noteTap(state: GeofenceState, visitIds: readonly string[]): GeofenceState {
  const sites = { ...state.sites };
  for (const id of visitIds) {
    const t = sites[id] ?? fresh();
    if (t.where !== "outside") sites[id] = { ...t, tapped: true };
  }
  return { ...state, sites };
}

/** Forgets visits that aren't today's any more (finished days, a visit moved off today). */
export function keepSites(state: GeofenceState, visitIds: readonly string[]): GeofenceState {
  const keep = new Set(visitIds);
  return { ...state, sites: Object.fromEntries(Object.entries(state.sites).filter(([id]) => keep.has(id))) };
}

/** What the person's clock is on now, as the clock card shows it (with taps still waiting). */
export interface ClockNow {
  category: string;
  visitId: string | null;
}

export type GeofenceAction =
  /** Start their clock on the visit, dated `at`, as the clock card's tap would. */
  | { kind: "start-clock"; visitId: string; at: number }
  /**
   * Move their clock off the visit and onto travel, dated `at`. Only on the whole-day clock, so
   * `travel` is always true: on the visits-only clock that would take them off the clock, and the
   * phone asks instead (ask-finish with stopClock).
   */
  | { kind: "stop-clock"; visitId: string; at: number; travel: true }
  /** "You're at 12 Oak St. Start the visit?" (or, with the visit under way, "Start your clock?"). */
  | { kind: "ask-start"; visitId: string; clockOnly: boolean }
  /** "Leaving 12 Oak St. Complete the visit, or stop your clock?": either part, as it applies. */
  | { kind: "ask-finish"; visitId: string; complete: boolean; stopClock: boolean };

/** A visit whose property the person is at now, as the tracker has it after the fix. */
export interface Stay {
  visitId: string;
  /** When they arrived, as the arrival was dated. */
  since: number;
  tapped: boolean;
  /** The latest fix was inside (not on their way out). */
  inNow: boolean;
  /** Arrived, and still to be put to them. */
  held: boolean;
}

export interface ActionContext {
  mode: GeofenceMode;
  /** Today's visits in the day's order, which says which one is next. */
  sites: readonly GeofenceSite[];
  clock: ClockNow | null;
  /** On the whole-day clock: leaving moves the clock to travel. Otherwise leaving only asks. */
  day: boolean;
  /** When the fix was taken. A clock started for an arrival that waited its turn is dated then, not back at the arrival. */
  now?: number;
  /** Where they are now (stays). Without it only what the fix confirmed is acted on. */
  here?: readonly Stay[];
  /** Visits whose "Start the visit?" is still on the screen. */
  asking?: readonly string[];
}

/** The visits whose property the person is at, from what the tracker knows. */
export function stays(state: GeofenceState): Stay[] {
  return Object.entries(state.sites)
    .filter(([, t]) => t.where === "inside")
    .map(([visitId, t]) => ({ visitId, since: t.arrivedAt ?? t.firstIn ?? state.last ?? 0, tapped: t.tapped, inNow: t.inRow > 0, held: t.held === true }));
}

const DONE = new Set(["completed", "cancelled"]);
const NOT_STARTED = new Set(["scheduled", "en_route"]);
/** Which visit to act on when two properties are the same (two visits at one address): the one under way, else on its way, else the first in the day's order. */
const RANK: Record<string, number> = { in_progress: 0, en_route: 1, scheduled: 2 };

/** A clock the phone may start a visit's clock over: none, or driving. Anything else is theirs to move. */
const clockFree = (clock: ClockNow | null) => clock == null || (clock.category === "drive" && !clock.visitId);

/**
 * Whether a visit is where they'd be expected next: under way, or they said they're on their way,
 * or the first in the day's order that hasn't started. The phone starts a clock by itself only
 * there, so driving past a later visit's property never starts its clock.
 */
function isNext(site: GeofenceSite, sites: readonly GeofenceSite[]): boolean {
  if (site.status !== "scheduled") return true;
  return sites.find((s) => NOT_STARTED.has(s.status))?.visitId === site.visitId;
}

/**
 * What to do about what a fix confirmed, and which arrivals wait their turn (`held`). Never twice
 * for one arrival (trackFix and geofenceStep see to that), never a clock on a finished or
 * cancelled visit, never over a clock that's running on anything but driving, never against a
 * tap the person made there, never taking them off the clock (leaving moves it to travel on the
 * whole-day clock, and is a question on the visits-only one), and never finishing a visit: that,
 * and starting one (which can text the client), is always the person's tap.
 */
function decide(events: readonly GeofenceEvent[], ctx: ActionContext): { actions: GeofenceAction[]; held: string[] } {
  if (ctx.mode === "off") return { actions: [], held: [] };
  const site = (id: string) => ctx.sites.find((s) => s.visitId === id);
  const byTurn = (a: GeofenceSite, b: GeofenceSite) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3) || ctx.sites.indexOf(a) - ctx.sites.indexOf(b);
  const here = ctx.here ?? [];
  const actions: GeofenceAction[] = [];
  let clock = ctx.clock;
  /** When the phone moved their clock to travel at a property they left, from this fix. */
  let stoppedAt: number | null = null;
  const gone = new Set<string>();

  // Leaving first: a fix can show them gone from one property and at the next.
  for (const e of events.filter((x) => x.kind === "left")) {
    gone.add(e.visitId);
    const s = site(e.visitId);
    if (!s || DONE.has(s.status)) continue;
    const clockOn = clock?.visitId === e.visitId;
    // Only onto travel, which is paid. With no travel to move it onto (the visits-only clock) the
    // phone would be taking working time off the clock: the drive to the next site, or to the
    // supplier and back. It asks instead (stopClock below), and the clock runs until they answer.
    const stops = ctx.mode === "clock" && ctx.day && !e.tapped && clockOn;
    if (stops) {
      actions.push({ kind: "stop-clock", visitId: e.visitId, at: e.at, travel: true });
      clock = { category: "drive", visitId: null };
      stoppedAt = Math.max(stoppedAt ?? e.at, e.at);
    }
    const complete = s.status === "in_progress";
    const stopClock = clockOn && !stops;
    if (complete || stopClock) actions.push({ kind: "ask-finish", visitId: e.visitId, complete, stopClock });
  }

  // Arrivals this fix confirmed, then ones that were waiting their turn (dated now: things have moved on since).
  const fresh = events.filter((x) => x.kind === "arrived").map((e) => ({ visitId: e.visitId, at: e.at, tapped: e.tapped }));
  const waiting = here.filter((h) => h.held && !fresh.some((f) => f.visitId === h.visitId)).map((h) => ({ visitId: h.visitId, at: ctx.now ?? h.since, tapped: h.tapped }));
  const arrivals = [...fresh, ...waiting]
    .map((e) => ({ e, s: site(e.visitId) }))
    .filter((x): x is { e: (typeof fresh)[number]; s: GeofenceSite } => Boolean(x.s) && !DONE.has(x.s!.status))
    .sort((a, b) => byTurn(a.s, b.s));
  // A start question still showing for another visit they're at: the next one waits for it.
  const asking = (ctx.asking ?? []).filter((id) => here.some((h) => h.visitId === id));
  const held: string[] = [];
  let asked = false;
  let started = false;
  for (const { e, s } of arrivals) {
    if (asked || asking.some((id) => id !== e.visitId)) {
      held.push(e.visitId);
      continue;
    }
    const clockOn = clock?.visitId === e.visitId;
    const starts = ctx.mode === "clock" && !e.tapped && !clockOn && clockFree(clock) && isNext(s, ctx.sites);
    if (starts) {
      actions.push({ kind: "start-clock", visitId: e.visitId, at: e.at });
      clock = { category: "visit", visitId: e.visitId };
      started = true;
    }
    if (NOT_STARTED.has(s.status)) {
      actions.push({ kind: "ask-start", visitId: e.visitId, clockOnly: false });
      asked = true;
    } else if (!clockOn && !starts) {
      actions.push({ kind: "ask-start", visitId: e.visitId, clockOnly: true });
      asked = true;
    }
  }

  // Their clock was on the visit they've now surely left, and the phone moved it to travel there. If
  // they've been at another visit's property a couple of minutes (they drove over with the phone
  // locked and were only asked on arriving, the clock being busy), it goes onto that one.
  if (ctx.mode === "clock" && stoppedAt != null && !started && clockFree(clock)) {
    const now = ctx.now ?? stoppedAt;
    const next = here
      .filter((h) => h.inNow && !h.tapped && !h.held && !held.includes(h.visitId) && !gone.has(h.visitId) && now - h.since >= STAYED_MS)
      .map((h) => ({ h, s: site(h.visitId) }))
      .filter((x): x is { h: Stay; s: GeofenceSite } => Boolean(x.s) && !DONE.has(x.s!.status))
      .sort((a, b) => byTurn(a.s, b.s))[0];
    if (next) actions.push({ kind: "start-clock", visitId: next.h.visitId, at: Math.max(stoppedAt, next.h.since) });
  }
  return { actions, held };
}

/** What to do about what a fix confirmed (decide, above). */
export function geofenceActions(events: readonly GeofenceEvent[], ctx: ActionContext): GeofenceAction[] {
  return decide(events, ctx).actions;
}

/**
 * One fix, start to finish: where it puts the person (trackFix), what to do about it, and the
 * state to keep, with the arrivals that are still waiting their turn marked so the next fix puts
 * them to the person.
 */
export function geofenceStep(
  state: GeofenceState,
  fix: Fix,
  radius: number,
  ctx: Omit<ActionContext, "now" | "here">,
): { state: GeofenceState; events: GeofenceEvent[]; actions: GeofenceAction[] } {
  const tracked = trackFix(state, fix, ctx.sites, radius);
  if (tracked.state === state) return { state, events: [], actions: [] };
  const { actions, held } = decide(tracked.events, { ...ctx, now: fix.at, here: stays(tracked.state) });
  const sites = Object.fromEntries(Object.entries(tracked.state.sites).map(([id, t]) => [id, t.where === "inside" && (t.held === true) !== held.includes(id) ? { ...t, held: held.includes(id) } : t]));
  return { state: { ...tracked.state, sites }, events: tracked.events, actions };
}

/**
 * How soon to look again, and how hard: often and with GPS near a property or while an arrival or a
 * departure is being confirmed, rarely and roughly far from all of them, to spare the battery.
 */
export function nextLook(state: GeofenceState, fix: Fix | null, sites: readonly GeofenceSite[], radius: number): { delayMs: number; precise: boolean } {
  const open = sites.filter((s) => !DONE.has(s.status));
  const busy = open.some((s) => {
    const t = state.sites[s.visitId];
    return t && ((t.inRow > 0 && t.where !== "inside") || t.outSince != null || t.held === true);
  });
  if (!fix || busy) return { delayMs: 20_000, precise: true };
  const nearest = Math.min(...open.map((s) => distance(fix, s)));
  if (nearest <= Math.max(1_500, radius * 5) || open.some((s) => state.sites[s.visitId]?.where === "inside")) return { delayMs: 30_000, precise: true };
  if (nearest <= 8_000) return { delayMs: 60_000, precise: true };
  return { delayMs: 120_000, precise: false };
}
