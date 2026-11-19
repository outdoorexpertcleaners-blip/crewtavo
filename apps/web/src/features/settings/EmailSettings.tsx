/**
 * Settings → Email: send quotes, invoices, reminders, invites and team notifications from the
 * company's own address. Resend comes first (it works on every Railway plan) with a step-by-step
 * guide; Gmail, Zoho and the other mailboxes take an app password and need no DNS changes. Crewtavo
 * signs in and sends a test before saving. Connecting, changing or disconnecting it asks for the
 * person's own password, since the owners hear about Stripe changes by this email.
 *
 * Below it, the second brand's mailbox (Christmas lights, /api/email/lights): its clients' quotes,
 * invoices, receipts and reminders go from it, under the brand's name, while everything else stays
 * on the main one. Until it's connected, those go from the main one too.
 */
import { emailDomain, isPersonalMailDomain, MAIL_PRESETS, mailPreset, type MailPreset, type MailStep } from "@crewtavo/core/email";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import gmailLogo from "@/assets/apps/gmail.svg";
import googleLogo from "@/assets/apps/google.svg";
import icloudLogo from "@/assets/apps/icloud.svg";
import outlookLogo from "@/assets/apps/outlook.svg";
import resendLogo from "@/assets/apps/resend.svg";
import yahooLogo from "@/assets/apps/yahoo.svg";
import zohoLogo from "@/assets/apps/zoho.svg";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusPill } from "@/components/ui/StatusPill";
import { ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { PASSWORD_HINT } from "../apps/catalog";
import styles from "./EmailSettings.module.css";

interface Mailbox {
  preset: MailPreset["id"];
  kind: "smtp" | "resend";
  host?: string;
  port?: number;
  security?: "tls" | "starttls";
  username?: string;
  from_email: string;
  from_name?: string | null;
  status: "connected" | "error";
  last_error: string | null;
  connected_at: string | null;
}
interface EmailState {
  mailbox: Mailbox | null;
  fallback: "server" | "dev" | null;
  on_railway?: boolean;
  /** The Christmas lights brand's own mailbox, and the brand's name (null until proposal settings name it). */
  lights?: Mailbox | null;
  lights_name?: string | null;
}

/** Each provider's own logo on a white tile, like the Apps page (see assets/apps/README.md). */
const LOGOS: Partial<Record<MailPreset["id"], string>> = {
  gmail: gmailLogo,
  google_workspace: googleLogo,
  zoho: zohoLogo,
  microsoft: outlookLogo,
  yahoo: yahooLogo,
  icloud: icloudLogo,
  resend: resendLogo,
};
/** Wordmark-shaped logos get more width. */
const WIDE = new Set<MailPreset["id"]>(["zoho"]);

/** The provider's logo, or the mail icon for any other server. Decorative: its name is right beside it. */
export function ProviderMark({ preset }: { preset: MailPreset["id"] }) {
  const logo = LOGOS[preset];
  if (!logo) return <span className={styles.mark} aria-hidden="true"><Icon name="mail" size={16} /></span>;
  return (
    <span className={`${styles.mark} ${styles.logo}`} data-wide={WIDE.has(preset) || undefined} aria-hidden="true">
      <img src={logo} alt="" />
    </span>
  );
}

export function EmailSettings() {
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ["email-settings", session.company.id];
  const state = useQuery({ queryKey: key, queryFn: () => api.get<EmailState>("/email") });
  const [editing, setEditing] = useState(false);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: key });
    session.refresh();
  };
  const test = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ to: string }>("/email/test", {}),
    onSuccess: (r) => {
      toast.success(`Test email sent to ${r.to}`);
      queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const [askDisconnect, setAskDisconnect] = useState(false);
  const disconnect = useMutation({
    meta: { success: "Email disconnected", inline: true },
    mutationFn: (password: string) => api.delete("/email", undefined, { current_password: password }),
    onSuccess: () => {
      setAskDisconnect(false);
      refresh();
    },
  });

  if (state.error) return <div className="card"><ErrorState error={state.error} onRetry={() => state.refetch()} /></div>;
  if (state.isPending) return <div className="card card-pad stack"><Skeleton width="40%" /><Skeleton height={120} radius={8} /></div>;
  const { mailbox, fallback, on_railway: onRailway = false } = state.data;
  const preset = mailPreset(mailbox?.preset);

  return (
    <div className="stack">
      <div className="card card-pad stack-sm">
        <strong style={{ fontSize: 16 }}>Send email from your own address</strong>
        <span className="muted">
          Quotes, invoices, reminders, team invites and notifications go out from your business address, so clients see your name and replies land in your inbox. Resend is free for up to 100 emails a day, or you can use the email account you already have; there's nothing to buy.
        </span>
      </div>

      {mailbox && !editing ? (
        <div className="card card-pad stack">
          <div className={styles.status}>
            <ProviderMark preset={mailbox.preset} />
            <div className="grow">
              <div className={styles.address}>{mailbox.from_email}</div>
              <span className="muted small">{preset?.label ?? "Email"}{mailbox.kind === "smtp" ? ` · ${mailbox.host}` : ""}{mailbox.connected_at ? ` · connected ${timeAgo(mailbox.connected_at)}` : ""}</span>
            </div>
            <StatusPill label={mailbox.status === "connected" ? "Connected" : "Needs attention"} tone={mailbox.status === "connected" ? "good" : "danger"} />
          </div>
          {mailbox.status === "error" && (
            <div className="callout callout-danger">
              <Icon name="alert" size={20} />
              <div className="grow">
                <div>Emails aren't going out</div>
                <div className="small" style={{ fontWeight: 400 }}>
                  {mailbox.kind === "resend"
                    ? `${mailbox.last_error ?? "Resend stopped accepting the API key."} Once it's fixed in Resend, connect again with the new key.`
                    : `${mailbox.last_error ?? "The mail server stopped accepting the sign-in."} If you changed the account's password or deleted the app password, connect it again.`}
                </div>
              </div>
            </div>
          )}
          {preset?.dailyLimit && (
            <span className="muted small">
              {preset.kind === "resend" ? `Resend sends ${preset.dailyLimit}.` : `${preset.label} lets one mailbox send ${preset.dailyLimit}. For big email campaigns, Resend handles more.`}
            </span>
          )}
          <FormError error={test.error} />
          <div className="row wrap" style={{ gap: 8 }}>
            <Button icon="send" loading={test.isPending} onClick={() => test.mutate()}>Send me a test</Button>
            <Button icon="edit" onClick={() => setEditing(true)}>{mailbox.status === "error" ? "Connect again" : "Change"}</Button>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" loading={disconnect.isPending} onClick={() => setAskDisconnect(true)}>Disconnect</Button>
          </div>
          {askDisconnect && (
            <DisconnectWithPassword
              body={fallback === "server" ? "Emails will go out from the address whoever installed Crewtavo set up." : "Quotes, invoices and invites won't be emailed until you connect a mailbox again. You can still copy their links."}
              busy={disconnect.isPending}
              error={disconnect.error}
              onDisconnect={(password) => disconnect.mutate(password)}
              onClose={() => {
                setAskDisconnect(false);
                disconnect.reset();
              }}
            />
          )}
        </div>
      ) : (
        <ConnectForm existing={mailbox} onRailway={onRailway} onCancel={mailbox ? () => setEditing(false) : undefined} onSaved={() => { setEditing(false); refresh(); }} />
      )}

      {!mailbox && fallback && (
        <div className="callout callout-info">
          <Icon name="info" size={20} />
          <div className="grow small" style={{ fontWeight: 400 }}>
            {fallback === "dev" ? "Test mode: until you connect a mailbox, emails go to the local Mailpit inbox (http://localhost:56324)." : "Until you connect a mailbox, emails go out from the address whoever installed Crewtavo set up."}
          </div>
        </div>
      )}

      <LightsMailbox mailbox={state.data.lights ?? null} brand={state.data.lights_name ?? null} main={mailbox?.from_email ?? null} onRailway={onRailway} onChanged={refresh} />
    </div>
  );
}

/**
 * The second brand's mailbox (Christmas lights): connected like the main one, with its own test and
 * disconnect. Its clients' emails go from it under the brand's name; without it, from the main sender.
 */
function LightsMailbox({ mailbox, brand, main, onRailway, onChanged }: { mailbox: Mailbox | null; brand: string | null; main: string | null; onRailway: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [askDisconnect, setAskDisconnect] = useState(false);
  const title = brand ? `${brand} emails` : "Second brand: Christmas lights emails";
  const who = brand ?? "Christmas lights";
  const test = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ to: string }>("/email/lights/test", {}),
    onSuccess: (r) => toast.success(`Test email sent to ${r.to}`),
  });
  const disconnect = useMutation({
    meta: { success: `${who} email disconnected`, inline: true },
    mutationFn: (password: string) => api.delete("/email/lights", undefined, { current_password: password }),
    onSuccess: () => {
      setAskDisconnect(false);
      onChanged();
    },
  });

  return (
    <div className="stack" aria-labelledby="lights-email-title">
      <div className="card card-pad stack-sm">
        <strong id="lights-email-title" style={{ fontSize: 16 }}>{title}</strong>
        <span className="muted">
          Quotes, invoices, receipts and reminders for {who} clients go out from this mailbox, under {brand ?? "the lights brand's name"}, and replies land in it. Team invites, sign-in codes and everything else stay on the main email above.
          {!mailbox && ` Until you connect one, they go from ${main ?? "the main email"}.`}
        </span>
        {mailbox && !editing && (
          <div className="stack" style={{ marginTop: 8 }}>
            <div className={styles.status}>
              <ProviderMark preset={mailbox.preset} />
              <div className="grow">
                <div className={styles.address}>{mailbox.from_email}</div>
                <span className="muted small">{mailPreset(mailbox.preset)?.label ?? "Email"}{mailbox.from_name ? ` · as ${mailbox.from_name}` : brand ? ` · as ${brand}` : ""}{mailbox.connected_at ? ` · connected ${timeAgo(mailbox.connected_at)}` : ""}</span>
              </div>
              <StatusPill label={mailbox.status === "connected" ? "Connected" : "Needs attention"} tone={mailbox.status === "connected" ? "good" : "danger"} />
            </div>
            {mailbox.status === "error" && (
              <div className="callout callout-danger">
                <Icon name="alert" size={20} />
                <div className="grow small" style={{ fontWeight: 400 }}>
                  {`${mailbox.last_error ?? "The mail server stopped accepting the sign-in."} Until it's fixed, ${who} emails go from the main email. If you changed the account's password or deleted the app password, connect it again.`}
                </div>
              </div>
            )}
            <FormError error={test.error} />
            <div className="row wrap" style={{ gap: 8 }}>
              <Button icon="send" loading={test.isPending} onClick={() => test.mutate()}>Send me a test</Button>
              <Button icon="edit" onClick={() => setEditing(true)}>{mailbox.status === "error" ? "Connect again" : "Change"}</Button>
              <span style={{ flex: 1 }} />
              <Button variant="ghost" loading={disconnect.isPending} onClick={() => setAskDisconnect(true)}>Disconnect</Button>
            </div>
          </div>
        )}
        {!mailbox && !editing && (
          <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
            <Button icon="mail" onClick={() => setEditing(true)}>Connect a Gmail mailbox</Button>
          </div>
        )}
      </div>
      {editing && (
        <ConnectForm
          existing={mailbox}
          onRailway={onRailway}
          lights={{ name: brand }}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
      {askDisconnect && (
        <DisconnectWithPassword
          title={`Disconnect the ${who} email?`}
          body={`${who} emails will go out from ${main ?? "the main email"} instead.`}
          busy={disconnect.isPending}
          error={disconnect.error}
          onDisconnect={(password) => disconnect.mutate(password)}
          onClose={() => {
            setAskDisconnect(false);
            disconnect.reset();
          }}
        />
      )}
    </div>
  );
}

/** Disconnect's question, with the person's password; it's cleared once sent, and a wrong one says so here. */
function DisconnectWithPassword({ title = "Disconnect email?", body, busy, error, onDisconnect, onClose }: { title?: string; body: string; busy: boolean; error: unknown; onDisconnect: (password: string) => void; onClose: () => void }) {
  const [password, setPassword] = useState("");
  return (
    <Dialog open onClose={onClose} title={title} size="sm">
      <form
        className="stack-sm"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onDisconnect(password);
          setPassword("");
        }}
      >
        <div className="muted" style={{ marginTop: -6 }}>{body}</div>
        <Field label="Your Crewtavo password" hint={PASSWORD_HINT}>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" maxLength={200} required autoFocus />
        </Field>
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger-solid" loading={busy}>Disconnect</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** One choice in "How do you want to send email?". The recommended one is wider, with its reason. */
function ProviderButton({ preset: p, pressed, onChoose }: { preset: MailPreset; pressed: boolean; onChoose: (p: MailPreset) => void }) {
  return (
    <button type="button" className={styles.provider} data-featured={p.recommended || undefined} aria-pressed={pressed} onClick={() => onChoose(p)}>
      <ProviderMark preset={p.id} />
      <span className="grow">
        <span className={styles.providerName}>
          {p.label}
          {p.recommended && <span className="chip chip-green">Recommended</span>}
        </span>
        {p.summary && <small>{p.summary}</small>}
        {p.id === "other" && <small>Any SMTP server</small>}
      </span>
    </button>
  );
}

/**
 * Connecting a mailbox. `lights` is the Christmas lights brand's (PUT /email/lights): a mailbox you
 * already have (Gmail first), no Resend, and a sender name that's the brand's unless one is typed.
 */
function ConnectForm({ existing, onRailway, onSaved, onCancel, lights }: { existing: Mailbox | null; onRailway: boolean; onSaved: () => void; onCancel?: () => void; lights?: { name: string | null } }) {
  const session = useSession();
  const [presetId, setPresetId] = useState<MailPreset["id"] | null>(existing?.preset ?? (lights ? "gmail" : null));
  const preset = mailPreset(presetId);
  const [fromEmail, setFromEmail] = useState(existing?.from_email ?? (lights ? "" : session.profile.email ?? ""));
  const [fromName, setFromName] = useState(existing?.from_name ?? (lights ? "" : session.company.name));
  const [password, setPassword] = useState("");
  const [host, setHost] = useState(existing?.host ?? "");
  const [port, setPort] = useState(existing?.port ? String(existing.port) : "");
  const [security, setSecurity] = useState<"tls" | "starttls" | "">(existing?.security ?? "");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [advanced, setAdvanced] = useState(false);
  // The person's own Crewtavo password, which saving asks for; cleared once sent.
  const [currentPassword, setCurrentPassword] = useState("");
  const keepsPassword = Boolean(existing && existing.preset === presetId);
  const resend = preset?.kind === "resend";

  const choose = (p: MailPreset) => {
    setPresetId(p.id);
    setHost(p.host ?? "");
    setPort(p.port ? String(p.port) : "");
    setSecurity(p.security ?? "");
    setAdvanced(p.id === "other");
    // Resend sends from your own domain, never Gmail or Yahoo; a mailbox starts from your sign-in address.
    if (p.kind === "resend" && isPersonalMailDomain(emailDomain(fromEmail))) setFromEmail("");
    if (p.kind === "smtp" && !fromEmail) setFromEmail(session.profile.email ?? "");
    save.reset();
  };

  const save = useMutation({
    meta: { inline: true },
    mutationFn: () =>
      api.put<{ connected: boolean; test_sent_to: string | null }>(lights ? "/email/lights" : "/email", {
        preset: presetId,
        from_email: fromEmail.trim(),
        from_name: fromName.trim() || null,
        ...(preset?.kind === "resend"
          ? { api_key: password.trim() || undefined }
          : { password: password || undefined, host: host.trim() || undefined, port: port ? Number(port) : undefined, security: security || undefined, username: username.trim() || undefined }),
        current_password: currentPassword,
      }),
    onSuccess: (r) => {
      toast.success(lights ? `${lights.name ?? "Christmas lights"} email connected` : "Email connected", { description: r.test_sent_to ? `We sent a test email to ${r.test_sent_to}.` : undefined });
      onSaved();
    },
    onSettled: () => setCurrentPassword(""),
  });

  // Catch the two usual Resend slips before sending: a key copied only partly, and a Gmail-style address.
  const fromDomain = emailDomain(fromEmail);
  const keyProblem = resend && password.trim() && !password.trim().startsWith("re_") ? "Resend API keys start with re_. Copy the key itself (shown once, right after you create it), not its name or ID." : null;
  const fromProblem = resend && isPersonalMailDomain(fromDomain) ? `Resend can't send from a ${fromDomain} address. Use one on the domain you added in Resend, like office@yourcompany.com.` : null;

  return (
    <form className="card card-pad stack" onSubmit={(e: FormEvent) => { e.preventDefault(); if (!keyProblem && !fromProblem) save.mutate(); }}>
      <div className="stack-sm" role="group" aria-labelledby={lights ? "lights-provider-label" : "provider-label"}>
        {lights ? (
          <strong id="lights-provider-label">Which mailbox sends {lights.name ?? "Christmas lights"} emails?</strong>
        ) : (
          <>
            <strong id="provider-label">How do you want to send email?</strong>
            {MAIL_PRESETS.filter((p) => p.recommended).map((p) => <ProviderButton key={p.id} preset={p} pressed={presetId === p.id} onChoose={choose} />)}
            <span className={styles.or}>Or send from a mailbox you already have</span>
          </>
        )}
        <div className={styles.providers}>
          {MAIL_PRESETS.filter((p) => !p.recommended).map((p) => <ProviderButton key={p.id} preset={p} pressed={presetId === p.id} onChoose={choose} />)}
        </div>
        {onRailway && (
          <span className="muted small">
            {lights ? "Crewtavo is running on Railway. Railway's trial and Hobby plans block sending from a mailbox, so this needs Railway Pro." : "Crewtavo is running on Railway. Railway's trial and Hobby plans block sending from a mailbox, so choose Resend unless you're on Railway Pro."}
          </span>
        )}
      </div>

      {preset && (
        <>
          {preset.steps.some((s) => typeof s !== "string") ? (
            <ol className={styles.guide} aria-label={`Set up ${preset.label}`}>
              {(preset.steps as MailStep[]).map((s, i) => (
                <li key={s.title}>
                  <span className={styles.stepNumber} aria-hidden="true">{i + 1}</span>
                  <div className="stack-sm" style={{ gap: 4 }}>
                    <strong>{s.title}</strong>
                    <span className="muted">{s.text}</span>
                    {s.url && (
                      <a className="btn btn-sm" style={{ justifySelf: "start", marginTop: 4 }} href={s.url} target="_blank" rel="noreferrer">
                        <Icon name="external" size={14} />{s.urlLabel ?? "Open"}
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="callout">
              <Icon name="info" size={20} />
              <div className="grow stack-sm" style={{ fontWeight: 400 }}>
                <ol className={styles.steps}>{preset.steps.map((s) => <li key={String(s)}>{String(s)}</li>)}</ol>
                {preset.helpUrl && (
                  <a className="btn btn-sm" style={{ justifySelf: "start" }} href={preset.helpUrl} target="_blank" rel="noreferrer">
                    <Icon name="external" size={14} />{preset.helpLabel ?? "Open help"}
                  </a>
                )}
                {preset.note && <span className="muted small">{preset.note}</span>}
              </div>
            </div>
          )}

          {resend ? (
            <div className="form-grid">
              <Field label="API key" error={keyProblem} hint={keepsPassword ? "Leave blank to keep the saved one." : "From step 3. It starts with re_."}>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required={!keepsPassword} maxLength={500} autoComplete="off" spellCheck={false} placeholder="re_…" />
              </Field>
              <Field label="Send from" error={fromProblem} hint="Any address on the domain you added in Resend.">
                <input className="input" type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} required maxLength={200} autoComplete="email" placeholder="office@yourcompany.com" />
              </Field>
            </div>
          ) : (
            <div className="form-grid">
              <Field label="Email address" hint="The mailbox you're connecting. Emails come from this address.">
                <input className="input" type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} required maxLength={200} autoComplete="email" />
              </Field>
              <Field label={preset.passwordLabel} hint={keepsPassword ? "Leave blank to keep the saved one." : preset.id !== "other" && preset.id !== "microsoft" ? "Not your regular password." : undefined}>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required={!keepsPassword} maxLength={500} autoComplete="new-password" spellCheck={false} />
              </Field>
            </div>
          )}
          <Field label="Sender name" optional={Boolean(lights)} hint={lights ? `What clients see as who it's from. Leave blank to use ${lights.name ?? "the lights brand's name from proposal settings"}.` : "What clients see as who it's from."}>
            <input className="input" value={fromName} onChange={(e) => setFromName(e.target.value)} maxLength={120} placeholder={lights?.name ?? undefined} />
          </Field>

          {preset.kind === "smtp" && (
            <>
              {preset.id !== "other" && (
                <button type="button" className="link-btn row" style={{ justifySelf: "start", gap: 4 }} onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
                  <Icon name={advanced ? "chevronDown" : "chevronRight"} size={14} />Server settings
                </button>
              )}
              {advanced && (
                <div className="form-grid">
                  <Field label="Outgoing mail (SMTP) server"><input className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" required maxLength={200} spellCheck={false} /></Field>
                  <Field label="Port"><input className="input" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="465" required maxLength={5} /></Field>
                  <Field label="Security">
                    <select className="select" value={security} onChange={(e) => setSecurity(e.target.value as "tls" | "starttls")} required>
                      <option value="tls">SSL/TLS (usually port 465)</option>
                      <option value="starttls">STARTTLS (usually port 587)</option>
                    </select>
                  </Field>
                  <Field label="Sign-in name" optional hint="Usually the email address."><input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={fromEmail} maxLength={200} spellCheck={false} /></Field>
                </div>
              )}
            </>
          )}

          <Field label="Your Crewtavo password" hint={PASSWORD_HINT}>
            <input className="input" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required maxLength={200} autoComplete="current-password" />
          </Field>

          <FormError error={save.error} />
          <div className="form-actions">
            <FormChecks />
            {onCancel && <Button onClick={onCancel}>Cancel</Button>}
            <Button type="submit" variant="primary" icon="check" loading={save.isPending}>{save.isPending ? "Connecting and sending a test…" : "Connect"}</Button>
          </div>
        </>
      )}
    </form>
  );
}
