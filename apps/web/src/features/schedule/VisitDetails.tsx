/**
 * A visit at a glance, the way Google Calendar opens an event: when, where (tap for directions in
 * your maps app), who it's for, the crew and people, equipment, gate code and instructions. Edit
 * opens the visit form; nothing changes from here by accident. A sheet on phones.
 */
import { marketingOn } from "@crewtavo/core/marketing";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { MapsLink } from "@/components/ui/MapsLink";
import { Note } from "@/components/ui/Note";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { EntityStatus, visitKindText } from "@/components/ui/StatusPill";
import { supabase, unwrap, unwrapOne } from "@/lib/api";
import { addressLine, formatTime } from "@/lib/format";
import { visitPlace } from "@/lib/maps";
import { can, hasRole, useSession } from "@/lib/session";
import { useVisitExtraScope } from "../field/FieldExtras";
import { canText, TextClientDialog, useTextLines } from "../field/FieldText";
import { usePendingChanges } from "./changeRequests";
import { lengthLabel } from "./VisitDialog";
import { intlLocale, msg, t } from "@/lib/i18n";

const day = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(intlLocale(), { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

export function VisitDetails({ visitId, onClose, onEdit }: { visitId: string; onClose: () => void; onEdit?: () => void }) {
  const session = useSession();
  const tz = session.company.timezone;
  const office = hasRole(session, "admin", "office", "estimator");
  const showcases = hasRole(session, "admin", "office") && can(session, "marketing") && marketingOn(session.company.settings);
  const visit = useQuery({
    queryKey: ["visit-details", visitId],
    queryFn: async () =>
      unwrapOne(
        await supabase()
          .from("visits")
          .select(
            "id, title, kind, status, scheduled_on, starts_at, ends_at, route_order, time_fixed, notes, address, hold_reason, series_day, series_total, crew:crews(name, color), assignees:visit_assignees(user_id), equipment:visit_equipment(equipment:equipment(name)), job:jobs(id, number, title, instructions, client:clients(id, display_name, phone, email)), request:requests(id, title, details, client:clients(id, display_name, phone, email)), property:properties(id, label, line1, line2, city, region, postal_code, lat, lng, notes)",
          )
          .eq("id", visitId)
          .maybeSingle(),
        msg("This visit"),
      ),
  });
  const v = visit.data;
  // Text goes from the business's Quo line for this visit's brand (FieldText.tsx), not the phone's own app.
  const [texting, setTexting] = useState(false);
  const textClient = v?.job?.client ?? v?.request?.client ?? null;
  const textLines = useTextLines(visitId, textClient?.id ?? null, Boolean(textClient?.phone));
  // A client's request to move or cancel it: Edit answers it.
  const asked = usePendingChanges(Boolean(onEdit)).data?.some((r) => r.visit_id === visitId);
  const people = useQuery({
    queryKey: ["visit-details", visitId, "people", v?.assignees.map((a) => a.user_id).join(",")],
    enabled: Boolean(v?.assignees.length),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("profiles").select("user_id, full_name").in("user_id", v!.assignees.map((a) => a.user_id))),
  });
  const access = useQuery({
    queryKey: ["visit-details", visitId, "access"],
    enabled: Boolean(v?.property),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("property_access").select("gate_code, lockbox_code, instructions").eq("property_id", v!.property!.id))[0] ?? null,
  });

  const extras = useVisitExtraScope(visitId, Boolean(v?.job));
  const client = v?.job?.client ?? v?.request?.client ?? null;
  const place = v ? visitPlace(v) : null;
  const minutes = v?.starts_at && v.ends_at ? Math.round((Date.parse(v.ends_at) - Date.parse(v.starts_at)) / 60_000) : null;
  const when = v
    ? `${v.scheduled_on ? day(v.scheduled_on) : t("Not scheduled yet")}${v.starts_at ? ` · ${formatTime(v.starts_at, tz)}${v.ends_at ? ` – ${formatTime(v.ends_at, tz)}` : ""}` : v.scheduled_on ? ` · ${t("Anytime")}` : ""}`
    : "";
  const codes = access.data;
  const names = (people.data ?? []).map((p) => p.full_name).filter(Boolean);

  return (
    <>
    <Dialog open onClose={onClose} title={v?.title ?? t("Visit")} description={v?.job ? <>Job #{v.job.number}{client ? ` · ${client.display_name}` : ""}</> : client?.display_name}>
      <div className="dialog-body">
        {visit.error && <ErrorState error={visit.error} onRetry={() => visit.refetch()} />}
        {visit.isPending && <><Skeleton width="60%" /><Skeleton width="80%" /><Skeleton width="40%" /></>}
        {v && (
          <>
            <div className="row wrap" style={{ gap: 6 }}>
              <EntityStatus kind="visit" status={v.status} />
              {v.kind !== "job" && <span className="chip">{visitKindText(v.kind)}</span>}
              {v.route_order && v.status === "scheduled" && <span className="chip"><Icon name="navigation" size={12} />{t("Stop {number}", { number: v.route_order })}</span>}
              {v.time_fixed && v.starts_at && <span className="chip chip-blue"><Icon name="lock" size={12} />{t("Fixed time")}</span>}
              {v.series_total && v.series_total > 1 && <span className="chip chip-blue">{t("Day {day} of {days}", { day: v.series_day, days: v.series_total })}</span>}
              {asked && <span className="chip chip-blue"><Icon name="calendar" size={12} />{t("Change requested")}</span>}
            </div>

            <div className="visit-facts">
              <Icon name="clock" size={16} />
              <div>
                {when}
                {minutes != null && <span className="muted"> ({lengthLabel(minutes)})</span>}
              </div>

              {v.property && (
                <>
                  <Icon name="pin" size={16} />
                  <div>
                    {v.property.label && <strong style={{ display: "block" }}>{v.property.label}</strong>}
                    <MapsLink className="address-link" place={v.property}>{addressLine(v.property)}</MapsLink>
                    {(codes?.gate_code || codes?.lockbox_code) && (
                      <span className="row wrap small" style={{ gap: 12, marginTop: 4 }}>
                        {codes.gate_code && <span><Icon name="lock" size={12} /> {t("Gate")} <strong>{codes.gate_code}</strong></span>}
                        {codes.lockbox_code && <span><Icon name="lock" size={12} /> {t("Lockbox")} <strong>{codes.lockbox_code}</strong></span>}
                      </span>
                    )}
                    {codes?.instructions && <span className="muted small pre-wrap" style={{ display: "block", marginTop: 4 }}>{codes.instructions}</span>}
                    {v.property.notes && <span className="muted small pre-wrap" style={{ display: "block", marginTop: 4 }}>{v.property.notes}</span>}
                  </div>
                </>
              )}
              {!v.property && place && (
                <>
                  <Icon name="pin" size={16} />
                  <div><MapsLink className="address-link" place={place}>{v.address}</MapsLink></div>
                </>
              )}

              {client && (
                <>
                  <Icon name="user" size={16} />
                  <div>
                    {office ? <Link to={`/clients/${client.id}`}>{client.display_name}</Link> : client.display_name}
                    {client.phone && <> · <a href={`tel:${client.phone}`}>{client.phone}</a></>}
                    {office && client.email && <span className="muted small" style={{ display: "block" }}>{client.email}</span>}
                  </div>
                </>
              )}

              {(v.crew || names.length > 0) && (
                <>
                  <Icon name="users" size={16} />
                  <div>
                    {v.crew && <span className="row" style={{ gap: 6, display: "inline-flex" }}><i style={{ width: 8, height: 8, borderRadius: "50%", background: v.crew.color ?? "var(--text-4)" }} />{v.crew.name}</span>}
                    {names.length > 0 && <span className="muted" style={{ display: "block" }}>{names.join(", ")}</span>}
                  </div>
                </>
              )}

              {v.equipment.length > 0 && (
                <>
                  <Icon name="truck" size={16} />
                  <div>{v.equipment.map((e) => e.equipment?.name).filter(Boolean).join(", ")}</div>
                </>
              )}

              {v.hold_reason && (
                <>
                  <Icon name="cloud" size={16} />
                  <div style={{ color: "var(--warning)", fontWeight: 600 }}>{t("Weather: {reason}", { reason: v.hold_reason })}</div>
                </>
              )}

              {(v.notes || v.job?.instructions || v.request?.details) && (
                <>
                  <Icon name="note" size={16} />
                  <div className="stack-sm">
                    {v.notes && <span className="pre-wrap">{v.notes}</span>}
                    {v.job?.instructions && <Note className="muted" text={v.job.instructions} />}
                    {!v.job && v.request?.details && <span className="pre-wrap muted">{v.request.details}</span>}
                  </div>
                </>
              )}

              {/* Extra work on this visit of a repeating job, without prices (the job page has those). */}
              {extras.data && extras.data.length > 0 && (
                <>
                  <Icon name="plus" size={16} />
                  <div className="stack-sm">
                    <strong>{t("Extra work on this visit")}</strong>
                    {extras.data.map((e) => <span key={e.id}>{e.name}{Number(e.quantity) !== 1 || e.unit !== "ea" ? ` · ${Number(e.quantity)} ${e.unit}` : ""}</span>)}
                  </div>
                </>
              )}
            </div>

            <div className="visit-actions">
              {onEdit && <Button variant="primary" icon="edit" onClick={onEdit}>{t("Edit")}</Button>}
              {place && <MapsLink className="btn" place={place}><Icon name="navigation" size={16} />{t("Directions")}</MapsLink>}
              {client?.phone && <a className="btn" href={`tel:${client.phone}`}><Icon name="phone" size={16} />{t("Call")}</a>}
              {client?.phone && canText(textLines.data, session.config.features.sms) && <Button icon="messages" onClick={() => setTexting(true)}>{t("Text")}</Button>}
              {office && v.job && <Link className="btn" to={`/jobs/${v.job.id}`} onClick={onClose}><Icon name="job" size={16} />{t("Open job")}</Link>}
              {/* A finished visit's before and after photos, on a page to share (Marketing → Showcases). */}
              {showcases && v.job && v.status === "completed" && (
                <Link className="btn" to={`/marketing?tab=showcases&job=${v.job.id}&visit=${v.id}`} onClick={onClose}><Icon name="image" size={16} />{t("Make a showcase")}</Link>
              )}
              {!office && <Link className="btn" to={`/field/visits/${v.id}`} onClick={onClose}><Icon name="clipboard" size={16} />{t("Open visit")}</Link>}
            </div>
          </>
        )}
      </div>
    </Dialog>
    {texting && client && <TextClientDialog client={client} visitId={visitId} lines={textLines.data} onClose={() => setTexting(false)} />}
    </>
  );
}
