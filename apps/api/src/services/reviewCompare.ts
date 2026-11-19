/**
 * GOOGLE'S TERMS, AND WHAT IS KEPT HERE. What Google says about a place is Google Maps Content, and
 * its Places API policies say what an application may keep of it
 * (developers.google.com/maps/documentation/places/web-service/policies, "Data storage, caching,
 * and scraping" and "Exceptions from caching restrictions"; read 2026-11-14):
 *
 *   "Cache or store Google Maps Content only as expressly permitted", with copying and saving
 *   "business names, addresses, or user reviews" named as not allowed; and the exception, "The
 *   place ID ... is exempt from the caching restrictions. You can therefore store place ID values
 *   indefinitely."
 *
 * So this server keeps place IDs and nothing else about a place, and never talks to Google Places:
 *
 *   review_comparisons   company_id, enabled, enabled_by, updated_at: the switch.
 *   review_places        id, company_id, place_id, is_own, created_at: which places, and which one
 *                        is the business itself. No name, address, link, rating, count or date read.
 *
 * (supabase/migrations/20261113001700_review_comparison_place_ids_only.sql dropped the rest, and
 * the weekly review_compare task with it.) The same policies say to "store exempt identifiers such
 * as the place ID to fetch fresh details when a user interacts with a place", which is what the
 * card does.
 *
 * How you compare (Marketing → Reviews): the business's Google rating and review count next to up
 * to five competitors'. The browser asks Google itself, with the Google key the map already uses
 * there (the company's from Settings → Maps, else this Crewtavo's GOOGLE_MAPS_BROWSER_KEY), when
 * someone presses Compare now, shows the answers, and keeps them nowhere
 * (apps/web/src/features/marketing/reviewPlaces.ts, ReviewCompare.tsx). A browser key is for
 * browsers: this server has no Places client, and sends no request in a website's name.
 *
 *   Its own switch   Off until an owner or admin turns it on. Their browser checks the key with
 *                    Google first (a free ids-only search) and says what to fix; here it's refused
 *                    without Marketing or without any key to use. With Google Business Profile
 *                    connected, the business's own place ID is added from it.
 *   Here             Only the list of place IDs: read by the office with the marketing area, five
 *                    competitors at most and one place of its own (the database's rules), written
 *                    by this server alone.
 */
import { PLACE_ID } from "@crewtavo/core/reviewCompare";
import { marketingOn } from "@crewtavo/core/marketing";
import type { MapSettings } from "@crewtavo/core/imagery";
import type { Env } from "../env";
import { dbError, HttpError } from "../lib/http";
import type { Db } from "../lib/supabase";

export const NO_KEY = "Add a Google key in Settings → Maps first, with Places API (New) turned on for it.";
export const TURNED_OFF = "Comparing with competitors is off. An owner or admin can turn it on here.";

/** What the card starts from: the switch, and the places to read from Google, by their IDs. */
export async function comparisonState(admin: Db, companyId: string) {
  const [row, places] = await Promise.all([
    admin.from("review_comparisons").select("enabled").eq("company_id", companyId).maybeSingle(),
    admin.from("review_places").select("id, place_id, is_own").eq("company_id", companyId).order("created_at"),
  ]);
  if (row.error) throw dbError(row.error);
  if (places.error) throw dbError(places.error);
  return {
    enabled: row.data?.enabled ?? false,
    places: (places.data ?? []).map((p) => ({ id: p.id, place_id: p.place_id, is_own: p.is_own })),
  };
}

/** Whether there's a Google key a browser can ask with: the company's own, or this Crewtavo's browser key. */
const hasBrowserKey = (env: Env, settings: unknown) => Boolean(((settings as { maps?: MapSettings } | null)?.maps?.google_key ?? "").trim() || env.GOOGLE_MAPS_BROWSER_KEY);

/**
 * The switch. On: the browser has already checked the key with Google; this refuses without
 * Marketing or any key at all, and adds the business's own place ID from Google Business Profile
 * when that's connected and the card has none yet. Nothing is asked of Google either way.
 */
export async function setComparison(env: Env, admin: Db, companyId: string, userId: string, enabled: boolean) {
  if (!enabled) {
    const { error } = await admin.from("review_comparisons").upsert({ company_id: companyId, enabled: false });
    if (error) throw dbError(error);
    return;
  }
  const { data: company, error: failed } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
  if (failed || !company) throw new HttpError(404, "Company not found.");
  if (!marketingOn(company.settings as Record<string, unknown> | null)) throw new HttpError(409, "Install Marketing first.");
  if (!hasBrowserKey(env, company.settings)) throw new HttpError(400, NO_KEY);
  const { error } = await admin.from("review_comparisons").upsert({ company_id: companyId, enabled: true, enabled_by: userId });
  if (error) throw dbError(error);
  // The business itself, when Google Business Profile knows which place it is.
  const { data: own } = await admin.from("review_places").select("id").eq("company_id", companyId).eq("is_own", true).maybeSingle();
  if (own) return;
  const { data: business } = await admin.from("integrations").select("status, settings").match({ company_id: companyId, provider: "google_business" }).maybeSingle();
  const placeId = (business?.settings as { place_id?: string | null } | null)?.place_id;
  if (business && business.status !== "disconnected" && placeId && PLACE_ID.test(placeId)) await addPlace(admin, companyId, placeId, true).catch(() => undefined);
}

/**
 * Adds a place to the card by its ID, which is all that's kept of it. `own`: the business itself,
 * taking the place of the one it had. The database turns down a sixth competitor.
 */
export async function addPlace(admin: Db, companyId: string, placeId: string, own: boolean) {
  if (!PLACE_ID.test(placeId)) throw new HttpError(400, "That isn't a Google place.");
  const { data: row, error: failed } = await admin.from("review_comparisons").select("enabled").eq("company_id", companyId).maybeSingle();
  if (failed) throw dbError(failed);
  if (!row?.enabled) throw new HttpError(409, TURNED_OFF);
  if (own) {
    const { error } = await admin.from("review_places").delete().eq("company_id", companyId).eq("is_own", true).neq("place_id", placeId);
    if (error) throw dbError(error);
  }
  const { data, error } = await admin
    .from("review_places")
    .upsert({ company_id: companyId, place_id: placeId, is_own: own }, { onConflict: "company_id,place_id" })
    .select("id")
    .single();
  if (error) throw error.code === "22023" ? new HttpError(400, error.message) : dbError(error);
  return data.id as string;
}
