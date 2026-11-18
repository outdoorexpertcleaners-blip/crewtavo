/**
 * One visit on a phone: where, how to get in, what to do, checklist, photos, receipts and notes. A
 * sub gets the client's name (and phone, if the office allows it) from visit_contact(), their own
 * price for the job once it's agreed, and no clock, receipts or materials: those are the team's.
 *
 * The visit's next step (On my way, Start visit, Complete visit) is the one thing to tap: on a phone
 * it sits in a bar above the tab bar, in thumb reach. The checklist and the notes save as the crew
 * goes, and Complete visit says how many required checklist items are left.
 *
 * The team adds work to the job from the price list, never seeing a price; once the visit is done,
 * the office on site makes its invoice, sends it and records cash or check (FieldBilling.tsx).
 */
import { shownCustomFields } from "@crewtavo/core/customFields";
import { onlineManager, useIsMutating, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore, type ChangeEvent, type RefObject } from "react";
import { Link, useParams } from "react-router-dom";
import { canDrawOn, DrawOnPhoto, OriginalLink } from "@/components/DrawOnPhoto";
import { PhotoEditor, type MarksFor } from "@/components/PhotoEditor";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { MapsLink } from "@/components/ui/MapsLink";
import { Note } from "@/components/ui/Note";
import { BackLink, useDocumentTitle } from "@/components/ui/PageHeader";
import { SaveStatus, useSaveStatus, type SaveState } from "@/components/ui/SaveStatus";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { PageError } from "@/components/ui/States";
import { EntityStatus, StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap, unwrapOne } from "@/lib/api";
import { errorMessage, isAuthError } from "@/lib/errors";
import { photoLinks } from "@/lib/photoMarkup";
import { addressLine, formatDateTime, timeAgo } from "@/lib/format";
import { visitPlace } from "@/lib/maps";
import { useListAnimation } from "@/lib/motion";
import { FIELD_SCOPE } from "@/lib/offline";
import { addVisitPhoto, phonePhotos, removePhonePhoto, subscribePhonePhotos, type PhonePhoto } from "@/lib/offlinePhotos";
import { hasRole, isSub, keepsTime, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { IN_TRASH } from "../drive/trash";
import { ShareToggle, shareToggleState } from "../marketing/ShareToggle";
import { undoable } from "@/lib/undo";
import { CustomFieldList, useCustomFields } from "../customFields/CustomFields";
import { ExpenseDialog } from "../jobs/ExpensesCard";
import { MaterialsCard } from "../jobs/JobMaterials";
import { ScopeOfWork } from "../jobs/ScopeOfWork";
import { FieldPlans } from "../plans/FieldPlans";
import { PropertyEquipment } from "../clients/PropertyEquipment";
import { Timeline } from "../clients/Timeline";
import { guideQuery } from "../kb/kbData";
import { contactLinks, visitContact, type VisitContact } from "./contact";
import { canText, OnMyWayNote, TextClientDialog, useTextLines } from "./FieldText";
import { pendingChecklistSaves, pendingVisitSave, pendingVisitStatus, showVisitStatus, statusSaved, type ChecklistSave, type VisitNotesSave, type VisitStatusChange } from "./fieldActions";
import { formatDuration, useStatusTap } from "./fieldData";
import { GeofenceCard } from "./GeofenceCard";
import { OfflineNote, useSignal } from "./OfflineNote";
import { SignaturePad } from "./SignaturePad";
import { visitChecklists, type VisitChecklist } from "./visitChecklists";
import { AddWork, VisitInvoice } from "./FieldBilling";
import { addsToVisit, addsWork, fieldInvoiceKind, takesMoney, takesWork } from "./fieldMoney";
import { VisitExtraScope } from "./FieldExtras";
import { YourPrice } from "./YourPrice";
import { LocationNotice } from "./LocationNoticeDialog";
import { onlyLooking } from "./visitAccess";
import { useMyCrews } from "../schedule/myCrews";
import { msg, t, T } from "@/lib/i18n";

interface ChecklistItem { key: string; label: string; type: "check" | "number" | "text" | "choice" | "photo" | "signature"; required: boolean; options?: string[]; sop_page_id?: string }

/** What's still required on the visit's checklists, for Complete visit. Null when nothing holds it up. */
interface ChecklistProgress { required: number; missing: Array<{ key: string; label: string }> }

interface ChecklistHandle {
  /** With the visit's completion: saves a checklist with nothing required missing as done, any other (completed anyway) as it is. */
  finish: () => void;
  /** Brings the first required item still missing to the middle of the screen, lit up for a moment. */
  showMissing: () => void;
}

const stillMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function FieldVisitPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const queryClient = useQueryClient();
  const [expense, setExpense] = useState(false);
  const [texting, setTexting] = useState(false);
  const sub = isSub(session);
  const clocks = keepsTime(session);
  const checklist = useRef<ChecklistHandle>(null);
  // Undefined while the checklist loads.
  const [progress, setProgress] = useState<ChecklistProgress | null | undefined>(undefined);
  // The required item an early Complete visit last pointed at: tapped again, it offers to go without.
  const pointedAt = useRef<string | null>(null);
  const online = useSignal();

  const visit = useQuery({
    queryKey: ["field-visit", id],
    queryFn: async () => {
      const row = unwrapOne(
        await supabase()
          .from("visits")
          .select("id, title, kind, status, starts_at, ends_at, scheduled_on, notes, address, hold_reason, completed_at, invoice_id, series_day, series_total, crew_id, assignees:visit_assignees(user_id), equipment:visit_equipment(equipment:equipment(id, name, kind)), job:jobs(id, number, title, instructions, property_id, custom_fields, kind, status, pricing, client:clients(id, display_name, phone, sms_opt_out_at, social_photos_opt_out)), request:requests(id, title, details, client:clients(id, display_name, phone, sms_opt_out_at, social_photos_opt_out)), property:properties(id, line1, city, region, postal_code, lat, lng, notes, custom_fields)")
          .eq("id", id)
          .maybeSingle(),
        msg("This visit"),
      );
      const notes = pendingVisitSave<VisitNotesSave>(queryClient, "visit-notes", id);
      return { ...row, status: pendingVisitStatus(queryClient, id) ?? row.status, notes: notes ? notes.notes : row.notes };
    },
  });
  const v = visit.data;
  useDocumentTitle(v?.title ?? t("Visit"));
  // Field crew can open anyone's visit from the schedule; on one they're not on, they only look.
  const myCrews = useMyCrews(session.role === "field_crew");
  const looking = Boolean(v) && onlyLooking(session, v!, myCrews.data);
  // The job's and property's own fields, to read (a sub reads none: they're the business's).
  const jobFields = useCustomFields("job");
  const propertyFields = useCustomFields("property");
  const access = useQuery({
    queryKey: ["field-visit", id, "access"],
    enabled: Boolean(v?.property),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("property_access").select("gate_code, lockbox_code, alarm_code, instructions").eq("property_id", v!.property!.id))[0] ?? null,
  });
  // A sub can't read clients: the name, and the phone if they may call, come from visit_contact().
  // Kept on the phone with the visit, for no signal.
  const contact = useQuery({
    queryKey: ["field-visit", id, "contact"],
    enabled: sub,
    meta: { silent: true },
    queryFn: async () => (unwrap(await supabase().rpc("visit_contact", { p_visit: id })) as VisitContact[])[0] ?? null,
  });
  // Whether the job is charged automatically when the visit is done: a yes or no from
  // visit_autopay(), never an amount or a card (crews don't see prices). Kept on the phone with the
  // visit. Not for subs: their price is their own, and the client's billing isn't theirs to see.
  const autopay = useQuery({
    queryKey: ["field-visit", id, "autopay"],
    enabled: !sub && Boolean(v?.job),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("visit_autopay", { p_visit: id })) === true,
  });
  const myTime = useQuery({
    queryKey: ["field-visit", id, "time"],
    enabled: clocks,
    queryFn: async () => unwrap(await supabase().from("time_entries").select("started_at, ended_at").eq("visit_id", id).eq("user_id", session.userId)),
  });
  // The team texts the client from the business's line inside the app (FieldText.tsx); a sub uses the phone's own.
  const teamClient = (v?.job?.client ?? v?.request?.client ?? null) as { id: string; display_name: string; phone: string | null; sms_opt_out_at: string | null } | null;
  const textLines = useTextLines(id, teamClient?.id ?? null, Boolean(teamClient?.phone));
  const refresh = () => {
    // The Jobs list and job pages say Late, Today, Upcoming or Unscheduled from the visits (public.job_state).
    for (const k of [["field-visit", id], ["field"], ["schedule"], ["job"], ["jobs"], ["running-timer"], ["crew-clock"], ["dashboard"], ["checklist", id], ["on-my-way", id]]) queryClient.invalidateQueries({ queryKey: k });
  };
  // These work offline: saved on the phone and sent, in order, when there's signal. Each is sent by
  // the action registered for it (fieldActions.ts), not a mutationFn here: lib/offline.ts notes when
  // it's on its way, for the count of updates waiting.
  const statusMutation = useMutation({
    mutationKey: ["visit-status"],
    scope: FIELD_SCOPE,
    meta: { success: statusSaved },
    onMutate: (change: VisitStatusChange) => {
      if (!onlineManager.isOnline()) toast.info(t("Saved on this phone"), { description: t("It sends when you have signal.") });
      showVisitStatus(queryClient, change);
    },
    onSettled: refresh,
  });
  const statusTap = useStatusTap((change) => statusMutation.mutate(change));
  const setStatus = (status: string) => statusTap.tap({ id, jobId: v?.job?.id ?? null }, status);
  // Which step is on its way: finding the phone's place comes first for one that clocks.
  const going = statusTap.locating?.id === id ? statusTap.locating.status : statusMutation.isPending && !statusMutation.isPaused ? (statusMutation.variables?.status ?? null) : null;

  // Notes save a moment after the crew stops typing, and when they leave the box.
  const showing = useShowing();
  const saveNotes = useMutation({
    mutationKey: ["visit-notes"],
    scope: FIELD_SCOPE,
    meta: { inline: true },
    onMutate: (change: VisitNotesSave) => {
      queryClient.setQueryData<typeof visit.data>(["field-visit", id], (old) => old && { ...old, notes: change.notes });
    },
    onError: toastIfGone(showing),
    // Not waited on: the next field action in line goes without waiting for this reload.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["field-visit", id], exact: true }),
  });
  const notesSave = useAutoSave((text: string) => saveNotes.mutateAsync({ companyId: session.company.id, visitId: id, notes: text.trim() || null }), 1000);
  const notesSending = useIsMutating({ mutationKey: ["visit-notes"], predicate: (m) => (m.state.variables as VisitNotesSave | undefined)?.visitId === id });
  const [notes, setNotes] = useState("");
  const notesIn = useRef(false);
  // What's saved comes in (the first load, the office changing them) unless something typed here is
  // still on its way, or they're typing.
  useEffect(() => {
    if (!visit.data) return;
    if (notesIn.current && (notesSending > 0 || notesSave.waiting() || document.activeElement?.id === "visit-notes")) return;
    notesIn.current = true;
    setNotes(visit.data.notes ?? "");
  }, [visit.data?.notes, visit.isSuccess, notesSending]);

  if (visit.isPending) return <DetailSkeleton />;
  if (visit.error || !v) {
    return (
      <div className="field-app">
        <PageError error={visit.error} onRetry={() => visit.refetch()} back={<BackLink to="/field">{t("My day")}</BackLink>} />
      </div>
    );
  }

  const place = visitPlace(v);
  const client = visitContact((v.job?.client ?? v.request?.client) as { display_name: string; phone: string | null } | null, contact.data);
  const codes = access.data;
  const minutes = (myTime.data ?? []).reduce((s, t) => s + ((t.ended_at ? Date.parse(t.ended_at) : Date.now()) - Date.parse(t.started_at)), 0);
  const left = progress?.missing.length ?? 0;
  const invoiceKind = v.job ? fieldInvoiceKind(v.job) : null;
  const complete = async () => {
    const first = progress?.missing[0];
    if (progress && first) {
      // The first tap shows what's still required; tapped again, it can go without.
      if (pointedAt.current !== first.key) {
        pointedAt.current = first.key;
        return checklist.current?.showMissing();
      }
      const names = progress.missing.map((m) => m.label).join(", ");
      const anyway = await confirm({ title: t("The checklist isn't done"), body: t("Still needed: {names}. The office will see the checklist is unfinished.", { names }), confirmLabel: t("Complete anyway"), cancelLabel: t("Keep working") });
      if (!anyway) return checklist.current?.showMissing();
    }
    checklist.current?.finish();
    setStatus("completed");
  };
  const commit =
    looking ? null : v.status === "scheduled" ? (
      <>
        <Button icon="navigation" className="big-action" loading={going === "en_route"} onClick={() => setStatus("en_route")}>{t("On my way")}</Button>
        <Button variant="primary" icon="play" className="big-action" loading={going === "in_progress"} onClick={() => setStatus("in_progress")}>{t("Start visit")}</Button>
      </>
    ) : v.status === "en_route" ? (
      <Button variant="primary" icon="play" className="big-action" loading={going !== null} onClick={() => setStatus("in_progress")}>{t("Start visit")}</Button>
    ) : v.status === "in_progress" ? (
      // Green once nothing required is missing; until then it says how much is left.
      <Button variant={left ? "secondary" : "primary"} icon={left ? undefined : "check"} className="big-action" loading={going !== null} onClick={() => void complete()}>
        {progress && left > 0 && going === null && <ProgressRing value={(progress.required - left) / progress.required} />}
        {t("Complete visit")}
        {left > 0 && (
          <>
            <span className="sr-only">, </span>
            <span className="field-commit-left"><T text={left === 1 ? msg("{count} required left", "one") : "{count} required left"} count={<AnimatedNumber value={left} />} /></span>
          </>
        )}
      </Button>
    ) : null;

  return (
    <div className="field-app">
      <BackLink to="/field">{t("My day")}</BackLink>
      <div className="stack-sm">
        <h1 className="page-title">{v.title}</h1>
        <div className="row wrap">
          <EntityStatus kind="visit" status={v.status} />
          <span className="muted">{v.starts_at ? formatDateTime(v.starts_at) : v.scheduled_on ? t("Anytime today") : t("Not scheduled")}</span>
          {v.series_total && v.series_total > 1 && <span className="chip chip-blue">{t("Day {day} of {days}", { day: v.series_day, days: v.series_total })}</span>}
          {clocks && minutes > 0 && <span className="chip"><Icon name="clock" size={12} />{t("You: {time}", { time: formatDuration(minutes) })}</span>}
          {/* i18n-ignore: test/invoices.test.ts reads this chip as written, so it stays in English */}
          {!sub && autopay.data && <span className="chip" title={t("The client is charged automatically after the visit")}><Icon name="card" size={12} />Autopay</span>}
        </div>
      </div>
      <OfflineNote />
      {/* After On my way: whether the client got the text, and from which line. */}
      <OnMyWayNote visitId={v.id} status={v.status} />
      {texting && teamClient && <TextClientDialog client={teamClient} visitId={v.id} lines={textLines.data} onClose={() => setTexting(false)} />}
      {/* What's saved about where they are, said once before a tap here would save it. */}
      <LocationNotice />
      {looking && <div className="callout"><Icon name="eye" size={20} /><div className="grow">{t("You're not on this visit, so you can look but not change it.")}</div></div>}
      {/* The clock at the property: Complete visit goes through the checklist check, as the button below does. */}
      {!looking && <GeofenceCard visitId={v.id} onStatus={(_visit, status) => (status === "completed" ? void complete() : setStatus(status))} />}
      {v.status === "completed" && v.completed_at && <div className="callout callout-good"><Icon name="check" size={20} /><div className="grow">{t("Completed {when}.", { when: timeAgo(v.completed_at) })}</div></div>}
      {/* Autopay bills the visit itself; with no signal, whether it does may not be on the phone. */}
      {v.status === "completed" && v.job && invoiceKind && takesMoney(session) && (autopay.isSuccess ? !autopay.data : !online) && <VisitInvoice visitId={v.id} jobId={v.job.id} kind={invoiceKind} />}

      <div className="field-actions">
        {commit && <div className="field-commit">{commit}</div>}
        {contactLinks(client).filter((link) => sub || link.label === "Call").map((link) => (
          <a key={link.label} className="btn big-action" href={link.href}><Icon name={link.label === "Call" ? "phone" : "messages"} size={20} />{link.label === "Call" ? t("Call") : t("Text", { context: "message" })}</a>
        ))}
        {/* The team's Text goes through the business's line, once texting is set up: on any visit they
            can see, their own or a teammate's (the owner wants techs able to reach any client). */}
        {!sub && teamClient?.phone && canText(textLines.data, session.config.features.sms) && (
          <Button icon="messages" className="big-action" onClick={() => setTexting(true)}>{t("Text", { context: "message" })}</Button>
        )}
        {place && <MapsLink className="btn big-action" place={place}><Icon name="navigation" size={20} />{t("Directions")}</MapsLink>}
      </div>

      <section className="card card-pad stack-sm">
        <strong style={{ fontSize: 16 }}>{client.name ?? t("Site")}</strong>
        {place && <MapsLink className="address-link" place={place}>{v.property ? addressLine(v.property) : v.address}</MapsLink>}
        {access.isPending && v.property ? <Skeleton width="40%" /> : (
          <>
            {codes?.gate_code && <span style={{ fontSize: 16 }}><Icon name="lock" size={16} /> {t("Gate code")} <strong style={{ fontSize: 20 }}>{codes.gate_code}</strong></span>}
            {codes?.lockbox_code && <span><Icon name="lock" size={14} /> {t("Lockbox")} <strong>{codes.lockbox_code}</strong></span>}
            {codes?.alarm_code && <span><Icon name="lock" size={14} /> {t("Alarm")} <strong>{codes.alarm_code}</strong></span>}
            {codes?.instructions && <span className="muted pre-wrap">{codes.instructions}</span>}
          </>
        )}
        {v.property?.notes && <span className="muted pre-wrap">{v.property.notes}</span>}
        {v.hold_reason && <span style={{ color: "var(--warning)", fontWeight: 600 }}><Icon name="cloud" size={14} /> {t("Weather: {reason}", { reason: v.hold_reason })}</span>}
      </section>

      {/* The client's texts, emails and notes (Clients → their page shows the same), so the crew can
          see what was said before they knock. Not a sub's: they deal with the job, not the client. */}
      {!sub && teamClient && <Timeline clientId={teamClient.id} />}

      {(v.job?.instructions || v.request?.details) && (
        <section className="card card-pad stack-sm" style={{ background: "var(--note)", borderColor: "var(--note-border)" }}>
          <strong>{t("Instructions")}</strong>
          {v.job?.instructions && <Note text={v.job.instructions} />}
          {v.request?.details && <p className="pre-wrap" style={{ margin: 0 }}>{v.request.details}</p>}
        </section>
      )}
      {(shownCustomFields(jobFields, v.job?.custom_fields).length > 0 || shownCustomFields(propertyFields, v.property?.custom_fields).length > 0) && (
        <section className="card card-pad stack-sm">
          <strong>{t("Details")}</strong>
          <dl className="kv">
            <CustomFieldList fields={jobFields} values={v.job?.custom_fields} />
            <CustomFieldList fields={propertyFields} values={v.property?.custom_fields} />
          </dl>
        </section>
      )}
      {/* The scope of work: the estimate's services, their descriptions and, for the team (not subs),
          each price and the total, on any job the person can see, theirs or a teammate's. */}
      {v.job && (
        <section className="card card-pad stack-sm">
          <ScopeOfWork jobId={v.job.id} title={t("Scope of work")} bare prices={!sub} />
          {/* A repeating job's work is the same every visit; this is what's extra on this one. */}
          {addsToVisit(v.job) && <VisitExtraScope visitId={v.id} />}
          {/* Not once a repeating job's visit is on an invoice: the office adds to the invoice then. */}
          {!looking && addsWork(session) && takesWork(v.job) && v.status !== "cancelled" && !(addsToVisit(v.job) && v.invoice_id) && <AddWork visitId={v.id} jobId={v.job.id} toVisit={addsToVisit(v.job)} />}
        </section>
      )}
      {sub && <YourPrice visitId={v.id} />}
      <FieldPlans visitId={v.id} jobId={v.job?.id ?? null} propertyId={v.property?.id ?? v.job?.property_id ?? null} />
      {v.equipment.length > 0 && (
        <section className="card card-pad stack-sm">
          <strong>{t("Bring")}</strong>
          <div className="row wrap" style={{ gap: 6 }}>
            {v.equipment.map((e) => e.equipment && <span key={e.equipment.id} className="chip"><Icon name="truck" size={12} />{e.equipment.name}</span>)}
          </div>
        </section>
      )}
      {/* The client's own equipment here is the team's to see, not a sub's. Checklists, materials,
          photos and equipment are the work of the people on the visit: someone just looking at
          another's visit can't save them (their rules are the visit's people's), so they aren't offered. */}
      {!sub && !looking && <PropertyEquipment propertyId={v.property?.id ?? v.job?.property_id ?? null} visitId={v.id} />}

      {!looking && <VisitWork visitId={v.id} visitStatus={v.status} checklist={checklist} onProgress={setProgress} jobId={v.job?.id ?? null} materials={!sub}
        clientOptOut={Boolean(v.job?.client?.social_photos_opt_out ?? v.request?.client?.social_photos_opt_out)} />}

      <section className="card card-pad stack-sm">
        <div className="row-between">
          <label htmlFor="visit-notes"><strong>{t("Notes for the office")}</strong></label>
          <AutoSaveStatus status={notesSave.status} waiting={notesSending > 0} />
        </div>
        <textarea
          id="visit-notes"
          className="textarea"
          value={notes}
          maxLength={5000}
          // Only the people on a visit can save its notes (visits_update_assigned): someone just looking
          // reads them, so nothing they type looks saved when it isn't.
          readOnly={looking}
          onChange={(e) => {
            setNotes(e.target.value);
            notesSave.change(e.target.value);
          }}
          onBlur={notesSave.flush}
          placeholder={t("Extra work they asked about, damage you noticed, materials used…")}
        />
        <FormError error={saveNotes.error} />
        {v.job && !sub && !looking && <Button variant="ghost" icon="receipt" style={{ justifySelf: "start" }} onClick={() => setExpense(true)}>{t("Add a receipt")}</Button>}
      </section>

      {expense && v.job && !sub && <ExpenseDialog jobId={v.job.id} expense={null} onClose={() => setExpense(false)} onSaved={() => toast.success(t("Receipt sent to the office"), { tone: "job" })} />}
      {/* Room at the bottom for the phone's bar, so nothing ends up behind it. */}
      {commit && <div className="field-commit-room" aria-hidden="true" />}
    </div>
  );
}

/** The checklists, materials (not a sub's) and photos, sharing the visit's photos (a checklist item can ask for them). */
function VisitWork({ visitId, visitStatus, checklist, onProgress, jobId, materials, clientOptOut }: { visitId: string; visitStatus: string; checklist: RefObject<ChecklistHandle>; onProgress: (p: ChecklistProgress | null | undefined) => void; jobId: string | null; materials: boolean; clientOptOut: boolean }) {
  const photos = useVisitPhotos(visitId);
  return (
    <>
      <Checklists ref={checklist} visitId={visitId} jobId={jobId} visitStatus={visitStatus} photos={photos} onProgress={onProgress} />
      {jobId && materials && <MaterialsCard jobId={jobId} visitId={visitId} compact />}
      <Photos photos={photos} clientOptOut={clientOptOut} />
    </>
  );
}

/**
 * Saving as the crew goes, for the parts of a visit with no Save button (the checklist, the notes):
 * `change` a moment after the last edit, `flush` at once (leaving a box), and before the screen goes
 * or the phone puts the app away. Each save is a field action, so with no signal it's kept on the
 * phone and goes out in order later; `status` is for SaveStatus.
 */
function useAutoSave<V>(send: (variables: V) => Promise<unknown>, delay: number) {
  const { status, edited, track } = useSaveStatus();
  const sendNow = useRef(send);
  sendNow.current = send;
  const next = useRef<{ variables: V } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const waiting = next.current;
    if (!waiting) return;
    next.current = null;
    void track(sendNow.current(waiting.variables));
  }, [track]);
  const change = useCallback(
    (variables: V) => {
      next.current = { variables };
      edited();
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, delay);
    },
    [edited, flush, delay],
  );
  useEffect(() => {
    // On the window as it's on its way down, so the save is made before lib/offline.ts (on the
    // document) writes what's waiting to the phone's storage.
    const hidden = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("visibilitychange", hidden, true);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("visibilitychange", hidden, true);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);
  return { status, change, flush, waiting: () => next.current !== null };
}

/** False once the screen has gone, for saves that come back after it. */
function useShowing() {
  const showing = useRef(false);
  useEffect(() => {
    showing.current = true;
    return () => {
      showing.current = false;
    };
  }, []);
  return showing;
}

/**
 * For a save whose error the screen shows (meta.inline): turned down once the screen has gone (sent
 * as the crew left it, or when the signal came back), a toast says so instead. A lost sign-in is
 * said by lib/queryClient.ts.
 */
const toastIfGone = (showing: RefObject<boolean>) => (error: Error) => {
  if (!showing.current && !isAuthError(error)) toast.error(errorMessage(error));
};

/**
 * How a part that saves as the crew goes stands: SaveStatus, or kept on the phone until there's
 * signal. `waiting` is a save of it not sent yet, from this screen or from before the app was
 * closed (lib/offline.ts keeps them), which with signal is only a moment behind.
 */
function AutoSaveStatus({ status, waiting }: { status: SaveState; waiting: boolean }) {
  const online = useSignal();
  if (waiting && !online) {
    return (
      <span className="save-status" data-state="queued" role="status">
        <Icon name="wifiOff" size={14} />
        {t("Saved on this phone")}
      </span>
    );
  }
  return <SaveStatus status={status} />;
}

/** How much of the checklist's required part is in, as a ring on Complete visit. */
function ProgressRing({ value }: { value: number }) {
  const length = 2 * Math.PI * 8;
  return (
    <svg className="progress-ring" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle className="progress-ring-track" cx="10" cy="10" r="8" />
      {value > 0 && <circle className="progress-ring-done" cx="10" cy="10" r="8" strokeDasharray={length} strokeDashoffset={length * (1 - value)} />}
    </svg>
  );
}

/** The mark on a required item, said as "required" to a screen reader. */
function Required() {
  return (
    <>
      <span className="text-danger" aria-hidden="true"> *</span>
      <span className="sr-only"> {t("(required)")}</span>
    </>
  );
}

interface ChecklistTemplate { id: string; name: string; items: unknown }
interface ChecklistResponse { id: string; template_id: string | null; answers: unknown; completed_at: string | null; completed_by: string | null }
interface ChecklistData { templates: ChecklistTemplate[]; matched: string[]; responses: ChecklistResponse[] }

// A key of its own: a phone may still keep the one-checklist shape saved under ["checklist", id].
const checklistsKey = (visitId: string) => ["checklist", visitId, "cards"];

/** A save still waiting on this phone, as the response it will be (the saved answers too, when it only marks it done). */
const waitingResponse = (v: ChecklistSave, saved: ChecklistResponse | undefined): ChecklistResponse => ({
  id: v.responseId,
  template_id: v.templateId,
  answers: v.answers ?? saved?.answers ?? {},
  completed_at: v.completedAt,
  completed_by: null,
});

/**
 * The visit's checklists (visitChecklists.ts): each one its job's price list items go with, ready to
 * fill in, and one more to pick from the rest. Complete visit counts what's required on all of them.
 */
const Checklists = forwardRef<ChecklistHandle, { visitId: string; jobId: string | null; visitStatus: string; photos: VisitPhotos; onProgress: (p: ChecklistProgress | null | undefined) => void }>(function Checklists({ visitId, jobId, visitStatus, photos, onProgress }, ref) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const data = useQuery({
    queryKey: checklistsKey(visitId),
    queryFn: async (): Promise<ChecklistData> => {
      const [templates, responses, matched] = await Promise.all([
        supabase().from("checklist_templates").select("id, name, items").eq("company_id", company.id).eq("active", true).order("name"),
        supabase().from("checklist_responses").select("id, template_id, answers, completed_at, completed_by").eq("visit_id", visitId).order("created_at"),
        // The crew can't read the job's lines (they have prices): the database says which checklists they bring up.
        jobId ? supabase().rpc("job_checklists", { p_job: jobId }) : null,
      ]);
      // Saves still waiting on this phone are newer than what the server has.
      const saved: ChecklistResponse[] = unwrap(responses);
      const queued = pendingChecklistSaves(queryClient, visitId);
      const merged = saved.map((r) => (queued.has(r.id) ? waitingResponse(queued.get(r.id)!, r) : r));
      for (const v of queued.values()) if (!saved.some((r) => r.id === v.responseId)) merged.push(waitingResponse(v, undefined));
      return { templates: unwrap(templates), matched: matched ? unwrap(matched) : [], responses: merged };
    },
  });
  // The one to pick saves with this, so saving twice with no signal updates one checklist instead of adding two.
  const [newId] = useState(() => crypto.randomUUID());
  const { cards, others } = data.data?.templates.length ? visitChecklists(data.data.templates, data.data.matched, data.data.responses, newId) : { cards: [], others: [] };
  const handles = useRef(new Map<string, ChecklistHandle>());
  const [progressBy, setProgressBy] = useState<Record<string, ChecklistProgress | null>>({});
  const report = useCallback(
    (key: string, p: ChecklistProgress | null | undefined) =>
      setProgressBy((all) => {
        const next = { ...all };
        if (p === undefined) delete next[key];
        else next[key] = p;
        return next;
      }),
    [],
  );

  // Complete visit says what's left on all of them, and points at the first.
  const each = cards.map((c) => progressBy[c.key]);
  const required = each.reduce((n, p) => n + (p?.required ?? 0), 0);
  const total = data.isPending || cards.some((c) => !(c.key in progressBy)) ? undefined : required ? { required, missing: cards.flatMap((c) => (progressBy[c.key]?.missing ?? []).map((m) => ({ key: `${c.key}:${m.key}`, label: m.label }))) } : null;
  const summary = JSON.stringify(total ?? String(total));
  useEffect(() => onProgress(total), [summary]);
  useEffect(() => () => onProgress(null), [onProgress]);

  useImperativeHandle(ref, () => ({
    finish: () => cards.forEach((c) => handles.current.get(c.key)?.finish()),
    showMissing: () => {
      const first = cards.find((c) => progressBy[c.key]?.missing.length);
      if (first) handles.current.get(first.key)?.showMissing();
    },
  }));

  if (data.isPending) return <section className="card card-pad"><Skeleton width="30%" /><div style={{ height: 10 }} /><Skeleton height={80} /></section>;
  const another = cards.some((c) => c.fixed);
  return cards.map((card) => (
    <Checklist
      key={card.key}
      ref={(handle) => {
        if (handle) handles.current.set(card.key, handle);
        else handles.current.delete(card.key);
      }}
      card={card}
      templates={data.data?.templates ?? []}
      others={others}
      another={another}
      visitId={visitId}
      visitStatus={visitStatus}
      photos={photos}
      report={report}
    />
  ));
});

/** One checklist on the visit: brought up by the job's items, or picked (`another` when some were brought up). */
const Checklist = forwardRef<
  ChecklistHandle,
  { card: VisitChecklist<ChecklistResponse>; templates: ChecklistTemplate[]; others: ChecklistTemplate[]; another: boolean; visitId: string; visitStatus: string; photos: VisitPhotos; report: (key: string, p: ChecklistProgress | null | undefined) => void }
>(function Checklist({ card, templates, others, another, visitId, visitStatus, photos, report }, ref) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const root = useRef<HTMLElement>(null);
  const flashing = useRef<number | undefined>(undefined);
  const showing = useShowing();
  const response = card.response;
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [templateId, setTemplateId] = useState("");
  const answersNow = useRef(answers);
  answersNow.current = answers;
  // Made here so saving twice with no signal updates one checklist instead of adding two (the one to pick has its card's).
  const [newId] = useState(() => (card.fixed ? crypto.randomUUID() : card.key));
  const responseId = response?.id ?? newId;

  // Sent by the action registered for it, like the visit's own (no mutationFn here).
  const saveMutation = useMutation({
    mutationKey: ["checklist-save"],
    scope: FIELD_SCOPE,
    meta: { inline: true },
    onMutate: (v: ChecklistSave) => {
      queryClient.setQueryData<ChecklistData>(checklistsKey(visitId), (old) => {
        if (!old) return old;
        const saved = old.responses.find((r) => r.id === v.responseId);
        const next = waitingResponse(v, saved);
        return { ...old, responses: saved ? old.responses.map((r) => (r.id === v.responseId ? next : r)) : [...old.responses, next] };
      });
    },
    onError: toastIfGone(showing),
    // Not waited on: the next field action in line goes without waiting for this reload.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: checklistsKey(visitId) }),
  });
  const autosave = useAutoSave((v: ChecklistSave) => saveMutation.mutateAsync(v), 500);
  const sending = useIsMutating({ mutationKey: ["checklist-save"], predicate: (m) => (m.state.variables as ChecklistSave | undefined)?.responseId === responseId });
  const loaded = useRef(false);
  // What's saved comes in (the first load, another phone, the checklist reopened) unless something
  // changed here is still on its way.
  useEffect(() => {
    if (loaded.current && (sending > 0 || autosave.waiting())) return;
    loaded.current = true;
    if (response) {
      setAnswers((response.answers ?? {}) as Record<string, unknown>);
      setTemplateId(response.template_id ?? "");
    } else if (card.templateId) setTemplateId(card.templateId);
  }, [response, sending]);

  const template = templates.find((t) => t.id === templateId);
  const items = (template?.items ?? []) as unknown as ChecklistItem[];
  // The guides its items link to (not for subs, who don't read guides): fetched now, so they open
  // with no signal later (lib/offline.ts keeps them), and linked once there's one to open.
  const guideIds = session.role === "subcontractor" ? [] : [...new Set(items.flatMap((i) => (i.sop_page_id ? [i.sop_page_id] : [])))];
  const guides = useQueries({ queries: guideIds.map((id) => ({ ...guideQuery(company.id, id), staleTime: 60 * 60_000 })) });
  const guideFor = (item: ChecklistItem) => (item.sop_page_id ? guides[guideIds.indexOf(item.sop_page_id)]?.data ?? null : null);
  const answered = (i: ChecklistItem) => {
    const a = answers[i.key];
    if (i.type === "photo") return true;
    // A signature needs the drawing (older checklists stored a typed name).
    if (i.type === "signature" && a && typeof a === "object") return Boolean((a as { image?: string }).image);
    return !(a === undefined || a === null || a === "" || a === false);
  };
  const missing = items.filter((i) => i.required && !answered(i));
  const required = items.filter((i) => i.required && i.type !== "photo").length;
  const doneCount = items.filter((i) => i.type !== "photo" && answered(i)).length;
  const countable = items.filter((i) => i.type !== "photo").length;
  const done = Boolean(response?.completed_at);

  // Complete visit says what's left, and points at it.
  const missingKeys = missing.map((m) => m.key).join("\n");
  useEffect(() => {
    report(card.key, template && !done && required ? { required, missing: missing.map(({ key, label }) => ({ key, label })) } : null);
  }, [template?.id, done, required, missingKeys]);
  useEffect(() => () => report(card.key, undefined), [report, card.key]);

  const variables = (next: Record<string, unknown> | undefined, chosen: string, completedAt: string | null = null): ChecklistSave => ({
    companyId: company.id,
    visitId,
    responseId,
    templateId: chosen || null,
    ...(next && { answers: next }),
    completedAt,
  });
  const set = (key: string, value: unknown) => {
    const next = { ...answersNow.current, [key]: value };
    answersNow.current = next;
    setAnswers(next);
    autosave.change(variables(next, templateId));
  };
  const choose = (id: string) => {
    setTemplateId(id);
    autosave.change(variables(answersNow.current, id));
  };

  // Marked done, the answers go along only while some made here are still to send. Otherwise the
  // saved ones stay: this phone's copy may be older than a crewmate's answers from another phone.
  const markDone = () => {
    autosave.change(variables(sending > 0 || autosave.waiting() ? answersNow.current : undefined, templateId, new Date().toISOString()));
    autosave.flush();
  };

  useImperativeHandle(ref, () => ({
    finish: () => {
      // Nothing required missing: marked done. Completed anyway: what's in goes as it is, unfinished.
      if (template && !done && !missing.length) return markDone();
      autosave.flush();
    },
    showMissing: () => {
      const first = missing[0];
      const row = first && root.current?.querySelector<HTMLElement>(`[data-check="${CSS.escape(first.key)}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: stillMotion() ? "auto" : "smooth" });
      // Lit up again even if it already was: a color change, so it shows with Reduce Motion too.
      row.removeAttribute("data-flash");
      void row.offsetWidth;
      row.setAttribute("data-flash", "");
      window.clearTimeout(flashing.current);
      flashing.current = window.setTimeout(() => row.removeAttribute("data-flash"), 1300);
      // A box takes the focus; for anything else the row does. A list or a text field would count as
      // typing (AppShell hides the phone's bars for the keyboard), with no keyboard or picker open.
      (row.querySelector<HTMLElement>('input[type="checkbox"]') ?? row).focus({ preventScroll: true });
    },
  }));

  const reopen = useMutation({
    mutationFn: async () => unwrap(await supabase().from("checklist_responses").update({ completed_at: null }).eq("id", response!.id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: checklistsKey(visitId) }),
  });

  return (
    <section ref={root} className="card card-pad stack-sm">
      <div className="row-between">
        <strong>{card.fixed ? (template?.name ?? t("Checklist")) : another ? t("Another checklist") : t("Checklist")}</strong>
        <span className="row" style={{ gap: 12 }}>
          <AutoSaveStatus status={autosave.status} waiting={sending > 0} />
          {done ? <StatusPill label={t("Done")} tone="good" /> : template && <span className="muted small tabular"><T text="{done} of {count}" done={<AnimatedNumber value={doneCount} />} count={countable} /></span>}
        </span>
      </div>
      {template && !done && <div className="progress"><span style={{ width: `${countable ? (doneCount / countable) * 100 : 0}%` }} /></div>}
      {!card.fixed && !done && (others.length > 1 || another) && (
        <select className="select" value={templateId} onChange={(e) => choose(e.target.value)} aria-label={t("Choose a checklist")}>
          <option value="">{t("Choose a checklist…")}</option>
          {others.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
      <div>
        {items.map((item) => (
          <div key={item.key} className="check-row" data-check={item.key} tabIndex={-1}>
            {item.type === "check" ? (
              // The whole row is the box's label, so a tap anywhere on it ticks it.
              <label className="checkbox">
                <input type="checkbox" checked={Boolean(answers[item.key])} disabled={done} onChange={(e) => set(item.key, e.target.checked)} />
                <span>{item.label}{item.required && <Required />}</span>
              </label>
            ) : item.type === "photo" ? (
              <>
                <span className="grow check-photo"><Icon name="camera" size={16} />{item.label}</span>
                {!done && <PhotoPicker photos={photos} />}
              </>
            ) : item.type === "choice" ? (
              <label className="field" style={{ flex: 1 }}><span>{item.label}{item.required && <Required />}</span>
                <select className="select" value={String(answers[item.key] ?? "")} disabled={done} onChange={(e) => set(item.key, e.target.value)}>
                  <option value="">{t("Choose…")}</option>
                  {item.options?.map((o) => <option key={o}>{o}</option>)}
                </select>
              </label>
            ) : item.type === "signature" ? (
              <SignatureAnswer label={item.label} required={item.required} value={answers[item.key]} disabled={done} onChange={(next) => set(item.key, next)} />
            ) : (
              <label className="field" style={{ flex: 1 }}><span>{item.label}{item.required && <Required />}</span>
                <input className="input" inputMode={item.type === "number" ? "decimal" : undefined} value={String(answers[item.key] ?? "")} disabled={done} onChange={(e) => set(item.key, item.type === "number" ? e.target.value.replace(/[^0-9.\-]/g, "") : e.target.value)} onBlur={autosave.flush} />
              </label>
            )}
            {guideFor(item) && <Link to={`/kb/${item.sop_page_id}`} className="check-guide" title={guideFor(item)!.title} aria-label={t("How to: {guide}", { guide: guideFor(item)!.title })}><Icon name="book" size={14} />{t("How to")}</Link>}
          </div>
        ))}
      </div>
      <FormError error={saveMutation.error} />
      {/* Under way, Complete visit marks it done. Otherwise this does: completed on My day, by the office, or anyway with the rest done after. */}
      {template && !done && !missing.length && visitStatus !== "in_progress" && <Button icon="check" style={{ justifySelf: "start" }} onClick={markDone}>{t("Mark done")}</Button>}
      {done && hasRole(session, "admin", "office", "crew_lead") && <Button variant="ghost" icon="undo" style={{ justifySelf: "start" }} loading={reopen.isPending} onClick={() => reopen.mutate()}>{t("Reopen checklist")}</Button>}
    </section>
  );
});

interface Photo {
  id: string; path: string; file_name: string; caption: string | null; content_type: string | null; shareable: boolean; created_at: string; created_by: string | null;
  /** The photo drawn on, shown instead of it (lib/photoMarkup.ts). */
  marked_path: string | null;
  /** What it shows (its drawing, if any), and the photo as taken. */
  url: string | null;
  originalUrl: string | null;
}
type VisitPhotos = ReturnType<typeof useVisitPhotos>;

/**
 * A visit's photos, for its Photos card and the checklist items that ask for them: added from the
 * camera or the phone's photos (in the task island while they go up), and removed with Undo.
 */
function useVisitPhotos(visitId: string) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const key = ["photos", visitId];
  // Being shrunk and written to the phone: a moment, shown as a blank picture.
  const [adding, setAdding] = useState(0);
  // Not uploaded yet, kept on the phone meanwhile (lib/offlinePhotos.ts): shown here as they will be.
  const waiting = useSyncExternalStore(subscribePhonePhotos, phonePhotos).filter((p) => p.userId === session.userId && p.visitId === visitId);
  // Removed and waiting on Undo: kept off the screen even if the list loads again meanwhile.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const list = useQuery({
    queryKey: key,
    queryFn: async () => {
      const rows = unwrap(await supabase().from("attachments").select("id, path, marked_path, file_name, caption, content_type, shareable, created_at, created_by").eq("owner_type", "visit").eq("owner_id", visitId).order("created_at"));
      return photoLinks(rows);
    },
  });
  // `drawn`: one photo drawn on before it's added (the photo editor), kept beside it.
  const add = async (files: File[], drawn?: Blob | null, marks?: MarksFor) => {
    setAdding((n) => n + files.length);
    for (const file of files) {
      try {
        const kept = await addVisitPhoto({ userId: session.userId, companyId: company.id, visitId }, file, files.length === 1 ? drawn : null, marks);
        // Said as it's taken: with no signal and nowhere to keep it, only the open app holds it.
        if (!kept && !onlineManager.isOnline()) toast.warning(t("This phone couldn't save the photo"), { description: t("Keep Crewtavo open until you have signal, or the photo will be lost.") });
      } catch (error) {
        toast.error(`${file.name}: ${errorMessage(error)}`);
      }
      setAdding((n) => n - 1);
    }
  };
  const refreshPhotos = () => queryClient.invalidateQueries({ queryKey: ["photos", visitId] });
  // Once its Undo has passed, the photo goes to the Trash with its row (the database moves it).
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (p: { id: string; path: string }) => {
      const gone = unwrap(await supabase().from("attachments").delete().eq("id", p.id).select("id"));
      if (!gone.length) throw new Error(t("You can only remove photos you added. Ask the office to remove this one."));
    },
    onSettled: () => void refreshPhotos(),
  });
  const without = (id: string) => (h: ReadonlySet<string>) => new Set([...h].filter((x) => x !== id));
  return {
    photos: (list.data ?? []).filter((p) => !hidden.has(p.id)),
    /** OK to share shown at once, as the field action goes (or waits for signal). */
    showShareable: (id: string, shareable: boolean) => queryClient.setQueryData<Photo[]>(key, (rows) => rows?.map((r) => (r.id === id ? { ...r, shareable } : r))),
    loading: list.isPending,
    adding,
    waiting,
    uploading: adding > 0 || waiting.some((p) => p.sending),
    add: (files: File[], drawn?: Blob | null, marks?: MarksFor) => void add(files, drawn, marks),
    /** Reloads them: a drawing saved or taken off. */
    refresh: () => void refreshPhotos(),
    /** One that hasn't uploaded is only on this phone, so removing it has no Undo: asked first. */
    removeWaiting: async (p: PhonePhoto) => {
      if (await confirm({ title: t("Remove this photo?"), body: t("It hasn't uploaded yet, so it will be gone for good."), confirmLabel: t("Remove"), danger: true })) removePhonePhoto(p.id);
    },
    // A sub removes only the photos they added.
    canRemove: (p: Photo) => !isSub(session) || p.created_by === session.userId,
    remove: (p: Photo) =>
      undoable({
        title: t("Photo removed"),
        // A sub has no Trash to take it from later: the office can.
        description: isSub(session) ? undefined : IN_TRASH,
        tone: "job",
        hide: () => {
          void queryClient.cancelQueries({ queryKey: key });
          setHidden((h) => new Set(h).add(p.id));
          queryClient.setQueryData<Photo[]>(key, (rows) => rows?.filter((r) => r.id !== p.id));
        },
        restore: () => {
          setHidden(without(p.id));
          queryClient.setQueryData<Photo[]>(key, (rows) => (rows && !rows.some((r) => r.id === p.id) ? [...rows, p].sort((a, b) => a.created_at.localeCompare(b.created_at)) : rows));
        },
        commit: () => remove.mutateAsync(p),
      }),
  };
}

/**
 * Take or choose photos for the visit: on the Photos card, and on checklist items that ask for them.
 * "Draw on a photo" takes or chooses one and opens it to draw on before it's added: the photo and
 * its drawing go through the phone's queue together, so it works with no signal.
 */
function PhotoPicker({ photos }: { photos: VisitPhotos }) {
  const [drawing, setDrawing] = useState<File | null>(null);
  return (
    <span className="row wrap" style={{ gap: 8 }}>
      <label className="btn">
        <Icon name="camera" size={16} />
        {photos.uploading ? t("Uploading…") : t("Add photos")}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="sr-only"
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) photos.add(files);
          }}
        />
      </label>
      <label className="btn btn-ghost">
        <Icon name="pen" size={16} />
        {t("Draw on a photo")}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) setDrawing(file);
          }}
        />
      </label>
      {drawing && (
        <PhotoEditor
          picture={drawing}
          saveLabel={t("Add photo")}
          keepsBlank
          onCancel={() => setDrawing(null)}
          onSave={(drawn, marks) => {
            photos.add([drawing], drawn, marks);
            setDrawing(null);
          }}
        />
      )}
    </span>
  );
}

function Photos({ photos, clientOptOut }: { photos: VisitPhotos; clientOptOut: boolean }) {
  const session = useSession();
  const grid = useListAnimation<HTMLDivElement>();
  const count = photos.photos.length + photos.waiting.length;
  // OK to share is only offered while Marketing is installed, never to subs (ShareToggle).
  const sharing = photos.photos.some((p) => shareToggleState(session, p, clientOptOut) === "ready");
  const unsupported = photos.photos.filter((p) => shareToggleState(session, p, clientOptOut) === "unsupported").length;
  return (
    <section className="card card-pad stack-sm">
      <div className="row-between"><strong>{t("Photos")}</strong>{count > 0 && <span className="muted small tabular"><AnimatedNumber value={count} /></span>}</div>
      <div ref={grid} className="thumbs">
        {photos.loading && [0, 1, 2].map((i) => <Skeleton key={i} height={96} radius={8} />)}
        {photos.photos.map((p) => (
          <div key={p.id} className="thumb">
            {p.url ? <a href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={p.caption ?? p.file_name} loading="lazy" /></a> : <span className="muted small">{t("Unavailable")}</span>}
            {photos.canRemove(p) && <button type="button" className="thumb-x" aria-label={t("Remove photo")} onClick={() => photos.remove(p)}><Icon name="x" size={12} strokeWidth={2} /></button>}
            <ShareToggle photo={p} clientOptOut={clientOptOut} onShown={(shareable) => photos.showShareable(p.id, shareable)} />
            {/* Drawn on: shown with the drawing, the photo as taken a tap away. */}
            {p.marked_path && <OriginalLink url={p.originalUrl} label={p.caption ?? p.file_name} />}
            {canDrawOn(session, p) && <DrawOnPhoto photo={p} label={p.caption ?? p.file_name} onSaved={photos.refresh} />}
          </div>
        ))}
        {photos.waiting.map((p) => <WaitingPhoto key={p.id} photo={p} onRemove={() => void photos.removeWaiting(p)} />)}
        {Array.from({ length: photos.adding }, (_, i) => <div key={`u${i}`} className="thumb" style={{ display: "grid", placeItems: "center" }}><span className="spinner" style={{ width: 20, height: 20, color: "var(--text-3)" }} /></div>)}
      </div>
      {sharing && <span className="muted small">{t("Tap the corner to mark photos OK to share, and the office can post them. Posts never show the client's name or address. Check the photo doesn't show a house number, a car plate or people's faces.")}</span>}
      {unsupported > 0 && !clientOptOut && <span className="muted small">{unsupported === photos.photos.length
        ? unsupported === 1 ? t("This photo can't be marked OK to share: only JPEG and PNG photos can be posted.") : t("These photos can't be marked OK to share: only JPEG and PNG photos can be posted.")
        : unsupported === 1 ? t("The photo marked Can't share can't be marked OK to share: only JPEG and PNG photos can be posted.") : t("The photos marked Can't share can't be marked OK to share: only JPEG and PNG photos can be posted.")}</span>}
      {count > 0 && clientOptOut && shareToggleState(session, { content_type: "image/jpeg" }) !== "hidden" && <span className="muted small">{t("This client asked us not to post photos of their property.")}</span>}
      <span style={{ justifySelf: "start" }}><PhotoPicker photos={photos} /></span>
    </section>
  );
}

/** A photo that hasn't uploaded yet, shown from the phone, with where it stands. */
function WaitingPhoto({ photo, onRemove }: { photo: PhonePhoto; onRemove: () => void }) {
  const [url, setUrl] = useState<string>();
  // Drawn on as it was added: shown with the drawing, as it will be once it's up.
  const shown = photo.marked?.body ?? photo.body;
  useEffect(() => {
    const made = URL.createObjectURL(shown);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [shown]);
  return (
    <div className="thumb">
      {url && <img src={url} alt={photo.fileName} />}
      {!photo.sending && <button type="button" className="thumb-x" aria-label={t("Remove photo")} onClick={onRemove}><Icon name="x" size={12} strokeWidth={2} /></button>}
      <span className="thumb-note">{photo.problem ? t("Didn't upload") : photo.sending ? t("Uploading…") : photo.kept ? t("Waiting to send") : t("Not saved")}</span>
    </div>
  );
}

/** A signature on a checklist: the person signs on the screen and prints their name. */
function SignatureAnswer({ label, required, value, disabled, onChange }: { label: string; required: boolean; value: unknown; disabled: boolean; onChange: (next: { name: string; image: string | null } | null) => void }) {
  // Older checklists stored a typed name.
  const legacy = typeof value === "string" ? value : null;
  const current = value && typeof value === "object" ? (value as { name?: string; image?: string | null }) : null;
  return (
    <div className="field" style={{ flex: 1 }}>
      <span>{label}{required && <Required />}</span>
      {legacy ? (
        <span style={{ fontFamily: "'Brush Script MT', cursive", fontSize: 24 }}>{legacy}</span>
      ) : (
        <>
          <SignaturePad value={current?.image ?? null} disabled={disabled} label={t("Sign with your finger")} onChange={(image) => onChange(image || current?.name ? { name: current?.name ?? "", image } : null)} />
          <input className="input" aria-label={t("Printed name")} placeholder={t("Printed name")} value={current?.name ?? ""} disabled={disabled} maxLength={120} onChange={(e) => onChange({ name: e.target.value, image: current?.image ?? null })} />
        </>
      )}
    </div>
  );
}
