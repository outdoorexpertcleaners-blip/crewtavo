/**
 * What the crew is doing on a job, from its line items: names, notes and quantities. With `prices`
 * (the team, not subs: the owner wants techs to see what the job is priced at), each line's price and
 * the job's total too, read from job_line_items (20261119000600_crew_sees_job_prices.sql).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { formatMoneyCents } from "@/lib/format";
import { pendingJobLines, waitingScopeLine } from "../field/fieldActions";
import { t } from "@/lib/i18n";

const qty = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);

export const scopeKey = (jobId: string | null | undefined) => ["job", jobId, "scope"];

export function useJobScope(jobId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: scopeKey(jobId),
    enabled: Boolean(jobId),
    meta: { silent: true },
    queryFn: async () => {
      const lines = unwrap(await supabase().rpc("job_scope", { p_job: jobId! }));
      // Work added on this phone that hasn't gone yet is newer than what the server has.
      const waiting = pendingJobLines(queryClient, jobId!).filter((w) => !lines.some((l) => l.id === w.lineId));
      return [...lines, ...waiting.map(waitingScopeLine)];
    },
  });
}

/** Each line's price, and the job's total (discounts included), for those who may see them. */
function useJobPrices(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["job", jobId, "scope-prices"],
    enabled,
    meta: { silent: true },
    queryFn: async () => {
      const rows = unwrap(await supabase().from("job_line_items").select("id, quantity, unit_price").eq("job_id", jobId).limit(500));
      const each = new Map(rows.map((r) => [r.id, Number(r.quantity) * Number(r.unit_price)]));
      return { each, total: [...each.values()].reduce((a, b) => a + b, 0) };
    },
  });
}

export function ScopeOfWork({ jobId, title = t("Scope of work"), bare = false, prices = false }: { jobId: string; title?: string; bare?: boolean; prices?: boolean }) {
  const scope = useJobScope(jobId);
  const priced = useJobPrices(jobId, prices).data;
  if (scope.isPending) return <Skeleton height={48} radius={8} />;
  if (!scope.data?.length) return null;
  const list = (
    <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
      {scope.data.map((l) => (
        <li key={l.id}>
          <strong>{l.name}</strong>
          {Number(l.quantity) !== 1 || l.unit !== "ea" ? <span className="tabular"> · {qty(Number(l.quantity))} {l.unit}</span> : null}
          {priced?.each.has(l.id) && <span className="tabular"> · {formatMoneyCents(priced.each.get(l.id))}</span>}
          {l.description && <span className="muted pre-wrap" style={{ display: "block" }}>{l.description}</span>}
        </li>
      ))}
      {priced && priced.each.size > 0 && <li style={{ listStyle: "none", marginLeft: -18, marginTop: 4 }}><strong>{t("Total")} <span className="tabular">{formatMoneyCents(priced.total)}</span></strong></li>}
    </ul>
  );
  if (bare) return <div className="stack-sm"><strong>{title}</strong>{list}</div>;
  return (
    <section className="stack">
      <h2 className="section-title">{title}</h2>
      <div className="card card-pad">{list}</div>
    </section>
  );
}
