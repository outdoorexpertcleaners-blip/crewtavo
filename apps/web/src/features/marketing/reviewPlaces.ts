/**
 * Google Places API (New), asked from the browser, for How you compare (ReviewCompare.tsx): Text
 * Search to find a business by name, and Place Details for a place's name, rating and number of
 * reviews. Asked with the Google key the map already uses in this browser (the company's from
 * Settings → Maps, else the one this Crewtavo was set up with), which is a browser key: the request
 * goes from this page, with the browser's own Referer, so a key limited to the company's web
 * address works as Google means it to. Crewtavo's server takes no part.
 *
 * What Google answers is Google Maps Content, which its terms don't let an application keep
 * (apps/api/src/services/reviewCompare.ts quotes them). So nothing here writes it anywhere: each
 * answer is handed back to the card, which holds it while it's on the screen. The browser is told
 * not to keep the response either (cache: "no-store").
 *
 * Each call asks only for the fields it shows (X-Goog-FieldMask), which also decides what Google
 * charges for it (developers.google.com/maps/documentation/places/web-service/place-details and
 * /text-search, "FieldMask", read 2026-11-14):
 *   the key check   places.id alone: Text Search Essentials IDs Only, which isn't charged.
 *   a search        the name, address and Maps link: Text Search Pro.
 *   a place         the rating and review count put it in Place Details Enterprise; the name, Maps
 *                   link and business status are in the tier below, so they add nothing.
 * Both also ask for `attributions`, which is in the uncharged tier: the names of any other data
 * providers Google says "must be shown with this result", which the card shows beside "Google Maps".
 */
import { PLACE_ID } from "@crewtavo/core/reviewCompare";
import { mapKeys } from "@/features/measure/imagery";

const PLACES = "https://places.googleapis.com/v1";
const TIMEOUT_MS = 10_000;

export const KEY_CHECK_FIELDS = "places.id";
export const SEARCH_FIELDS = "places.id,places.displayName,places.formattedAddress,places.googleMapsUri,places.attributions";
export const DETAIL_FIELDS = "id,displayName,rating,userRatingCount,googleMapsUri,businessStatus,attributions";

/** The Google key this browser asks with, picked as the measuring map picks its own; null with none. */
export const comparisonKey = (settings: Record<string, unknown> | null | undefined, deploymentGoogleKey: string | null): string | null => mapKeys(settings ?? {}, deploymentGoogleKey).google_key ?? null;

/**
 * What Google said, in words that say what to fix. `place`: the trouble is with one place (Google
 * doesn't list it anymore), not with the key, so the next place is still worth asking about.
 */
export class PlacesProblem extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly place = false,
    /** Google's refusal was one of those placesProblem knows, about the key or its project. */
    readonly known = true,
  ) {
    super(message);
  }
}

export const NOT_REACHED = "Couldn't reach Google. Check your internet connection and try again.";
export const NOT_ANSWERING = "Google Places isn't answering right now. Try again later.";
export const PLACE_GONE = "Google no longer lists this place.";

type GoogleError = { error?: { message?: string; status?: string; details?: Array<{ reason?: string }> } };

/** Google's refusal as a sentence saying what to fix, or null when it isn't one of the refusals known here. */
export function placesProblem(status: number, error?: GoogleError["error"]): string | null {
  const text = `${error?.status ?? ""} ${error?.message ?? ""} ${(error?.details ?? []).map((d) => d.reason ?? "").join(" ")}`;
  const here = typeof location === "undefined" ? "this app's address" : location.origin;
  if (/API_KEY_INVALID|API key not valid|API key expired/i.test(text)) return "Google didn't accept the key. Check the Google key in Settings → Maps.";
  if (/REFERRER_BLOCKED|referer|referrer/i.test(text)) return `The Google key is limited to other websites. In Google Cloud, add ${here} to the key's website restrictions.`;
  if (/IP_ADDRESS_BLOCKED|IP address|ANDROID_APP_BLOCKED|IOS_APP_BLOCKED/i.test(text)) return "The Google key is limited to a server or a phone app, so a web page can't use it. In Google Cloud, limit it to websites instead, or use a key that is.";
  if (/SERVICE_DISABLED|has not been used|is disabled/i.test(text)) return "The Google key's project doesn't have Places API (New) turned on. In Google Cloud, enable Places API (New) for it.";
  if (/API_KEY_SERVICE_BLOCKED|are blocked/i.test(text)) return "The Google key isn't allowed to use Places API (New). In Google Cloud, add Places API (New) to the key's API restrictions.";
  if (/billing/i.test(text)) return "Google needs a billing account on the key's project before it answers Places requests.";
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(text)) return "The Google key has used up its Places quota for now. Try again later.";
  if (status === 401 || status === 403) return "Google refused the key for Places. Check that Places API (New) is allowed for it.";
  return null;
}

/**
 * One request to Google, from this page. Only the key and the field mask are sent as headers (and
 * the content type with a body): the Referer is the browser's to send and isn't touched.
 */
async function ask<T>(key: string, path: string, fields: string, body?: unknown): Promise<T> {
  const res = await fetch(`${PLACES}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": fields, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!res) throw new PlacesProblem(NOT_REACHED);
  const answer = (await res.json().catch(() => ({}))) as T & GoogleError;
  if (!res.ok || answer.error) {
    const known = placesProblem(res.status, answer.error);
    throw new PlacesProblem(known ?? NOT_ANSWERING, res.status, false, known !== null);
  }
  return answer;
}

type GooglePlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  businessStatus?: string;
  attributions?: Array<{ provider?: string; providerUri?: string }>;
};

const mapsLink = (uri: string | undefined) => (uri?.startsWith("https://") ? uri : null);

/** Someone besides Google whose data a result carries, to be named with it. */
export interface Provider {
  name: string;
  url: string | null;
}
const providersOf = (p: GooglePlace): Provider[] => (p.attributions ?? []).flatMap((a) => (a.provider?.trim() ? [{ name: a.provider.trim(), url: mapsLink(a.providerUri) }] : []));

/** A search result: enough to tell which business it is. Its ID is the only part that's ever saved. */
export interface FoundPlace {
  place_id: string;
  name: string;
  address: string | null;
  maps_url: string | null;
  providers: Provider[];
}

/** Places matching `query` ("Acme Paving near Springfield, IL"): one Text Search, up to ten results. */
export async function searchPlaces(key: string, query: string): Promise<FoundPlace[]> {
  const body = await ask<{ places?: GooglePlace[] }>(key, "/places:searchText", SEARCH_FIELDS, { textQuery: query.slice(0, 200), pageSize: 10 });
  return (body.places ?? []).flatMap((p): FoundPlace[] =>
    p.id && PLACE_ID.test(p.id) && p.displayName?.text ? [{ place_id: p.id, name: p.displayName.text, address: p.formattedAddress ?? null, maps_url: mapsLink(p.googleMapsUri), providers: providersOf(p) }] : [],
  );
}

/** A place as Google describes it right now. */
export interface LivePlace {
  place_id: string;
  name: string;
  rating: number | null;
  ratings_total: number | null;
  maps_url: string | null;
  /** Google marks it permanently closed. */
  closed: boolean;
  providers: Provider[];
}

/**
 * One place's name, rating, review count and Maps link: one Place Details call, with only the
 * fields shown. A place Google no longer has (its listing was removed, or merged into another) throws a
 * PlacesProblem with `place` set, so the card can say so and go on to the rest.
 */
export async function readPlace(key: string, placeId: string): Promise<LivePlace> {
  if (!PLACE_ID.test(placeId)) throw new PlacesProblem(PLACE_GONE, null, true);
  let raw: GooglePlace;
  try {
    raw = await ask<GooglePlace>(key, `/places/${placeId}`, DETAIL_FIELDS);
  } catch (error) {
    // Not found, or an ID Google no longer takes; a refused key has its own words (placesProblem) and isn't this.
    if (error instanceof PlacesProblem && !error.known && (error.status === 404 || error.status === 400)) throw new PlacesProblem(PLACE_GONE, error.status, true);
    throw error;
  }
  if (!raw.displayName?.text) throw new PlacesProblem(PLACE_GONE, 200, true);
  return {
    place_id: placeId,
    name: raw.displayName.text,
    rating: typeof raw.rating === "number" ? raw.rating : null,
    ratings_total: typeof raw.userRatingCount === "number" ? raw.userRatingCount : null,
    maps_url: mapsLink(raw.googleMapsUri),
    closed: raw.businessStatus === "CLOSED_PERMANENTLY",
    providers: providersOf(raw),
  };
}

/**
 * Whether a key answers Places from this page at all: a Text Search asking for place IDs only,
 * which Google doesn't charge for. A sentence saying what to fix, or null when it works.
 */
export async function checkPlacesKey(key: string, query: string): Promise<string | null> {
  try {
    await ask(key, "/places:searchText", KEY_CHECK_FIELDS, { textQuery: query.trim().slice(0, 200) || "hardware store", pageSize: 1 });
    return null;
  } catch (error) {
    if (error instanceof PlacesProblem) return error.message;
    throw error;
  }
}
