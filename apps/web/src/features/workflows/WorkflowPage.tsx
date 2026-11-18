/**
 * One workflow, as GoHighLevel's builder lays it out: the trigger card at the top and the steps
 * below it as cards on one line, with a + between them to add a step. Click a step to change it.
 * Draft / Publish at the top. "Enrollment history" lists the clients going through it, with what
 * happened, and pauses, resumes or stops one (routes/sequences.ts).
 */
import { LEAD_STAGES, stageLabel } from "@crewtavo/core/pipeline";
import {
  ON_REPLY, ON_REPLY_LABEL, SEQUENCE_FILL_INS, SEQUENCE_TRIGGERS, sendWindow, sequenceSteps, STEP_LABEL, TRIGGER_LABEL, waitWords,
  type SendWindow, type SequenceStep, type StepKind,
} from "@crewtavo/core/sequences";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon, type IconName } from "@/components/ui/Icon";
import { BackLink } from "@/components/ui/PageHeader";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { SequenceRow } from "./WorkflowsPage";

const ICON: Record<StepKind, IconName> = { wait: "clock", text: "messages", alert: "bell", task: "check", stage: "pipeline", hours: "calendar", goto: "arrowRight", end: "x" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NEW_STEP: Record<StepKind, SequenceStep> = {
  wait: { kind: "wait", minutes: 60 * 24, window: null },
  text: { kind: "text", body: "Hi {{first_name}}, " },
  alert: { kind: "alert", body: "{{name}} {{phone}}" },
  task: { kind: "task", title: "Call {{name}}", days: 0 },
  stage: { kind: "stage", stage: "hot" },
  hours: { kind: "hours", start: "07:00", end: "20:00", otherwise: 0 },
  goto: { kind: "goto", step: 0 },
  end: { kind: "end" },
};

const windowWords = (w: SendWindow | null | undefined) => (w ? `${w.days.map((d) => DAYS[d]).join(", ")} ${w.start}–${w.end}` : "Any time");

/** One line about a step, as GHL's card shows it. */
function summary(s: SequenceStep): string {
  switch (s.kind) {
    case "wait": return `${waitWords(s.minutes)}${s.window ? `, then ${windowWords(s.window)}` : ""}`;
    case "text": return s.body.replace(/\s+/g, " ").slice(0, 90);
    case "alert": return s.body.replace(/\s+/g, " ").slice(0, 90);
    case "task": return `${s.title} · due in ${s.days} ${s.days === 1 ? "day" : "days"}`;
    case "stage": return stageLabel(s.stage);
    case "hours": return `${s.start}–${s.end}, otherwise step ${s.otherwise + 1}`;
    case "goto": return `Step ${s.step + 1}`;
    case "end": return "The workflow ends";
  }
}

export function WorkflowPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"builder" | "settings" | "history">("builder");
  const key = ["sequence", id];
  const seq = useQuery({
    queryKey: key,
    queryFn: async () => unwrap(await supabase().from("sequences").select("id, name, brand, trigger, on_reply, send_window, steps, enabled, template_key, updated_at").eq("id", id).single()) as unknown as SequenceRow,
  });
  const [steps, setSteps] = useState<SequenceStep[] | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  useEffect(() => { if (seq.data && steps === null) setSteps(sequenceSteps(seq.data.steps)); }, [seq.data, steps]);
  const save = useMutation({
    meta: { success: "Saved" },
    mutationFn: async (patch: Partial<SequenceRow>) => unwrap(await supabase().from("sequences").update(patch as never).eq("id", id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ["sequences", session.company.id] });
    },
  });
  if (seq.error) return <div className="card"><ErrorState error={seq.error} onRetry={() => seq.refetch()} /></div>;
  if (!seq.data || !steps) return <Loading label="Loading workflow"><Skeleton height={300} /></Loading>;
  const s = seq.data;
  const dirty = JSON.stringify(steps) !== JSON.stringify(sequenceSteps(s.steps));
  const insert = (at: number, kind: StepKind) => {
    // Steps after the insert move down one: go-tos and the hours fork keep pointing at the same step.
    const shift = (n: number) => (n >= at ? n + 1 : n);
    const moved = steps.map((x) => (x.kind === "goto" ? { ...x, step: shift(x.step) } : x.kind === "hours" ? { ...x, otherwise: shift(x.otherwise) } : x));
    setSteps([...moved.slice(0, at), NEW_STEP[kind], ...moved.slice(at)]);
    setEditing(at);
  };
  const remove = (at: number) => {
    const shift = (n: number) => (n > at ? n - 1 : n);
    setSteps(steps.filter((_, i) => i !== at).map((x) => (x.kind === "goto" ? { ...x, step: shift(x.step) } : x.kind === "hours" ? { ...x, otherwise: shift(x.otherwise) } : x)));
    setEditing(null);
  };
  const change = (at: number, next: SequenceStep) => setSteps(steps.map((x, i) => (i === at ? next : x)));

  return (
    <div className="stack ghl-builder">
      <BackLink to="/workflows">Workflows list</BackLink>
      <div className="ghl-builder-bar">
        <input className="input ghl-builder-name" value={s.name} aria-label="Workflow name" onChange={(e) => queryClient.setQueryData<SequenceRow>(key, { ...s, name: e.target.value })} onBlur={(e) => save.mutate({ name: e.target.value.trim() || s.name })} />
        <div className="segmented" role="tablist" aria-label="Workflow view">
          <button type="button" aria-pressed={tab === "builder"} onClick={() => setTab("builder")}>Builder</button>
          <button type="button" aria-pressed={tab === "settings"} onClick={() => setTab("settings")}>Settings</button>
          <button type="button" aria-pressed={tab === "history"} onClick={() => setTab("history")}>Enrollment history</button>
        </div>
        <span className="grow" />
        {dirty && <Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ steps: steps as never })}>Save</Button>}
        <label className="ghl-switch">
          <span>Draft</span>
          <input type="checkbox" checked={s.enabled} onChange={(e) => save.mutate({ enabled: e.target.checked })} aria-label="Publish" />
          <span>Publish</span>
        </label>
      </div>

      {tab === "builder" && (
        <div className="ghl-canvas">
          <div className="ghl-node ghl-trigger">
            <span className="ghl-node-icon"><Icon name="bolt" size={14} /></span>
            <span className="grow">
              <strong>{TRIGGER_LABEL[s.trigger]}</strong>
              <span className="muted small" style={{ display: "block" }}>{s.brand ? (s.brand === "lights" ? "Christmas lights only" : "Washing only") : "Both brands"} · on reply: {ON_REPLY_LABEL[s.on_reply as keyof typeof ON_REPLY_LABEL] ?? s.on_reply}</span>
            </span>
          </div>
          <AddStep onAdd={(k) => insert(0, k)} />
          {steps.map((step, i) => (
            <div key={i} className="ghl-step-wrap">
              <div className="ghl-node" data-kind={step.kind} data-open={editing === i || undefined}>
                <button type="button" className="ghl-node-main" onClick={() => setEditing(editing === i ? null : i)}>
                  <span className="ghl-node-num">{i + 1}</span>
                  <span className="ghl-node-icon"><Icon name={ICON[step.kind]} size={14} /></span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <strong>{STEP_LABEL[step.kind]}</strong>
                    <span className="muted small ellipsis" style={{ display: "block" }}>{summary(step)}</span>
                  </span>
                </button>
                {editing === i && <StepEditor step={step} count={steps.length} onChange={(n) => change(i, n)} onRemove={() => remove(i)} />}
              </div>
              <AddStep onAdd={(k) => insert(i + 1, k)} />
            </div>
          ))}
          <div className="ghl-node ghl-end"><Icon name="x" size={14} /> End</div>
        </div>
      )}
      {tab === "settings" && <Settings s={s} onSave={(p) => save.mutate(p)} />}
      {tab === "history" && <History sequenceId={s.id} />}
    </div>
  );
}

function AddStep({ onAdd }: { onAdd: (kind: StepKind) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ghl-add">
      <button type="button" className="ghl-plus" aria-label="Add a step" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="plus" size={12} /></button>
      {open && (
        <div className="ghl-add-menu" role="menu">
          {(Object.keys(STEP_LABEL) as StepKind[]).map((k) => (
            <button key={k} type="button" role="menuitem" onClick={() => { onAdd(k); setOpen(false); }}><Icon name={ICON[k]} size={14} />{STEP_LABEL[k]}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function StepEditor({ step, count, onChange, onRemove }: { step: SequenceStep; count: number; onChange: (s: SequenceStep) => void; onRemove: () => void }) {
  const stepPick = (value: number, set: (n: number) => void, label: string) => (
    <label className="stack-sm"><span className="small strong">{label}</span>
      <select className="select" value={value} onChange={(e) => set(Number(e.target.value))}>
        {Array.from({ length: count }, (_, i) => <option key={i} value={i}>Step {i + 1}</option>)}
      </select>
    </label>
  );
  return (
    <div className="ghl-editor stack-sm">
      {step.kind === "wait" && (
        <>
          <label className="stack-sm"><span className="small strong">Wait</span>
            <span className="row" style={{ gap: 8 }}>
              <input className="input" type="number" min={0} style={{ width: 110 }} value={step.minutes >= 1440 && step.minutes % 1440 === 0 ? step.minutes / 1440 : step.minutes >= 60 && step.minutes % 60 === 0 ? step.minutes / 60 : step.minutes}
                onChange={(e) => { const n = Math.max(0, Number(e.target.value)); const unit = step.minutes >= 1440 && step.minutes % 1440 === 0 ? 1440 : step.minutes >= 60 && step.minutes % 60 === 0 ? 60 : 1; onChange({ ...step, minutes: n * unit }); }} />
              <select className="select" style={{ width: 130 }} value={step.minutes >= 1440 && step.minutes % 1440 === 0 ? 1440 : step.minutes >= 60 && step.minutes % 60 === 0 ? 60 : 1}
                onChange={(e) => { const unit = Number(e.target.value); const cur = step.minutes >= 1440 && step.minutes % 1440 === 0 ? step.minutes / 1440 : step.minutes >= 60 && step.minutes % 60 === 0 ? step.minutes / 60 : step.minutes; onChange({ ...step, minutes: Math.max(1, cur) * unit }); }}>
                <option value={1}>minutes</option><option value={60}>hours</option><option value={1440}>days</option>
              </select>
            </span>
          </label>
          <WindowEditor value={step.window ?? null} onChange={(w) => onChange({ ...step, window: w })} label="Then wait until (optional)" />
        </>
      )}
      {(step.kind === "text" || step.kind === "alert") && (
        <label className="stack-sm"><span className="small strong">{step.kind === "text" ? "Message to the client" : "Alert to the office"}</span>
          <textarea className="textarea" rows={5} maxLength={1600} value={step.body} onChange={(e) => onChange({ ...step, body: e.target.value })} />
          <span className="muted small">Fill-ins: {SEQUENCE_FILL_INS.map((f) => `{{${f}}}`).join(" ")}</span>
        </label>
      )}
      {step.kind === "task" && (
        <>
          <label className="stack-sm"><span className="small strong">Task</span><input className="input" value={step.title} maxLength={200} onChange={(e) => onChange({ ...step, title: e.target.value })} /></label>
          <label className="stack-sm"><span className="small strong">Due in (days)</span><input className="input" type="number" min={0} style={{ width: 110 }} value={step.days} onChange={(e) => onChange({ ...step, days: Math.max(0, Number(e.target.value)) })} /></label>
        </>
      )}
      {step.kind === "stage" && (
        <label className="stack-sm"><span className="small strong">Move the lead to</span>
          <select className="select" value={step.stage} onChange={(e) => onChange({ ...step, stage: e.target.value as typeof step.stage })}>
            {LEAD_STAGES.map((st) => <option key={st} value={st}>{stageLabel(st)}</option>)}
          </select>
        </label>
      )}
      {step.kind === "hours" && (
        <>
          <span className="row wrap" style={{ gap: 8 }}>
            <label className="stack-sm"><span className="small strong">From</span><input className="input" type="time" value={step.start} onChange={(e) => onChange({ ...step, start: e.target.value })} /></label>
            <label className="stack-sm"><span className="small strong">To</span><input className="input" type="time" value={step.end} onChange={(e) => onChange({ ...step, end: e.target.value })} /></label>
          </span>
          {stepPick(step.otherwise, (n) => onChange({ ...step, otherwise: n }), "Outside these hours, go to")}
        </>
      )}
      {step.kind === "goto" && stepPick(step.step, (n) => onChange({ ...step, step: n }), "Go to")}
      <div className="row"><Button size="sm" variant="danger" icon="trash" onClick={onRemove}>Delete step</Button></div>
    </div>
  );
}

function WindowEditor({ value, onChange, label }: { value: SendWindow | null; onChange: (w: SendWindow | null) => void; label: string }) {
  const w = value ?? { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "19:00" };
  return (
    <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
      <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked ? w : null)} /><span className="small strong">{label}</span></label>
      {value && (
        <>
          <span className="row wrap" style={{ gap: 6 }}>
            {DAYS.map((d, i) => (
              <label key={d} className="ghl-day"><input type="checkbox" checked={w.days.includes(i)} onChange={(e) => onChange(sendWindow({ ...w, days: e.target.checked ? [...w.days, i] : w.days.filter((x) => x !== i) }) ?? w)} />{d}</label>
            ))}
          </span>
          <span className="row wrap" style={{ gap: 8 }}>
            <input className="input" type="time" value={w.start} aria-label="From" onChange={(e) => onChange(sendWindow({ ...w, start: e.target.value }) ?? w)} />
            <input className="input" type="time" value={w.end} aria-label="To" onChange={(e) => onChange(sendWindow({ ...w, end: e.target.value }) ?? w)} />
          </span>
        </>
      )}
    </fieldset>
  );
}

function Settings({ s, onSave }: { s: SequenceRow; onSave: (p: Partial<SequenceRow>) => void }) {
  return (
    <div className="card card-pad stack" style={{ maxWidth: 640 }}>
      <label className="stack-sm"><span className="strong">Starts when</span>
        <select className="select" value={s.trigger} onChange={(e) => onSave({ trigger: e.target.value as SequenceRow["trigger"] })}>
          {SEQUENCE_TRIGGERS.map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}
        </select>
      </label>
      <label className="stack-sm"><span className="strong">For</span>
        <select className="select" value={s.brand ?? ""} onChange={(e) => onSave({ brand: (e.target.value || null) as SequenceRow["brand"] })}>
          <option value="">Both brands</option><option value="washing">Washing only</option><option value="lights">Christmas lights only</option>
        </select>
      </label>
      <label className="stack-sm"><span className="strong">When they text back</span>
        <select className="select" value={s.on_reply} onChange={(e) => onSave({ on_reply: e.target.value })}>
          {ON_REPLY.map((o) => <option key={o} value={o}>{ON_REPLY_LABEL[o]}</option>)}
        </select>
      </label>
      <WindowEditor value={sendWindow(s.send_window)} onChange={(w) => onSave({ send_window: w as never })} label="Only send texts during" />
    </div>
  );
}

interface RunRow { id: string; status: string; step: number; next_at: string; created_at: string; ended_reason: string | null; log: Array<{ at: string; note: string }>; client: { id: string; display_name: string } | null; subject_type: string; subject_id: string }

function History({ sequenceId }: { sequenceId: string }) {
  const queryClient = useQueryClient();
  const key = ["sequence-runs", sequenceId];
  const runs = useQuery({
    queryKey: key,
    refetchInterval: 30_000,
    queryFn: async () => unwrap(await supabase().from("sequence_runs").select("id, status, step, next_at, created_at, ended_reason, log, subject_type, subject_id, client:clients(id, display_name)").eq("sequence_id", sequenceId).order("created_at", { ascending: false }).limit(100)) as unknown as RunRow[],
  });
  const act = useMutation({
    meta: { success: (_: unknown, v: { action: string }) => (v.action === "resume" ? "Resumed: the next text goes now" : v.action === "pause" ? "Paused" : "Stopped") },
    mutationFn: (v: { id: string; action: "pause" | "resume" | "stop" }) => api.post(`/sequence-runs/${v.id}/${v.action}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const link = (r: RunRow) => (r.subject_type === "request" ? `/requests/${r.subject_id}` : r.subject_type === "quote" ? `/quotes/${r.subject_id}` : `/jobs/${r.subject_id}`);
  return (
    <div className="card">
      {runs.data?.length === 0 && <p className="card-pad muted">Nobody has gone through this workflow yet.</p>}
      {runs.data?.map((r) => (
        <details key={r.id} className="ghl-run">
          <summary className="row wrap" style={{ gap: 10 }}>
            <span className={`ghl-run-status ghl-run-${r.status}`}>{r.status === "active" ? "Active" : r.status === "paused" ? "Paused" : r.status === "done" ? "Finished" : "Stopped"}</span>
            <Link to={link(r)} className="strong" onClick={(e) => e.stopPropagation()}>{r.client?.display_name ?? "Client"}</Link>
            <span className="muted small">started {timeAgo(r.created_at)} · {r.status === "active" ? `step ${r.step + 1}, next ${formatDateTime(r.next_at)}` : r.ended_reason ?? `at step ${r.step + 1}`}</span>
            <span className="grow" />
            {r.status === "active" && <Button size="sm" onClick={(e) => { e.preventDefault(); act.mutate({ id: r.id, action: "pause" }); }}>Pause</Button>}
            {r.status === "paused" && <Button size="sm" variant="primary" onClick={(e) => { e.preventDefault(); act.mutate({ id: r.id, action: "resume" }); }}>Resume follow-up</Button>}
            {(r.status === "active" || r.status === "paused") && <Button size="sm" onClick={async (e) => { e.preventDefault(); if (await confirm({ title: "Stop this workflow for them?", confirmLabel: "Stop", danger: true })) act.mutate({ id: r.id, action: "stop" }); }}>Stop</Button>}
          </summary>
          <ol className="ghl-log">
            {[...r.log].reverse().map((l, i) => <li key={i}><span className="muted small nowrap">{formatDateTime(l.at)}</span> {l.note}</li>)}
          </ol>
        </details>
      ))}
    </div>
  );
}
