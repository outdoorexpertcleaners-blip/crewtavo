/**
 * Which brand a text is about (washing or Christmas lights, core/pipeline.ts), so it goes from that
 * brand's Quo line (lib/notify.ts sendSms). About a quote or request: its own. About anything else:
 * the client's latest quote, else their latest request. Null when nothing says (the wash line).
 */
import { quoteBrand, requestBrand, type Brand } from "@crewtavo/core/pipeline";
import type { Db } from "../lib/supabase";

export async function brandFor(admin: Db, companyId: string, about: { subject?: string | null; id?: string | null; clientId?: string | null }): Promise<Brand | null> {
  const quote = (q: { brand: string | null; lines: Array<{ name: string }> } | null) => (q ? quoteBrand(q) : null);
  const request = (r: { brand: string | null; title: string } | null) => (r ? requestBrand(r) : null);
  try {
    if (about.subject === "quote" && about.id) {
      return quote((await admin.from("quotes").select("brand, lines:quote_line_items(name)").eq("company_id", companyId).eq("id", about.id).maybeSingle()).data);
    }
    if (about.subject === "request" && about.id) {
      return request((await admin.from("requests").select("brand, title").eq("company_id", companyId).eq("id", about.id).maybeSingle()).data);
    }
    if (!about.clientId) return null;
    const latest = (await admin.from("quotes").select("brand, lines:quote_line_items(name)").eq("company_id", companyId).eq("client_id", about.clientId).eq("is_template", false).order("updated_at", { ascending: false }).limit(1).maybeSingle()).data;
    if (latest) return quote(latest);
    return request((await admin.from("requests").select("brand, title").eq("company_id", companyId).eq("client_id", about.clientId).order("updated_at", { ascending: false }).limit(1).maybeSingle()).data);
  } catch {
    return null;
  }
}
