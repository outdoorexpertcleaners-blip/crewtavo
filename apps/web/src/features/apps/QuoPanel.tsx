/**
 * Quo on its app page (routes/quo.ts): the business's phone system, for texting from its own lines,
 * one per brand. Test only until the business goes live: Crewtavo texts only the test numbers here,
 * and a text from any other number is dropped without being kept.
 *
 * Practice mode tries it all without a Quo account: texts are marked sent without leaving Crewtavo,
 * and "Pretend a reply" files a text from a test number as if it came in. Connecting the real
 * workspace takes its API key and a line per brand; incoming texts come here only once someone asks
 * (a webhook in the Quo workspace).
 */
import { phoneDisplay as formatPhone } from "@crewtavo/core/phone";
import type { QuoLine } from "@crewtavo/core/quo";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import type { AppRow, QuoState } from "./catalog";

const QUO_API_SETTINGS = "https://my.quo.com/settings/api";

const numbersText = (list: readonly string[]) => list.map((n) => formatPhone(n)).join("\n");

export function QuoPanel({ app, onChanged }: { app: AppRow; onChanged: () => void }) {
  const state = app.quo ?? null;
  const [connecting, setConnecting] = useState(false);
  if (!state || connecting) {
    return (
      <>
        {!state && <PracticeCard onChanged={onChanged} />}
        <ConnectForm state={state} onSaved={() => { setConnecting(false); onChanged(); }} onCancel={state ? () => setConnecting(false) : undefined} />
      </>
    );
  }
  return (
    <>
      <section className="card card-pad stack-sm" aria-label="Quo" style={{ gap: 6 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          <Icon name="check" size={16} />
          <span className="grow">
            {state.practice ? <><strong>Practice mode</strong>: no Quo account. Texts are marked sent but never leave the app.</> : <>Connected to your Quo workspace</>}
          </span>
          <Button size="sm" onClick={() => setConnecting(true)}>{state.practice ? "Connect your Quo account" : "Change"}</Button>
        </div>
        {!state.practice && (
          <dl className="kv">
            <dt>Washing texts from</dt><dd>{state.lines.washing ? `${state.lines.washing.name} · ${formatPhone(state.lines.washing.number)}` : "The lighting line"}</dd>
            <dt>Lights texts from</dt><dd>{state.lines.lights ? `${state.lines.lights.name} · ${formatPhone(state.lines.lights.number)}` : "The wash line"}</dd>
          </dl>
        )}
      </section>
      {state.test_only && <TestNumbersCard numbers={state.test_numbers} onChanged={onChanged} />}
      {!state.practice && <IncomingCard state={state} onChanged={onChanged} />}
      {state.test_only && <PretendCard numbers={state.test_numbers} />}
    </>
  );
}

function TestOnlyNote() {
  return (
    <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
      <Icon name="lock" size={16} />
      <span className="small">
        <strong>Test only.</strong> The app texts only the test numbers below, and drops texts from any other number without keeping them. Your customers never hear from this
        app, and their texts stay in Quo only.
      </span>
    </div>
  );
}

function PracticeCard({ onChanged }: { onChanged: () => void }) {
  const [numbers, setNumbers] = useState("");
  const save = useMutation({
    meta: { inline: true, success: "Practice mode is on" },
    mutationFn: () => api.put(`/apps/quo/practice`, { test_numbers: numbers }),
    onSuccess: onChanged,
  });
  return (
    <section className="card card-pad stack" aria-labelledby="quo-practice-title">
      <div className="stack-sm" style={{ gap: 4 }}>
        <h2 id="quo-practice-title" className="section-title" style={{ fontSize: 16 }}>Try it first: practice mode</h2>
        <span className="muted small">No Quo account needed. Texts are marked sent without leaving the app, and you can pretend one of your test numbers texted back.</span>
      </div>
      <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Test numbers" hint="One per line, up to 10. Use fake 555-01xx numbers, or your own cell.">
          <textarea className="input" rows={3} value={numbers} onChange={(e) => { setNumbers(e.target.value); save.reset(); }} placeholder={"(470) 555-0101\n(470) 555-0102"} />
        </Field>
        <FormError error={save.error} />
        <div className="row"><Button type="submit" variant="primary" loading={save.isPending}>Turn on practice mode</Button></div>
      </form>
    </section>
  );
}

function ConnectForm({ state, onSaved, onCancel }: { state: QuoState | null; onSaved: () => void; onCancel?: () => void }) {
  const hasKey = Boolean(state && !state.practice);
  const [key, setKey] = useState("");
  const [lines, setLines] = useState<QuoLine[] | null>(null);
  const [washing, setWashing] = useState(state?.lines.washing && !state.practice ? state.lines.washing.id : "");
  const [lights, setLights] = useState(state?.lines.lights && !state.practice ? state.lines.lights.id : "");
  const [numbers, setNumbers] = useState(numbersText(state?.test_numbers ?? []));
  const check = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ lines: QuoLine[] }>(`/apps/quo/lines`, key ? { api_key: key.trim() } : {}),
    onSuccess: (res) => {
      setLines(res.lines);
      const named = (word: RegExp) => res.lines.find((l) => word.test(l.name))?.id ?? "";
      if (!washing) setWashing(named(/wash|clean/i));
      if (!lights) setLights(named(/light|christmas/i));
    },
  });
  const save = useMutation({
    meta: { inline: true, success: "Quo connected, test only" },
    mutationFn: () => api.put(`/apps/quo/account`, { ...(key ? { api_key: key.trim() } : {}), washing_line_id: washing || null, lights_line_id: lights || null, ...(state ? {} : { test_numbers: numbers }) }),
    onSuccess: onSaved,
  });
  return (
    <section id="app-setup" className="card card-pad stack" aria-labelledby="quo-setup-title">
      <div className="stack-sm" style={{ gap: 4 }}>
        <h2 id="quo-setup-title" className="section-title" style={{ fontSize: 16 }}>{hasKey ? "Change your Quo connection" : "Connect your Quo account"}</h2>
        <span className="muted small">
          Texts go out from your own Quo lines and show in the Quo app like any other text. Quo bills texts sent this way from its prepaid credit (Quo: Settings → Billing).
        </span>
      </div>
      <TestOnlyNote />
      <ol className="app-steps">
        <li>
          <a className="btn btn-sm" href={QUO_API_SETTINGS} target="_blank" rel="noreferrer">Open Quo's API settings <Icon name="external" size={12} /></a>
          <span className="muted small" style={{ display: "block", marginTop: 4 }}>Only an owner or admin of the Quo workspace can make a key.</span>
        </li>
        <li>Make a key named <strong>Outdoor Expert app test</strong> and copy it.</li>
        <li>Paste it here and press <strong>Find my lines</strong>. It's checked with Quo, stored encrypted and never shown again.</li>
      </ol>
      <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); if (lines || hasKey) save.mutate(); else check.mutate(); }}>
        <Field label="Quo API key" hint={hasKey ? "Leave empty to keep the key you saved." : undefined}>
          <div className="row" style={{ gap: 8 }}>
            <input className="input grow" type="password" value={key} onChange={(e) => { setKey(e.target.value); setLines(null); check.reset(); }} autoComplete="off" spellCheck={false} maxLength={300} />
            <Button loading={check.isPending} onClick={() => check.mutate()} disabled={!key && !hasKey}>Find my lines</Button>
          </div>
        </Field>
        <FormError error={check.error} />
        {lines && (
          <div className="form-grid">
            <Field label="Washing texts from">
              <select className="select" value={washing} onChange={(e) => setWashing(e.target.value)}>
                <option value="">The lighting line</option>
                {lines.map((l) => <option key={l.id} value={l.id}>{l.name} · {formatPhone(l.number)}</option>)}
              </select>
            </Field>
            <Field label="Lights texts from">
              <select className="select" value={lights} onChange={(e) => setLights(e.target.value)}>
                <option value="">The wash line</option>
                {lines.map((l) => <option key={l.id} value={l.id}>{l.name} · {formatPhone(l.number)}</option>)}
              </select>
            </Field>
          </div>
        )}
        {/* Set up already: the test numbers stay as they are, and change on their own card. */}
        {!state && (
          <Field label="Test numbers" hint="The only numbers the app texts or hears from. One per line, up to 10: your own cell, or a teammate's who agreed.">
            <textarea className="input" rows={3} value={numbers} onChange={(e) => setNumbers(e.target.value)} placeholder="(470) 555-0101" />
          </Field>
        )}
        <FormError error={save.error} />
        <div className="row wrap" style={{ gap: 8 }}>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!lines && !hasKey}>Save</Button>
          {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        </div>
      </form>
    </section>
  );
}

function TestNumbersCard({ numbers, onChanged }: { numbers: string[]; onChanged: () => void }) {
  const [text, setText] = useState(numbersText(numbers));
  const save = useMutation({
    meta: { inline: true, success: "Test numbers saved" },
    mutationFn: () => api.put(`/apps/quo/test-numbers`, { test_numbers: text }),
    onSuccess: onChanged,
  });
  return (
    <section className="card card-pad stack-sm" aria-labelledby="quo-test-title">
      <h2 id="quo-test-title" className="section-title" style={{ fontSize: 16 }}>Test numbers</h2>
      <TestOnlyNote />
      <textarea className="input" rows={3} aria-label="Test numbers" value={text} onChange={(e) => { setText(e.target.value); save.reset(); }} />
      <FormError error={save.error} />
      <div className="row"><Button loading={save.isPending} onClick={() => save.mutate()} disabled={text === numbersText(numbers)}>Save test numbers</Button></div>
    </section>
  );
}

function IncomingCard({ state, onChanged }: { state: QuoState; onChanged: () => void }) {
  const set = useMutation({
    meta: { inline: true, success: "Replies to your test numbers now come into Messages" },
    mutationFn: () => api.post(`/apps/quo/webhook`),
    onSuccess: onChanged,
  });
  return (
    <section className="card card-pad stack-sm" aria-labelledby="quo-incoming" style={{ gap: 10 }}>
      <h2 id="quo-incoming" className="section-title" style={{ fontSize: 16 }}>Replies</h2>
      {state.webhook_set ? (
        <div className="row" style={{ gap: 10 }}><Icon name="check" size={16} /><span className="grow">Quo tells the app when a text comes in. Texts from your test numbers land in Messages; all others are dropped.</span></div>
      ) : (
        <>
          <span className="muted small">
            For replies to show here, Quo has to tell the app when a text comes in. This adds a webhook named "Outdoor Expert app (test)" to your Quo workspace. Nothing changes in the Quo
            app, and while it's test only, texts from customers are dropped the moment they arrive.
          </span>
          {state.reachable ? (
            <div className="row"><Button variant="primary" loading={set.isPending} onClick={() => set.mutate()}>Send replies to the app</Button></div>
          ) : (
            <span className="small" style={{ color: "var(--warning)", fontWeight: 600 }}>Quo can only reach a public https address, and this app doesn't have one yet.</span>
          )}
          <FormError error={set.error} />
        </>
      )}
    </section>
  );
}

function PretendCard({ numbers }: { numbers: string[] }) {
  const [from, setFrom] = useState(numbers[0] ?? "");
  const [body, setBody] = useState("");
  const send = useMutation({
    meta: { inline: true, success: "Filed as a text that came in. See Messages." },
    mutationFn: () => api.post(`/apps/quo/pretend`, { from, body }),
    onSuccess: () => setBody(""),
  });
  if (!numbers.length) return null;
  return (
    <section className="card card-pad stack-sm" aria-labelledby="quo-pretend">
      <h2 id="quo-pretend" className="section-title" style={{ fontSize: 16 }}>Pretend a reply</h2>
      <span className="muted small">Files a text as if one of your test numbers sent it, so you can see what happens without a phone.</span>
      <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); send.mutate(); }}>
        <div className="form-grid">
          <Field label="From">
            <select className="select" value={from} onChange={(e) => setFrom(e.target.value)}>
              {numbers.map((n) => <option key={n} value={n}>{formatPhone(n)}</option>)}
            </select>
          </Field>
          <Field label="They texted">
            <input className="input" value={body} onChange={(e) => { setBody(e.target.value); send.reset(); }} maxLength={1600} placeholder="Yes, let's book it" />
          </Field>
        </div>
        <FormError error={send.error} />
        <div className="row"><Button type="submit" loading={send.isPending} disabled={!body.trim()}>File it</Button></div>
      </form>
    </section>
  );
}
