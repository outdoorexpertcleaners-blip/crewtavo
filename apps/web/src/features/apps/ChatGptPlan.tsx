/**
 * A person's own ChatGPT plan for Crewtavo's AI (Apps → ChatGPT, and Settings → AI assistants for
 * everyone the company lets): sign in with ChatGPT and what you ask Crewtavo's AI yourself is
 * answered on your plan. It's yours alone: other people's asks, and what Crewtavo does by itself,
 * use the company's key.
 *
 * OpenAI sends the browser back to an address on the person's own computer, where Crewtavo isn't,
 * so signing in is two steps: approve on ChatGPT's page, then paste the address the browser ended
 * up on, which the server checks and finishes (apps/api/src/integrations/chatgptPlan.ts). The
 * wording OpenAI asks apps to use for plan usage is kept as it gives it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";

export interface PlanStatus {
  status: "connected" | "disconnected";
  email: string | null;
  model: string | null;
  models: Array<{ slug: string; display_name: string }>;
  model_locked: boolean;
  problem: "usage_limit" | "sign_in" | "not_eligible" | null;
  notice_seen: boolean;
  /** Signed in here before: signing in again is the same registration at OpenAI. */
  registered: boolean;
  connected_at: string | null;
}

export interface PlanData {
  /** This person may connect a plan: an owner or admin who manages apps, or anyone once the company allows it. */
  allowed: boolean;
  /** The company lets everyone on the team connect theirs. */
  team_plans: boolean;
  plan: PlanStatus;
  /** The company (or the server) has a key that answers when the plan can't. */
  fallback: boolean;
  redirect_uri: string;
  usage_url: string;
}

/** Where OpenAI's own page for a plan's usage is, until the server says. */
const USAGE_URL = "https://chatgpt.com/settings/usage";
const ELIGIBLE = "ChatGPT Plus and Pro plans can be used; an OpenAI API key is the other way.";

export const planKey = (userId: string, companyId: string) => ["chatgpt-plan", userId, companyId];

/** The signed-in person's plan connection. Quietly nothing on a server from before this could be done. */
export function useChatGptPlan(enabled = true) {
  const session = useSession();
  return useQuery({ queryKey: planKey(session.userId, session.company.id), queryFn: () => api.get<PlanData>("/ai/chatgpt"), enabled, retry: false });
}

/** "Using ChatGPT plan · Manage usage", as OpenAI asks it be said wherever a person's plan is in use. */
export function ManageUsage({ href = USAGE_URL }: { href?: string }) {
  return <a href={href} target="_blank" rel="noreferrer">Manage usage <Icon name="external" size={12} /></a>;
}

/**
 * The card. `where`: on the ChatGPT app's page it always shows (for the owners and admins who get
 * there); in Settings it shows for anyone who may connect a plan or has one to deal with, and not
 * at all otherwise.
 */
export function ChatGptPlanCard({ where }: { where: "app" | "settings" }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const query = useChatGptPlan();
  const key = planKey(session.userId, session.company.id);
  // Sign-in under way: OpenAI's page for it, and the address pasted back.
  const [signIn, setSignIn] = useState<{ url: string } | null>(null);
  const [address, setAddress] = useState("");
  const [welcome, setWelcome] = useState(false);

  const changed = (plan?: PlanStatus) => {
    if (plan) queryClient.setQueryData<PlanData>(key, (old) => (old ? { ...old, plan } : old));
    queryClient.invalidateQueries({ queryKey: key });
    queryClient.invalidateQueries({ queryKey: ["apps"] });
    // AI turns on, or off, for this person across the app (lib/session.tsx).
    session.refresh();
  };
  const start = useMutation({
    mutationFn: (options: { fresh: boolean; tab: Window | null }) => api.post<{ authorization_url: string }>("/ai/chatgpt/sign-in", { fresh: options.fresh }),
    onSuccess: (res, options) => {
      setSignIn({ url: res.authorization_url });
      setAddress("");
      finish.reset();
      // The tab opened with the click (so the browser allows it) goes to ChatGPT's page now.
      if (options.tab) options.tab.location.href = res.authorization_url;
    },
    onError: (_error, options) => options.tab?.close(),
  });
  /** Opens the tab first, while the click still counts as the person's, then asks for the address to send it to. */
  const begin = (fresh = false) => {
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    start.mutate({ fresh, tab });
  };
  const finish = useMutation({
    meta: { inline: true, success: "Your ChatGPT plan is connected" },
    mutationFn: () => api.post<{ plan: PlanStatus }>("/ai/chatgpt/sign-in/finish", { address: address.trim() }),
    onSuccess: (res) => {
      setSignIn(null);
      setAddress("");
      if (!res.plan.notice_seen) setWelcome(true);
      changed(res.plan);
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api.post<{ plan: PlanStatus; revoked: boolean }>("/ai/chatgpt/disconnect", {}),
    onSuccess: (res) => {
      if (res.revoked) toast.success("Your ChatGPT plan is disconnected");
      else toast.info("Disconnected here, but ChatGPT didn't confirm it. To be sure, remove the app under Apps in your ChatGPT settings.");
      setSignIn(null);
      changed(res.plan);
    },
  });
  const model = useMutation({
    meta: { success: "Model saved" },
    mutationFn: (slug: string) => api.put<{ plan: PlanStatus }>("/ai/chatgpt/model", { model: slug }),
    onSuccess: (res) => changed(res.plan),
  });
  const models = useMutation({
    mutationFn: () => api.post<{ plan: PlanStatus }>("/ai/chatgpt/models", {}),
    onSuccess: (res) => {
      toast.info("The list is up to date.");
      changed(res.plan);
    },
  });
  const retry = useMutation({
    meta: { success: "Your next ask tries your plan again" },
    mutationFn: () => api.post<{ plan: PlanStatus }>("/ai/chatgpt/retry", {}),
    onSuccess: (res) => changed(res.plan),
  });
  const gotIt = useMutation({ mutationFn: () => api.post("/ai/chatgpt/notice", {}), onSettled: () => queryClient.invalidateQueries({ queryKey: key }) });

  if (query.isPending) return where === "app" ? <section className="card card-pad"><Skeleton height={80} radius={8} /></section> : null;
  // A server from before this (the page can be newer than the server for a moment during an update).
  if (!query.data) return null;
  const { plan, allowed, fallback } = query.data;
  const usage = query.data.usage_url || USAGE_URL;
  const connected = plan.status === "connected";
  if (where === "settings" && !allowed && !connected && plan.problem !== "sign_in") return null;

  const askDisconnect = async () => {
    const body = `The app signs out of your ChatGPT account, and what you ask the AI ${fallback ? `uses ${session.company.name}'s own key again` : "stops working until you connect again or an admin adds a key"}. You can connect again any time.`;
    if (await confirm({ title: "Disconnect your ChatGPT plan?", body, confirmLabel: "Disconnect", danger: true })) disconnect.mutate();
  };
  const paste = (e: FormEvent) => {
    e.preventDefault();
    if (address.trim()) finish.mutate();
  };
  const picked = model.isPending ? model.variables : plan.model;
  // What answers this person's asks while their plan can't.
  const meanwhile = fallback ? `Meanwhile, what you ask uses ${session.company.name}'s own key.` : "Nothing else is set up to answer instead, so AI is paused for you until then.";

  return (
    <section className="card card-pad stack-sm" aria-labelledby="chatgpt-plan" style={{ gap: 10 }}>
      <h2 id="chatgpt-plan" className="section-title" style={{ fontSize: 16 }}>Use your ChatGPT plan</h2>
      <span className="muted small">Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.</span>

      {connected && plan.problem !== "sign_in" && (
        <>
          <div className="row wrap" style={{ gap: 10 }}>
            <Icon name="check" size={16} />
            <span className="grow">
              <strong>Using ChatGPT plan</strong>{plan.email ? <> · {plan.email}</> : null}
            </span>
            <ManageUsage href={usage} />
          </div>
          <span className="muted small">
            Yours alone: what you ask the app's AI yourself (a rewrite, a caption, a reply, an answer from your guides, a receipt you add) is answered on your ChatGPT account.
            Other people's asks, and anything the app drafts by itself, {fallback ? "use the company's own key" : "need a key of the company's"}.
          </span>
        </>
      )}

      {connected && plan.problem === "usage_limit" && (
        <div className="callout callout-warning" role="status">
          <Icon name="alert" size={20} />
          <div className="grow stack-sm" style={{ gap: 6 }}>
            <span>ChatGPT · Usage limit reached</span>
            <span style={{ fontWeight: 400 }}>Review your plan or this app's limit in ChatGPT settings. {meanwhile}</span>
            <div className="row wrap" style={{ gap: 8 }}>
              <a className="btn btn-primary btn-sm" href={usage} target="_blank" rel="noreferrer">Manage usage <Icon name="external" size={12} /></a>
              <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate()}>Try again</Button>
            </div>
          </div>
        </div>
      )}
      {connected && plan.problem === "not_eligible" && (
        <div className="callout callout-warning" role="status">
          <Icon name="alert" size={20} />
          <div className="grow stack-sm" style={{ gap: 6 }}>
            <span>ChatGPT says your plan can't be used here</span>
            <span style={{ fontWeight: 400 }}>{ELIGIBLE} {meanwhile}</span>
            <div className="row wrap" style={{ gap: 8 }}>
              <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate()}>Try again</Button>
            </div>
          </div>
        </div>
      )}
      {plan.problem === "sign_in" && (
        <div className="callout callout-warning" role="status">
          <Icon name="alert" size={20} />
          <div className="grow stack-sm" style={{ gap: 6 }}>
            <span>Sign in again</span>
            <span style={{ fontWeight: 400 }}>Your ChatGPT sign-in has ended, so your plan isn't being used. {meanwhile}</span>
          </div>
        </div>
      )}

      {connected && plan.problem !== "sign_in" && (
        plan.model_locked ? (
          <span className="muted small">Whoever runs this app server set the model to <strong>{plan.model}</strong> (OPENAI_MODEL), so it isn't picked here.</span>
        ) : (
          <div className="row wrap" style={{ gap: 8 }}>
            <select className="select grow" style={{ maxWidth: 320 }} value={picked ?? ""} disabled={model.isPending} onChange={(e) => model.mutate(e.target.value)} aria-label="Model your ChatGPT plan uses">
              {picked && !plan.models.some((m) => m.slug === picked) && <option value={picked}>{picked} (not listed anymore)</option>}
              {plan.models.map((m) => <option key={m.slug} value={m.slug}>{m.display_name}</option>)}
            </select>
            <Button icon="refresh" loading={models.isPending} onClick={() => models.mutate()}>Check for new models</Button>
          </div>
        )
      )}

      {(!connected || plan.problem === "sign_in") && (allowed || plan.problem === "sign_in") && (
        <>
          {plan.problem !== "sign_in" && (
            <span className="muted small">
              For you alone: what you ask the app's AI yourself is answered on your own ChatGPT account, and your plan pays for it. Other people's asks, and anything the app drafts by itself,
              use the company's key. {ELIGIBLE}
            </span>
          )}
          {allowed ? (
            <div className="row wrap" style={{ gap: 10 }}>
              <Button variant="primary" loading={start.isPending} onClick={() => begin()}>Continue with ChatGPT</Button>
              {plan.registered && plan.email && !signIn && (
                <button type="button" className="link-btn small" disabled={start.isPending} onClick={() => begin(true)}>Use a different account than {plan.email}</button>
              )}
            </div>
          ) : (
            <span className="muted small">{session.company.name} has turned off using your own ChatGPT plan, so it can't be connected again for now.</span>
          )}
          {signIn && (
            <form className="stack-sm" onSubmit={paste}>
              <ol className="app-steps">
                <li>
                  ChatGPT's sign-in opened in a new tab. Sign in there and allow the app.{" "}
                  <a href={signIn.url} target="_blank" rel="noreferrer">Open it again <Icon name="external" size={12} /></a>
                </li>
                <li>
                  Your browser then goes to an address that starts with <code>http://127.0.0.1:1455</code> and says the page can't be reached. That's expected: the address is all that's needed, and nothing is meant to open there.
                </li>
                <li>Copy that whole address from the address bar and paste it here. It works once, within ten minutes.</li>
              </ol>
              <div className="row" style={{ gap: 8 }}>
                <input
                  className="input grow"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="http://127.0.0.1:1455/auth/callback?code=…"
                  value={address}
                  onChange={(e) => { setAddress(e.target.value); finish.reset(); }}
                  aria-label="The address your browser ended up on"
                />
                <Button type="submit" loading={finish.isPending} disabled={!address.trim()}>Connect</Button>
              </div>
              {finish.error && <span className="field-error" role="alert">{(finish.error as Error).message}</span>}
            </form>
          )}
          {start.error && <span className="field-error" role="alert">{(start.error as Error).message}</span>}
        </>
      )}

      {(connected || plan.problem === "sign_in") && (
        <div className="row wrap" style={{ gap: 8 }}>
          <Button size="sm" variant="ghost" loading={disconnect.isPending} onClick={askDisconnect}>{connected ? "Disconnect" : "Forget this sign-in"}</Button>
          {where === "settings" && <span className="muted small">An OpenAI API key for the whole company is added by an owner or admin under Apps → ChatGPT.</span>}
        </div>
      )}

      {/* Shown once, the first time someone connects, as OpenAI asks. */}
      <Dialog open={welcome} onClose={() => { setWelcome(false); gotIt.mutate(); }} title="You're using your ChatGPT plan" size="sm">
        <div className="stack-sm">
          <p style={{ margin: 0 }}>Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.</p>
          <div className="form-actions">
            <Button variant="primary" onClick={() => { setWelcome(false); gotIt.mutate(); }}>Got it</Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}

/**
 * Owners and admins let everyone on the team connect their own ChatGPT plan, or keep it to owners
 * and admins. What someone asks then goes to OpenAI on their own account, so it starts off.
 */
export function TeamPlansSwitch() {
  const session = useSession();
  const queryClient = useQueryClient();
  const query = useChatGptPlan();
  const save = useMutation({
    mutationFn: (on: boolean) => api.put<{ team_plans: boolean }>("/ai/team-plans", { on }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: planKey(session.userId, session.company.id) });
      queryClient.invalidateQueries({ queryKey: ["apps"] });
      session.refresh();
    },
  });
  if (!query.data) return null;
  const on = save.isPending ? Boolean(save.variables) : query.data.team_plans;
  const change = async (next: boolean) => {
    if (!next && !(await confirm({ title: "Keep ChatGPT plans to owners and admins?", body: "Everyone else's ChatGPT plan is disconnected now, and what they ask the AI uses the company's own key again.", confirmLabel: "Turn off", danger: true }))) return;
    save.mutate(next);
  };
  return (
    <section className="card card-pad stack-sm" aria-label="ChatGPT plans for the team" style={{ gap: 8 }}>
      <label className="switch-row">
        <input type="checkbox" className="switch" checked={on} disabled={save.isPending} onChange={(e) => change(e.target.checked)} />
        Let everyone on my team use their own ChatGPT plan
      </label>
      <span className="muted small">
        Each person connects theirs under <Link to="/settings?tab=assistants" style={{ textDecoration: "underline" }}>Settings → AI assistants</Link>. What they ask the app's AI themselves then goes to OpenAI on their own ChatGPT account, and their plan pays for it.
        Off, only owners and admins can connect one. Subcontractors never can.
      </span>
    </section>
  );
}
