/**
 * The clock at the property on the phone (features/field/geofence.ts; the decisions are core's,
 * packages/core/test/geofence.test.ts): which visits it watches, what it kept between looks and
 * across a reload, which taps take a visit's clock off it, what it asks and while that still means
 * anything, and how Timesheets tells its clocks from taps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/api", () => ({ api: {}, supabase: () => ({}), unwrap: (r: { data: unknown }) => r.data }));
const { actionWords, askPrompt, dismissPrompt, forgetGeofence, geofenceKey, geofencePrompts, geofenceSites, loadGeofence, LOOK_WATCHDOG_MS, promptStands, promptText, restorePrompts, saveGeofence, tappedVisits, watchPlace } = await import("../src/features/field/geofence");
const { geofenceStep } = await import("@crewtavo/core/geofence");
type Fix = import("@crewtavo/core/geofence").Fix;
type GeofenceSite = import("@crewtavo/core/geofence").GeofenceSite;
const { atPropertyNote } = await import("../src/features/timesheets/clockPlace");
const { emptyGeofence } = await import("@crewtavo/core/geofence");
type MyDayVisit = import("../src/features/field/myDay").MyDayVisit;
type GeofencePrompt = import("../src/features/field/geofence").GeofencePrompt;

const store = new Map<string, string>();
const storage = {
  get length() {
    return store.size;
  },
  key: (i: number) => [...store.keys()][i] ?? null,
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
beforeEach(() => {
  store.clear();
  forgetGeofence();
  vi.stubGlobal("localStorage", storage);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
/** A phone that won't keep anything: storage full. What's there already can still be read. */
const full = { ...storage, get length() { return store.size; }, setItem: () => { throw new Error("QuotaExceededError"); } };

const visit = (id: string, over: Partial<MyDayVisit> = {}): MyDayVisit => ({
  id, title: `Visit ${id}`, kind: "job", status: "scheduled", starts_at: null, ends_at: null, scheduled_on: "2026-11-13", route_order: null, hold_reason: null, crew_id: null,
  job: { id: `job-${id}`, number: 1, title: "Mowing", client: null }, property: { id: `p-${id}`, line1: "12 Oak St", city: "Springfield", lat: 40, lng: -75 },
  assignees: [], series_day: null, series_total: null, mine: true, ...over,
});

describe("the visits it watches", () => {
  it("is today's visits this person is on, at a property with a point on the map, not finished", () => {
    const sites = geofenceSites([
      visit("a"),
      visit("b", { status: "in_progress", property: { id: "p", line1: "", city: null, lat: 41, lng: -74 } }),
      visit("c", { mine: false }),
      visit("d", { property: { id: "p", line1: "1 Elm", city: null, lat: null, lng: null } }),
      visit("e", { property: null, address: "A task somewhere" }),
      visit("f", { status: "completed" }),
      visit("g", { status: "cancelled" }),
      // A copy kept on the phone from before "mine" was added: it was on My day, so it's theirs.
      visit("h", { mine: undefined }),
    ]);
    expect(sites).toEqual([
      { visitId: "a", lat: 40, lng: -75, place: "12 Oak St", status: "scheduled" },
      { visitId: "b", lat: 41, lng: -74, place: "Visit b", status: "in_progress" },
      { visitId: "h", lat: 40, lng: -75, place: "12 Oak St", status: "scheduled" },
    ]);
    expect(geofenceSites(undefined)).toEqual([]);
  });

  it("is in the day's order, as My day lists them, which says which visit is next", () => {
    const sites = geofenceSites([
      visit("late", { starts_at: "2026-11-13T18:00:00Z" }),
      visit("anytime"),
      visit("early", { starts_at: "2026-11-13T13:00:00Z" }),
    ]);
    expect(sites.map((s) => s.visitId)).toEqual(["early", "late", "anytime"]);
    expect(geofenceSites([visit("b", { route_order: 2 }), visit("a", { route_order: 1 })]).map((s) => s.visitId)).toEqual(["a", "b"]);
  });
});

describe("what it kept between looks", () => {
  const key = geofenceKey("c1", "ray", "2026-11-13");

  it("comes back as it was saved, per company, person and day", () => {
    const state = { last: 5, sites: { a: { where: "inside" as const, inRow: 2, firstIn: 1, outSince: null, tapped: true } } };
    saveGeofence(key, state);
    expect(loadGeofence(key)).toEqual(state);
    expect(loadGeofence(geofenceKey("c1", "sam", "2026-11-13"))).toEqual(emptyGeofence());
  });

  it("drops other days' as it saves today's, and leaves other people's alone", () => {
    store.set(geofenceKey("c1", "ray", "2026-11-12"), "{}");
    store.set(geofenceKey("c1", "sam", "2026-11-12"), "{}");
    store.set("something-else", "1");
    saveGeofence(key, emptyGeofence());
    expect([...store.keys()].sort()).toEqual([geofenceKey("c1", "ray", "2026-11-13"), geofenceKey("c1", "sam", "2026-11-12"), "something-else"].sort());
  });

  it("starts again from nothing when what's there can't be read, or storage is off", () => {
    store.set(key, "not json");
    expect(loadGeofence(key)).toEqual(emptyGeofence());
    store.set(key, JSON.stringify({ last: 1 }));
    expect(loadGeofence(key)).toEqual(emptyGeofence());
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("off"); }, setItem: () => { throw new Error("off"); } });
    expect(loadGeofence(key)).toEqual(emptyGeofence());
    expect(() => saveGeofence(key, emptyGeofence())).not.toThrow();
  });
});

describe("on a phone that won't keep what it knows (storage full or off)", () => {
  const key = geofenceKey("c1", "ray", "2026-11-13");
  const OAK: GeofenceSite = { visitId: "oak", lat: 40, lng: -75, place: "12 Oak St", status: "scheduled" };
  const T0 = Date.parse("2026-11-13T14:00:00Z");
  const fix = (north: number, seconds: number): Fix => ({ lat: 40 + north / 111_195, lng: -75, accuracy: 15, at: T0 + seconds * 1000 });
  /** One look, as the phone does it: what it knew, the fix, what it knows now. */
  const look = (f: Fix) => {
    const out = geofenceStep(loadGeofence(key), f, 200, { mode: "clock", sites: [OAK], clock: null, day: false });
    saveGeofence(key, out.state);
    return out.actions.map((a) => a.kind);
  };

  it("still notices an arrival, from what the page remembers: it used to start from nothing at every look and never fire", () => {
    vi.stubGlobal("localStorage", full);
    expect(look(fix(10, 0))).toEqual([]);
    expect(look(fix(10, 20))).toEqual(["start-clock", "ask-start"]);
    // And once: not again at every look after.
    expect(look(fix(10, 40))).toEqual([]);
    expect(look(fix(10, 60))).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("doesn't fire the same arrival again and again from something old it once kept", () => {
    // Kept while there was room: one fix inside, a moment ago.
    look(fix(10, 0));
    expect(store.has(key)).toBe(true);
    vi.stubGlobal("localStorage", full);
    expect(look(fix(10, 20))).toEqual(["start-clock", "ask-start"]);
    expect(look(fix(10, 40))).toEqual([]);
    expect(look(fix(10, 70))).toEqual([]);
  });

  it("works with storage turned off altogether, and goes back to the phone's copy once it keeps things again", () => {
    vi.stubGlobal("localStorage", { get length(): number { throw new Error("SecurityError"); }, key: () => null, getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); }, removeItem: () => undefined });
    expect(look(fix(10, 0))).toEqual([]);
    expect(look(fix(10, 20))).toEqual(["start-clock", "ask-start"]);
    vi.stubGlobal("localStorage", storage);
    expect(look(fix(10, 40))).toEqual([]);
    expect(JSON.parse(store.get(key)!).sites.oak.where).toBe("inside");
  });
});

describe("a question, after the page loads again", () => {
  const key = geofenceKey("c1", "ray", "2026-11-13");
  const prompt: GeofencePrompt = { id: "start:v1", kind: "start", visitId: "v1", jobId: "j1", title: "Mowing", place: "12 Oak St", done: "Clock started at 12 Oak St" };

  it("is still there: tapping its notification reloads the page, and the arrival behind it is used up", () => {
    restorePrompts(key);
    askPrompt(prompt);
    expect(geofencePrompts()).toEqual([prompt]);
    // The page loads again (the service worker's navigate): nothing in memory.
    forgetGeofence();
    expect(geofencePrompts()).toEqual([]);
    restorePrompts(key);
    expect(geofencePrompts()).toEqual([prompt]);
  });

  it("is gone for good once it's answered or waved away", () => {
    restorePrompts(key);
    askPrompt(prompt);
    dismissPrompt(prompt.id);
    forgetGeofence();
    restorePrompts(key);
    expect(geofencePrompts()).toEqual([]);
  });

  it("is never shown to the next person on the phone, nor carried to the next day", () => {
    restorePrompts(key);
    askPrompt(prompt);
    restorePrompts(geofenceKey("c1", "sam", "2026-11-13"));
    expect(geofencePrompts()).toEqual([]);
    // Ray, the next morning: yesterday's question is cleared off the phone.
    restorePrompts(geofenceKey("c1", "ray", "2026-11-14"));
    expect(geofencePrompts()).toEqual([]);
    expect([...store.keys()].filter((k) => k.includes(":ray:"))).toEqual([]);
  });

  it("copes with something unreadable where the questions were kept", () => {
    store.set("crewtavo-geofence-asks:c1:ray:2026-11-13", "{not json");
    restorePrompts(key);
    expect(geofencePrompts()).toEqual([]);
    store.set("crewtavo-geofence-asks:c1:sam:2026-11-13", JSON.stringify([{ id: 1 }, null, prompt]));
    restorePrompts(geofenceKey("c1", "sam", "2026-11-13"));
    expect(geofencePrompts()).toEqual([prompt]);
  });
});

describe("looking where the phone is", () => {
  type Ok = (p: { coords: { latitude: number; longitude: number; accuracy: number }; timestamp: number }) => void;
  type Fail = (e: { code: number; PERMISSION_DENIED: number }) => void;
  /** A phone whose answers the test gives, one request at a time. */
  function phone() {
    const asked: Array<{ ok: Ok; fail: Fail; precise: boolean }> = [];
    const geolocation = { getCurrentPosition: (ok: Ok, fail: Fail, options: { enableHighAccuracy?: boolean }) => void asked.push({ ok, fail, precise: Boolean(options.enableHighAccuracy) }) } as unknown as Geolocation;
    const position = (at: number) => ({ coords: { latitude: 40, longitude: -75, accuracy: 12 }, timestamp: at });
    return { asked, geolocation, position };
  }

  it("looks, hands on each fix, and looks again when the plan says", () => {
    vi.useFakeTimers();
    const { asked, geolocation, position } = phone();
    const fixes: Fix[] = [];
    const looks = watchPlace({ geolocation, onFix: (f) => fixes.push(f), onDenied: () => undefined, plan: () => ({ delayMs: 30_000, precise: false }) });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.precise).toBe(true);
    asked[0]!.ok(position(1_000));
    expect(fixes).toEqual([{ lat: 40, lng: -75, accuracy: 12, at: 1_000 }]);
    vi.advanceTimersByTime(29_000);
    expect(asked).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(asked).toHaveLength(2);
    expect(asked[1]!.precise).toBe(false);
    looks.stop();
    asked[1]!.ok(position(2_000));
    vi.advanceTimersByTime(120_000);
    expect(fixes).toHaveLength(1);
    expect(asked).toHaveLength(2);
  });

  it("doesn't stop for good when the phone never answers a look: it gives up on that one and looks again", () => {
    vi.useFakeTimers();
    const { asked, geolocation, position } = phone();
    const fixes: Fix[] = [];
    const looks = watchPlace({ geolocation, onFix: (f) => fixes.push(f), onDenied: () => undefined, plan: () => ({ delayMs: 20_000, precise: true }) });
    // Neither a position nor an error, ever (the page was put away mid-look).
    vi.advanceTimersByTime(LOOK_WATCHDOG_MS - 1);
    expect(asked).toHaveLength(1);
    vi.advanceTimersByTime(1 + 20_000);
    expect(asked).toHaveLength(2);
    // Coming back to the screen while one is out doesn't pile up a second.
    looks.now();
    expect(asked).toHaveLength(2);
    // The lost one answering at last is still a fix, and doesn't start a second chain of looks.
    asked[0]!.ok(position(5_000));
    expect(fixes).toHaveLength(1);
    asked[1]!.ok(position(6_000));
    vi.advanceTimersByTime(20_000);
    expect(asked).toHaveLength(3);
    vi.advanceTimersByTime(LOOK_WATCHDOG_MS + 20_000);
    expect(asked).toHaveLength(4);
    looks.stop();
  });

  it("stops while the phone refuses, says so, and tries again when the screen comes back", () => {
    vi.useFakeTimers();
    const { asked, geolocation, position } = phone();
    const denied: boolean[] = [];
    const looks = watchPlace({ geolocation, onFix: () => undefined, onDenied: (d) => denied.push(d), plan: () => ({ delayMs: 20_000, precise: true }) });
    asked[0]!.fail({ code: 1, PERMISSION_DENIED: 1 });
    vi.advanceTimersByTime(10 * 60_000);
    expect(asked).toHaveLength(1);
    expect(denied).toEqual([true]);
    looks.now();
    asked[1]!.ok(position(1_000));
    expect(denied).toEqual([true, false]);
    // Any other error (no fix in time): just the next look.
    vi.advanceTimersByTime(20_000);
    asked[2]!.fail({ code: 3, PERMISSION_DENIED: 1 });
    vi.advanceTimersByTime(20_000);
    expect(asked).toHaveLength(4);
    looks.stop();
  });
});

describe("the schedule isn't read for nothing", () => {
  it("fetches My day for the clock at the property only where the company has it on", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (name: string) => readFileSync(new URL(`../src/features/field/${name}`, import.meta.url), "utf8");
    expect(read("geofence.ts")).toContain("const day = useMyDay(on);");
    expect(read("GeofenceCard.tsx")).toContain('const day = useMyDay(mode !== "off");');
    expect(read("myDay.ts")).toMatch(/export function useMyDay\(enabled = true\)[\s\S]{0,400}enabled,\n\s+refetchInterval/);
  });
});

describe("which taps take a visit's clock off it", () => {
  const change = (over: object = {}) => ({ companyId: "c1", userId: "ray", who: ["ray"], target: { category: "visit" as const, visit: { id: "v2", jobId: null, title: "Elm" } }, at: "2026-11-13T15:00:00Z", ...over });

  it("is the visit a tap of their own puts their clock on, and the one it takes it off", () => {
    expect(tappedVisits(change(), "ray", { visit: { id: "v1", title: "Oak" } })).toEqual(["v2", "v1"]);
    expect(tappedVisits(change({ target: null }), "ray", { visit: { id: "v1", title: "Oak" } })).toEqual(["v1"]);
    expect(tappedVisits(change({ target: { category: "break" } }), "ray", null)).toEqual([]);
    expect(tappedVisits(change({ target: null, fromVisit: "v1" }), "ray", null)).toEqual(["v1"]);
  });

  it("isn't the phone's own, nor a crew lead's tap that leaves them out", () => {
    expect(tappedVisits(change({ geofence: true }), "ray", { visit: { id: "v1", title: "Oak" } })).toEqual([]);
    expect(tappedVisits(change({ who: ["sam"] }), "ray", { visit: { id: "v1", title: "Oak" } })).toEqual([]);
    // A lead clocking the whole crew in, themselves included, is their own tap too.
    expect(tappedVisits(change({ userId: "lou", who: ["lou", "ray"] }), "ray", null)).toEqual(["v2"]);
  });
});

describe("what it says and asks", () => {
  const prompt = (over: Partial<GeofencePrompt>): GeofencePrompt => ({ id: "x", kind: "start", visitId: "v1", jobId: null, title: "Mowing", place: "12 Oak St", ...over });

  it("asks in one line", () => {
    expect(promptText(prompt({}))).toEqual({ title: "You're at 12 Oak St", question: "Start the visit?" });
    expect(promptText(prompt({ clockOnly: true }))).toEqual({ title: "You're at 12 Oak St", question: "Start your clock?" });
    expect(promptText(prompt({ kind: "finish", complete: true, stopClock: true }))).toEqual({ title: "Leaving 12 Oak St", question: "Complete the visit, or stop your clock?" });
    expect(promptText(prompt({ kind: "finish", complete: true })).question).toBe("Complete the visit?");
    expect(promptText(prompt({ kind: "finish", stopClock: true })).question).toBe("Stop your clock?");
  });

  it("says what the phone did by itself", () => {
    expect(actionWords({ kind: "start-clock", visitId: "v1", at: 0 }, "12 Oak St")).toBe("Clock started at 12 Oak St");
    expect(actionWords({ kind: "stop-clock", visitId: "v1", at: 0, travel: true }, "12 Oak St")).toBe("You left 12 Oak St, so your clock is on driving");
    expect(actionWords({ kind: "ask-start", visitId: "v1", clockOnly: false }, "12 Oak St")).toBeNull();
  });

  it("stops asking once the question is answered some other way", () => {
    const on = { visit: { id: "v1", title: "Mowing" } };
    expect(promptStands(prompt({}), "scheduled", null)).toBe(true);
    expect(promptStands(prompt({}), "en_route", null)).toBe(true);
    expect(promptStands(prompt({}), "in_progress", on)).toBe(false);
    expect(promptStands(prompt({ clockOnly: true }), "in_progress", null)).toBe(true);
    expect(promptStands(prompt({ clockOnly: true }), "in_progress", on)).toBe(false);
    const finish = prompt({ kind: "finish", complete: true, stopClock: true });
    expect(promptStands(finish, "in_progress", null)).toBe(true);
    expect(promptStands(prompt({ kind: "finish", stopClock: true }), "scheduled", null)).toBe(false);
    expect(promptStands(prompt({ kind: "finish", stopClock: true }), "scheduled", on)).toBe(true);
    for (const status of ["completed", "cancelled", undefined]) expect(promptStands(finish, status, on)).toBe(false);
  });
});

describe("what the crew is told on My day", () => {
  it("says the clock starts when Crewtavo is open at the property, not when they pull in", async () => {
    const { readFileSync } = await import("node:fs");
    const card = readFileSync(new URL("../src/features/field/GeofenceCard.tsx", import.meta.url), "utf8");
    expect(card).toContain("Your clock starts when the app is open on this phone at your next visit, not when you pull in.");
    expect(card).toContain("It can't tell while the phone is locked.");
    expect(card).not.toContain("Your clock starts when you get to a visit");
  });
});

describe("leaving, on the visits-only clock", () => {
  it("tells the crew the phone asks and never stops their clock by itself, and that the whole-day clock goes to driving", async () => {
    const { readFileSync } = await import("node:fs");
    const card = readFileSync(new URL("../src/features/field/GeofenceCard.tsx", import.meta.url), "utf8");
    expect(card).toContain("It never stops your clock by itself: once it sees you've left, it asks you.");
    expect(card).toContain("Once it sees you've left, it moves your clock to driving.");
    expect(card).not.toContain("and stops once it sees you've left");
  });

  it("has no words for a clock the phone stopped, and no way to send one: leaving only ever moves it to driving", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync(new URL("../src/features/field/geofence.ts", import.meta.url), "utf8");
    expect(code).not.toContain("Clock stopped as you left");
    // The geofence's own tap: a start goes onto the visit, anything else onto driving, never to nothing.
    expect(code).toContain(': { category: "drive" };');
    expect(code).not.toMatch(/action\.travel \? \{ category: "drive" \} : null/);
  });
});

describe("on Timesheets", () => {
  it("tells the phone's clocks from taps", () => {
    expect(atPropertyNote({ category: "visit", geofence_in: false, geofence_out: false })).toBeNull();
    expect(atPropertyNote({ category: "visit" })).toBeNull();
    expect(atPropertyNote({ category: "visit", geofence_in: true, geofence_out: true })).toBe("Started and stopped by the phone at the property");
    expect(atPropertyNote({ category: "visit", geofence_in: true })).toBe("Started by the phone on arriving at the property");
    expect(atPropertyNote({ category: "visit", geofence_out: true })).toBe("Stopped by the phone on leaving the property");
    expect(atPropertyNote({ category: "drive", geofence_in: true })).toBe("Started by the phone on leaving a property");
    expect(atPropertyNote({ category: "drive", geofence_out: true })).toBe("Stopped by the phone on arriving at a property");
    expect(atPropertyNote({ category: "drive", geofence_in: true, geofence_out: true })).toBe("Started by the phone on leaving a property, stopped on arriving at a property");
  });
});
