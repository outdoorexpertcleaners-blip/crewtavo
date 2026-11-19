/**
 * How you compare (features/marketing/ReviewCompare.tsx, reviewCompareState.ts, reviewPlaces.ts).
 * Google's terms let Crewtavo keep a place's ID and nothing else about it, so these fail if:
 *   - anything Google says about a place is written to this browser's storage, kept in the copy of
 *     screens saved for offline, or sent to Crewtavo's server (only place IDs go there);
 *   - Google's content is on the screen without its attribution and notices, or its attribution is
 *     on a list Google had no part in;
 *   - the card asks Google anything before Compare now is pressed, or lets it be pressed again
 *     within the minute.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import {
  GOOGLE_ATTRIBUTION,
  GOOGLE_REVIEW_NOTICE,
  GOOGLE_REVIEW_POLICY_LABEL,
  GOOGLE_REVIEW_POLICY_URL,
  GOOGLE_SEARCH_NOTICE,
  GOOGLE_SEARCH_NOTICE_LABEL,
  GOOGLE_SEARCH_NOTICE_URL,
  PLACE_ID,
} from "@crewtavo/core/reviewCompare";
import { onlineManager, QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompareTable, FoundList } from "../src/features/marketing/ReviewCompare";
import {
  canCompare,
  comparableAt,
  compareRows,
  COOLDOWN_MS,
  forSaved,
  loadComparison,
  NO_KEY,
  noteCompared,
  notYetAdded,
  providersOn,
  removePlace,
  roomLeft,
  runComparison,
  savePlace,
  searchText,
  showsGoogle,
  standingOf,
  switchComparison,
  townOf,
  tradeSearchText,
  turnOn,
  withFound,
  type Readings,
  type SavedPlace,
} from "../src/features/marketing/reviewCompareState";
import { PLACE_GONE, PlacesProblem, readPlace, searchPlaces, type LivePlace } from "../src/features/marketing/reviewPlaces";
import { startOfflineCache } from "../src/lib/offline";
import { loadServiceWorker } from "./serviceWorker";

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");
/** The code alone: comments say plenty about storage, and aren't what runs. */
const code = (path: string) => source(path).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
const css = source("styles/features.css");
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node).replace(/<!-- -->/g, "");

const own: SavedPlace = { id: "row-own", place_id: "ChIJ-own", is_own: true };
const a: SavedPlace = { id: "row-a", place_id: "ChIJ_a", is_own: false };
const b: SavedPlace = { id: "row-b", place_id: "ChIJ_b", is_own: false };
const c: SavedPlace = { id: "row-c", place_id: "ChIJ_c", is_own: false };
const live = (place_id: string, name: string, rating: number | null, ratings_total: number | null, closed = false): LivePlace => ({ place_id, name, rating, ratings_total, maps_url: `https://maps.google.com/?cid=${place_id}`, closed, providers: [] });
const answers: Record<string, LivePlace> = {
  "ChIJ-own": live("ChIJ-own", "Sketchy Gutters", 4.6, 80),
  ChIJ_a: live("ChIJ_a", "Acme Gutters", 4.2, 300),
  ChIJ_b: live("ChIJ_b", "Best Gutters", 4.8, 120),
  ChIJ_c: live("ChIJ_c", "Closed Gutters", 5, 2, true),
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Google's words, shown as Google asks", () => {
  it("are its own: the attribution, the notice about reviews, and what decides the order of search results", () => {
    // Written out from the policy page (developers.google.com/maps/documentation/places/web-service/policies), not from the code.
    expect(GOOGLE_ATTRIBUTION).toBe("Google Maps");
    expect(GOOGLE_REVIEW_NOTICE).toBe("Reviews aren't verified by Google, but Google checks for and removes fake content when it's identified.");
    expect(GOOGLE_REVIEW_POLICY_LABEL).toBe("Learn more about Google Maps user-generated content policy");
    expect(GOOGLE_REVIEW_POLICY_URL).toBe("https://support.google.com/contributionpolicy/answer/7422880");
    expect(GOOGLE_SEARCH_NOTICE).toBe(
      "When searching for businesses or places near a location, Google Maps will show local results. Several factors — primarily relevance, distance and prominence — are combined to help find the best results for a search.",
    );
    expect(GOOGLE_SEARCH_NOTICE_LABEL).toBe("Learn more");
    expect(GOOGLE_SEARCH_NOTICE_URL).toBe("https://support.google.com/maps/answer/3092445?&ref_topic=3092444#zippy=%2Cwithin-google-maps%2Cother-google-products");
  });

  it("keep the attribution to the type Google allows: a sans-serif at weight 400, 12 to 16px, its grey or white, never wrapped", () => {
    const rule = /\.google-attribution \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/font-family: Roboto, [^;]*sans-serif;/);
    expect(rule).toContain("font-style: normal;");
    expect(rule).toContain("font-weight: 400;");
    expect(rule).toContain("letter-spacing: normal;");
    expect(rule).toContain("white-space: nowrap;");
    const size = Number(/font-size: (\d+)px;/.exec(rule)?.[1]);
    expect(size).toBeGreaterThanOrEqual(12);
    expect(size).toBeLessThanOrEqual(16);
    expect(rule.toLowerCase()).toContain("color: #5e5e5e;");
    expect(css).toMatch(/:root\.dark \.google-attribution \{ color: #fff; \}/);
    // Google's content is told apart from Crewtavo's by a box of its own.
    expect(/\.google-box \{([^}]*)\}/.exec(css)?.[1]).toMatch(/border: 1px solid/);
  });
});

describe("the card, before anything is read", () => {
  const rows = compareRows([a, own, b], {});

  it("lists the saved places as still to be read, the business first, with nothing of Google's to show", () => {
    expect(rows.map((r) => [r.label, r.status, r.rating, r.ratings_total, r.maps_url])).toEqual([
      ["Your business", "unread", null, null, null],
      ["Competitor 1", "unread", null, null, null],
      ["Competitor 2", "unread", null, null, null],
    ]);
    expect(showsGoogle(rows)).toBe(false);
    expect(standingOf(rows)).toBeNull();
    const table = html(createElement(CompareTable, { rows, running: false, removing: false, onRemove: () => undefined }));
    expect(table).toContain("Your business");
    expect(table).toContain("Competitor 2");
    expect(table.match(/Not read yet/g)).toHaveLength(3);
    // Google's name isn't put on a list Google had no part in.
    expect(table).not.toContain("Google Maps");
    expect(table).not.toContain(GOOGLE_REVIEW_NOTICE);
  });

  it("asks Google nothing by itself: the only thing loaded when it opens is the list of place IDs", () => {
    const card = code("features/marketing/ReviewCompare.tsx");
    // One query, for the saved list; Google is read only from the Compare now button and the add dialog's search.
    expect(card.match(/useQuery\(/g)).toHaveLength(1);
    expect(card).toContain("useQuery({ queryKey, queryFn: loadComparison })");
    expect(card.match(/readPlace\(/g)).toHaveLength(1);
    expect(card).toMatch(/async function compare\([^)]*\) \{[\s\S]*readPlace\(/);
    expect(card).toMatch(/onClick=\{\(\) => googleKey && compare\(s\.places, googleKey\)\}>Compare now</);
    expect(card.match(/searchPlaces\(/g)).toHaveLength(1);
    // No effect starts a read or a search.
    for (const effect of card.match(/useEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/g) ?? []) expect(effect).not.toMatch(/readPlace|searchPlaces|runComparison|compare\(/);
    expect(card.match(/useEffect\(/g)).toHaveLength(2);
  });
});

describe("Compare now", () => {
  it("reads each place once, in order, and shows the business first and the competitors best rated first", async () => {
    const asked: string[] = [];
    const steps: number[] = [];
    const result = await runComparison([a, own, b], async (id) => (asked.push(id), answers[id]!), {}, (r) => steps.push(Object.values(r).filter((x) => x.status === "read").length));
    expect(asked).toEqual(["ChIJ_a", "ChIJ-own", "ChIJ_b"]);
    expect(steps).toEqual([0, 1, 2, 3]);
    expect(result).toMatchObject({ answered: 3, problem: null });
    const rows = compareRows([a, own, b], result.readings);
    expect(rows.map((r) => [r.label, r.rating, r.ratings_total])).toEqual([["Sketchy Gutters", 4.6, 80], ["Best Gutters", 4.8, 120], ["Acme Gutters", 4.2, 300]]);
    expect(rows.every((r) => r.status === "read" && r.fromGoogle)).toBe(true);
    // Rated 4.8, 4.6, 4.2: second of three; the others average 4.5 and 210 reviews.
    expect(standingOf(rows)).toEqual({ rank: 2, of: 3, ratingVsAverage: 0.1, reviewsVsAverage: -130 });
  });

  it("shows Google's figures with its attribution, its notice about reviews and a link to each place on Google Maps", async () => {
    const { readings } = await runComparison([own, a], async (id) => answers[id]!);
    const rows = compareRows([own, a], readings);
    expect(showsGoogle(rows)).toBe(true);
    const table = html(createElement(CompareTable, { rows, running: false, removing: false, onRemove: () => undefined }));
    expect(table).toContain('<a href="https://maps.google.com/?cid=ChIJ_a" target="_blank" rel="noreferrer">Acme Gutters</a>');
    expect(table).toContain("4.2 ★");
    expect(table).toContain(">300<");
    expect(table).toContain('<span class="google-attribution" translate="no">Google Maps</span>');
    expect(table).toContain("Reviews aren&#x27;t verified by Google, but Google checks for and removes fake content when it&#x27;s identified.");
    expect(table).toContain(`<a href="${GOOGLE_REVIEW_POLICY_URL}" target="_blank" rel="noreferrer" style="text-decoration:underline">${GOOGLE_REVIEW_POLICY_LABEL}</a>`);
    // In the same box as the figures, after them.
    expect(table.startsWith('<div class="google-box">')).toBe(true);
    expect(table.indexOf("google-attribution")).toBeGreaterThan(table.indexOf("</table>"));
    // And no column for a change since last week, which would need last week's count kept.
    expect(table).not.toMatch(/Since|Change|last week/);
  });

  it("names the other data providers Google says must be shown with a place, beside its own name", async () => {
    const acme = { name: "Acme Listings", url: "https://acme.example/listing" };
    const { readings } = await runComparison([own, a, b], async (id) => ({ ...answers[id]!, providers: id === "ChIJ-own" ? [] : id === "ChIJ_a" ? [acme, { name: "Plain Data", url: null }] : [acme] }));
    const rows = compareRows([own, a, b], readings);
    expect(providersOn(rows)).toEqual([acme, { name: "Plain Data", url: null }]);
    const table = html(createElement(CompareTable, { rows, running: false, removing: false, onRemove: () => undefined }));
    expect(table).toContain(
      '<span class="google-attribution" translate="no">Google Maps</span><span class="google-attribution" translate="no">, <a href="https://acme.example/listing" target="_blank" rel="noreferrer">Acme Listings</a></span><span class="google-attribution" translate="no">, Plain Data</span>',
    );
    const list = html(createElement(FoundList, { results: [{ place_id: "ChIJ_n", name: "New Gutters", address: null, maps_url: null, providers: [{ name: "Plain Data", url: null }] }], places: [], busy: false, onPick: () => undefined }));
    expect(list).toContain('<span class="google-attribution" translate="no">Google Maps</span><span class="google-attribution" translate="no">, Plain Data</span>');
  });

  it("marks a place Google no longer lists, with Remove, and still reads the rest", async () => {
    const result = await runComparison([own, a, b], async (id) => {
      if (id === "ChIJ_a") throw new PlacesProblem(PLACE_GONE, 404, true);
      return answers[id]!;
    });
    expect(result).toMatchObject({ answered: 3, problem: null });
    const rows = compareRows([own, a, b], result.readings);
    expect(rows.map((r) => [r.label, r.status])).toEqual([["Sketchy Gutters", "read"], ["Best Gutters", "read"], ["Competitor 1", "gone"]]);
    const table = html(createElement(CompareTable, { rows, running: false, removing: false, onRemove: () => undefined }));
    expect(PLACE_GONE).toBe("Google no longer lists this place.");
    expect(table).toContain("Google no longer lists this place.");
    expect(table).toMatch(/<button[^>]*>(<[^>]+>)*Remove(<[^>]+>)*<\/button>/);
    // Asked about again at the next Compare now, in case Google lists it once more.
    const again = await runComparison([own, a, b], async (id) => answers[id]!, result.readings);
    expect(compareRows([own, a, b], again.readings).every((r) => r.status === "read")).toBe(true);
  });

  it("stops where it is when the key is refused, saying what to fix, and doesn't go on asking", async () => {
    const asked: string[] = [];
    const result = await runComparison([own, a, b], async (id) => {
      asked.push(id);
      if (id === "ChIJ_a") throw new PlacesProblem("The Google key has used up its Places quota for now. Try again later.", 429);
      return answers[id]!;
    });
    expect(asked).toEqual(["ChIJ-own", "ChIJ_a"]);
    expect(result).toMatchObject({ answered: 1, problem: "The Google key has used up its Places quota for now. Try again later." });
    expect(compareRows([own, a, b], result.readings).map((r) => r.status)).toEqual(["read", "unread", "unread"]);
    // Refused at the first place: nothing was read, so there's nothing to wait a minute for.
    expect(await runComparison([own], async () => Promise.reject(new PlacesProblem("Google didn't accept the key.", 400)))).toMatchObject({ answered: 0, problem: "Google didn't accept the key." });
    // Anything else that goes wrong isn't swallowed.
    await expect(runComparison([own], async () => Promise.reject(new Error("bug")))).rejects.toThrow("bug");
  });

  it("drops the figures from the time before as it starts, so the table never mixes two readings", async () => {
    const first = await runComparison([own, a], async (id) => answers[id]!);
    const seen: Readings[] = [];
    await runComparison([own, a], async (id) => ({ ...answers[id]!, ratings_total: 999 }), first.readings, (r) => seen.push(r));
    // Names stay while it runs; the old ratings and counts don't.
    expect(seen[0]).toEqual({
      "ChIJ-own": { status: "named", name: "Sketchy Gutters", maps_url: "https://maps.google.com/?cid=ChIJ-own", providers: [] },
      ChIJ_a: { status: "named", name: "Acme Gutters", maps_url: "https://maps.google.com/?cid=ChIJ_a", providers: [] },
    });
    expect(compareRows([own, a], seen[0]!).map((r) => [r.label, r.rating, r.ratings_total])).toEqual([["Sketchy Gutters", null, null], ["Acme Gutters", null, null]]);
  });

  it("says when Google marks a competitor permanently closed, and doesn't count it as competition", async () => {
    const { readings } = await runComparison([own, a, c], async (id) => answers[id]!);
    const rows = compareRows([own, a, c], readings);
    expect(rows.find((r) => r.place_id === "ChIJ_c")).toMatchObject({ closed: true, label: "Closed Gutters" });
    expect(html(createElement(CompareTable, { rows, running: false, removing: false, onRemove: () => undefined }))).toContain("Google says this place is permanently closed.");
    // Rated against Acme alone, not the closed 5.0.
    expect(standingOf(rows)).toMatchObject({ rank: 1, of: 2 });
  });

  it("can't be pressed while it runs, for a minute after, without places or without a key", () => {
    const ready = { places: 3, running: false, waiting: false, key: "AIzaBrowser" };
    expect(canCompare(ready)).toBe(true);
    expect(canCompare({ ...ready, running: true })).toBe(false);
    expect(canCompare({ ...ready, waiting: true })).toBe(false);
    expect(canCompare({ ...ready, places: 0 })).toBe(false);
    expect(canCompare({ ...ready, key: null })).toBe(false);
    expect(COOLDOWN_MS).toBe(60_000);
    expect(comparableAt("co-never")).toBe(0);
    noteCompared("co-waits", 1_000_000);
    expect(comparableAt("co-waits")).toBe(1_060_000);
    // Per company, and kept apart from the card itself, so leaving the tab and coming back doesn't get round it.
    expect(comparableAt("co-other")).toBe(0);
    const card = code("features/marketing/ReviewCompare.tsx");
    expect(card).toContain("if (result.answered) noteCompared(company.id);");
    expect(card).toContain("const waiting = waitUntil > Date.now();");
    expect(card).toContain("disabled={!canCompare({ places: s.places.length, running: run.running, waiting, key: googleKey })}");
  });

  it("says the figures are Google's as of now, with no change over time", () => {
    const card = source("features/marketing/ReviewCompare.tsx");
    expect(card).toContain("Google's figures as of ${formatTime(run.at)}. The app doesn't keep them, so there's no change over time to show");
    expect(card).not.toMatch(/Checked again every week|Last checked|week to week|Since \$\{/);
  });
});

describe("adding a business", () => {
  it("searches by name near the company's own town and state, typed into the search", () => {
    expect(townOf({ city: " Springfield ", region: "IL" })).toBe("Springfield, IL");
    expect(townOf({ city: "Springfield" })).toBe("Springfield");
    expect(townOf(null)).toBe("");
    expect(searchText(" Acme Paving ", { city: "Springfield", region: "IL" })).toBe("Acme Paving near Springfield, IL");
    expect(searchText("Acme Paving", null)).toBe("Acme Paving");
    expect(tradeSearchText("lawn_care", { city: "Springfield", region: "IL" })).toBe("lawn care near Springfield, IL");
    expect(tradeSearchText("general", { city: "Springfield", region: "IL" })).toBe("contractor near Springfield, IL");
    // Without a town there's nowhere to look for the trade; a name can still be searched.
    expect(tradeSearchText("lawn_care", {})).toBeNull();
  });

  it("shows each result's name and address live, in Google's box with its attribution and what orders the results", () => {
    const results = [
      { place_id: "ChIJ_a", name: "Acme Gutters", address: "1 Elm St, Springfield, IL", maps_url: "https://maps.google.com/?cid=1", providers: [] },
      { place_id: "ChIJ_n", name: "New Gutters", address: null, maps_url: null, providers: [] },
    ];
    const list = html(createElement(FoundList, { results, places: [a], busy: false, onPick: () => undefined }));
    expect(list.startsWith('<div class="google-box">')).toBe(true);
    expect(list).toContain("Acme Gutters");
    expect(list).toContain("1 Elm St, Springfield, IL");
    expect(list).toContain('<span class="google-attribution" translate="no">Google Maps</span>');
    expect(list).toContain("Several factors — primarily relevance, distance and prominence — are combined to help find the best results for a search.");
    expect(list).toContain(`<a href="${GOOGLE_SEARCH_NOTICE_URL.replace(/&/g, "&amp;")}" target="_blank" rel="noreferrer" style="text-decoration:underline">Learn more</a>`);
    // One already on the card isn't offered again; the other can be added, or picked as the business itself.
    expect(list).toContain("On the card");
    expect(list.match(/>Add</g)).toHaveLength(1);
    expect(list.match(/>This is us</g)).toHaveLength(1);
  });

  it("offers no sixth competitor, and the business itself only once", () => {
    const five = [1, 2, 3, 4, 5].map((n): SavedPlace => ({ id: `r${n}`, place_id: `ChIJ${n}`, is_own: false }));
    expect(roomLeft(five)).toEqual({ hasOwn: false, full: true });
    expect(roomLeft([own, a])).toEqual({ hasOwn: true, full: false });
    const full = html(createElement(FoundList, { results: [{ place_id: "ChIJ_n", name: "New Gutters", address: null, maps_url: null, providers: [] }], places: [...five, own], busy: false, onPick: () => undefined }));
    expect(full).toMatch(/<button[^>]*disabled=""[^>]*>(<[^>]+>)*Add/);
    expect(full).not.toContain("This is us");
    expect(notYetAdded([{ place_id: "ChIJ_a", name: "Acme", address: null, maps_url: null, providers: [] }, { place_id: "ChIJ_n", name: "New", address: null, maps_url: null, providers: [] }], [a]).map((p) => p.place_id)).toEqual(["ChIJ_n"]);
  });

  it("shows the name of a place just picked, until Compare now reads its figures", () => {
    const readings = withFound({}, { place_id: "ChIJ_a", name: "Acme Gutters", maps_url: null, providers: [] });
    expect(compareRows([a], readings)[0]).toMatchObject({ label: "Acme Gutters", status: "named", fromGoogle: true, rating: null });
    // What's known about a place goes when the place is removed.
    expect(forSaved(readings, [])).toEqual({});
  });
});

// -----------------------------------------------------------------------------------------------
// Nothing Google says is kept, anywhere.
// -----------------------------------------------------------------------------------------------

/** Words and numbers only Google's answers in these tests contain. None may be stored, or reach Crewtavo's server. */
const GOOGLE_SAID = ["Rival Gutters ZQX", "Rival", "ZQX", "17 Quarry Rd", "Quarry", "cid=777001", "maps.google.com", "4.37", "98765", "Ourselves Gutters QWV", "QWV", "OPERATIONAL"];

describe("what Google says about a place", () => {
  type Sent = { url: string; method: string; body: any };
  const server = { enabled: false, places: [] as SavedPlace[] };
  let toGoogle: Sent[] = [];
  let toCrewtavo: Sent[] = [];
  const writes: string[] = [];

  /** Storage that notes every write (and anything else that isn't a read). */
  const watchedStorage = (name: string) => ({
    getItem: () => null,
    setItem: (key: string, value: string) => void writes.push(`${name}.setItem ${key} ${value}`),
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  });
  /** IndexedDB, Cache Storage and cookies: any use at all is noted. */
  const watched = (name: string) => new Proxy({}, { get: (_t, prop) => (...args: unknown[]) => (writes.push(`${name}.${String(prop)} ${JSON.stringify(args)}`), Promise.resolve(undefined)) });

  beforeEach(() => {
    server.enabled = false;
    server.places = [];
    toGoogle = [];
    toCrewtavo = [];
    writes.length = 0;
    vi.stubGlobal("location", { origin: "https://crew.example.com" });
    vi.stubGlobal("localStorage", watchedStorage("localStorage"));
    vi.stubGlobal("sessionStorage", watchedStorage("sessionStorage"));
    vi.stubGlobal("indexedDB", watched("indexedDB"));
    vi.stubGlobal("caches", watched("caches"));
    vi.stubGlobal("document", { set cookie(value: string) { writes.push(`document.cookie ${value}`); }, get cookie() { return ""; } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit = {}) => {
        const url = String(input);
        const sent = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null };
        if (url.startsWith("https://places.googleapis.com/")) {
          toGoogle.push(sent);
          if (url.endsWith(":searchText")) {
            return Response.json({
              places: [
                { id: "ChIJ_rival", displayName: { text: "Rival Gutters ZQX" }, formattedAddress: "17 Quarry Rd, Springfield, IL", googleMapsUri: "https://maps.google.com/?cid=777001" },
                { id: "ChIJ-ours", displayName: { text: "Ourselves Gutters QWV" }, formattedAddress: "17 Quarry Rd, Unit 2", googleMapsUri: "https://maps.google.com/?cid=777001-2" },
              ],
            });
          }
          const id = url.split("/").pop()!;
          return Response.json({ id, displayName: { text: id === "ChIJ_rival" ? "Rival Gutters ZQX" : "Ourselves Gutters QWV" }, rating: 4.37, userRatingCount: 98765, googleMapsUri: "https://maps.google.com/?cid=777001", businessStatus: "OPERATIONAL" });
        }
        // Crewtavo's server, which keeps only what it's sent.
        toCrewtavo.push(sent);
        if (sent.method === "PUT") server.enabled = sent.body.enabled;
        if (sent.method === "POST") server.places.push({ id: `row-${server.places.length + 1}`, place_id: sent.body.place_id, is_own: sent.body.own });
        if (sent.method === "DELETE") server.places = server.places.filter((p) => !url.endsWith(`/${p.id}`));
        return Response.json({ enabled: server.enabled, places: server.places, can_switch: true });
      }),
    );
  });

  /** Everything the card does, start to finish: turn it on, search, pick two places, compare, remove one. */
  async function useTheCard() {
    await turnOn("AIzaBrowser", "Sketchy Gutters");
    const found = await searchPlaces("AIzaBrowser", searchText("Rival Gutters", { city: "Springfield", region: "IL" }));
    await savePlace(found[0]!.place_id, false);
    await savePlace(found[1]!.place_id, true);
    const state = await loadComparison();
    const result = await runComparison(state.places, (id) => readPlace("AIzaBrowser", id), withFound({}, found[0]!));
    const rows = compareRows(state.places, result.readings);
    await removePlace(state.places[0]!.id);
    await switchComparison(false);
    return { found, rows };
  }

  it("is shown: the flow really does read names, ratings and counts from Google", async () => {
    const { found, rows } = await useTheCard();
    expect(found.map((f) => f.name)).toEqual(["Rival Gutters ZQX", "Ourselves Gutters QWV"]);
    expect(rows.map((r) => [r.label, r.rating, r.ratings_total, r.maps_url])).toEqual([
      ["Ourselves Gutters QWV", 4.37, 98765, "https://maps.google.com/?cid=777001"],
      ["Rival Gutters ZQX", 4.37, 98765, "https://maps.google.com/?cid=777001"],
    ]);
    // The check, the search, and one Place Details for each of the two places.
    expect(toGoogle.map((g) => `${g.method} ${new URL(g.url).pathname}`)).toEqual(["POST /v1/places:searchText", "POST /v1/places:searchText", "GET /v1/places/ChIJ_rival", "GET /v1/places/ChIJ-ours"]);
  });

  it("is never written to this browser's storage: not localStorage, sessionStorage, IndexedDB, the cache or a cookie", async () => {
    await useTheCard();
    expect(writes).toEqual([]);
  });

  it("is never sent to Crewtavo's server, which gets place IDs and the switch and nothing else", async () => {
    await useTheCard();
    expect(toCrewtavo.map((s) => `${s.method} ${s.url}`)).toEqual([
      "PUT /api/reviews/compare/enabled",
      "POST /api/reviews/compare/places",
      "POST /api/reviews/compare/places",
      "GET /api/reviews/compare",
      "DELETE /api/reviews/compare/places/row-1",
      "PUT /api/reviews/compare/enabled",
    ]);
    expect(toCrewtavo.map((s) => s.body)).toEqual([{ enabled: true }, { place_id: "ChIJ_rival", own: false }, { place_id: "ChIJ-ours", own: true }, null, null, { enabled: false }]);
    for (const sent of toCrewtavo) {
      // Whatever shape a request takes in future, it carries nothing but IDs, the switch and "it's us".
      for (const [field, value] of Object.entries(sent.body ?? {})) {
        expect(["enabled", "place_id", "own"], `${sent.url} sends ${field}`).toContain(field);
        if (field === "place_id") expect(value).toMatch(PLACE_ID);
        else expect(typeof value).toBe("boolean");
      }
      for (const said of GOOGLE_SAID) expect(`${sent.url} ${JSON.stringify(sent.body)}`, `${sent.method} ${sent.url} carries “${said}”`).not.toContain(said);
    }
  });

  it("is checked by these tests against a list that would catch it: the words are in Google's answers and nowhere in what's saved", async () => {
    const { rows, found } = await useTheCard();
    const shown = JSON.stringify([rows, found]);
    for (const said of GOOGLE_SAID.filter((w) => w !== "OPERATIONAL")) expect(shown, said).toContain(said);
    expect(JSON.stringify(server)).toBe('{"enabled":false,"places":[{"id":"row-2","place_id":"ChIJ-ours","is_own":true}]}');
  });

  it("stays off when Google refuses the key, and nothing is sent to Crewtavo", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (String(input).startsWith("https://places.googleapis.com/")) return Response.json({ error: { status: "PERMISSION_DENIED", message: "Places API (New) has not been used in project 1 before or it is disabled." } }, { status: 403 });
      toCrewtavo.push({ url: String(input), method: "?", body: null });
      return Response.json({});
    }));
    await expect(turnOn("AIzaBrowser", "Sketchy Gutters")).rejects.toThrow("The Google key's project doesn't have Places API (New) turned on. In Google Cloud, enable Places API (New) for it.");
    await expect(turnOn(null, "Sketchy Gutters")).rejects.toThrow(NO_KEY);
    expect(NO_KEY).toContain("Settings → Maps");
    expect(toCrewtavo).toEqual([]);
  });
});

describe("what's kept on a phone for offline, and by the service worker", () => {
  it("leaves the comparison out: the saved copy of screens holds neither the place list nor anything read", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0 });
    vi.stubGlobal("navigator", { onLine: true });
    vi.useFakeTimers();
    onlineManager.setOnline(true);
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    qc.mount();
    // Kept for someone whose screens are saved (a crew lead who is also given the marketing area, say).
    const stop = startOfflineCache(qc, "u-compare", true);
    qc.setQueryData(["field", "co-1", "2026-11-14"], { today: [] });
    qc.setQueryData(["review-compare", "co-1"], { enabled: true, places: [own, a], can_switch: false });
    await vi.advanceTimersByTimeAsync(1_000);
    const saved = JSON.parse(store.get("crewtavo.offline.v1.u-compare") ?? "null") as { queries: Array<{ queryKey: unknown[] }> };
    expect(saved.queries.map((q) => q.queryKey[0])).toEqual(["field"]);
    expect([...store.values()].join(" ")).not.toMatch(/review-compare|ChIJ/);
    stop();
    qc.unmount();
  });

  it("never passes through the service worker's cache: not Google's answers, not the list of place IDs", async () => {
    const network = vi.fn(async () => Response.json({ displayName: { text: "Rival Gutters ZQX" } }));
    const sw = loadServiceWorker({ offline: true, network });
    expect(await sw.dispatch("fetch", { request: { url: "https://places.googleapis.com/v1/places/ChIJ_rival", method: "GET", mode: "cors" } })).toBe("unhandled");
    expect(await sw.dispatch("fetch", { request: { url: "https://crew.example.com/api/reviews/compare", method: "GET", mode: "cors" } })).toBe("unhandled");
    expect(network).not.toHaveBeenCalled();
    expect([...sw.caches.stores.values()].flatMap((s) => [...s.keys()]).filter((url) => /places\.googleapis|reviews\/compare/.test(url))).toEqual([]);
  });
});

describe("the code that handles Google's answers", () => {
  const STORAGE = /localStorage|sessionStorage|indexedDB|IDBDatabase|\bcaches\b|document\.cookie|BroadcastChannel|navigator\.storage/;

  it("touches no storage, and keeps the answers out of React Query, whose cache is what gets saved for offline", () => {
    for (const file of ["features/marketing/ReviewCompare.tsx", "features/marketing/reviewCompareState.ts", "features/marketing/reviewPlaces.ts"]) expect(code(file), file).not.toMatch(STORAGE);
    const card = code("features/marketing/ReviewCompare.tsx");
    // Google's answers are held with useState. The only things given to React Query are the saved list and the saves themselves.
    expect(card).not.toMatch(/setQueryData\([^)]*(readings|results|found)/);
    expect([...card.matchAll(/mutationFn: ([^\n]*)/g)].map((m) => m[1])).toEqual([
      "(enabled: boolean) => (enabled ? turnOn(googleKey, company.name) : switchComparison(false)),",
      "(id: string) => removePlace(id),",
      "(p: { place_id: string; own: boolean }) => savePlace(p.place_id, p.own),",
    ]);
    expect(card).not.toMatch(/useQuery\(\{[^}]*(readPlace|searchPlaces)/);
  });

  it("talks to Crewtavo's server in four places only, each written out with what it sends", () => {
    const state = code("features/marketing/reviewCompareState.ts");
    expect([...state.matchAll(/api\.(get|put|post|delete)<[^(]*\(([^\n]*)\);/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
      'get "/reviews/compare"',
      'put "/reviews/compare/enabled", { enabled }',
      'post "/reviews/compare/places", { place_id: placeId, own }',
      "delete `/reviews/compare/places/${id}`",
    ]);
    expect(state.match(/\bapi\./g)).toHaveLength(4);
    // The card and the Places client don't reach the server or the database themselves.
    for (const file of ["features/marketing/ReviewCompare.tsx", "features/marketing/reviewPlaces.ts"]) expect(code(file), file).not.toMatch(/\bapi\.|supabase\(|from "@\/lib\/api"/);
    // And the Places client talks to Google alone.
    expect(code("features/marketing/reviewPlaces.ts").match(/fetch\(/g)).toHaveLength(1);
    expect(code("features/marketing/reviewPlaces.ts")).toContain("fetch(`${PLACES}${path}`");
  });
});
