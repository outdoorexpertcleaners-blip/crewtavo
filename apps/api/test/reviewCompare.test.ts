/**
 * How you compare (services/reviewCompare.ts, routes/reviewCompare.ts): the server keeps the switch
 * and the list of place IDs and nothing else, never asks Google about a place, and turns down a
 * body that carries anything Google said. The database answers what each test gives.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv, Env } from "../src/env";
import { addPlace, comparisonState, NO_KEY, setComparison } from "../src/services/reviewCompare";
import { CRON_TASKS, TASKS } from "../src/tasks";

const current = vi.hoisted(() => ({ db: null as unknown, role: "office" }));
vi.mock("../src/lib/supabase", async (original) => ({ ...(await original<typeof import("../src/lib/supabase")>()), adminClient: () => current.db }));
// Signed in as someone in the office with the marketing area, or as an owner.
vi.mock("../src/lib/auth", async (original) => ({
  ...(await original<typeof import("../src/lib/auth")>()),
  requireUser: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("userId", "00000000-0000-4000-8000-0000000000a1");
    await next();
  },
  requireCompany: (roles: readonly string[]) => async (c: { set: (k: string, v: unknown) => void; json: (b: unknown, s: number) => Response }, next: () => Promise<void>) => {
    if (!roles.includes(current.role)) return c.json({ error: "You don't have access to that." }, 403);
    c.set("companyId", CO);
    c.set("role", current.role);
    await next();
  },
}));
const { reviewCompare } = await import("../src/routes/reviewCompare");

const env: Env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test", APP_URL: "https://crew.example.com" };
const CO = "00000000-0000-4000-8000-0000000000c0";
const USER = "00000000-0000-4000-8000-0000000000a1";

type Row = Record<string, any>;
/** The tables as lists of rows, with the two rules the database keeps for review_places. */
function memoryDb(tables: Record<string, Row[]>) {
  let ids = 0;
  const query = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let upsert: Row | null = null;
    let remove = false;
    let single = false;
    const run = () => {
      const rows = (tables[table] ??= []);
      if (upsert) {
        const key = table === "review_places" ? (r: Row) => r.company_id === upsert!.company_id && r.place_id === upsert!.place_id : (r: Row) => r.company_id === upsert!.company_id;
        const found = rows.find(key);
        // review_places_limit: five competitors at most.
        if (table === "review_places" && !upsert.is_own && rows.filter((r) => r.company_id === upsert!.company_id && !r.is_own && r !== found).length >= 5)
          return { data: null, error: { code: "22023", message: "Compare with up to five competitors. Remove one first." } };
        const row = found ? Object.assign(found, upsert) : (rows.push({ id: `row-${++ids}`, ...upsert }), rows.at(-1)!);
        return { data: single ? { ...row } : null, error: null };
      }
      const matching = rows.filter((r) => filters.every((f) => f(r)));
      if (remove) {
        tables[table] = rows.filter((r) => !matching.includes(r));
        return { data: null, error: null };
      }
      return { data: single ? (matching[0] ?? null) : matching.map((r) => ({ ...r })), error: null };
    };
    const q: any = {
      select: () => q,
      upsert: (v: Row) => ((upsert = v), q),
      delete: () => ((remove = true), q),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
      match: (v: Row) => (filters.push((r) => Object.entries(v).every(([k, x]) => r[k] === x)), q),
      order: () => q,
      maybeSingle: () => ((single = true), q),
      single: () => ((single = true), q),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return q;
  };
  return { from: query, rpc: async (name: string) => Promise.reject(new Error(`No function is called anymore, but ${name} was`)) };
}

const world = (settings: Row = { marketing: { enabled: true }, maps: { google_key: "AIzaBrowser" } }, more: Record<string, Row[]> = {}): Record<string, Row[]> => ({
  companies: [{ id: CO, name: "Sketchy Gutters", settings }],
  review_comparisons: [],
  review_places: [],
  integrations: [],
  ...more,
});

/** Google, which this server must never call. */
const outside = vi.fn(async () => new Response("{}", { status: 500 }));
beforeEach(() => {
  outside.mockClear();
  current.role = "office";
  vi.stubGlobal("fetch", outside);
});
afterEach(() => vi.unstubAllGlobals());

describe("what the server keeps", () => {
  it("is the switch and each place's Google ID, and that's all it hands the card", async () => {
    const tables = world(undefined, {
      review_comparisons: [{ company_id: CO, enabled: true, enabled_by: USER }],
      review_places: [{ id: "a", company_id: CO, place_id: "ChIJ-own", is_own: true }, { id: "b", company_id: CO, place_id: "ChIJ_rival", is_own: false }],
    });
    expect(await comparisonState(memoryDb(tables) as never, CO)).toEqual({
      enabled: true,
      places: [{ id: "a", place_id: "ChIJ-own", is_own: true }, { id: "b", place_id: "ChIJ_rival", is_own: false }],
    });
    expect(await comparisonState(memoryDb(world()) as never, CO)).toEqual({ enabled: false, places: [] });
  });

  it("adds a place by its ID alone, and never asks Google about it", async () => {
    const tables = world(undefined, { review_comparisons: [{ company_id: CO, enabled: true }] });
    const db = memoryDb(tables);
    await addPlace(db as never, CO, "ChIJ_rival", false);
    await addPlace(db as never, CO, "ChIJ-own", true);
    expect(tables.review_places!.map(({ id: _id, ...row }) => row)).toEqual([
      { company_id: CO, place_id: "ChIJ_rival", is_own: false },
      { company_id: CO, place_id: "ChIJ-own", is_own: true },
    ]);
    expect(outside).not.toHaveBeenCalled();
  });

  it("takes only something shaped like a place ID", async () => {
    const db = memoryDb(world(undefined, { review_comparisons: [{ company_id: CO, enabled: true }] }));
    for (const not of ["Rival Gutters", "1 Elm St, Springfield", "https://maps.google.com/?cid=1", "../admin", ""]) await expect(addPlace(db as never, CO, not, false)).rejects.toThrow(/isn't a Google place/);
  });

  it("turns down a sixth competitor, as the database does", async () => {
    const tables = world(undefined, {
      review_comparisons: [{ company_id: CO, enabled: true }],
      review_places: [1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, company_id: CO, place_id: `ChIJ${n}`, is_own: false })),
    });
    const db = memoryDb(tables);
    await expect(addPlace(db as never, CO, "ChIJ6", false)).rejects.toThrow(/up to five competitors/);
    // The business itself still fits, and so does marking one of the five as the business.
    await addPlace(db as never, CO, "ChIJ-own", true);
    expect(tables.review_places).toHaveLength(6);
  });

  it("has one place of its own: picking another takes the first one's place", async () => {
    const tables = world(undefined, { review_comparisons: [{ company_id: CO, enabled: true }], review_places: [{ id: "a", company_id: CO, place_id: "ChIJold", is_own: true }] });
    await addPlace(memoryDb(tables) as never, CO, "ChIJnew", true);
    expect(tables.review_places!.map((p) => [p.place_id, p.is_own])).toEqual([["ChIJnew", true]]);
  });

  it("adds nothing while the comparison is off", async () => {
    await expect(addPlace(memoryDb(world()) as never, CO, "ChIJ1", false)).rejects.toThrow(/Comparing with competitors is off/);
  });
});

describe("the switch", () => {
  it("turns on without asking Google anything: the browser has checked the key", async () => {
    const tables = world();
    await setComparison(env, memoryDb(tables) as never, CO, USER, true);
    expect(tables.review_comparisons).toEqual([{ id: "row-1", company_id: CO, enabled: true, enabled_by: USER }]);
    expect(outside).not.toHaveBeenCalled();
  });

  it("is refused with no Google key a browser could use, saying where to add one", async () => {
    const tables = world({ marketing: { enabled: true } });
    await expect(setComparison(env, memoryDb(tables) as never, CO, USER, true)).rejects.toThrow(NO_KEY);
    expect(NO_KEY).toContain("Settings → Maps");
    expect(tables.review_comparisons).toEqual([]);
    // This Crewtavo's own browser key will do. Its server key won't: that one never leaves the server.
    await expect(setComparison({ ...env, GOOGLE_MAPS_SERVER_KEY: "server-only" }, memoryDb(tables) as never, CO, USER, true)).rejects.toThrow(NO_KEY);
    await setComparison({ ...env, GOOGLE_MAPS_BROWSER_KEY: "AIzaInstance" }, memoryDb(tables) as never, CO, USER, true);
    expect(tables.review_comparisons![0]).toMatchObject({ enabled: true });
  });

  it("needs Marketing installed", async () => {
    await expect(setComparison(env, memoryDb(world({ maps: { google_key: "AIzaBrowser" } })) as never, CO, USER, true)).rejects.toThrow(/Install Marketing/);
  });

  it("adds the business's own place ID from Google Business Profile, without looking it up", async () => {
    const tables = world(undefined, { integrations: [{ company_id: CO, provider: "google_business", status: "connected", settings: { place_id: "ChIJ-own" } }] });
    await setComparison(env, memoryDb(tables) as never, CO, USER, true);
    expect(tables.review_places!.map(({ id: _id, ...row }) => row)).toEqual([{ company_id: CO, place_id: "ChIJ-own", is_own: true }]);
    expect(outside).not.toHaveBeenCalled();
    // Not when it's disconnected, or when what it holds isn't a place ID.
    for (const integration of [{ status: "disconnected", settings: { place_id: "ChIJ-own" } }, { status: "connected", settings: { place_id: "Sketchy Gutters, 1 Elm St" } }]) {
      const other = world(undefined, { integrations: [{ company_id: CO, provider: "google_business", ...integration }] });
      await setComparison(env, memoryDb(other) as never, CO, USER, true);
      expect(other.review_places).toEqual([]);
    }
  });

  it("turns off, keeping the places picked", async () => {
    const tables = world(undefined, { review_comparisons: [{ company_id: CO, enabled: true }], review_places: [{ id: "a", company_id: CO, place_id: "ChIJ1", is_own: false }] });
    await setComparison(env, memoryDb(tables) as never, CO, USER, false);
    expect(tables.review_comparisons![0]).toMatchObject({ enabled: false });
    expect(tables.review_places).toHaveLength(1);
  });
});

describe("what the server is sent", () => {
  const app = new Hono<AppEnv>().route("/api", reviewCompare);
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const on = () => world(undefined, { review_comparisons: [{ company_id: CO, enabled: true }] });

  it("is a place's ID and whether it's the business itself, and answers with IDs only", async () => {
    const tables = on();
    current.db = memoryDb(tables);
    const res = await send("POST", "/reviews/compare/places", { place_id: "ChIJ_rival", own: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, places: [{ id: "row-1", place_id: "ChIJ_rival", is_own: false }] });
    expect(outside).not.toHaveBeenCalled();
  });

  it("refuses anything Google said that comes along with it", async () => {
    const tables = on();
    current.db = memoryDb(tables);
    for (const extra of [{ name: "Rival Gutters" }, { address: "1 Elm St" }, { rating: 4.7 }, { ratings_total: 51 }, { maps_url: "https://maps.google.com/?cid=1" }, { lat: 39.78, lng: -89.65 }]) {
      const res = await send("POST", "/reviews/compare/places", { place_id: "ChIJ_rival", own: false, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await send("POST", "/reviews/compare/places", { place_id: "Rival Gutters" })).status).toBe(400);
    expect(tables.review_places).toEqual([]);
    current.role = "owner";
    expect((await send("PUT", "/reviews/compare/enabled", { enabled: false, last_error: "Google doesn't list Rival Gutters anymore" })).status).toBe(400);
    expect(tables.review_comparisons![0]).toMatchObject({ enabled: true });
  });

  it("has no route left that asks Google: no search, no suggestions, no check", async () => {
    current.db = memoryDb(on());
    expect((await send("GET", "/reviews/compare/search?q=rival")).status).toBe(404);
    expect((await send("GET", "/reviews/compare/suggest")).status).toBe(404);
    expect((await send("POST", "/reviews/compare/refresh")).status).toBe(404);
    expect(outside).not.toHaveBeenCalled();
  });

  it("lets the office with the marketing area pick places, and only an owner or admin flip the switch", async () => {
    current.db = memoryDb(on());
    expect((await send("PUT", "/reviews/compare/enabled", { enabled: false })).status).toBe(403);
    expect(await (await send("GET", "/reviews/compare")).json()).toMatchObject({ enabled: true, can_switch: false });
    current.role = "owner";
    expect(await (await send("PUT", "/reviews/compare/enabled", { enabled: false })).json()).toMatchObject({ enabled: false, can_switch: true });
  });

  it("removes a place by Crewtavo's own id for it", async () => {
    const tables = world(undefined, { review_comparisons: [{ company_id: CO, enabled: true }], review_places: [{ id: "00000000-0000-4000-8000-00000000000b", company_id: CO, place_id: "ChIJ1", is_own: false }] });
    current.db = memoryDb(tables);
    expect((await send("DELETE", "/reviews/compare/places/not-an-id")).status).toBe(404);
    expect(await (await send("DELETE", "/reviews/compare/places/00000000-0000-4000-8000-00000000000b")).json()).toEqual({ enabled: true, places: [] });
  });
});

describe("the server and Google Places", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

  it("has no Places client: nothing on the server names Google's Places address", () => {
    expect(existsSync(join(src, "integrations/places.ts"))).toBe(false);
    const naming = files(src).filter((f) => readFileSync(f, "utf8").includes("places.googleapis.com"));
    expect(naming).toEqual([]);
  });

  it("sends no request in a website's name: the comparison's code sets no Referer and makes no request at all", () => {
    for (const file of ["services/reviewCompare.ts", "routes/reviewCompare.ts"]) {
      const code = readFileSync(join(src, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/referer/i);
      expect(code, file).not.toMatch(/\bfetch\s*\(/);
      expect(code, file).not.toContain("GOOGLE_MAPS_SERVER_KEY");
    }
  });

  it("has no weekly task left", () => {
    expect(TASKS).not.toContain("review_compare");
    expect(Object.values(CRON_TASKS).flat()).not.toContain("review_compare");
  });
});
