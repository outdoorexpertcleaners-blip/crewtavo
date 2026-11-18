/**
 * Square on its app page (routes/square.ts): connecting the business's Square account so clients
 * pay invoices on Square's checkout page. Sandbox first (test cards, no real money), Production when
 * the business goes live. Payments are booked when the client comes back to their invoice, and right
 * away once Square is asked to report them here (a webhook subscription in the Square app).
 */
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import type { AppRow, SquareState } from "./catalog";

const SQUARE_DEVELOPER = "https://developer.squareup.com/apps";
const SANDBOX_CARD = "4111 1111 1111 1111";

interface Location {
  id: string;
  name: string;
  currency: string | null;
}

export function SquarePanel({ app, onChanged }: { app: AppRow; onChanged: () => void }) {
  const state = app.square ?? null;
  const [changing, setChanging] = useState(false);
  if (!state || changing) return <ConnectForm state={state} onSaved={() => { setChanging(false); onChanged(); }} onCancel={state ? () => setChanging(false) : undefined} />;
  const sandbox = state.environment === "sandbox";
  return (
    <>
      <section className="card card-pad stack-sm" aria-label="Square" style={{ gap: 6 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          <Icon name="check" size={16} />
          <span className="grow">
            Connected to Square{sandbox ? <>: <strong>Sandbox</strong> (test money only)</> : <>: <strong>Production</strong> (real payments)</>}
          </span>
          <Button size="sm" onClick={() => setChanging(true)}>Change</Button>
        </div>
        <dl className="kv">
          <dt>Payments go to</dt><dd>{state.location_name ?? "—"}</dd>
        </dl>
        <span className="muted small">
          A client presses <strong>Pay</strong> on their invoice and pays on Square's checkout page. The payment shows on the invoice when they come back to it
          {state.webhook_set ? ", or within seconds either way" : ""}.
        </span>
        {sandbox && (
          <span className="small">
            <Icon name="lock" size={12} /> Sandbox: pay with Square's test card <strong>{SANDBOX_CARD}</strong>, any future date, any CVV and any ZIP. Nothing is charged.
          </span>
        )}
      </section>
      <WebhookCard state={state} onChanged={onChanged} />
    </>
  );
}

function ConnectForm({ state, onSaved, onCancel }: { state: SquareState | null; onSaved: () => void; onCancel?: () => void }) {
  const hasToken = Boolean(state);
  const [environment, setEnvironment] = useState<"sandbox" | "production">(state?.environment ?? "sandbox");
  const [token, setToken] = useState("");
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [location, setLocation] = useState(state?.location_id ?? "");
  const check = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ locations: Location[] }>(`/apps/square/locations`, { environment, ...(token ? { access_token: token.trim() } : {}) }),
    onSuccess: (res) => {
      setLocations(res.locations);
      if (!res.locations.some((l) => l.id === location)) setLocation(res.locations[0]?.id ?? "");
    },
  });
  const save = useMutation({
    meta: { inline: true, success: "Square connected" },
    mutationFn: () => api.put(`/apps/square/account`, { environment, location_id: location, ...(token ? { access_token: token.trim() } : {}) }),
    onSuccess: onSaved,
  });
  const reset = () => { setLocations(null); check.reset(); save.reset(); };
  return (
    <section id="app-setup" className="card card-pad stack" aria-labelledby="square-setup-title">
      <div className="stack-sm" style={{ gap: 4 }}>
        <h2 id="square-setup-title" className="section-title" style={{ fontSize: 16 }}>{hasToken ? "Change your Square connection" : "Connect your Square account"}</h2>
        <span className="muted small">Clients pay invoices on Square's checkout page, and the money goes to your Square account. Start with Sandbox: nothing is charged.</span>
      </div>
      <ol className="app-steps">
        <li>
          <a className="btn btn-sm" href={SQUARE_DEVELOPER} target="_blank" rel="noreferrer">Open Square's Developer Dashboard <Icon name="external" size={12} /></a>
          <span className="muted small" style={{ display: "block", marginTop: 4 }}>Sign in with your Square account. Make an application (any name, like "Outdoor Expert app") if there isn't one.</span>
        </li>
        <li>Open the application, choose <strong>{environment === "sandbox" ? "Sandbox" : "Production"}</strong> at the top, then <strong>Credentials</strong>, and copy the <strong>Access token</strong>.</li>
        <li>Paste it here and press <strong>Find my locations</strong>. It's checked with Square, stored encrypted and never shown again.</li>
      </ol>
      <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); if (locations) save.mutate(); else check.mutate(); }}>
        <Field label="Square account">
          <select className="select" value={environment} onChange={(e) => { setEnvironment(e.target.value as "sandbox" | "production"); reset(); }}>
            <option value="sandbox">Sandbox: test cards, no real money</option>
            <option value="production">Production: real payments</option>
          </select>
        </Field>
        <Field label="Access token" hint={hasToken ? "Leave empty to keep the token you saved." : undefined}>
          <div className="row" style={{ gap: 8 }}>
            <input className="input grow" type="password" value={token} onChange={(e) => { setToken(e.target.value); reset(); }} autoComplete="off" spellCheck={false} maxLength={500} />
            <Button loading={check.isPending} onClick={() => check.mutate()} disabled={!token && !hasToken}>Find my locations</Button>
          </div>
        </Field>
        <FormError error={check.error} />
        {locations && (
          locations.length ? (
            <Field label="Payments go to">
              <select className="select" value={location} onChange={(e) => setLocation(e.target.value)}>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}{l.currency ? ` (${l.currency})` : ""}</option>)}
              </select>
            </Field>
          ) : (
            <span className="small" style={{ color: "var(--warning)", fontWeight: 600 }}>This Square account has no active locations. Add one in Square first.</span>
          )
        )}
        <FormError error={save.error} />
        <div className="row wrap" style={{ gap: 8 }}>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!locations || !location}>Save</Button>
          {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        </div>
      </form>
    </section>
  );
}

function WebhookCard({ state, onChanged }: { state: SquareState; onChanged: () => void }) {
  const set = useMutation({
    meta: { inline: true, success: "Square now reports payments right away" },
    mutationFn: () => api.post(`/apps/square/webhook`),
    onSuccess: onChanged,
  });
  return (
    <section className="card card-pad stack-sm" aria-labelledby="square-webhook" style={{ gap: 10 }}>
      <h2 id="square-webhook" className="section-title" style={{ fontSize: 16 }}>Payments right away</h2>
      {state.webhook_set ? (
        <div className="row" style={{ gap: 10 }}><Icon name="check" size={16} /><span className="grow">Square tells this app the moment a payment is made.</span></div>
      ) : (
        <>
          <span className="muted small">
            Without this, a payment shows on its invoice when the client comes back to it from Square. This adds a webhook to your Square application so it shows within seconds
            even if they close the page. Nothing else changes in Square.
          </span>
          {state.reachable ? (
            <div className="row"><Button variant="primary" loading={set.isPending} onClick={() => set.mutate()}>Report payments here</Button></div>
          ) : (
            <span className="small" style={{ color: "var(--warning)", fontWeight: 600 }}>Square can only reach a public https address, and this app doesn't have one yet.</span>
          )}
          <FormError error={set.error} />
        </>
      )}
    </section>
  );
}
