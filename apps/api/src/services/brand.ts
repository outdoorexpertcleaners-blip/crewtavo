/**
 * Which brand a text is about (washing or Christmas lights, core/pipeline.ts), so it goes from that
 * brand's Quo line (lib/notify.ts sendSms). About a quote or request: its own. About a visit: its
 * job's quote, else the request it's for (visitBrand). About anything else, or a visit that says
 * nothing: the client's latest quote, else their latest request. Null when nothing says (the wash line).
 */
import { quoteBrand, requestBrand, type Brand } from "@crewtavo/core/pipeline";
import { proposalBrand } from "@crewtavo/core/proposal";
import type { Db } from "../lib/supabase";

type QuoteRow = { brand: string | null; lines: Array<{ name: string }> };
type RequestRow = { brand: string | null; title: string };
export interface VisitBrandRow {
  job: { quote: QuoteRow | null; lines?: Array<{ name: string }> | null } | null;
  request: RequestRow | null;
}

/**
 * A visit's brand from what it's for: the quote its job came from (the office's pick, else its
 * lines), else the request it was booked from, else the job's own lines when they're Christmas
 * lights (a job made without a quote). Null when none of them says, so the caller falls back to the
 * client's latest quote: a crew on a lighting job texts from the lighting line even when the
 * client's newest quote is a house wash.
 */
export function visitBrand(row: VisitBrandRow | null): Brand | null {
  if (!row) return null;
  if (row.job?.quote) return quoteBrand(row.job.quote);
  if (row.request) return requestBrand(row.request);
  if (row.job?.lines?.length && proposalBrand(row.job.lines) === "lights") return "lights";
  return null;
}

export async function brandFor(admin: Db, companyId: string, about: { subject?: string | null; id?: string | null; clientId?: string | null }): Promise<Brand | null> {
  const quote = (q: QuoteRow | null) => (q ? quoteBrand(q) : null);
  const request = (r: RequestRow | null) => (r ? requestBrand(r) : null);
  try {
    if (about.subject === "quote" && about.id) {
      return quote((await admin.from("quotes").select("brand, lines:quote_line_items(name)").eq("company_id", companyId).eq("id", about.id).maybeSingle()).data);
    }
    if (about.subject === "request" && about.id) {
      return request((await admin.from("requests").select("brand, title").eq("company_id", companyId).eq("id", about.id).maybeSingle()).data);
    }
    if (about.subject === "visit" && about.id) {
      const own = visitBrand(
        (
          await admin
            .from("visits")
            .select("job:jobs(quote:quotes!jobs_company_id_quote_id_fkey(brand, lines:quote_line_items(name)), lines:job_line_items(name)), request:requests(brand, title)")
            .eq("company_id", companyId)
            .eq("id", about.id)
            .maybeSingle()
        ).data as VisitBrandRow | null,
      );
      if (own) return own;
    }
    if (!about.clientId) return null;
    const latest = (await admin.from("quotes").select("brand, lines:quote_line_items(name)").eq("company_id", companyId).eq("client_id", about.clientId).eq("is_template", false).order("updated_at", { ascending: false }).limit(1).maybeSingle()).data;
    if (latest) return quote(latest);
    return request((await admin.from("requests").select("brand, title").eq("company_id", companyId).eq("client_id", about.clientId).order("updated_at", { ascending: false }).limit(1).maybeSingle()).data);
  } catch {
    return null;
  }
}
