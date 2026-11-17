/**
 * The Big Proposal (Outdoor Expert Cleaners' modification; core proposal.ts): an open quote's Client
 * Hub page laid out as Customer Factor's "Big Proposal" was, one look per brand (washing or lights,
 * from its lines). A fixed bar in the brand's color with Print, Accept and Decline; the business's
 * letterhead; a menu of sections (Introduction, Insurance, Photos, Testimonials, Agreement, Proposal,
 * In Closing) and the section itself, with arrows to the one before and after.
 *
 * Accept asks for up to three preferred dates first (POST /hub/:token/preferred-dates, a note for the
 * office), then shows Crewtavo's own approval (options, agreement, signature, deposit), so signing
 * works exactly as it does without the Big Proposal. Decline marks the quote lost (POST
 * /hub/:token/decline). An approved, declined or expired quote shows a short card instead.
 */
import { fillProposal, firstName, proposalBrand, proposalDate, type ProposalBrand } from "@crewtavo/core/proposal";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { formatMoney, todayIn } from "@/lib/format";
import { sanitizeHtml } from "@/lib/html";
import type { HubBrandProposal, QuoteView } from "./document";
import s from "./BigProposal.module.css";

/** Where this modified version's source code is, as its license asks of a version others use over the web. */
export const SOURCE_URL = "https://github.com/outdoorexpertcleaners-blip/crewtavo";

type Fetch = <T>(path: string, body?: unknown) => Promise<T>;
type Section = "intro" | "insurance" | "photos" | "testimonials" | "agreement" | "proposal" | "closing";

const WAITING = ["sent", "changes_requested"];

/** The proposal's look for this quote, or null when the business has it off. */
export function bigProposalFor(data: QuoteView): { brand: ProposalBrand; look: HubBrandProposal } | null {
  const bp = data.company.big_proposal;
  if (!bp) return null;
  const brand = proposalBrand(data.quote.lines);
  return { brand, look: bp[brand] };
}

export function BigProposal({ token, data, look, hubFetch, onChanged, onPrint, approval }: {
  token: string;
  data: QuoteView;
  look: HubBrandProposal;
  hubFetch: Fetch;
  onChanged: () => void;
  onPrint: () => void;
  /** Crewtavo's own approval (or, once signed, the signed quote), shown after Accept. */
  approval: ReactNode;
}) {
  const q = data.quote;
  const company = look.name || data.company.name;
  const phone = look.phone || data.company.phone || "";
  const email = look.email || data.company.email || "";
  const address = look.address.length ? look.address : (data.company.address ?? []);
  const logo = look.logo || data.company.logo || null;
  const client = q.client?.display_name ?? "";
  const fill = (html: string) => sanitizeHtml(fillProposal(html, { first_name: firstName(client), client_name: client, company, phone, email, owner: look.owner }));
  const today = todayIn(data.company.timezone || "America/New_York");
  const waiting = WAITING.includes(q.status);
  const expired = waiting && Boolean(q.valid_until) && q.valid_until!.slice(0, 10) < today;
  const preview = Boolean(data.preview);

  const sections: Array<{ id: Section; title: string }> = [
    { id: "intro", title: "Introduction" },
    { id: "insurance", title: "Insurance" },
    { id: "photos", title: look.photos_title || "Photos" },
    { id: "testimonials", title: "Testimonials" },
    ...(look.agreement_html.trim() ? [{ id: "agreement" as const, title: "Agreement" }] : []),
    { id: "proposal", title: "Proposal" },
    { id: "closing", title: "In Closing" },
  ];
  const [section, setSection] = useState<Section>("intro");
  const [signing, setSigning] = useState(false);
  const [dialog, setDialog] = useState<"accept" | "decline" | null>(null);
  const top = useRef<HTMLDivElement>(null);
  const at = sections.findIndex((x) => x.id === section);
  const go = (id: Section) => {
    setSigning(false);
    setSection(id);
    if (window.innerWidth < 992) top.current?.scrollIntoView({ block: "start" });
    else window.scrollTo({ top: 0 });
  };

  const style = { ["--bp-brand" as string]: look.color };
  const footer = (
    <p className={s.foot}>
      <a href={SOURCE_URL} target="_blank" rel="noreferrer">Source code</a>
    </p>
  );

  // Approved (or a job already): the card, then the signed quote with its deposit to pay.
  if (q.status === "approved" || q.status === "converted") {
    return (
      <div className={s.page} style={style}>
        <Solo logo={logo} company={company} number={q.number} client={client} state="ok" label="Accepted">
          Thank you! Your proposal has been accepted. We'll be in touch shortly to confirm your appointment. Questions? Call our office at {phone}.
        </Solo>
        <div className={s.after}>{approval}</div>
        {footer}
      </div>
    );
  }
  if (q.status === "lost" || q.status === "archived") {
    return (
      <div className={s.page} style={style}>
        <Solo logo={logo} company={company} number={q.number} client={client} state="no" label="Declined">
          This proposal has been declined. If you change your mind or would like an updated proposal, please call our office at {phone}.
        </Solo>
        {footer}
      </div>
    );
  }
  if (expired) {
    return (
      <div className={s.page} style={style}>
        <Solo logo={logo} company={company} number={q.number} client={client} state="no" label="Expired">
          This Proposal expired on {proposalDate(q.valid_until!)}. Please call our office at {phone} or{" "}
          {email ? <a href={`mailto:${email}`}>send us an email</a> : "send us an email"} for an updated proposal.
        </Solo>
        {footer}
      </div>
    );
  }

  return (
    <div className={s.page} style={style}>
      <nav className={s.bar} aria-label="Proposal actions">
        <button type="button" onClick={onPrint} aria-label="Print or save as PDF">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1h8v3H4zM1 5h14a1 1 0 0 1 1 1v5h-3v4H3v-4H0V6a1 1 0 0 1 1-1zm4 6v3h6v-3zm8-4.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z" /></svg>
        </button>
        {waiting && (
          <>
            <span className={s.sep}><button type="button" onClick={() => setDialog("accept")}>Accept</button></span>
            <button type="button" onClick={() => setDialog("decline")}>Decline</button>
          </>
        )}
      </nav>
      <div className={s.wrap}>
        {preview && <div className={s.preview}>Preview: this is what your client sees.</div>}
        <header className={`${s.shadow} ${s.head}`}>
          <div>
            <h1>{company}</h1>
            <div className={s.addr}>
              {[...address, phone, email].filter(Boolean).map((line, i) => <div key={i}>{line}</div>)}
            </div>
          </div>
          {logo && <img src={logo} alt={`${company} logo`} />}
        </header>
        <div className={s.cols}>
          <aside className={`${s.shadow} ${s.side}`}>
            <div className={s.for}>Proposal #{q.number} for:<br />{client}</div>
            {look.show_expiry && q.valid_until && <div className={s.exp}>Expires: {proposalDate(q.valid_until)}</div>}
            <ul className={s.menu}>
              {sections.map((x) => (
                <li key={x.id}><button type="button" aria-current={!signing && x.id === section} onClick={() => go(x.id)}>{x.title}</button></li>
              ))}
            </ul>
          </aside>
          <section className={`${s.shadow} ${s.main}`} ref={top} aria-live="polite">
            {signing ? (
              <>
                <div className={s.ttl}>
                  <button type="button" className={`${s.chev} ${s.prev}`} onClick={() => setSigning(false)} aria-label="Back to the proposal"><Chevron left /></button>
                  <h2>Accept</h2>
                </div>
                <div className={s.approval}>{approval}</div>
              </>
            ) : (
              <>
                <div className={s.ttl}>
                  {at > 0 && <button type="button" className={`${s.chev} ${s.prev}`} onClick={() => go(sections[at - 1]!.id)} aria-label="Previous section"><Chevron left /></button>}
                  <h2>{sections[at]?.title}</h2>
                  {at < sections.length - 1 && <button type="button" className={`${s.chev} ${s.next}`} onClick={() => go(sections[at + 1]!.id)} aria-label="Next section"><Chevron /></button>}
                </div>
                <div className={s.content}>
                  <SectionBody id={section} look={look} data={data} fill={fill} />
                </div>
              </>
            )}
          </section>
        </div>
        {footer}
      </div>
      {dialog === "accept" && (
        <AcceptDialog
          token={token}
          company={company}
          number={q.number}
          hubFetch={hubFetch}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setSigning(true);
            top.current?.scrollIntoView({ block: "start" });
          }}
        />
      )}
      {dialog === "decline" && <DeclineDialog token={token} number={q.number} preview={preview} hubFetch={hubFetch} onClose={() => setDialog(null)} onDone={onChanged} />}
    </div>
  );
}

function Chevron({ left = false }: { left?: boolean }) {
  return (
    <svg viewBox="0 0 13 15" aria-hidden="true">
      <path d={left ? "M10.5 1.2 12 2.7 6.9 7.5 12 12.3l-1.5 1.5L4 7.5z" : "M2.5 1.2 1 2.7l5.1 4.8L1 12.3l1.5 1.5L9 7.5z"} />
    </svg>
  );
}

/** A short card in place of the proposal: approved, declined or expired, as CF showed an expired one. */
function Solo({ logo, company, number, client, state, label, children }: { logo: string | null; company: string; number: number; client: string; state: "ok" | "no"; label: string; children: ReactNode }) {
  return (
    <div className={s.solo}>
      <div className={s.soloLogo}>{logo ? <img src={logo} alt={`${company} logo`} /> : <strong>{company}</strong>}</div>
      <div className={s.soloBox}>
        <div className={s.for}>Proposal #{number} for:<br />{client}</div>
        <div className={state === "ok" ? s.ok : s.exp}>{label}</div>
        <p className={s.msg}>{children}</p>
      </div>
    </div>
  );
}

function SectionBody({ id, look, data, fill }: { id: Section; look: HubBrandProposal; data: QuoteView; fill: (html: string) => string }) {
  switch (id) {
    case "intro":
      return <div className={s.rich} dangerouslySetInnerHTML={{ __html: fill(look.intro_html) }} />;
    case "closing":
      return <div className={s.rich} dangerouslySetInnerHTML={{ __html: fill(look.closing_html) }} />;
    case "agreement":
      return <div className={`${s.rich} ${s.agreement}`} dangerouslySetInnerHTML={{ __html: fill(look.agreement_html) }} />;
    case "insurance":
      return look.insurance_picture ? (
        <div className={s.coi}><img src={look.insurance_picture} alt="Certificate of insurance" /></div>
      ) : (
        <p className={s.muted}>Our certificate of insurance is available on request.</p>
      );
    case "photos":
      return (
        <>
          {look.photos_caption && <p>{look.photos_caption}</p>}
          {look.photos.length ? (
            <div className={s.photos}>{look.photos.map((src) => <img key={src} src={src} alt="A recent project" loading="lazy" />)}</div>
          ) : (
            <p className={s.muted}>Photos of our recent projects are coming soon.</p>
          )}
        </>
      );
    case "testimonials":
      return (
        <>
          {look.testimonials_html.trim() && <div className={s.rich} dangerouslySetInnerHTML={{ __html: fill(look.testimonials_html) }} />}
          {look.testimonials_picture && <div className={s.reviews}><img src={look.testimonials_picture} alt="What our customers say" /></div>}
          {!look.testimonials_html.trim() && !look.testimonials_picture && <p className={s.muted}>Ask us for references from customers near you.</p>}
        </>
      );
    case "proposal":
      return <ProposalTable data={data} look={look} />;
  }
}

/** The price: who it's for and where, each service with its description, the total and the deposit. */
function ProposalTable({ data, look }: { data: QuoteView; look: HubBrandProposal }) {
  const q = data.quote;
  const p = q.property;
  const cityLine = p ? [p.city, [p.region, p.postal_code].filter(Boolean).join("  ")].filter(Boolean).join(", ") : "";
  // The lines on the option shown (every line, without options), as the client would sign it today.
  const lines = q.lines.filter((l) => (!l.option_id || l.option_id === q.option_id) && (!l.optional || l.selected));
  const deposit = Number(q.deposit_amount) || 0;
  return (
    <div className={s.pt}>
      <div className={s.who}>
        <div>Presented To:<br />{q.client?.display_name}{p && <><br />{p.line1}<br />{cityLine}</>}</div>
        {p && <div>Service location:<br />{p.line1}<br />{cityLine}</div>}
      </div>
      <div className={s.scroll}>
        <table className={s.lines}>
          <thead><tr><th>Description</th><th>Amount</th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <LineRows key={l.id ?? i} name={l.name} amount={l.quantity * l.unit_price} quantity={l.quantity} unit={l.unit} unitPrice={l.unit_price} description={l.description} />
            ))}
          </tbody>
        </table>
      </div>
      <table className={s.tot}>
        <tbody>
          {Number(q.discount_amount) > 0 && <tr><td>Discount</td><td>-{formatMoney(Number(q.discount_amount))}</td></tr>}
          {Number(q.tax_amount) > 0 && <tr><td>Tax</td><td>{formatMoney(Number(q.tax_amount))}</td></tr>}
          <tr><td>Total</td><td>{formatMoney(q.total ?? 0)}</td></tr>
          {deposit > 0 && <tr><td>Deposit Due{q.deposit_percent ? ` (${Number(q.deposit_percent)}%)` : ""}</td><td>{formatMoney(deposit)}</td></tr>}
        </tbody>
      </table>
      {look.terms_url && <a className={s.terms} href={look.terms_url} target="_blank" rel="noreferrer">For Terms and Conditions Click Here</a>}
    </div>
  );
}

function LineRows({ name, amount, quantity, unit, unitPrice, description }: { name: string; amount: number; quantity: number; unit: string; unitPrice: number; description: string | null }) {
  return (
    <>
      <tr>
        <td><span className={s.nm}>{name}</span>{quantity !== 1 && <span className={s.qty}> ({quantity} {unit} × {formatMoney(unitPrice)})</span>}</td>
        <td className={s.amt}>{formatMoney(amount)}</td>
      </tr>
      {description && <tr><td className={s.desc} colSpan={2}>{description}</td></tr>}
    </>
  );
}

const TIMES = ["8:00", "9:00", "10:00", "11:00", "12:00", "1:00", "2:00", "3:00", "4:00", "5:00"];

/** Accept's first step: when they'd like it done (or no preference) and anything to know. */
function AcceptDialog({ token, company, number, hubFetch, onClose, onDone }: { token: string; company: string; number: number; hubFetch: Fetch; onClose: () => void; onDone: () => void }) {
  const id = useId();
  const [dates, setDates] = useState([{ day: "", time: "", ampm: "AM" }, { day: "", time: "", ampm: "AM" }, { day: "", time: "", ampm: "AM" }]);
  const [none, setNone] = useState(false);
  const [notes, setNotes] = useState("");
  const [problem, setProblem] = useState("");
  const send = useMutation({
    mutationFn: () =>
      hubFetch(`${token}/preferred-dates`, {
        dates: dates.filter((d) => d.day).map((d) => `${proposalDate(d.day)}${d.time ? ` ${d.time} ${d.ampm}` : ""}`),
        no_preference: none,
        notes: notes.trim(),
      }),
    onSuccess: onDone,
    onError: (e) => setProblem(e instanceof ApiError ? e.message : "That didn't go through. Try again."),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!none && !dates.some((d) => d.day)) return setProblem("Please pick at least one preferred date, or tick “I have no date preference”.");
    setProblem("");
    send.mutate();
  };
  const set = (i: number, key: "day" | "time" | "ampm", value: string) => setDates((all) => all.map((d, j) => (j === i ? { ...d, [key]: value } : d)));
  return (
    <Dialog title={`Accept Proposal #${number}`} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p className={s.lead}>Thank you for choosing {company}! Please let us know up to three dates and times that work best for you. Next, you'll review and sign.</p>
        {dates.map((d, i) => (
          <div className={s.row} key={i}>
            <label htmlFor={`${id}-d${i}`}>Preferred date {i + 1}</label>
            <input id={`${id}-d${i}`} type="date" value={d.day} min={new Date().toISOString().slice(0, 10)} onChange={(e) => set(i, "day", e.target.value)} />
            <select aria-label={`Time for date ${i + 1}`} value={d.time} onChange={(e) => set(i, "time", e.target.value)}>
              <option value="">Time</option>
              {TIMES.map((t) => <option key={t}>{t}</option>)}
            </select>
            <select aria-label={`AM or PM for date ${i + 1}`} value={d.ampm} onChange={(e) => set(i, "ampm", e.target.value)}>
              <option>AM</option>
              <option>PM</option>
            </select>
          </div>
        ))}
        <label className={s.check}><input type="checkbox" checked={none} onChange={(e) => setNone(e.target.checked)} /> I have no date preference</label>
        <label htmlFor={`${id}-notes`} className={s.label}>Notes</label>
        <textarea id={`${id}-notes`} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} placeholder="Gate code, pets, anything we should know" />
        <div className={s.err} role="alert">{problem}</div>
        <div className={s.acts}>
          <button type="button" className={s.ghost} onClick={onClose}>Cancel</button>
          <button type="submit" className={s.btn} disabled={send.isPending}>{send.isPending ? "Saving…" : "Continue"}</button>
        </div>
      </form>
    </Dialog>
  );
}

function DeclineDialog({ token, number, preview, hubFetch, onClose, onDone }: { token: string; number: number; preview: boolean; hubFetch: Fetch; onClose: () => void; onDone: () => void }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState("");
  const send = useMutation({
    mutationFn: () => hubFetch(`${token}/decline`, { reason: reason.trim() || undefined }),
    onSuccess: onDone,
    onError: (e) => setProblem(e instanceof ApiError ? e.message : "That didn't go through. Try again."),
  });
  return (
    <Dialog title={`Decline Proposal #${number}`} onClose={onClose} narrow>
      <p className={s.lead}>Are you sure you want to decline this proposal?</p>
      <label htmlFor={`${id}-why`} className={s.label}>Anything we could do better? (optional)</label>
      <textarea id={`${id}-why`} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
      <div className={s.err} role="alert">{preview ? "This is a preview, so declining here does nothing." : problem}</div>
      <div className={s.acts}>
        <button type="button" className={s.ghost} onClick={onClose}>Cancel</button>
        <button type="button" className={s.btn} disabled={send.isPending || preview} onClick={() => send.mutate()}>{send.isPending ? "Sending…" : "Decline"}</button>
      </div>
    </Dialog>
  );
}

function Dialog({ title, onClose, narrow = false, children }: { title: string; onClose: () => void; narrow?: boolean; children: ReactNode }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("input, textarea, button")?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className={s.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={s.pop} role="dialog" aria-modal="true" aria-labelledby={id} ref={box} style={narrow ? { width: 460 } : undefined}>
        <header id={id}>{title}</header>
        <button type="button" className={s.x} onClick={onClose} aria-label="Close">×</button>
        <div className={s.bd}>{children}</div>
      </div>
    </div>
  );
}
