import { describe, expect, it } from "vitest";
import {
  emptyGeofence,
  geofence,
  GEOFENCE_MODE_HINTS,
  GEOFENCE_NOTE,
  geofenceActions,
  geofenceRadius,
  geofenceStep,
  IN_A_ROW_MS,
  keepSites,
  LEAVE_AFTER_MS,
  nextLook,
  noteTap,
  STAYED_MS,
  stays,
  trackFix,
  type ActionContext,
  type Fix,
  type GeofenceEvent,
  type GeofenceSite,
  type GeofenceState,
} from "../src/geofence";

// 12 Oak St, and a fix `north` metres north of it (a degree of latitude is about 111.2 km).
const OAK: GeofenceSite = { visitId: "oak", lat: 40, lng: -75, place: "12 Oak St", status: "scheduled" };
const ELM: GeofenceSite = { visitId: "elm", lat: 40.05, lng: -75, place: "8 Elm Ave", status: "scheduled" };
const M_PER_DEG = 111_195;
const T0 = Date.parse("2026-11-13T14:00:00Z");
const min = 60_000;
const fix = (north: number, minutes: number, accuracy = 15): Fix => ({ lat: 40 + north / M_PER_DEG, lng: -75, accuracy, at: T0 + minutes * min });

/** Feeds fixes in order and collects every event. */
function run(fixes: Fix[], sites: GeofenceSite[] = [OAK], radius = 200, from: GeofenceState = emptyGeofence()) {
  let state = from;
  const events: GeofenceEvent[] = [];
  for (const f of fixes) {
    const out = trackFix(state, f, sites, radius);
    state = out.state;
    events.push(...out.events);
  }
  return { state, events };
}

describe("the setting (settings.clock.geofence)", () => {
  it("is off for a company with nothing saved, and for anything it doesn't know", () => {
    expect(geofence({})).toEqual({ mode: "off", radius: 200 });
    expect(geofence(null)).toEqual({ mode: "off", radius: 200 });
    expect(geofence({ clock: { mode: "day" } })).toEqual({ mode: "off", radius: 200 });
    expect(geofence({ clock: { geofence: { mode: "auto" } } }).mode).toBe("off");
    expect(geofence({ clock: { geofence: "clock" } }).mode).toBe("off");
  });

  it("reads both choices and the radius", () => {
    expect(geofence({ clock: { geofence: { mode: "remind", radius: 150 } } })).toEqual({ mode: "remind", radius: 150 });
    expect(geofence({ clock: { geofence: { mode: "clock", radius: 300 } } })).toEqual({ mode: "clock", radius: 300 });
  });

  it("keeps the radius to 100 to 500 metres, 200 when it isn't a number", () => {
    expect(geofenceRadius(50)).toBe(100);
    expect(geofenceRadius(5000)).toBe(500);
    expect(geofenceRadius("250")).toBe(250);
    expect(geofenceRadius(212.6)).toBe(213);
    expect(geofenceRadius("")).toBe(200);
    expect(geofenceRadius("wide")).toBe(200);
    expect(geofenceRadius(undefined)).toBe(200);
    expect(geofenceRadius(Number.NaN)).toBe(200);
  });
});

describe("what the office is told under the setting", () => {
  it("says plainly that the times go by when the phone notices, which is when Crewtavo is opened there, not when they pulled in", () => {
    expect(GEOFENCE_NOTE).toContain("This goes by when the phone notices, and it only notices while the app is open on it");
    expect(GEOFENCE_NOTE).toContain("Someone who pulls in at 8:00 and opens the app at 8:40 is at the property from 8:40");
    expect(GEOFENCE_NOTE).toContain("leaving is noticed when they next open it");
    for (const mode of ["remind", "clock"] as const) expect(GEOFENCE_MODE_HINTS[mode]).toMatch(/phone notices/);
    // And what the phone won't do by itself.
    expect(GEOFENCE_MODE_HINTS.clock).toContain("never moves a running clock from one visit to another by itself");
  });

  it("says the phone never takes anyone off the clock by itself, and what leaving does on each clock", () => {
    expect(GEOFENCE_MODE_HINTS.clock).toContain("The phone never takes anyone off the clock by itself");
    expect(GEOFENCE_MODE_HINTS.clock).toContain('on the "Whole day" clock it moves their clock to driving, which is still paid time');
    expect(GEOFENCE_MODE_HINTS.clock).toContain('on the "Visits only" clock it asks "Stop your clock?" and the clock keeps running until they answer');
    // The old promise, which took the drive to the next site off a visits-only clock.
    expect(GEOFENCE_MODE_HINTS.clock).not.toContain("stops it when it notices they've left");
  });
});

describe("arriving", () => {
  it("takes two good fixes in a row inside the radius, and is dated at the first", () => {
    const { events } = run([fix(2000, 0), fix(150, 1), fix(40, 2)]);
    expect(events).toEqual([{ kind: "arrived", visitId: "oak", at: T0 + 1 * min, tapped: false }]);
  });

  it("isn't one fix: the phone may be passing by", () => {
    expect(run([fix(2000, 0), fix(100, 1), fix(2000, 2)]).events).toEqual([]);
  });

  it("doesn't count a fix less sure than the radius, and starts the count again after it", () => {
    expect(run([fix(50, 0), fix(50, 1, 400), fix(50, 2)]).events).toEqual([]);
    expect(run([fix(50, 0), fix(50, 1, 400), fix(50, 2), fix(50, 3)]).events).toEqual([{ kind: "arrived", visitId: "oak", at: T0 + 2 * min, tapped: false }]);
  });

  it("counts a fix as sure as the radius, and not one just outside it", () => {
    expect(run([fix(0, 0, 200), fix(0, 1, 200)]).events).toHaveLength(1);
    expect(run([fix(205, 0), fix(205, 1)]).events).toEqual([]);
  });

  it("follows the radius the office chose", () => {
    expect(run([fix(300, 0), fix(300, 1)], [OAK], 200).events).toEqual([]);
    expect(run([fix(300, 0), fix(300, 1)], [OAK], 400).events).toHaveLength(1);
  });

  it("counts when the app opens already there (the phone didn't know where it was before)", () => {
    expect(run([fix(10, 0), fix(12, 0.5)]).events).toEqual([{ kind: "arrived", visitId: "oak", at: T0, tapped: false }]);
  });

  it("happens once however long they stay", () => {
    const { events } = run([fix(10, 0), fix(10, 1), fix(10, 2), fix(30, 30), fix(5, 90), fix(400, 95), fix(20, 96)]);
    expect(events.filter((e) => e.kind === "arrived")).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("starts a new run when the fixes are far apart in time: they may have left and come back between", () => {
    const { events } = run([fix(2000, 0), fix(10, 1), fix(10, 1 + IN_A_ROW_MS / min + 5), fix(10, 1 + IN_A_ROW_MS / min + 6)]);
    expect(events).toEqual([{ kind: "arrived", visitId: "oak", at: T0 + (1 + IN_A_ROW_MS / min + 5) * min, tapped: false }]);
  });

  it("skips a fix older than the last, or the same one again, or one that makes no sense", () => {
    const first = run([fix(10, 5)]);
    expect(trackFix(first.state, fix(10, 4), [OAK], 200)).toEqual({ state: first.state, events: [] });
    expect(trackFix(first.state, fix(10, 5), [OAK], 200)).toEqual({ state: first.state, events: [] });
    expect(trackFix(first.state, { ...fix(10, 6), lat: Number.NaN }, [OAK], 200).events).toEqual([]);
    expect(trackFix(first.state, { ...fix(10, 6), accuracy: -1 }, [OAK], 200).state).toBe(first.state);
  });

  it("leaves out a property with no point on the map", () => {
    expect(run([fix(10, 0), fix(10, 1)], [{ ...OAK, lat: Number.NaN }]).events).toEqual([]);
  });
});

describe("leaving", () => {
  const there = () => run([fix(10, 0), fix(10, 1)]).state;

  it("takes fixes past the radius and its margin for a few minutes, and is dated at the first one outside", () => {
    const { events } = run([fix(600, 10), fix(900, 11), fix(1500, 10 + LEAVE_AFTER_MS / min)], [OAK], 200, there());
    expect(events).toEqual([{ kind: "left", visitId: "oak", at: T0 + 10 * min, tapped: false }]);
  });

  it("isn't a few fixes in the margin: a big lot, or a rough fix", () => {
    // 200 m radius, 100 m margin: 250 m out is neither in nor gone.
    expect(run([fix(250, 10), fix(260, 20), fix(280, 40)], [OAK], 200, there()).events).toEqual([]);
  });

  it("isn't a fix far out with an error as big as the distance", () => {
    expect(run([fix(600, 10, 500), fix(600, 30, 500)], [OAK], 200, there()).events).toEqual([]);
  });

  it("is cancelled by a fix back inside (they walked to the truck and back)", () => {
    expect(run([fix(600, 10), fix(20, 11), fix(600, 12), fix(600, 14)], [OAK], 200, there()).events).toEqual([]);
  });

  it("isn't cancelled by a fix in the margin", () => {
    expect(run([fix(600, 10), fix(250, 11), fix(600, 14)], [OAK], 200, there()).events).toEqual([{ kind: "left", visitId: "oak", at: T0 + 10 * min, tapped: false }]);
  });

  it("is never dated from an old fix outside: a run to the parts store at noon doesn't end the day's work at noon", () => {
    // 12:00 one fix on the way out for parts, and the phone is locked. Back at 12:20, working until
    // 15:40 with the phone in a pocket. Crewtavo is opened again after leaving, at 15:45.
    const noon = 120;
    const opened = noon + 225;
    const lunch = run([fix(900, noon)], [OAK], 200, there());
    expect(lunch.events).toEqual([]);
    const first = run([fix(1200, opened)], [OAK], 200, lunch.state);
    // The first fix after hours away starts the run again: nothing yet, and nothing dated at noon.
    expect(first.events).toEqual([]);
    expect(first.state.sites.oak!.outSince).toBe(T0 + opened * min);
    const sure = run([fix(1500, opened + 0.5), fix(2500, opened + LEAVE_AFTER_MS / min)], [OAK], 200, first.state);
    expect(sure.events).toEqual([{ kind: "left", visitId: "oak", at: T0 + opened * min, tapped: false }]);
  });

  it("isn't one bad fix followed, much later, by another, with only rough fixes between", () => {
    // Indoors: a fix that jumps 600 m out, then fixes too rough to say either way, then another jump.
    const rough = Array.from({ length: 8 }, (_, i) => fix(30, 12 + i * 4, 400));
    const { events, state } = run([fix(600, 10), ...rough, fix(600, 45)], [OAK], 200, there());
    expect(events).toEqual([]);
    expect(state.sites.oak!.where).toBe("inside");
    // The second jump is only the start of a new run, which a good fix inside then cancels.
    expect(state.sites.oak!.outSince).toBe(T0 + 45 * min);
    expect(run([fix(20, 46), fix(600, 49)], [OAK], 200, state).events).toEqual([]);
  });

  it("still counts fixes outside a few minutes apart as one run", () => {
    const { events } = run([fix(600, 10), fix(700, 10 + IN_A_ROW_MS / min - 1)], [OAK], 200, there());
    expect(events).toEqual([{ kind: "left", visitId: "oak", at: T0 + 10 * min, tapped: false }]);
    // Just past it: a new run, confirmed only by a fix a few minutes into that one.
    const late = run([fix(600, 10), fix(700, 10 + IN_A_ROW_MS / min + 1)], [OAK], 200, there());
    expect(late.events).toEqual([]);
    expect(run([fix(700, 10 + IN_A_ROW_MS / min + 1 + LEAVE_AFTER_MS / min)], [OAK], 200, late.state).events).toEqual([
      { kind: "left", visitId: "oak", at: T0 + (10 + IN_A_ROW_MS / min + 1) * min, tapped: false },
    ]);
  });

  it("doesn't trust an old first fix outside kept by a phone from before this", () => {
    // What an older app saved: when the run began, and nothing about its latest fix.
    const kept: GeofenceState = { last: T0 + 120 * min, sites: { oak: { where: "inside", inRow: 0, firstIn: null, outSince: T0 + 120 * min, tapped: false } } };
    const { events, state } = run([fix(900, 345)], [OAK], 200, kept);
    expect(events).toEqual([]);
    expect(state.sites.oak!.outSince).toBe(T0 + 345 * min);
  });

  it("only follows an arrival: never having been there isn't leaving", () => {
    expect(run([fix(2000, 0), fix(3000, 10), fix(4000, 20)]).events).toEqual([]);
  });

  it("happens once, and then coming back is a new arrival", () => {
    const { events } = run([fix(600, 10), fix(600, 14), fix(800, 20), fix(10, 30), fix(10, 31)], [OAK], 200, there());
    expect(events.map((e) => [e.kind, (e.at - T0) / min])).toEqual([["left", 10], ["arrived", 30]]);
  });
});

describe("taps win", () => {
  it("marks the visit when they tap while there, and says so as they leave; then it's forgotten", () => {
    let state = noteTap(run([fix(10, 0), fix(10, 1)]).state, ["oak"]);
    const out = run([fix(600, 10), fix(600, 14)], [OAK], 200, state);
    expect(out.events).toEqual([{ kind: "left", visitId: "oak", at: T0 + 10 * min, tapped: true }]);
    state = out.state;
    expect(state.sites.oak!.tapped).toBe(false);
    expect(run([fix(10, 30), fix(10, 31)], [OAK], 200, state).events[0]!.tapped).toBe(false);
  });

  it("counts a tap made before the phone knew where it was, for the arrival it finds", () => {
    const state = noteTap(emptyGeofence(), ["oak"]);
    expect(run([fix(10, 0), fix(10, 1)], [OAK], 200, state).events).toEqual([{ kind: "arrived", visitId: "oak", at: T0, tapped: true }]);
  });

  it("doesn't count a tap made on the way there: arriving is coming back", () => {
    const away = run([fix(3000, 0)]).state;
    const state = noteTap(away, ["oak"]);
    expect(state).toEqual(away);
    expect(run([fix(10, 10), fix(10, 11)], [OAK], 200, state).events[0]!.tapped).toBe(false);
  });
});

describe("two properties", () => {
  it("tracks each on its own: gone from one and at the next", () => {
    const elmNorth = (ELM.lat - 40) * M_PER_DEG;
    const { events } = run([fix(10, 0), fix(10, 1), fix(elmNorth, 20), fix(elmNorth + 5, 21), fix(elmNorth, 24)], [OAK, ELM]);
    expect(events.map((e) => [e.kind, e.visitId, (e.at - T0) / min])).toEqual([["arrived", "oak", 0], ["arrived", "elm", 20], ["left", "oak", 20]]);
  });

  it("forgets a visit that isn't today's any more", () => {
    const { state } = run([fix(10, 0), fix(10, 1)], [OAK, ELM]);
    expect(Object.keys(keepSites(state, ["elm"]).sites)).toEqual(["elm"]);
  });
});

describe("what to do", () => {
  const arrived = (visitId = "oak", tapped = false): GeofenceEvent => ({ kind: "arrived", visitId, at: T0, tapped });
  const left = (visitId = "oak", tapped = false): GeofenceEvent => ({ kind: "left", visitId, at: T0 + 60 * min, tapped });
  const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({ mode: "clock", sites: [OAK], clock: null, day: false, ...over });

  it("does nothing when the company has it off", () => {
    expect(geofenceActions([arrived(), left()], ctx({ mode: "off" }))).toEqual([]);
  });

  describe("remind", () => {
    it("asks to start a visit that hasn't started, and never touches the clock", () => {
      expect(geofenceActions([arrived()], ctx({ mode: "remind" }))).toEqual([{ kind: "ask-start", visitId: "oak", clockOnly: false }]);
      expect(geofenceActions([arrived()], ctx({ mode: "remind", sites: [{ ...OAK, status: "en_route" }] }))).toEqual([{ kind: "ask-start", visitId: "oak", clockOnly: false }]);
    });

    it("asks to start their clock on a visit a crewmate started", () => {
      expect(geofenceActions([arrived()], ctx({ mode: "remind", sites: [{ ...OAK, status: "in_progress" }] }))).toEqual([{ kind: "ask-start", visitId: "oak", clockOnly: true }]);
    });

    it("asks nothing when the visit is under way and their clock is on it", () => {
      expect(geofenceActions([arrived()], ctx({ mode: "remind", sites: [{ ...OAK, status: "in_progress" }], clock: { category: "visit", visitId: "oak" } }))).toEqual([]);
    });

    it("asks to complete the visit, or stop their clock, as they leave", () => {
      const sites = [{ ...OAK, status: "in_progress" }];
      expect(geofenceActions([left()], ctx({ mode: "remind", sites, clock: { category: "visit", visitId: "oak" } }))).toEqual([{ kind: "ask-finish", visitId: "oak", complete: true, stopClock: true }]);
      expect(geofenceActions([left()], ctx({ mode: "remind", sites }))).toEqual([{ kind: "ask-finish", visitId: "oak", complete: true, stopClock: false }]);
      expect(geofenceActions([left()], ctx({ mode: "remind", clock: { category: "visit", visitId: "oak" } }))).toEqual([{ kind: "ask-finish", visitId: "oak", complete: false, stopClock: true }]);
      expect(geofenceActions([left()], ctx({ mode: "remind" }))).toEqual([]);
    });
  });

  describe("start and stop the clock", () => {
    it("starts their clock at the arrival and still asks them to start the visit (that can text the client)", () => {
      expect(geofenceActions([arrived()], ctx())).toEqual([
        { kind: "start-clock", visitId: "oak", at: T0 },
        { kind: "ask-start", visitId: "oak", clockOnly: false },
      ]);
    });

    it("moves them onto the visit from driving, as a tap would", () => {
      expect(geofenceActions([arrived()], ctx({ clock: { category: "drive", visitId: null }, day: true }))[0]).toEqual({ kind: "start-clock", visitId: "oak", at: T0 });
    });

    it("never moves a clock that's running on another visit, the shop or other work: it only asks", () => {
      const sites = [{ ...ELM, status: "in_progress" }, OAK];
      for (const clock of [{ category: "visit", visitId: "elm" }, { category: "shop", visitId: null }, { category: "other", visitId: null }, { category: "assessment", visitId: null }, { category: "drive", visitId: "elm" }]) {
        expect(geofenceActions([arrived()], ctx({ sites, clock }))).toEqual([{ kind: "ask-start", visitId: "oak", clockOnly: false }]);
        // On a visit a crewmate started, it offers their clock rather than taking it.
        expect(geofenceActions([arrived()], ctx({ sites: [sites[0]!, { ...OAK, status: "in_progress" }], clock }))).toEqual([{ kind: "ask-start", visitId: "oak", clockOnly: true }]);
      }
    });

    it("only asks at a visit that isn't the next one today: driving past a later property doesn't start its clock", () => {
      const pine: GeofenceSite = { visitId: "pine", lat: 40.1, lng: -75, place: "3 Pine Rd", status: "scheduled" };
      // Oak is next; Elm and Pine come later.
      expect(geofenceActions([arrived("elm")], ctx({ sites: [OAK, ELM, pine] }))).toEqual([{ kind: "ask-start", visitId: "elm", clockOnly: false }]);
      expect(geofenceActions([arrived("pine")], ctx({ sites: [OAK, ELM, pine], clock: { category: "drive", visitId: null }, day: true }))).toEqual([{ kind: "ask-start", visitId: "pine", clockOnly: false }]);
      expect(geofenceActions([arrived("oak")], ctx({ sites: [OAK, ELM, pine] }))[0]).toEqual({ kind: "start-clock", visitId: "oak", at: T0 });
      // With Oak under way (or done, and gone from the list), Elm is next.
      expect(geofenceActions([arrived("elm")], ctx({ sites: [{ ...OAK, status: "in_progress" }, ELM, pine] }))[0]).toEqual({ kind: "start-clock", visitId: "elm", at: T0 });
      expect(geofenceActions([arrived("elm")], ctx({ sites: [ELM, pine] }))[0]).toEqual({ kind: "start-clock", visitId: "elm", at: T0 });
      // They said they're on their way to Pine: that's where they're expected.
      expect(geofenceActions([arrived("pine")], ctx({ sites: [OAK, ELM, { ...pine, status: "en_route" }] }))[0]).toEqual({ kind: "start-clock", visitId: "pine", at: T0 });
    });

    it("starts their clock on a visit a crewmate started, and asks nothing more", () => {
      expect(geofenceActions([arrived()], ctx({ sites: [{ ...OAK, status: "in_progress" }] }))).toEqual([{ kind: "start-clock", visitId: "oak", at: T0 }]);
    });

    it("leaves a clock already on the visit as it is", () => {
      expect(geofenceActions([arrived()], ctx({ sites: [{ ...OAK, status: "in_progress" }], clock: { category: "visit", visitId: "oak" } }))).toEqual([]);
    });

    it("never starts a clock over a break: it asks instead", () => {
      expect(geofenceActions([arrived()], ctx({ clock: { category: "break", visitId: null } }))).toEqual([{ kind: "ask-start", visitId: "oak", clockOnly: false }]);
      expect(geofenceActions([arrived()], ctx({ clock: { category: "break", visitId: null }, sites: [{ ...OAK, status: "in_progress" }] }))).toEqual([{ kind: "ask-start", visitId: "oak", clockOnly: true }]);
    });

    it("never starts a clock on a finished or cancelled visit, nor asks about one", () => {
      for (const status of ["completed", "cancelled"]) {
        expect(geofenceActions([arrived(), left()], ctx({ sites: [{ ...OAK, status }], clock: { category: "visit", visitId: "oak" } }))).toEqual([]);
      }
    });

    it("doesn't fight a tap: after one there, it only asks", () => {
      expect(geofenceActions([arrived("oak", true)], ctx())).toEqual([{ kind: "ask-start", visitId: "oak", clockOnly: false }]);
      expect(geofenceActions([left("oak", true)], ctx({ sites: [{ ...OAK, status: "in_progress" }], clock: { category: "visit", visitId: "oak" } }))).toEqual([
        { kind: "ask-finish", visitId: "oak", complete: true, stopClock: true },
      ]);
    });

    it("never stops a visits-only clock as they leave: it asks, and the clock runs on (the drive to the next site is working time)", () => {
      expect(geofenceActions([left()], ctx({ sites: [{ ...OAK, status: "in_progress" }], clock: { category: "visit", visitId: "oak" } }))).toEqual([
        { kind: "ask-finish", visitId: "oak", complete: true, stopClock: true },
      ]);
      // A visit that isn't in progress (a crewmate's, or one not started): still only the question.
      expect(geofenceActions([left()], ctx({ clock: { category: "visit", visitId: "oak" } }))).toEqual([{ kind: "ask-finish", visitId: "oak", complete: false, stopClock: true }]);
    });

    it("moves it to travel on the whole-day clock, and asks them to complete the visit", () => {
      expect(geofenceActions([left()], ctx({ day: true, clock: { category: "visit", visitId: "oak" } }))).toEqual([{ kind: "stop-clock", visitId: "oak", at: T0 + 60 * min, travel: true }]);
      expect(geofenceActions([left()], ctx({ day: true, sites: [{ ...OAK, status: "in_progress" }], clock: { category: "visit", visitId: "oak" } }))).toEqual([
        { kind: "stop-clock", visitId: "oak", at: T0 + 60 * min, travel: true },
        { kind: "ask-finish", visitId: "oak", complete: true, stopClock: false },
      ]);
    });

    it("never takes anyone off the clock, whatever the clock, the visit's status or what else the fix shows", () => {
      const clock = { category: "visit", visitId: "oak" };
      for (const day of [false, true]) {
        for (const status of ["scheduled", "en_route", "in_progress"]) {
          for (const events of [[left()], [left(), arrived("elm")], [arrived("elm"), left()]]) {
            const actions = geofenceActions(events, ctx({ day, sites: [{ ...OAK, status }, ELM], clock, now: T0 + 70 * min, here: [{ visitId: "elm", since: T0, tapped: false, inNow: true, held: false }] }));
            // The only thing that changes a running clock is a move onto travel, and only on the whole-day clock.
            for (const a of actions) if (a.kind === "stop-clock") expect(day && a.travel).toBe(true);
            expect(actions.some((a) => a.kind === "stop-clock")).toBe(day);
            if (!day) expect(actions.some((a) => a.kind === "start-clock")).toBe(false);
          }
        }
      }
    });

    it("leaves a clock that isn't on the visit as it is (a break, the next visit, driving)", () => {
      expect(geofenceActions([left()], ctx({ clock: { category: "break", visitId: null } }))).toEqual([]);
      expect(geofenceActions([left()], ctx({ clock: { category: "visit", visitId: "elm" } }))).toEqual([]);
      expect(geofenceActions([left()], ctx({ sites: [{ ...OAK, status: "in_progress" }], clock: { category: "drive", visitId: null } }))).toEqual([
        { kind: "ask-finish", visitId: "oak", complete: true, stopClock: false },
      ]);
    });

    it("never completes a visit itself", () => {
      const all = geofenceActions([left(), arrived()], ctx({ sites: [{ ...OAK, status: "in_progress" }], clock: { category: "visit", visitId: "oak" } }));
      expect(all.map((a) => a.kind)).not.toContain("complete");
    });

    it("acts on one visit when two are at the same property: the one under way, else the first", () => {
      const twin = { ...OAK, visitId: "oak-2" };
      expect(geofenceActions([arrived("oak"), arrived("oak-2")], ctx({ sites: [OAK, twin] }))).toEqual([
        { kind: "start-clock", visitId: "oak", at: T0 },
        { kind: "ask-start", visitId: "oak", clockOnly: false },
      ]);
      // One under way already: their clock goes on it, and the other is asked about, the clock left where it is.
      expect(geofenceActions([arrived("oak"), arrived("oak-2")], ctx({ sites: [OAK, { ...twin, status: "in_progress" }] }))).toEqual([
        { kind: "start-clock", visitId: "oak-2", at: T0 },
        { kind: "ask-start", visitId: "oak", clockOnly: false },
      ]);
    });

    it("moves the clock to travel at the last property before starting it at the next, from one fix (the whole-day clock)", () => {
      const sites = [{ ...OAK, status: "in_progress" }, ELM];
      expect(geofenceActions([arrived("elm"), left("oak")], ctx({ day: true, sites, clock: { category: "visit", visitId: "oak" } }))).toEqual([
        { kind: "stop-clock", visitId: "oak", at: T0 + 60 * min, travel: true },
        { kind: "ask-finish", visitId: "oak", complete: true, stopClock: false },
        { kind: "start-clock", visitId: "elm", at: T0 },
        { kind: "ask-start", visitId: "elm", clockOnly: false },
      ]);
    });

    it("on the visits-only clock, asks about both from one fix and moves nothing: the clock stays on the visit they left", () => {
      const sites = [{ ...OAK, status: "in_progress" }, ELM];
      expect(geofenceActions([arrived("elm"), left("oak")], ctx({ sites, clock: { category: "visit", visitId: "oak" } }))).toEqual([
        { kind: "ask-finish", visitId: "oak", complete: true, stopClock: true },
        { kind: "ask-start", visitId: "elm", clockOnly: false },
      ]);
    });

    it("ignores a visit it doesn't have (taken off today since)", () => {
      expect(geofenceActions([arrived("gone"), left("gone")], ctx())).toEqual([]);
    });
  });
});

describe("a day, fix by fix (geofenceStep)", () => {
  const elmNorth = (ELM.lat - 40) * M_PER_DEG;
  type Ctx = Parameters<typeof geofenceStep>[3];
  const ctx = (over: Partial<Ctx> = {}): Ctx => ({ mode: "clock", sites: [OAK, ELM], clock: null, day: false, ...over });
  /** Feeds fixes with what the phone knows at each, and collects what it does. */
  function day(fixes: Fix[], at: (f: Fix) => Partial<Ctx>, from: GeofenceState = emptyGeofence()) {
    let state = from;
    const done: Array<[number, GeofenceEvent["kind"] | string, string, number?]> = [];
    for (const f of fixes) {
      const out = geofenceStep(state, f, 200, ctx(at(f)));
      state = out.state;
      for (const a of out.actions) done.push([(f.at - T0) / min, a.kind, a.visitId, "at" in a ? (a.at - T0) / min : undefined]);
    }
    return { state, done };
  }

  /** Clock on Oak (in progress). They drive to Elm with the phone locked and open Crewtavo there at minute 30. The phone does what it decides. */
  function driveToElm(dayClock: boolean) {
    const oak = { ...OAK, status: "in_progress" };
    const atOak = run([fix(10, 0), fix(10, 1)], [oak, ELM]).state;
    const fixes = [fix(elmNorth, 30), fix(elmNorth + 5, 30.4), fix(elmNorth, 31), fix(elmNorth + 3, 32), fix(elmNorth, 33.1)];
    let clock: Ctx["clock"] = { category: "visit", visitId: "oak" };
    let state = atOak;
    const done: string[] = [];
    for (const f of fixes) {
      const out = geofenceStep(state, f, 200, ctx({ day: dayClock, sites: [oak, ELM], clock }));
      state = out.state;
      for (const a of out.actions) {
        done.push(`${(f.at - T0) / min} ${a.kind} ${a.visitId}${"at" in a ? ` @${(a.at - T0) / min}` : ""}${a.kind === "ask-finish" && a.stopClock ? " stop?" : ""}`);
        if (a.kind === "stop-clock") clock = { category: "drive", visitId: null };
        if (a.kind === "start-clock") clock = { category: "visit", visitId: a.visitId };
      }
    }
    return { done, clock };
  }

  it("leaves the clock on the last visit when they turn up at the next with it still running, and moves it once it's sure they left (the whole-day clock)", () => {
    expect(driveToElm(true).done).toEqual([
      // At Elm: asked, and Oak's clock is left alone (it used to jump to Elm here).
      "30.4 ask-start elm",
      // Three minutes on, surely gone from Oak: onto travel there, dated when they were first seen away, and started at Elm from then.
      "33.1 stop-clock oak @30",
      "33.1 ask-finish oak",
      "33.1 start-clock elm @30",
    ]);
  });

  it("on the visits-only clock the same drive only asks: nothing comes off the clock, and it's still running on the visit they left", () => {
    const { done, clock } = driveToElm(false);
    expect(done).toEqual(["30.4 ask-start elm", "33.1 ask-finish oak stop?"]);
    expect(clock).toEqual({ category: "visit", visitId: "oak" });
  });

  it("doesn't start a clock at a property they're only passing as the one behind is confirmed left", () => {
    const oak = { ...OAK, status: "in_progress" };
    const pine: GeofenceSite = { visitId: "pine", lat: 40.02, lng: -75, place: "3 Pine Rd", status: "scheduled" };
    const pineNorth = (pine.lat - 40) * M_PER_DEG;
    const atOak = run([fix(10, 0), fix(10, 1)], [oak, ELM, pine]).state;
    // Away from Oak at minute 30, through Pine's circle (a later visit) a minute on, and out the other side.
    const { done } = day([fix(900, 30), fix(pineNorth - 20, 31), fix(pineNorth + 20, 31.4), fix(pineNorth + 900, 32), fix(pineNorth + 1500, 33.2)], () => ({ day: true, sites: [oak, ELM, pine], clock: { category: "visit", visitId: "oak" } }), atOak);
    expect(done).toEqual([
      [31.4, "ask-start", "pine", undefined],
      [33.2, "stop-clock", "oak", 30],
      [33.2, "ask-finish", "oak", undefined],
    ]);
    expect(STAYED_MS).toBeGreaterThanOrEqual(2 * min);
  });

  it("gives the second visit at one address its own question once the first's is answered", () => {
    const twin = { ...OAK, visitId: "oak-2" };
    let sites = [OAK, twin];
    let clock: Ctx["clock"] = null;
    let asking: string[] = [];
    let state = emptyGeofence();
    const step = (f: Fix) => {
      const out = geofenceStep(state, f, 200, ctx({ sites, clock, asking }));
      state = out.state;
      return out.actions;
    };
    expect(step(fix(10, 0))).toEqual([]);
    // Both arrive on this fix: the first in the day's order is put to them, the other waits.
    expect(step(fix(10, 0.4))).toEqual([{ kind: "start-clock", visitId: "oak", at: T0 }, { kind: "ask-start", visitId: "oak", clockOnly: false }]);
    expect(stays(state).find((h) => h.visitId === "oak-2")!.held).toBe(true);
    clock = { category: "visit", visitId: "oak" };
    asking = ["oak"];
    // While that question is on the screen, nothing more.
    expect(step(fix(10, 1))).toEqual([]);
    expect(step(fix(10, 1.5))).toEqual([]);
    // They tap Start visit: the question is answered, and the other visit gets its own. Their clock stays where it is.
    sites = [{ ...OAK, status: "in_progress" }, twin];
    asking = [];
    expect(step(fix(10, 2))).toEqual([{ kind: "ask-start", visitId: "oak-2", clockOnly: false }]);
    expect(stays(state).every((h) => !h.held)).toBe(true);
    asking = ["oak-2"];
    // And once, not at every fix after.
    expect(step(fix(10, 2.5))).toEqual([]);
  });

  it("does the same when the first is finished, or its question is waved away, and for circles that overlap", () => {
    // Elm's property is 250 m up the road from Oak's: standing between them is inside both circles.
    const near: GeofenceSite = { ...ELM, lat: 40 + 250 / M_PER_DEG };
    let sites = [OAK, near];
    let asking: string[] = [];
    let state = emptyGeofence();
    const step = (f: Fix, clock: Ctx["clock"] = null) => {
      const out = geofenceStep(state, f, 200, ctx({ sites, clock, asking }));
      state = out.state;
      return out.actions;
    };
    step(fix(125, 0));
    expect(step(fix(125, 0.4)).map((a) => `${a.kind} ${a.visitId}`)).toEqual(["start-clock oak", "ask-start oak"]);
    asking = ["oak"];
    expect(step(fix(125, 1), { category: "visit", visitId: "oak" })).toEqual([]);
    // "Not now" on Oak's question: Elm's turn, asked only (their clock is on Oak).
    asking = [];
    expect(step(fix(125, 1.5), { category: "visit", visitId: "oak" })).toEqual([{ kind: "ask-start", visitId: "elm", clockOnly: false }]);

    // Another day: Oak is completed while they stand there (their clock stops with it), and Elm, now next, gets its clock, dated now.
    state = emptyGeofence();
    sites = [OAK, near];
    step(fix(125, 0));
    step(fix(125, 0.4));
    asking = ["oak"];
    step(fix(125, 20), { category: "visit", visitId: "oak" });
    sites = [{ ...OAK, status: "completed" }, near];
    asking = [];
    expect(step(fix(125, 45))).toEqual([{ kind: "start-clock", visitId: "elm", at: T0 + 45 * min }, { kind: "ask-start", visitId: "elm", clockOnly: false }]);
  });

  it("changes nothing for a fix it skips", () => {
    const first = geofenceStep(emptyGeofence(), fix(10, 5), 200, ctx());
    expect(geofenceStep(first.state, fix(10, 4), 200, ctx())).toEqual({ state: first.state, events: [], actions: [] });
  });
});

describe("how often to look", () => {
  it("looks soon and with GPS before the first fix, and while an arrival or departure is being confirmed", () => {
    expect(nextLook(emptyGeofence(), null, [OAK], 200)).toEqual({ delayMs: 20_000, precise: true });
    const halfway = run([fix(10, 0)]).state;
    expect(nextLook(halfway, fix(10, 0), [OAK], 200)).toEqual({ delayMs: 20_000, precise: true });
  });

  it("every half minute near a property or while there", () => {
    expect(nextLook(run([fix(1000, 0)]).state, fix(1000, 0), [OAK], 200)).toEqual({ delayMs: 30_000, precise: true });
    expect(nextLook(run([fix(10, 0), fix(10, 1)]).state, fix(10, 1), [OAK], 200)).toEqual({ delayMs: 30_000, precise: true });
  });

  it("less often, and roughly, far from all of them", () => {
    expect(nextLook(run([fix(5000, 0)]).state, fix(5000, 0), [OAK], 200)).toEqual({ delayMs: 60_000, precise: true });
    expect(nextLook(run([fix(30_000, 0)]).state, fix(30_000, 0), [OAK], 200)).toEqual({ delayMs: 120_000, precise: false });
  });

  it("doesn't count finished visits", () => {
    expect(nextLook(emptyGeofence(), fix(10, 0), [{ ...OAK, status: "completed" }], 200)).toEqual({ delayMs: 120_000, precise: false });
  });
});
