/** Public booking / request form: /book/:company/:form (?embed=1 inside an iframe; see embed.ts). No account needed. */
import { textDisclosure } from "@crewtavo/core/marketing";
import { slotLabel, slotTime, type OpenSlot } from "@crewtavo/core/slots";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { PrivacyFooter } from "@/components/ui/PrivacyLink";
import { Skeleton } from "@/components/ui/Skeleton";
import { publicFetch, useTurnstile } from "@/lib/publicApi";
import { formatPhoneTyping } from "@/lib/validate";
import { fileSize, isAbort, PLAN_MAX_BYTES, TooLargeError, uploadToLink } from "../plans/plans";
import { postToHost } from "./embed";

/** The most files a request can bring (the API's limit too). */
const MAX_FILES = 10;
const isFileQuestion = (q: Question) => q.type === "files" || q.type === "photos";
/**
 * Where the keyboard goes when the form can't be sent yet: the first thing to fix, in the form's
 * order. A field says so itself (:invalid, aria-invalid); a group of choices, the times and a file
 * question are marked data-invalid on what holds them, and their first button or their file picker
 * takes the focus. What's wrong is said beside each in a role="alert", so it's read out as well.
 */
export const FIRST_PROBLEM = ":invalid:not(form):not(fieldset), [aria-invalid='true'], [data-invalid='true'] button:not(:disabled), [data-invalid='true'] input:not(:disabled)";

/** What the field says when it's left empty: why it's needed, in the business's voice. */
const NAME_NEEDED = "Enter your name, so we know who to reply to.";
const ADDRESS_NEEDED = "Enter the address where the work is.";
/** A time picked on the form: booked, or asked for and waiting on the business. `calendar` is an add-to-calendar file's text. */
interface Booked { status: "booked" | "asked"; starts_at: string; ends_at: string; emailed: boolean; texted: boolean; calendar?: string }
interface Sent { reference: number; booking?: Booked; uploads?: Array<{ name: string; path: string; token: string } | null>; files_token?: string }
/** What a form with "Let clients pick a time" on says about its times (the openings come a week at a time). */
interface Booking { timezone: string; timezone_label: string; minutes: number; window_min: number; needs_ok: boolean; needs_postal_code: boolean; first: string; last: string }
interface Week { from: string; to: string; first: string; last: string; slots: OpenSlot[] }
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const visitLength = (minutes: number) => (minutes < 60 ? `${minutes} minutes` : minutes % 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : minutes === 60 ? "an hour" : `${minutes / 60} hours`);

interface Question {
  key: string;
  label: string;
  type: "address" | "text" | "long_text" | "number" | "yes_no" | "choice" | "multi_choice" | "photos" | "files";
  required: boolean;
  options?: string[];
}
interface FormView {
  /** `texts`: the business can text, so the phone box says what giving a number agrees to. */
  company: { name: string; phone: string | null; texts?: boolean; privacy_url?: string | null };
  form: { name: string; kind: string; questions: Question[] };
  booking?: Booking;
}

export function BookingFormPage() {
  const { company = "", form = "" } = useParams();
  const [params] = useSearchParams();
  const embedded = params.get("embed") === "1";
  const page = useFitFrame(embedded);
  const path = `/public/forms/${encodeURIComponent(company)}/${encodeURIComponent(form)}`;
  const view = useQuery({ queryKey: ["booking", company, form], retry: false, queryFn: () => publicFetch<FormView>(path) });
  const [contact, setContact] = useState({ name: "", email: "", phone: "", line1: "", city: "", postal_code: "" });
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  // Files picked for "Files" and "Photos" questions; they go up after the request is in.
  const [files, setFiles] = useState<Record<string, File[]>>({});
  const [sending, setSending] = useState<{ done: number; total: number; progress: number } | null>(null);
  const fileCount = Object.values(files).reduce((n, list) => n + list.length, 0);
  const [touched, setTouched] = useState(false);
  // Each try at sending with something missing: the keyboard goes to the first thing to fix, once the form says what's wrong.
  const [refused, setRefused] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (refused) formRef.current?.querySelector<HTMLElement>(FIRST_PROBLEM)?.focus();
  }, [refused]);
  // A promo code from the link (?promo=SPRING10) or typed in, checked before sending.
  const [promo, setPromo] = useState({ code: (params.get("promo") ?? "").toUpperCase().slice(0, 24), offer: "" as string, open: Boolean(params.get("promo")) });
  const checkPromo = useMutation({
    mutationFn: (code: string) => publicFetch<{ code: string; offer: string }>(`${path}/promo`, { code }),
    onSuccess: (r) => setPromo((p) => ({ ...p, code: r.code, offer: r.offer })),
  });
  useEffect(() => {
    if (view.data && promo.code && !promo.offer && !checkPromo.isPending && !checkPromo.isError && !checkPromo.isSuccess) checkPromo.mutate(promo.code);
  }, [view.data]);
  const turnstile = useTurnstile(Boolean(view.data));
  const questions = (view.data?.form.questions ?? []).filter((q) => q.type !== "address");
  const unanswered = questions.filter(
    (q) => q.required && (isFileQuestion(q) ? !files[q.key]?.length : q.type === "multi_choice" ? !(answers[q.key] as string[] | undefined)?.length : !String(answers[q.key] ?? "").trim()),
  );
  const noContact = !contact.email.trim() && !contact.phone.trim();
  // The time picked, on a form that offers times. With nothing open online it's sent as a plain request.
  const booking = view.data?.booking;
  const [time, setTime] = useState<OpenSlot | null>(null);
  const [noneOpen, setNoneOpen] = useState(false);
  const [turnedAway, setTurnedAway] = useState(0);
  const noTime = Boolean(booking) && !time && !noneOpen;

  useEffect(() => {
    if (view.data) document.title = `${view.data.form.name} · ${view.data.company.name}`;
  }, [view.data]);

  const submit = useMutation({
    mutationFn: async () => {
      const picked = Object.entries(files).flatMap(([question, list]) => list.map((file) => ({ question, file })));
      const sent = await publicFetch<Sent>(path, {
        name: contact.name.trim(),
        email: contact.email.trim() || undefined,
        phone: contact.phone.trim() || undefined,
        address: { line1: contact.line1.trim(), city: contact.city.trim() || undefined, postal_code: contact.postal_code.trim() || undefined },
        // Which files came with each question, by name.
        answers: { ...answers, ...Object.fromEntries(Object.entries(files).filter(([, list]) => list.length).map(([key, list]) => [key, list.map((f) => f.name)])) },
        files: picked.map(({ question, file }) => ({ question, name: file.name, size: file.size, type: file.type || undefined })),
        promo_code: promo.offer ? promo.code : undefined,
        // Where the lead came from, when the link says (?source=Facebook).
        source: params.get("source")?.slice(0, 60) || undefined,
        turnstile_token: turnstile.token || undefined,
        starts_at: (booking && time?.starts_at) || undefined,
      });
      // The request is in. Now the files, one at a time, each on its own one-time link.
      const failed: string[] = [];
      const uploaded: Array<{ path: string; name: string }> = [];
      const links = sent.uploads ?? [];
      for (const [i, { file }] of picked.entries()) {
        const link = links[i]?.name === file.name ? links[i] : undefined;
        if (!link) {
          failed.push(file.name);
          continue;
        }
        setSending({ done: i, total: picked.length, progress: 0 });
        try {
          uploaded.push({ path: await uploadToLink(link, file, (progress) => setSending({ done: i, total: picked.length, progress })).promise, name: file.name });
        } catch (error) {
          if (!isAbort(error)) failed.push(file.name);
        }
      }
      let recorded = 0;
      if (uploaded.length && sent.files_token) {
        recorded = (await publicFetch<{ added: number }>(`${path}/files`, { files_token: sent.files_token, uploaded: uploaded.map((u) => u.path) }).catch(() => ({ added: 0 }))).added;
        // Sent but not recorded: as good as not sent.
        if (!recorded) failed.push(...uploaded.map((u) => u.name));
      }
      return { reference: sent.reference, booking: sent.booking, sentFiles: recorded, failed };
    },
    onSettled: () => setSending(null),
    // The time went to someone else meanwhile (or they have a booking already): they pick again from what's open now.
    onError: (error) => {
      if (!booking || (error as { status?: number }).status !== 409) return;
      setTime(null);
      setTurnedAway((n) => n + 1);
    },
    onSuccess: () => (embedded ? postToHost({ crewtavo: "top" }) : window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })),
  });
  const set = (key: keyof typeof contact) => (e: { target: { value: string } }) => setContact({ ...contact, [key]: e.target.value });

  return (
    // Embedded, just enough room around the card for its shadow; index.html clears the page's own background.
    <div ref={page} className="public-page" style={embedded ? { padding: "1px 1px 4px", background: "transparent", minHeight: 0 } : undefined}>
      <div className="public-wrap" style={{ maxWidth: 640 }}>
        {view.isPending && <div className="card card-pad stack-sm"><Skeleton width="40%" height={12} /><Skeleton width="65%" height={26} /><Skeleton height={300} radius={8} /></div>}
        {view.error && (
          <div className="card"><div className="empty-state error-state"><span className="empty-icon"><Icon name="search" size={24} /></span><h3>This form isn't available</h3><p>{(view.error as Error).message}</p></div></div>
        )}
        {view.data && submit.data && (
          <div className="card card-pad stack-sm" style={{ textAlign: "center", justifyItems: "center", padding: 32 }}>
            <span className="success-mark"><Icon name="check" size={30} strokeWidth={3} /></span>
            <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "var(--tracking-display)" }}>{submit.data.booking?.status === "booked" ? `You're booked, ${contact.name.trim().split(" ")[0]}` : `Thanks, ${contact.name.trim().split(" ")[0]}`}</h1>
            {submit.data.booking && booking ? (
              <BookedNote sent={submit.data.booking} booking={booking} company={view.data.company.name} reference={submit.data.reference} />
            ) : (
              <p style={{ margin: 0 }}>{view.data.company.name} got your request (reference #{submit.data.reference}) and will be in touch soon.</p>
            )}
            {submit.data.sentFiles > 0 && <p className="muted" style={{ margin: 0 }}>{submit.data.sentFiles === 1 ? "Your file came with it." : `Your ${submit.data.sentFiles} files came with it.`}</p>}
            {submit.data.failed.length > 0 && (
              <div className="callout callout-warning" style={{ textAlign: "left", width: "100%" }}>
                <Icon name="alert" size={20} />
                <div className="grow">
                  <div>{submit.data.failed.length === 1 ? "One file didn't come through:" : `${submit.data.failed.length} files didn't come through:`} {submit.data.failed.join(", ")}</div>
                  <div className="small" style={{ fontWeight: 400 }}>Your request is in. Email {submit.data.failed.length === 1 ? "it" : "them"} to {view.data.company.name}{view.data.company.phone ? `, or call ${view.data.company.phone}` : ""}.</div>
                </div>
              </div>
            )}
            {view.data.company.phone && <p className="muted" style={{ margin: 0 }}>Questions? Call <a href={`tel:${view.data.company.phone}`}>{view.data.company.phone}</a>.</p>}
          </div>
        )}
        {view.data && !submit.data && (
          <form
            ref={formRef}
            className="card card-pad stack"
            noValidate
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setTouched(true);
              const form = e.currentTarget as HTMLFormElement;
              if (!form.checkValidity() || unanswered.length || noContact || noTime) {
                // After this render, when a missing time, choice or file is marked: the effect above moves the focus.
                setRefused((n) => n + 1);
                return;
              }
              submit.mutate();
            }}
          >
            <div>
              {!embedded && <div className="muted strong">{view.data.company.name}</div>}
              <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "var(--tracking-display)" }}>{view.data.form.name}</h1>
            </div>
            <div className="form-grid">
              <Field label="Your name" requiredMessage={NAME_NEEDED} error={touched && contact.name.trim().length < 2 ? NAME_NEEDED : null}><input className="input" value={contact.name} onChange={set("name")} required minLength={2} maxLength={120} autoComplete="name" /></Field>
              <Field label="Email" error={touched && noContact ? "Add an email or a phone number, so we can reach you." : null}><input className="input" type="email" value={contact.email} onChange={set("email")} maxLength={200} autoComplete="email" aria-invalid={touched && noContact} /></Field>
              <Field label="Phone" hint={view.data.company.texts ? textDisclosure(view.data.company.name) : undefined}><input className="input" type="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: formatPhoneTyping(e.target.value) })} maxLength={30} autoComplete="tel" aria-invalid={touched && noContact} /></Field>
            </div>
            <Field label="Service address" requiredMessage={ADDRESS_NEEDED} error={touched && contact.line1.trim().length < 3 ? ADDRESS_NEEDED : null}><input className="input" value={contact.line1} onChange={set("line1")} required minLength={3} maxLength={200} autoComplete="street-address" /></Field>
            <div className="form-grid">
              <Field label="City"><input className="input" value={contact.city} onChange={set("city")} maxLength={100} autoComplete="address-level2" /></Field>
              <Field label="ZIP / Postal code"><input className="input" value={contact.postal_code} onChange={set("postal_code")} maxLength={12} autoComplete="postal-code" /></Field>
            </div>
            {questions.map((q) => (
              isFileQuestion(q) ? (
                <FileQuestion key={q.key} q={q} files={files[q.key] ?? []} room={MAX_FILES - fileCount} invalid={touched && unanswered.includes(q)} disabled={submit.isPending} onChange={(list) => setFiles((all) => ({ ...all, [q.key]: list }))} />
              ) : (
                <QuestionField key={q.key} q={q} value={answers[q.key]} invalid={touched && unanswered.includes(q)} onChange={(v) => setAnswers({ ...answers, [q.key]: v })} />
              )
            ))}
            {booking && (
              <TimePicker path={path} booking={booking} postalCode={contact.postal_code} picked={time} onPick={setTime} onNoneOpen={setNoneOpen} invalid={touched && noTime} refreshed={turnedAway} />
            )}
            {promo.offer ? (
              <div className="callout callout-good">
                <Icon name="tag" size={20} />
                <div className="grow"><strong className="mono">{promo.code}</strong>: {promo.offer}. It'll be applied to your quote.</div>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setPromo({ code: "", offer: "", open: false }); checkPromo.reset(); }}>Remove</button>
              </div>
            ) : promo.open ? (
              <Field label="Promo code" optional error={checkPromo.error ? (checkPromo.error as Error).message : null}>
                <div className="promo-entry">
                  <input className="input mono grow" value={promo.code} onChange={(e) => { setPromo({ ...promo, code: e.target.value.toUpperCase() }); checkPromo.reset(); }} maxLength={24} autoCapitalize="characters" />
                  <Button loading={checkPromo.isPending} disabled={!promo.code.trim()} onClick={() => checkPromo.mutate(promo.code.trim())}>Apply</Button>
                </div>
              </Field>
            ) : (
              <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: "start" }} onClick={() => setPromo({ ...promo, open: true })}><Icon name="tag" size={14} />Have a promo code?</button>
            )}
            <div ref={turnstile.ref} />
            <FormError error={submit.error} />
            {sending && (
              <div className="stack-sm" role="status" aria-live="polite">
                <div className="row-between small"><span className="strong">Sending your files: {sending.done + 1} of {sending.total}</span><span className="muted tabular">{Math.round(sending.progress * 100)}%</span></div>
                <div className="progress"><span style={{ width: `${Math.round(((sending.done + sending.progress) / sending.total) * 100)}%` }} /></div>
                <span className="muted small">Keep this page open until they're done.</span>
              </div>
            )}
            <FormChecks />
            <Button type="submit" variant="primary" size="lg" icon={booking && time ? "calendar" : "send"} loading={submit.isPending} disabled={turnstile.required && !turnstile.token}>
              {booking && time ? (booking.needs_ok ? "Request this time" : "Book this time") : "Send request"}
            </Button>
          </form>
        )}
        <PrivacyFooter url={view.data?.company.privacy_url} />
      </div>
    </div>
  );
}

/** After a time was picked: when, in whose time zone, how they'll hear, and a file for their calendar. */
function BookedNote({ sent, booking, company, reference }: { sent: Booked; booking: Booking; company: string; reference: number }) {
  const when = slotLabel({ date: new Date(sent.starts_at).toLocaleDateString("en-CA", { timeZone: booking.timezone }), starts_at: sent.starts_at }, booking.timezone, booking.window_min);
  const told = sent.emailed && sent.texted ? "We've emailed and texted you the details." : sent.emailed ? "We've emailed you the details." : sent.texted ? "We've texted you the details." : null;
  const calendar = useMemo(() => (sent.calendar ? URL.createObjectURL(new Blob([sent.calendar], { type: "text/calendar" })) : null), [sent.calendar]);
  useEffect(() => () => { if (calendar) URL.revokeObjectURL(calendar); }, [calendar]);
  return (
    <>
      {sent.status === "booked" ? (
        <p style={{ margin: 0 }}>{company} will see you <strong>{when}</strong> (reference #{reference}).</p>
      ) : (
        <p style={{ margin: 0 }}>You asked for <strong>{when}</strong> (reference #{reference}). This time isn't confirmed yet: {company} will confirm it, or get in touch to find another.</p>
      )}
      <p className="muted" style={{ margin: 0 }}>Times are in {booking.timezone_label}.{told ? ` ${told}` : ""}</p>
      {calendar && <a className="btn" href={calendar} download="visit.ics"><Icon name="calendar" size={16} />Add to calendar</a>}
    </>
  );
}

/**
 * The times the business has open, a week at a time: a day, then a time on it. Shown once the
 * postal code is in when the form has a service area, so nobody outside it is offered a time.
 * `refreshed` changes when a send was turned away, and brings the openings as they are now.
 */
function TimePicker({ path, booking, postalCode, picked, onPick, onNoneOpen, invalid, refreshed }: { path: string; booking: Booking; postalCode: string; picked: OpenSlot | null; onPick: (slot: OpenSlot | null) => void; onNoneOpen: (none: boolean) => void; invalid: boolean; refreshed: number }) {
  // Asked for once they stop typing, not at every letter.
  const [postal, setPostal] = useState(postalCode.trim());
  useEffect(() => {
    const timer = setTimeout(() => setPostal(postalCode.trim()), 600);
    return () => clearTimeout(timer);
  }, [postalCode]);
  const waiting = booking.needs_postal_code && postal.length < 3;
  // No `from`: the first week that has a time.
  const [from, setFrom] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const week = useQuery({
    queryKey: ["booking-openings", path, from, booking.needs_postal_code ? postal : "", refreshed],
    enabled: !waiting,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: () => {
      const query = new URLSearchParams({ ...(from && { from }), ...(booking.needs_postal_code && { postal_code: postal }) }).toString();
      return publicFetch<Week>(`${path}/openings${query ? `?${query}` : ""}`);
    },
  });
  const w = week.data;
  const slots = w?.slots ?? [];
  const days = [...new Set(slots.map((s) => s.date))];
  const shownDay = day && days.includes(day) ? day : (days[0] ?? null);
  // Nothing open in the whole stretch the form books: the request goes without a time.
  const none = week.isSuccess && !slots.length && week.data.from <= week.data.first && week.data.to >= week.data.last;
  // Outside the service area (400) nothing is sent; when the times just can't be read, the request still can be.
  const outside = week.isError && (week.error as { status?: number }).status === 400;
  const unread = week.isError && !outside;
  useEffect(() => onNoneOpen(none || unread), [none, unread]);
  // A time that's no longer offered isn't kept picked.
  useEffect(() => {
    if (picked && week.isSuccess && !week.isPlaceholderData && week.data.from <= picked.date && picked.date <= week.data.to && !slots.some((s) => s.starts_at === picked.starts_at)) onPick(null);
  }, [week.data]);
  const dayName = (date: string) => slotLabel({ date, starts_at: null }, booking.timezone);
  const choice = (key: string, on: boolean, label: string, pick: () => void) => (
    <button key={key} type="button" className="tab" aria-pressed={on} style={{ height: "var(--control)", padding: "0 14px" }} onClick={pick}>{on && <Icon name="check" size={14} strokeWidth={2} />}{label}</button>
  );
  return (
    <fieldset className="field" data-invalid={invalid || undefined} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 10 }}>
      <legend style={{ marginBottom: 6 }}>{booking.needs_ok ? "Pick a time you'd like" : "Pick a time"}</legend>
      <span className="muted small">Times are in {booking.timezone_label}. {booking.window_min ? "We arrive within the window you pick." : `Set aside about ${visitLength(booking.minutes)}.`}</span>
      {waiting ? (
        <span className="muted">Enter your ZIP / postal code above to see the times we have open.</span>
      ) : week.isPending ? (
        <Skeleton height={96} radius={8} />
      ) : outside ? (
        <span className="field-error">{(week.error as Error).message}</span>
      ) : unread ? (
        <span className="muted">We couldn't show our open times just now. Send your request and we'll be in touch to set one.</span>
      ) : none || !w ? (
        <span className="muted">We don't have a time open online right now. Send your request and we'll be in touch to set one.</span>
      ) : (
        <>
          <div className="row wrap" style={{ gap: 8 }}>
            <Button size="sm" icon="chevronLeft" disabled={w.from <= w.first || week.isFetching} onClick={() => { setDay(null); setFrom(addDays(w.from, -7) <= w.first ? w.first : addDays(w.from, -7)); }}>Earlier</Button>
            <strong className="grow" style={{ textAlign: "center" }}>{dayName(w.from)} to {dayName(w.to)}</strong>
            <Button size="sm" disabled={w.to >= w.last || week.isFetching} onClick={() => { setDay(null); setFrom(addDays(w.to, 1)); }}>Later<Icon name="chevronRight" size={14} /></Button>
          </div>
          {days.length === 0 ? (
            <span className="muted">Nothing open these days. Try {w.to >= w.last ? "earlier" : "later"}.</span>
          ) : (
            <>
              <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Day">{days.map((d) => choice(d, d === shownDay, dayName(d), () => setDay(d)))}</div>
              <div className="row wrap" style={{ gap: 6 }} role="group" aria-label={booking.window_min ? "Arrival window" : "Time"}>
                {slots.filter((s) => s.date === shownDay).map((s) => choice(s.starts_at!, picked?.starts_at === s.starts_at, slotTime(s.starts_at!, booking.timezone, booking.window_min), () => onPick(picked?.starts_at === s.starts_at ? null : s)))}
              </div>
            </>
          )}
          {picked && <span className="strong" role="status">{booking.needs_ok ? "You're asking for" : "You picked"} {slotLabel(picked, booking.timezone, booking.window_min)}.</span>}
        </>
      )}
      {invalid && !waiting && !week.isError && <span className="field-error" role="alert">Pick a time for your visit.</span>}
      {invalid && waiting && <span className="field-error" role="alert">Enter your ZIP / postal code, then pick a time.</span>}
    </fieldset>
  );
}

/** In an iframe on the business's website: keeps the frame as tall as the form (embed.ts). */
function useFitFrame(embedded: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const page = ref.current;
    if (!embedded || !page) return;
    const observer = new ResizeObserver(() => postToHost({ crewtavo: "height", height: page.getBoundingClientRect().height }));
    observer.observe(page);
    return () => observer.disconnect();
  }, [embedded]);
  return ref;
}

/**
 * A "Files" or "Photos" question: pick or drop files; they're sent once the request is in. The
 * picker is a real file input kept in the page (only hidden from sight), so Tab reaches it, Enter
 * and Space open it, and a screen reader says what it's for; its label shows the focus.
 */
export function FileQuestion({ q, files, room, invalid, disabled, onChange }: { q: Question; files: File[]; room: number; invalid: boolean; disabled: boolean; onChange: (files: File[]) => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const photos = q.type === "photos";
  const add = (picked: File[]) => {
    const fitting = picked.filter((f) => f.size > 0 && f.size <= PLAN_MAX_BYTES && (!photos || f.type.startsWith("image/")));
    const tooBig = picked.filter((f) => f.size > PLAN_MAX_BYTES);
    const taken = fitting.slice(0, Math.max(0, room));
    setProblem(
      tooBig.length ? new TooLargeError(`${tooBig[0]!.name} is larger than ${fileSize(PLAN_MAX_BYTES)}. Split it into smaller files, or send it another way.`).message
        : fitting.length > taken.length ? `You can send up to ${MAX_FILES} files with a request.`
          : picked.length > fitting.length ? (photos ? "Only pictures here." : "Some of those files are empty.") : null,
    );
    if (taken.length) onChange([...files, ...taken]);
  };
  const label = <>{q.label}{!q.required && <span className="optional"> (optional)</span>}</>;
  const errorId = useId();
  const error = problem ?? (invalid ? "Add a file to send with your request." : null);
  return (
    <div
      className="field"
      data-invalid={invalid || undefined}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) add([...e.dataTransfer.files]); }}
      style={over ? { outline: "2px dashed var(--green)", outlineOffset: 4, borderRadius: "var(--radius-control)" } : undefined}
    >
      <span>{label}</span>
      {files.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="row" style={{ gap: 8 }}>
              <Icon name={f.type.startsWith("image/") ? "image" : "file"} size={16} />
              <span className="grow" style={{ overflowWrap: "anywhere" }}>{f.name} <span className="muted small">{fileSize(f.size)}</span></span>
              <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Remove ${f.name}`} disabled={disabled} onClick={() => onChange(files.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      <label className="btn" style={{ justifySelf: "start" }} aria-disabled={disabled || room <= 0}>
        <Icon name={photos ? "camera" : "upload"} size={16} />{photos ? "Add photos" : "Add files"}
        <input
          type="file"
          multiple
          className="sr-only"
          // Its name starts with the words on the button, then says which question it answers.
          aria-label={`${photos ? "Add photos" : "Add files"}: ${q.label}${q.required ? "" : " (optional)"}`}
          aria-required={q.required || undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={error ? errorId : undefined}
          accept={photos ? "image/*" : undefined}
          disabled={disabled || room <= 0}
          onChange={(e) => { const picked = [...(e.target.files ?? [])]; e.target.value = ""; add(picked); }}
        />
      </label>
      <span className="muted small">{photos ? "Pictures" : "Plans, PDFs or pictures"}, up to {fileSize(PLAN_MAX_BYTES)} each. You can also drop them here.</span>
      {error && <span id={errorId} className="field-error" role="alert">{error}</span>}
    </div>
  );
}

export function QuestionField({ q, value, invalid, onChange }: { q: Question; value: unknown; invalid: boolean; onChange: (v: unknown) => void }) {
  const label = <>{q.label}{!q.required && <span className="optional"> (optional)</span>}</>;
  const error = invalid ? "Answer this one to send your request." : null;
  switch (q.type) {
    case "long_text":
      return <Field label={label} error={error}><textarea className="textarea" value={String(value ?? "")} maxLength={4000} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} /></Field>;
    case "number":
      return <Field label={label} error={error}><input className="input" inputMode="decimal" value={String(value ?? "")} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))} aria-invalid={invalid} /></Field>;
    case "yes_no":
    case "choice":
    case "multi_choice": {
      const options = q.type === "yes_no" ? ["Yes", "No"] : q.options ?? [];
      const list = Array.isArray(value) ? (value as string[]) : [];
      return (
        <fieldset className="field" data-invalid={invalid || undefined} style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ marginBottom: 6 }}>{label}</legend>
          <div className="row wrap" style={{ gap: 6 }}>
            {options.map((o) => {
              const on = q.type === "multi_choice" ? list.includes(o) : value === o;
              return (
                <button key={o} type="button" className="tab" aria-pressed={on} style={{ height: "var(--control)", padding: "0 14px" }} onClick={() => onChange(q.type === "multi_choice" ? (on ? list.filter((x) => x !== o) : [...list, o]) : o)}>
                  {on && <Icon name="check" size={14} strokeWidth={2} />}{o}
                </button>
              );
            })}
          </div>
          {error && <span className="field-error" role="alert">{error}</span>}
        </fieldset>
      );
    }
    default:
      return <Field label={label} error={error}><input className="input" value={String(value ?? "")} maxLength={500} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} /></Field>;
  }
}
