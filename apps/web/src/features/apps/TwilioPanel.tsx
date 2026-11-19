/**
 * Twilio on its app page: the business's own Twilio account, so texting works without anyone
 * setting up the server. Step by step to find the Account SID, Auth Token and number in Twilio; all
 * three are checked with Twilio before they're kept (the token encrypted, never shown again). Once
 * connected: the number texts go from, the address Twilio needs for incoming texts, and a button
 * that sets it on the number. A Crewtavo whose server was given a Twilio account works without any
 * of this, and says so.
 */
import { TEXT_CONSENT_HINT } from "@crewtavo/core/marketing";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatPhoneTyping } from "@/lib/validate";
import type { AppRow, TwilioState } from "./catalog";

const TWILIO_CONSOLE = "https://console.twilio.com/";
const TWILIO_NUMBERS = "https://console.twilio.com/us1/develop/phone-numbers/manage/incoming";

export function TwilioPanel({ app, onChanged }: { app: AppRow; onChanged: () => void }) {
  const state = app.twilio ?? null;
  const [changing, setChanging] = useState(false);
  if (state?.own && app.status !== "disconnected" && !changing) return <Connected app={app} state={state} onChanged={onChanged} onChange={() => setChanging(true)} />;
  return (
    <>
      {state?.server && (
        <section className="card card-pad stack-sm" aria-label="Texting" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 10 }}><Icon name="check" size={16} /><span className="grow">Texts go out from the Twilio number set up for this server</span></div>
          <span className="muted small">Nothing to do here. To text from your own number instead, connect your Twilio account below.</span>
        </section>
      )}
      <ConnectForm
        app={app}
        changing={changing || Boolean(state?.own)}
        optional={Boolean(state?.server)}
        onSaved={() => {
          setChanging(false);
          onChanged();
        }}
        onCancel={changing ? () => setChanging(false) : undefined}
      />
    </>
  );
}

function ConnectForm({ app, changing, optional, onSaved, onCancel }: { app: AppRow; changing: boolean; optional: boolean; onSaved: () => void; onCancel?: () => void }) {
  const [f, setF] = useState({ account_sid: "", auth_token: "", from_number: "" });
  const [show, setShow] = useState(false);
  const save = useMutation({
    meta: { inline: true, success: (res: { trial?: boolean }) => (res.trial ? "Twilio connected. A trial account only texts numbers you've verified in Twilio." : "Twilio connected") },
    mutationFn: () => api.put<{ trial?: boolean }>(`/apps/${app.id}/account`, { account_sid: f.account_sid.trim(), auth_token: f.auth_token.trim(), from_number: f.from_number.trim() }),
    onSuccess: () => {
      setF({ account_sid: "", auth_token: "", from_number: "" });
      onSaved();
    },
  });
  const set = (patch: Partial<typeof f>) => {
    setF({ ...f, ...patch });
    save.reset();
  };
  return (
    <section id="app-setup" className="card card-pad stack" aria-labelledby="twilio-setup-title">
      <div className="stack-sm" style={{ gap: 4 }}>
        <h2 id="twilio-setup-title" className="section-title" style={{ fontSize: 16 }}>{changing ? "Change your Twilio account" : optional ? "Use your own Twilio account" : "Connect your Twilio account"}</h2>
        <span className="muted small">
          About five minutes once you have a Twilio number. Twilio bills you directly for the texts you send, a fraction of a cent to a few cents each. In the US, Twilio also asks you to register
          your business before a new number can text (A2P 10DLC), which can take a few days.
        </span>
        <span className="muted small">{TEXT_CONSENT_HINT}</span>
      </div>
      <ol className="app-steps">
        <li>
          <a className="btn btn-sm" href={TWILIO_CONSOLE} target="_blank" rel="noreferrer">Open your Twilio console <Icon name="external" size={12} /></a>
          <span className="muted small" style={{ display: "block", marginTop: 4 }}>No account yet? Sign up there, then buy a phone number that can send SMS.</span>
        </li>
        <li>On the console's first page, under <strong>Account Info</strong>, copy the <strong>Account SID</strong> and the <strong>Auth Token</strong> (click the eye to show it).</li>
        <li>Copy your number from <a href={TWILIO_NUMBERS} target="_blank" rel="noreferrer">Phone Numbers → Active numbers</a>.</li>
        <li>Paste all three here. The app checks them with Twilio before saving, at no cost.</li>
      </ol>
      <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          <Field label="Account SID" hint="Starts with AC." requiredMessage="Paste your Account SID.">
            <input className="input" value={f.account_sid} onChange={(e) => set({ account_sid: e.target.value.trim() })} autoComplete="off" spellCheck={false} maxLength={60} required placeholder="AC…" />
          </Field>
          <Field label="Your Twilio number" requiredMessage="Enter your Twilio number.">
            <input className="input" type="tel" value={f.from_number} onChange={(e) => set({ from_number: formatPhoneTyping(e.target.value) })} maxLength={40} required placeholder="(555) 555-0123" />
          </Field>
        </div>
        <Field label="Auth Token" hint="Stored encrypted and never shown again." requiredMessage="Paste your Auth Token.">
          <div className="input-group">
            <input className="input" type={show ? "text" : "password"} value={f.auth_token} onChange={(e) => set({ auth_token: e.target.value })} autoComplete="off" spellCheck={false} maxLength={200} required style={{ paddingRight: 36 }} />
            <button type="button" className="icon-btn addon-right" style={{ position: "absolute", right: 2, pointerEvents: "auto" }} aria-label={show ? "Hide token" : "Show token"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={14} /></button>
          </div>
        </Field>
        <FormError error={save.error} />
        <div className="row wrap" style={{ gap: 8 }}>
          <FormChecks />
          <Button type="submit" variant="primary" loading={save.isPending}>{changing ? "Save" : "Connect"}</Button>
          {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        </div>
      </form>
    </section>
  );
}

function Connected({ app, state, onChanged, onChange }: { app: AppRow; state: TwilioState; onChanged: () => void; onChange: () => void }) {
  const point = useMutation({
    meta: { inline: true, success: "Incoming texts now come to the app" },
    mutationFn: () => api.post(`/apps/${app.id}/webhook`),
    onSuccess: onChanged,
  });
  return (
    <>
      <section className="card card-pad stack-sm" aria-label="Twilio account" style={{ gap: 6 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          <Icon name={app.status === "error" ? "alert" : "check"} size={16} />
          <span className="grow">
            {app.status === "error" ? <strong>Twilio isn't accepting this account anymore</strong> : <>Connected{app.account_label ? <> to <strong>{app.account_label}</strong></> : null}</>}
          </span>
          <Button size="sm" onClick={onChange}>Change account</Button>
        </div>
        {app.last_error && <span className="small" style={{ color: "var(--danger)", fontWeight: 600 }}>{app.last_error}</span>}
        <span className="muted small">Reminders, on-my-way texts and the texts you send from Messages go out from this number.</span>
      </section>
      <section className="card card-pad stack-sm" aria-labelledby="twilio-incoming" style={{ gap: 10 }}>
        <h2 id="twilio-incoming" className="section-title" style={{ fontSize: 16 }}>Replies from clients</h2>
        {state.webhook_set ? (
          <div className="row" style={{ gap: 10 }}><Icon name="check" size={16} /><span className="grow">Texts to your number come into Messages, and STOP is honoured.</span></div>
        ) : (
          <>
            <span className="muted small">
              For replies to land in Messages, your Twilio number has to send incoming texts to this address.
              {state.other_webhook ? <> Right now it sends them to <span style={{ overflowWrap: "anywhere" }}>{state.other_webhook}</span>, which this would replace.</> : null}
            </span>
            {state.reachable ? (
              <div className="row wrap" style={{ gap: 8 }}>
                <Button variant="primary" loading={point.isPending} onClick={() => point.mutate()}>Set it up for me</Button>
              </div>
            ) : (
              <span className="small" style={{ color: "var(--warning)", fontWeight: 600 }}>Twilio can only reach a public https address, and this app doesn't have one yet. Texts still go out.</span>
            )}
            <FormError error={point.error} />
          </>
        )}
        <details>
          <summary className="small" style={{ cursor: "pointer" }}>{state.webhook_set ? "The address Twilio uses" : "Or set it yourself in Twilio"}</summary>
          <div className="stack-sm small" style={{ gap: 6, marginTop: 8 }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <code className="code-pill grow">{state.webhook_url}</code>
              <Button size="sm" icon="copy" onClick={() => copyText(state.webhook_url, "Address copied")}>Copy</Button>
            </div>
            <span className="muted">In Twilio, open <a href={TWILIO_NUMBERS} target="_blank" rel="noreferrer">Phone Numbers → Active numbers</a>, click your number, and under <strong>Messaging configuration</strong> set <strong>A message comes in</strong> to Webhook, this address, HTTP POST. Then save.</span>
          </div>
        </details>
      </section>
    </>
  );
}
