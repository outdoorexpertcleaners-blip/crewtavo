/**
 * Workflows, as GoHighLevel's Automation → Workflows list: the business's sequences
 * (core/sequences.ts) with whether each is published, how many people went through it and how many
 * are in it now. The business's GoHighLevel workflows are added from their templates, turned off.
 * The number the office's alerts are texted to is set here.
 */
import { phoneDisplay } from "@crewtavo/core/phone";
import { TRIGGER_LABEL, type SequenceTrigger } from "@crewtavo/core/sequences";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";

export interface SequenceRow {
  id: string;
  name: string;
  brand: "washing" | "lights" | null;
  trigger: SequenceTrigger;
  on_reply: string;
  send_window: unknown;
  steps: unknown;
  enabled: boolean;
  template_key: string | null;
  updated_at: string;
}

export function WorkflowsPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ["sequences", session.company.id];
  const list = useQuery({
    queryKey: key,
    queryFn: async () => {
      const [seqs, runs] = await Promise.all([
        supabase().from("sequences").select("id, name, brand, trigger, on_reply, send_window, steps, enabled, template_key, updated_at").eq("company_id", session.company.id).order("name"),
        supabase().from("sequence_runs").select("sequence_id, status").eq("company_id", session.company.id).limit(1000),
      ]);
      const counts = new Map<string, { total: number; active: number }>();
      for (const r of unwrap(runs)) {
        const c = counts.get(r.sequence_id) ?? { total: 0, active: 0 };
        c.total++;
        if (r.status === "active" || r.status === "paused") c.active++;
        counts.set(r.sequence_id, c);
      }
      return { sequences: unwrap(seqs) as unknown as SequenceRow[], counts };
    },
  });
  const addTemplates = useMutation({
    meta: { success: (r: { added: number }) => (r.added ? `Added ${r.added} workflows, turned off` : "They're all here already") },
    mutationFn: () => api.post<{ added: number }>("/sequences/templates"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const toggle = useMutation({
    meta: { success: (_: unknown, v: { enabled: boolean }) => (v.enabled ? "Published" : "Turned off") },
    mutationFn: async (v: { id: string; enabled: boolean }) => unwrap(await supabase().from("sequences").update({ enabled: v.enabled }).eq("id", v.id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return (
    <div className="stack">
      <PageHeader title="Workflows" actions={<Button icon="plus" loading={addTemplates.isPending} onClick={() => addTemplates.mutate()}>Add Outdoor Expert's GHL workflows</Button>} />
      <AlertPhone />
      {list.error && <div className="card"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div>}
      <div className="card ghl-wf-list">
        <div className="ghl-wf-row ghl-wf-head" role="row">
          <span>Name</span><span>Status</span><span className="num">Total enrolled</span><span className="num">Active enrolled</span><span>Starts when</span>
        </div>
        {list.isPending && <Loading label="Loading workflows">{[0, 1, 2].map((i) => <div key={i} className="ghl-wf-row"><Skeleton width="60%" /></div>)}</Loading>}
        {list.data && list.data.sequences.length === 0 && (
          <EmptyState icon="bolt" title="No workflows yet" action={<Button variant="primary" onClick={() => addTemplates.mutate()}>Add Outdoor Expert's GHL workflows</Button>}>
            Adds your six GoHighLevel workflows (dialing, estimate follow-up and review requests, for washing and lights), word for word and turned off.
          </EmptyState>
        )}
        {list.data?.sequences.map((s) => {
          const c = list.data.counts.get(s.id) ?? { total: 0, active: 0 };
          return (
            <div key={s.id} className="ghl-wf-row" role="row">
              <span className="row" style={{ gap: 8, minWidth: 0 }}>
                <Icon name="bolt" size={16} />
                <Link to={`/workflows/${s.id}`} className="strong ellipsis">{s.name}</Link>
                {s.brand && <span className={`pill-brand pill-brand-${s.brand}`}>{s.brand === "lights" ? "Lights" : "Washing"}</span>}
              </span>
              <span>
                <label className="ghl-switch">
                  <input type="checkbox" checked={s.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate({ id: s.id, enabled: e.target.checked })} aria-label={`${s.name}: published`} />
                  <span>{s.enabled ? "Published" : "Draft"}</span>
                </label>
              </span>
              <span className="num">{c.total}</span>
              <span className="num">{c.active}</span>
              <span className="muted small">{TRIGGER_LABEL[s.trigger] ?? s.trigger}</span>
            </div>
          );
        })}
      </div>
      <p className="muted small">
        Drafts don't run. A published workflow starts for each new lead, quote or job from then on, never for ones before. While Quo is test only, its texts only reach your test numbers.
      </p>
    </div>
  );
}

function AlertPhone() {
  const session = useSession();
  const saved = useQuery({ queryKey: ["sequence-alert-phone", session.company.id], queryFn: () => api.get<{ phone: string | null }>("/sequences/alert-phone") });
  const [typed, setPhone] = useState<string | null>(null);
  const phone = typed ?? (saved.data?.phone ? phoneDisplay(saved.data.phone) : "");
  const save = useMutation({
    meta: { inline: true, success: "Alert number saved" },
    mutationFn: () => api.put("/sequences/alert-phone", { phone }),
    onSuccess: () => saved.refetch(),
  });
  return (
    <section className="card card-pad stack-sm" aria-labelledby="alert-phone-title">
      <strong id="alert-phone-title">Text alerts go to</strong>
      <span className="muted small">New leads and replies are texted here (in place of GoHighLevel's call to connect you), and shown to the office in the app.</span>
      <div className="row wrap" style={{ gap: 8 }}>
        <input className="input" style={{ maxWidth: 220 }} type="tel" value={phone} onChange={(e) => { setPhone(e.target.value); save.reset(); }} placeholder="(470) 555-0101" aria-label="Alert number" />
        <Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
      </div>
      <FormError error={save.error} />
    </section>
  );
}
