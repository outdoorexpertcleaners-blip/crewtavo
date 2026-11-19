/**
 * Crewtavo's own AI on the Claude and ChatGPT app pages: which of the company's two keys it uses
 * when it has both, and the model its OpenAI key uses. Which service answers each ask is decided on
 * the server (apps/api/src/services/ai.ts).
 */
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import type { AiState, AppRow, OpenAiState } from "./catalog";

const SERVICES: Array<{ service: "claude" | "chatgpt"; label: string; hint: string }> = [
  { service: "claude", label: "Claude", hint: "Your Anthropic key, from Apps → Claude." },
  { service: "chatgpt", label: "ChatGPT", hint: "Your OpenAI key, from Apps → ChatGPT." },
];

/**
 * A company with both a Claude key and an OpenAI key chooses which one Crewtavo's AI uses. With
 * one key, or none, there's nothing to choose and nothing shows.
 */
export function AiServiceChoice({ ai, onChanged }: { ai: AiState | undefined; onChanged: () => void }) {
  const save = useMutation({
    meta: { success: (res: { service: string | null }) => `The app's AI uses ${res.service === "chatgpt" ? "ChatGPT" : "Claude"} now` },
    mutationFn: (service: "claude" | "chatgpt") => api.put<{ service: string | null }>("/ai/service", { service }),
    onSuccess: onChanged,
  });
  if (!ai?.claude || !ai.chatgpt) return null;
  const using = save.isPending ? save.variables : ai.service;
  return (
    <section className="card card-pad stack-sm" aria-labelledby="ai-service" style={{ gap: 10 }}>
      <h2 id="ai-service" className="section-title" style={{ fontSize: 16 }}>The app's AI uses</h2>
      <span className="muted small">You've added a key for both. This one writes the drafts, answers from your guides and reads receipts; the other is kept and not used.</span>
      <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }} disabled={save.isPending}>
        <legend className="sr-only">The app's AI uses</legend>
        {SERVICES.map((s) => (
          <label key={s.service} className={`card-row choice-row${using === s.service ? " picked" : ""}`} style={{ cursor: "pointer" }}>
            <input type="radio" name="ai-service" checked={using === s.service} onChange={() => save.mutate(s.service)} />
            <span className="grow">
              <strong style={{ display: "block" }}>{s.label}</strong>
              <span className="muted small">{s.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

/** The model the company's OpenAI key uses, among the ones OpenAI lists for it. */
export function OpenAiModelCard({ app, onChanged }: { app: AppRow; onChanged: () => void }) {
  const state: OpenAiState | undefined = app.openai;
  const pick = useMutation({
    meta: { success: "Model saved" },
    mutationFn: (model: string) => api.put("/apps/chatgpt/model", { model }),
    onSuccess: onChanged,
  });
  const check = useMutation({
    mutationFn: () => api.post<OpenAiState>("/apps/chatgpt/models"),
    onSuccess: (res) => {
      toast.info(res.models.length === state?.models.length ? "No new models." : "The list is up to date.");
      onChanged();
    },
  });
  if (!state) return null;
  const model = pick.isPending ? pick.variables : state.model;
  return (
    <section className="card card-pad stack-sm" aria-labelledby="openai-model" style={{ gap: 10 }}>
      <h2 id="openai-model" className="section-title" style={{ fontSize: 16 }}>Model</h2>
      {state.model_locked ? (
        <span className="muted small">Whoever runs this app server set the model to <strong>{state.model}</strong> (OPENAI_MODEL), so it isn't picked here.</span>
      ) : (
        <>
          <span className="muted small">The OpenAI model your key uses for the app's AI. These are the ones OpenAI lists for your key; OpenAI's prices differ by model.</span>
          <div className="row wrap" style={{ gap: 8 }}>
            <select className="select grow" style={{ maxWidth: 320 }} value={model ?? ""} disabled={pick.isPending} onChange={(e) => pick.mutate(e.target.value)} aria-label="OpenAI model">
              {/* A model picked before that OpenAI no longer lists still shows, so it can be seen and changed. */}
              {model && !state.models.some((m) => m.slug === model) && <option value={model}>{model} (not listed anymore)</option>}
              {state.models.map((m) => <option key={m.slug} value={m.slug}>{m.display_name}</option>)}
            </select>
            <Button icon="refresh" loading={check.isPending} onClick={() => check.mutate()}>Check for new models</Button>
          </div>
        </>
      )}
    </section>
  );
}
