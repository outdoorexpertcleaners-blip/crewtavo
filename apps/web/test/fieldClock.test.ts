/**
 * A crew member's clock on a visit (fieldActions.setVisitStatus + fieldData.clockVisit): the visit's
 * status is shared and only moves forward, each person clocks in as they tapped and a tap sent again
 * doesn't add time twice, and finishing the visit ends every clock still running on it (the
 * database: 20261113000600_finished_visits_end_their_clocks.sql). A sub without a clock moves the
 * visit along and has no time at all, as decided when they tapped.
 *
 * On the whole-day clock (settings.clock.mode "day") On my way starts the clock on travel, Start
 * visit moves it onto the visit and Complete moves it back to travel, for the team and never a sub.
 */
import { beforeEach, expect, it, vi } from "vitest";

// The server side: the visit's status with the API's forward_only rule (apps/api/src/routes/schedule.ts),
// and time_entries rows as the database holds them.
const STEPS: Record<string, number> = { unscheduled: 0, scheduled: 0, en_route: 1, in_progress: 2, completed: 3 };
type Entry = { id: number; company_id?: string; user_id: string; visit_id: string | null; category?: string; started_at: string; ended_at: string | null };
const server = { status: "scheduled", completedAt: null as string | null, entries: [] as Entry[], refuseTime: false, sent: [] as object[], order: [] as string[], day: false, brands: {} as Record<string, string>, brandAsked: 0 };
// The database's rule: a clock running on a visit ends when the visit was finished, with no place
// of its own, and so does a clock-in that arrives afterwards dated before it. On the whole-day
// clock (server.day) the person goes on to travel from there.
const endOnFinishedVisit = () => {
  for (const e of [...server.entries]) {
    if (!(e.visit_id === "v1" && e.ended_at === null && server.completedAt && e.started_at < server.completedAt)) continue;
    e.ended_at = server.completedAt;
    if (server.day) server.entries.push({ id: server.entries.length + 1, company_id: e.company_id, user_id: e.user_id, visit_id: null, category: "drive", started_at: `${server.completedAt} +1ms`, ended_at: null });
  }
};

vi.mock("../src/lib/api", () => {
  const api = {
    patch: async (_path: string, body: { status: string; forward_only?: boolean; completed_at?: string }) => {
      server.sent.push(body);
      server.order.push(`visit ${body.status}`);
      if (body.forward_only && (server.status === "cancelled" || (STEPS[server.status] ?? 0) > (STEPS[body.status] ?? 0))) return { status: server.status, skipped: true };
      if (body.status === "completed" && server.status !== "completed") {
        server.completedAt = body.completed_at ?? null;
        endOnFinishedVisit();
      }
      server.status = body.status;
      return { status: server.status };
    },
  };
  const table = () => {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let update: Record<string, unknown> | null = null;
    let limit = Infinity;
    const q = {
      select: () => q,
      update: (values: Record<string, unknown>) => ((update = values), q),
      insert: (values: Omit<Entry, "id" | "ended_at">) => {
        // The office took a sub off the clock: the database refuses their time.
        if (server.refuseTime) return Promise.resolve({ data: null, error: new Error('new row violates row-level security policy for table "time_entries"') });
        server.entries.push({ id: server.entries.length + 1, ended_at: null, ...values });
        server.order.push("clock in");
        if (server.status === "completed") endOnFinishedVisit();
        return Promise.resolve({ data: null, error: null });
      },
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
      lte: (k: string, v: string) => (filters.push((r) => r[k] != null && String(r[k]) <= v), q),
      gt: (k: string, v: string) => (filters.push((r) => r[k] != null && String(r[k]) > v), q),
      limit: (n: number) => ((limit = n), q),
      then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => {
        const rows = server.entries.filter((r) => filters.every((f) => f(r))).slice(0, limit);
        if (update) rows.forEach((r) => Object.assign(r, update));
        if (update && rows.length) server.order.push("clock out");
        return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(resolve, reject);
      },
    };
    return q;
  };
  // public.job_brand: the job's brand, or an error for a job it doesn't know (an older server).
  const rpc = async (_name: string, args: { p_job: string }) => {
    server.brandAsked++;
    return args.p_job in server.brands ? { data: server.brands[args.p_job], error: null } : { data: null, error: new Error("function public.job_brand(uuid) does not exist") };
  };
  return { api, supabase: () => ({ from: () => table(), rpc }), unwrap: (r: { data: unknown; error: unknown }) => { if (r.error) throw r.error; return r.data; } };
});

const { setVisitStatus, statusSaved } = await import("../src/features/field/fieldActions");
const { statusChange } = await import("../src/features/field/fieldData");
const tap = (userId: string, status: string, at: string, place?: { lat: number; lng: number; accuracy: number }, clock?: boolean) => setVisitStatus({ companyId: "c1", userId, visitId: "v1", jobId: null, status, at, place, clock });
const timeOf = (userId: string) => server.entries.filter((e) => e.user_id === userId).map((e) => [e.started_at, e.ended_at]);
/** A tap by someone on the whole-day clock, and their time as "what, from, to". */
const dayTap = (userId: string, status: string, at: string, place?: { lat: number; lng: number; accuracy: number }) => setVisitStatus({ companyId: "c1", userId, visitId: "v1", jobId: null, status, at, place, clock: true, day: true });
const dayOf = (userId: string) => server.entries.filter((e) => e.user_id === userId).map((e) => [e.visit_id ? "visit" : e.category, e.started_at, e.ended_at]);

beforeEach(() => {
  server.status = "scheduled";
  server.day = false;
  server.completedAt = null;
  server.order = [];
  server.entries = [];
  server.refuseTime = false;
  server.sent = [];
  server.brands = {};
  server.brandAsked = 0;
});

it("clocks a crewmate in even when the visit was finished before their taps arrived, up to when it was finished", async () => {
  // Alice's phone gets signal first; Bob tapped Start and Complete with none, and his go out later.
  await tap("alice", "en_route", "2026-10-17T12:50:00Z");
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z");
  await tap("alice", "completed", "2026-10-17T16:00:00Z");
  await tap("bob", "in_progress", "2026-10-17T13:05:00Z");
  await tap("bob", "completed", "2026-10-17T16:10:00Z");
  expect(server.status).toBe("completed");
  // The visit was finished at 4:00: that's where everyone's clock on it ends, Bob's included.
  expect(timeOf("bob")).toEqual([["2026-10-17T13:05:00Z", "2026-10-17T16:00:00Z"]]);
});

it("stops the tapper's own clock before the visit is finished, and leaves a crewmate's to the database", async () => {
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z");
  await tap("bob", "in_progress", "2026-10-17T13:05:00Z");
  server.order = [];
  await tap("alice", "completed", "2026-10-17T16:00:00Z");
  // Her phone's stop goes first (it carries where the phone was); finishing the visit ends Bob's.
  expect(server.order).toEqual(["clock out", "visit completed"]);
  expect(timeOf("alice")).toEqual([["2026-10-17T13:00:00Z", "2026-10-17T16:00:00Z"]]);
  expect(timeOf("bob")).toEqual([["2026-10-17T13:05:00Z", "2026-10-17T16:00:00Z"]]);
  // Bob's own Complete, tapped later with no signal, changes nothing when it arrives.
  await tap("bob", "completed", "2026-10-17T16:10:00Z");
  expect(timeOf("bob")).toEqual([["2026-10-17T13:05:00Z", "2026-10-17T16:00:00Z"]]);
});

it("doesn't add time when someone's own Start is sent again after they finished", async () => {
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z");
  await tap("alice", "completed", "2026-10-17T16:00:00Z");
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z");
  expect(server.status).toBe("completed");
  expect(timeOf("alice")).toEqual([["2026-10-17T13:00:00Z", "2026-10-17T16:00:00Z"]]);
});

it("stops the clock on a visit the office cancelled, and doesn't start one", async () => {
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z");
  server.status = "cancelled";
  await tap("alice", "completed", "2026-10-17T14:00:00Z");
  expect(timeOf("alice")).toEqual([["2026-10-17T13:00:00Z", "2026-10-17T14:00:00Z"]]);
  await tap("bob", "in_progress", "2026-10-17T13:30:00Z");
  expect(timeOf("bob")).toEqual([]);
});

it("saves where the phone was with the clock it starts and stops, even sent later", async () => {
  const shop = { lat: 40.1, lng: -75.1, accuracy: 20 };
  const site = { lat: 40.0004, lng: -75.0003, accuracy: 12 };
  const after = { lat: 40.0001, lng: -75.0001, accuracy: 8 };
  server.entries.push({ id: 1, company_id: "c1", user_id: "alice", visit_id: null, started_at: "2026-10-17T12:00:00Z", ended_at: null, in_place: shop } as Entry);
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z", site);
  await tap("alice", "completed", "2026-10-17T16:00:00Z", after);
  const [drive, visit] = server.entries as Array<Entry & { in_place?: unknown; out_place?: unknown }>;
  expect([drive!.in_place, drive!.out_place]).toEqual([shop, site]);
  expect([visit!.in_place, visit!.out_place]).toEqual([site, after]);
});

it("doesn't clock a sub in or out when the office doesn't keep their hours, but moves the visit along", async () => {
  await tap("sub", "en_route", "2026-10-17T12:50:00Z", undefined, false);
  await tap("sub", "in_progress", "2026-10-17T13:00:00Z", undefined, false);
  expect(server.status).toBe("in_progress");
  await tap("sub", "completed", "2026-10-17T16:00:00Z", undefined, false);
  expect(server.status).toBe("completed");
  expect(server.entries).toEqual([]);
});

it("clocks a sub the office keeps hours for, and a tap saved before the flag existed, as before", async () => {
  await tap("sub", "in_progress", "2026-10-17T13:00:00Z", undefined, true);
  await tap("sub", "completed", "2026-10-17T15:00:00Z", undefined, true);
  expect(timeOf("sub")).toEqual([["2026-10-17T13:00:00Z", "2026-10-17T15:00:00Z"]]);
  // No flag on the tap: it clocks (and the visit, finished at 3:00, is where that clock ends).
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z");
  expect(timeOf("alice")).toEqual([["2026-10-17T13:00:00Z", "2026-10-17T15:00:00Z"]]);
});

it("doesn't promise a running clock to someone who has none", () => {
  const change = { companyId: "c1", userId: "sub", visitId: "v1", jobId: null, status: "in_progress", at: "2026-10-17T13:00:00Z" };
  expect(statusSaved({ skipped: false }, { ...change, clock: false })).toBe("Visit started");
  expect(statusSaved({ skipped: false }, { ...change, clock: true })).toBe("Visit started, your clock is running");
  expect(statusSaved({ skipped: false }, change)).toBe("Visit started, your clock is running");
  expect(statusSaved({ skipped: true, visitStatus: "completed" }, { ...change, clock: false })).toBe("This visit had already moved on");
  expect(statusSaved({ skipped: true, visitStatus: "cancelled" }, { ...change, clock: false })).toBe("The office cancelled this visit");
});

it("decides at the tap whether it clocks, and asks the phone where it is for a clock or On my way", () => {
  const at = "2026-10-17T13:00:00Z";
  const visit = { id: "v1", jobId: "j1" };
  const person = (role: string, extra: object = {}, settings: Record<string, unknown> = {}) => ({ role, userId: "u1", subcontractor: null, company: { id: "c1", settings }, ...extra }) as never;
  const sub = (uses_clock: boolean) => person("subcontractor", { subcontractor: { id: "s1", name: "Apex", can_contact_clients: false, uses_clock } });
  expect(statusChange(sub(false), visit, "in_progress", at)).toEqual({
    change: { companyId: "c1", userId: "u1", visitId: "v1", jobId: "j1", status: "in_progress", at, clock: false, sub: true },
    locate: false,
  });
  expect(statusChange(sub(true), visit, "completed", at)).toMatchObject({ change: { clock: true, sub: true }, locate: true });
  const crew = statusChange(person("field_crew"), visit, "in_progress", at);
  expect(crew).toMatchObject({ change: { clock: true }, locate: true });
  expect(crew.change).not.toHaveProperty("sub");
  // On my way asks too, to tell the client when the crew should get there, even for a sub without a clock.
  expect(statusChange(person("field_crew"), visit, "en_route", at).locate).toBe(true);
  expect(statusChange(sub(false), visit, "en_route", at).locate).toBe(true);
  expect(statusChange(person("field_crew"), visit, "scheduled", at).locate).toBe(false);
  // Not where the business doesn't keep where people are.
  expect(statusChange(person("field_crew", {}, { clock: { record_location: false } }), visit, "in_progress", at).locate).toBe(false);
  expect(statusChange(person("field_crew", {}, { clock: { record_location: false } }), visit, "en_route", at).locate).toBe(false);
});

it("sends where the phone was with On my way, for the arrival time, and keeps it off the clock", async () => {
  server.sent = [];
  const place = { lat: 37.131, lng: -80.408, accuracy: 12 };
  await tap("alice", "en_route", "2026-10-17T12:50:00Z", place);
  expect(server.sent).toEqual([{ status: "en_route", forward_only: true, from: { lat: 37.131, lng: -80.408 } }]);
  expect(server.entries).toEqual([]);
  // A phone that couldn't say sends none, and the server works it out another way or leaves it out.
  server.sent = [];
  server.status = "scheduled";
  await setVisitStatus({ companyId: "c1", userId: "alice", visitId: "v1", jobId: null, status: "en_route", at: "2026-10-17T12:50:00Z", place: { missing: "denied" } });
  expect(server.sent).toEqual([{ status: "en_route", forward_only: true }]);
  // A clock tap's place stays the clock's.
  server.sent = [];
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z", place);
  expect(server.sent).toEqual([{ status: "in_progress", forward_only: true }]);
});

it("moves a sub's visit along when the office turned their clock off after the phone last heard, without clocking", async () => {
  server.refuseTime = true;
  const result = await setVisitStatus({ companyId: "c1", userId: "al", visitId: "v1", jobId: null, status: "in_progress", at: "2026-10-17T13:00:00Z", clock: true, sub: true });
  expect(result).toEqual({ skipped: false, visitStatus: "in_progress", clockOff: true });
  expect(server.status).toBe("in_progress");
  expect(statusSaved(result, { companyId: "c1", userId: "al", visitId: "v1", jobId: null, status: "in_progress", at: "", clock: true, sub: true })).toBe("Visit started");
  // The team's clock refused is a real problem, shown as one.
  await expect(tap("alice", "in_progress", "2026-10-17T13:05:00Z")).rejects.toThrow(/row-level security/);
});


it("dates a Complete by when it was tapped, so one sent after a spell without signal isn't dated when it went out", async () => {
  await tap("alice", "en_route", "2026-10-17T12:50:00Z");
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z");
  await tap("alice", "completed", "2026-10-17T16:00:00Z");
  // A sub without a clock is dated the same way: the date is the visit's, not their time.
  await tap("sub", "completed", "2026-10-17T16:05:00Z", undefined, false);
  expect(server.sent).toEqual([
    { status: "en_route", forward_only: true },
    { status: "in_progress", forward_only: true },
    { status: "completed", forward_only: true, completed_at: "2026-10-17T16:00:00Z" },
    { status: "completed", forward_only: true, completed_at: "2026-10-17T16:05:00Z" },
  ]);
});

// ----- The whole-day clock -----------------------------------------------------------------------

it("on the whole-day clock, On my way starts the clock on travel, Start visit moves it to the visit and Complete moves it back", async () => {
  server.day = true;
  const yard = { lat: 40.1, lng: -75.1, accuracy: 20 };
  const site = { lat: 40.0004, lng: -75.0003, accuracy: 12 };
  const onMyWay = await dayTap("alice", "en_route", "2026-10-17T12:40:00Z", yard);
  expect(dayOf("alice")).toEqual([["drive", "2026-10-17T12:40:00Z", null]]);
  expect(statusSaved(onMyWay, { status: "en_route" } as never)).toBe("On your way, your clock is running");
  await dayTap("alice", "in_progress", "2026-10-17T13:00:00Z", site);
  server.order = [];
  const done = await dayTap("alice", "completed", "2026-10-17T16:00:00Z", site);
  expect(dayOf("alice")).toEqual([
    ["drive", "2026-10-17T12:40:00Z", "2026-10-17T13:00:00Z"],
    ["visit", "2026-10-17T13:00:00Z", "2026-10-17T16:00:00Z"],
    ["drive", "2026-10-17T16:00:00Z", null],
  ]);
  // Her phone moves her own clock first, with where it was, then the visit is finished.
  expect(server.order).toEqual(["clock out", "clock in", "visit completed"]);
  expect(statusSaved(done, { status: "completed" } as never)).toBe("Visit completed, your clock keeps running");
  // Travel is the Driving timer: on no visit and no job, with the place it started from.
  const travel = server.entries.at(-1) as Entry & { job_id?: unknown; in_place?: unknown };
  expect([travel.visit_id ?? null, travel.job_id ?? null, travel.in_place]).toEqual([null, null, site]);
  expect((server.entries[0] as Entry & { in_place?: unknown; out_place?: unknown }).in_place).toEqual(yard);
});

it("moves a crewmate on the visit's clock to travel when someone else finishes it (the database), and leaves their own later Complete nothing to do", async () => {
  server.day = true;
  await dayTap("alice", "in_progress", "2026-10-17T13:00:00Z");
  await dayTap("bob", "in_progress", "2026-10-17T13:05:00Z");
  await dayTap("alice", "completed", "2026-10-17T16:00:00Z");
  const bob = [["visit", "2026-10-17T13:05:00Z", "2026-10-17T16:00:00Z"], ["drive", "2026-10-17T16:00:00Z +1ms", null]];
  expect(dayOf("bob")).toEqual(bob);
  const late = await dayTap("bob", "completed", "2026-10-17T16:10:00Z");
  expect(dayOf("bob")).toEqual(bob);
  expect(late.travel).toBe(true);
});

it("doesn't split the drive when someone already driving taps On my way, or add one when a tap is sent again", async () => {
  server.day = true;
  server.entries.push({ id: 1, company_id: "c1", user_id: "alice", visit_id: null, category: "drive", started_at: "2026-10-17T12:00:00Z", ended_at: null });
  await dayTap("alice", "en_route", "2026-10-17T12:40:00Z");
  expect(dayOf("alice")).toEqual([["drive", "2026-10-17T12:00:00Z", null]]);
  await dayTap("alice", "in_progress", "2026-10-17T13:00:00Z");
  await dayTap("alice", "completed", "2026-10-17T16:00:00Z");
  const day = dayOf("alice");
  // Each of the three sent again, after the app closed before it heard back.
  await dayTap("alice", "en_route", "2026-10-17T12:40:00Z");
  await dayTap("alice", "in_progress", "2026-10-17T13:00:00Z");
  await dayTap("alice", "completed", "2026-10-17T16:00:00Z");
  expect(dayOf("alice")).toEqual(day);
  expect(day).toHaveLength(3);
});

it("leaves a break a break, and no clock no clock, when the visit is completed on the whole-day clock", async () => {
  server.day = true;
  server.status = "in_progress";
  server.entries.push({ id: 1, company_id: "c1", user_id: "alice", visit_id: null, category: "break", started_at: "2026-10-17T15:30:00Z", ended_at: null });
  const onBreak = await dayTap("alice", "completed", "2026-10-17T16:00:00Z");
  expect(dayOf("alice")).toEqual([["break", "2026-10-17T15:30:00Z", null]]);
  expect(statusSaved(onBreak, { status: "completed" } as never)).toBe("Visit completed");
  server.status = "in_progress";
  server.completedAt = null;
  await dayTap("bob", "completed", "2026-10-17T16:00:00Z");
  expect(dayOf("bob")).toEqual([]);
});

it("doesn't start the day for a visit the office cancelled", async () => {
  server.day = true;
  server.status = "cancelled";
  await dayTap("alice", "en_route", "2026-10-17T12:40:00Z");
  expect(server.entries).toEqual([]);
});

it("keeps a sub and a company on visits only off the whole-day clock, as decided at the tap", async () => {
  const person = (role: string, settings: Record<string, unknown>, extra: object = {}) => ({ role, userId: "u1", subcontractor: null, company: { id: "c1", settings }, ...extra }) as never;
  const visit = { id: "v1", jobId: null };
  const whole = { clock: { mode: "day" } };
  expect(statusChange(person("field_crew", whole), visit, "en_route").change.day).toBe(true);
  expect(statusChange(person("crew_lead", whole), visit, "completed").change.day).toBe(true);
  expect(statusChange(person("field_crew", {}), visit, "en_route").change).not.toHaveProperty("day");
  expect(statusChange(person("field_crew", { clock: { mode: "visits" } }), visit, "en_route").change).not.toHaveProperty("day");
  const sub = person("subcontractor", whole, { subcontractor: { id: "s1", name: "Apex", can_contact_clients: false, uses_clock: true } });
  expect(statusChange(sub, visit, "en_route").change).not.toHaveProperty("day");
  // A sub's On my way never clocks, and their Complete stops their clock, even if a tap said otherwise.
  await setVisitStatus({ companyId: "c1", userId: "sub", visitId: "v1", jobId: null, status: "en_route", at: "2026-10-17T12:40:00Z", clock: true, sub: true, day: true });
  expect(server.entries).toEqual([]);
  await tap("sub", "in_progress", "2026-10-17T13:00:00Z", undefined, true);
  await setVisitStatus({ companyId: "c1", userId: "sub", visitId: "v1", jobId: null, status: "completed", at: "2026-10-17T15:00:00Z", clock: true, sub: true, day: true });
  expect(timeOf("sub")).toEqual([["2026-10-17T13:00:00Z", "2026-10-17T15:00:00Z"]]);
  // Visits only: On my way is off the clock, and Complete stops it.
  server.status = "scheduled";
  server.completedAt = null;
  expect(statusSaved(await tap("alice", "en_route", "2026-10-17T12:40:00Z"), { status: "en_route" } as never)).toBe("On your way");
  expect(timeOf("alice")).toEqual([]);
});

// ----- The brand clock (the owner's: Pressure washing or Christmas lights, never Driving) ----------

/** A team member's tap on the brand clock, on job j1; `day`: the whole-day clock. */
const brandTap = (userId: string, status: string, at: string, options: { day?: boolean; brand?: "washing" | "lights" } = {}) =>
  setVisitStatus({ companyId: "c1", userId, visitId: "v1", jobId: "j1", status, at, clock: true, brandClock: true, ...(options.day && { day: true }), ...(options.brand && { brand: options.brand }) });
const brandOf = (userId: string) => server.entries.filter((e) => e.user_id === userId).map((e) => [e.category, e.visit_id ? "on visit" : (e as Entry & { job_id?: string }).job_id ?? null, e.started_at, e.ended_at]);

it("on the whole-day brand clock, On my way starts the job's brand and it runs through the visit and after it", async () => {
  server.day = true;
  server.brands = { j1: "lights" };
  await brandTap("alice", "en_route", "2026-10-17T12:40:00Z", { day: true });
  expect(brandOf("alice")).toEqual([["lights", "j1", "2026-10-17T12:40:00Z", null]]);
  await brandTap("alice", "in_progress", "2026-10-17T13:00:00Z", { day: true });
  const done = await brandTap("alice", "completed", "2026-10-17T16:00:00Z", { day: true });
  // One block: Start visit doesn't split it onto the visit, and finishing the visit doesn't end it.
  expect(brandOf("alice")).toEqual([["lights", "j1", "2026-10-17T12:40:00Z", null]]);
  expect(statusSaved(done, { status: "completed" } as never)).toBe("Visit completed, your clock keeps running");
  // Sent again after the app closed before it heard back: nothing more.
  await brandTap("alice", "en_route", "2026-10-17T12:40:00Z", { day: true });
  expect(brandOf("alice")).toHaveLength(1);
});

it("moves a break, the shop or the other brand onto the job's brand at On my way or Start visit", async () => {
  server.day = true;
  server.entries.push({ id: 1, company_id: "c1", user_id: "alice", visit_id: null, category: "break", started_at: "2026-10-17T12:00:00Z", ended_at: null });
  await brandTap("alice", "in_progress", "2026-10-17T12:30:00Z", { day: true, brand: "washing" });
  expect(brandOf("alice")).toEqual([["break", null, "2026-10-17T12:00:00Z", "2026-10-17T12:30:00Z"], ["washing", "j1", "2026-10-17T12:30:00Z", null]]);
  // The tap knew the brand: the server isn't asked.
  expect(server.brandAsked).toBe(0);
  server.status = "scheduled";
  await brandTap("alice", "en_route", "2026-10-17T15:00:00Z", { day: true, brand: "lights" });
  expect(brandOf("alice").at(-1)).toEqual(["lights", "j1", "2026-10-17T15:00:00Z", null]);
  expect(brandOf("alice")[1]![3]).toBe("2026-10-17T15:00:00Z");
});

it("on visits only, Start visit clocks onto the job's brand on the visit and Complete stops it", async () => {
  server.brands = { j1: "washing" };
  await brandTap("alice", "en_route", "2026-10-17T12:40:00Z");
  expect(server.entries).toEqual([]);
  await brandTap("alice", "in_progress", "2026-10-17T13:00:00Z");
  await brandTap("alice", "completed", "2026-10-17T16:00:00Z");
  expect(brandOf("alice")).toEqual([["washing", "on visit", "2026-10-17T13:00:00Z", "2026-10-17T16:00:00Z"]]);
});

it("keeps the time on washing when the server can't say the brand", async () => {
  server.day = true;
  await brandTap("alice", "en_route", "2026-10-17T12:40:00Z", { day: true });
  expect(brandOf("alice")).toEqual([["washing", "j1", "2026-10-17T12:40:00Z", null]]);
});

it("puts a team member on the brand clock at the tap, and never a sub", () => {
  const person = (role: string, extra: object = {}) => ({ role, userId: "u1", subcontractor: null, company: { id: "c1", settings: { clock: { mode: "day" } } }, ...extra }) as never;
  expect(statusChange(person("field_crew"), { id: "v1", jobId: "j1" }, "en_route").change).toMatchObject({ brandClock: true });
  expect(statusChange(person("field_crew"), { id: "v1", jobId: "j1", brand: "lights" }, "en_route").change).toMatchObject({ brandClock: true, brand: "lights" });
  const sub = person("subcontractor", { subcontractor: { id: "s1", name: "Apex", can_contact_clients: false, uses_clock: true } });
  expect(statusChange(sub, { id: "v1", jobId: "j1", brand: "lights" }, "en_route").change).not.toHaveProperty("brandClock");
});
