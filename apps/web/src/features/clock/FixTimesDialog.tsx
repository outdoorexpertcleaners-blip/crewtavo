/**
 * Fix times: one person's blocks for one day, as rows of what, start and end, the way the owner's
 * page has it. Saving makes that day's time match the rows (clockData.fixTimesWrites): rows taken
 * out are deleted, changed ones updated, new ones added as typed in. Each change is on record, and
 * the person is told when it's somebody else who changed it (time_entry_changes).
 *
 * A tech fixes their own time until it's approved; the office fixes anyone's. The database holds
 * that line too (time_entries' policies), and keeps approved or paid days as they are.
 */
import { localTime } from "@crewtavo/core/time";
import { checkFixTimes, CLOCK_KIND_LABELS } from "@crewtavo/core/timeclock";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { todayIn } from "@/lib/format";
import { intlLocale, t } from "@/lib/i18n";
import { can, hasRole, useSession } from "@/lib/session";
import { CLOCK_CHOICES } from "../field/clockTaps";
import { CATEGORY_LABELS, type TimerCategory } from "../field/fieldData";
import { fixTimesWrites, loadTime, saveFixTimes, type ClockEntry, type FixDraft } from "./clockData";
import styles from "./clock.module.css";

const draftOf = (e: ClockEntry, timeZone: string): FixDraft => ({ id: e.id, kind: e.category, start: localTime(new Date(e.started_at), timeZone), end: e.ended_at ? localTime(new Date(e.ended_at), timeZone) : "" });

export function FixTimesDialog({ userId, name, date: firstDate, pickDate = false, onClose }: { userId: string; name?: string; date: string; pickDate?: boolean; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const tz = session.company.timezone;
  const today = todayIn(tz);
  const isOffice = hasRole(session, "admin", "office") && can(session, "timesheets");
  const [date, setDate] = useState(firstDate);
  const day = useQuery({
    queryKey: ["time", session.company.id, "clock-day", userId, date],
    queryFn: () => loadTime({ companyId: session.company.id, userId, from: date, days: 1, timeZone: tz }),
  });
  const [drafts, setDrafts] = useState<FixDraft[] | null>(null);
  // The rows start as the day's entries, again whenever another day is picked.
  useEffect(() => {
    if (day.data) setDrafts(day.data.map((e) => draftOf(e, tz)));
  }, [day.data, tz]);
  // The row a problem is about, marked while the problem shows.
  const [problemRow, setProblemRow] = useState<number | null>(null);
  // Approved time is the office's to change.
  const locked = !isOffice && Boolean(day.data?.some((e) => e.approved_at));

  const save = useMutation({
    meta: { inline: true, success: t("Times saved") },
    mutationFn: async () => {
      const rows = drafts ?? [];
      const checked = checkFixTimes(rows, { date, today, timeZone: tz });
      setProblemRow(checked.ok ? null : (checked.row ?? null));
      if (!checked.ok) throw new Error(t(checked.problem));
      await saveFixTimes(session.company.id, userId, fixTimesWrites(day.data ?? [], rows, checked.blocks));
    },
    onSuccess: () => {
      for (const k of ["time", "running-timer", "crew-clock", "time-history"]) void queryClient.invalidateQueries({ queryKey: [k] });
      onClose();
    },
  });

  const change = (i: number, patch: Partial<FixDraft>) => setDrafts((d) => d && d.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const add = () =>
    setDrafts((d) => {
      const last = d?.at(-1);
      return [...(d ?? []), { kind: last && last.kind !== "break" ? last.kind : "washing", start: last?.end ?? "", end: "" }];
    });
  const remove = (i: number) => setDrafts((d) => d && d.filter((_, j) => j !== i));
  const dayName = new Date(`${date}T12:00:00Z`).toLocaleDateString(intlLocale(), { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
  const kindLabel = (kind: string) => t((CLOCK_KIND_LABELS as Record<string, string>)[kind] ?? CATEGORY_LABELS[kind as TimerCategory] ?? CLOCK_KIND_LABELS.shop);

  return (
    <Dialog open onClose={onClose} title={name ? t("Fix {name}'s times", { name }) : t("Fix times")} description={dayName}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        {pickDate && (
          <Field label={t("Day")}>
            <input className="input" type="date" value={date} max={today} onChange={(e) => {
              if (!e.target.value || e.target.value === date) return;
              setDrafts(null);
              setDate(e.target.value);
            }} required />
          </Field>
        )}
        {day.isPending && <Loading><Skeleton height={120} /></Loading>}
        {day.error && <ErrorState error={day.error} onRetry={() => day.refetch()} />}
        {drafts && (
          <>
            {locked && (
              <div className="callout callout-warning"><Icon name="alert" size={16} /><div className="grow">{t("Some of this day's time is approved. Ask the office to change it.")}</div></div>
            )}
            {drafts.length === 0 && <p className="muted">{t("Nothing on this day yet.")}</p>}
            {drafts.map((row, i) => (
              <div key={row.id ?? `new-${i}`} className={styles.fixRow} data-problem={(save.error && problemRow === i) || undefined}>
                <label>
                  {t("What")}
                  <select className="select" value={row.kind} disabled={locked} onChange={(e) => change(i, { kind: e.target.value })}>
                    {CLOCK_CHOICES.map((k) => <option key={k} value={k}>{t(CLOCK_KIND_LABELS[k])}</option>)}
                    {/* Time from before these kinds keeps its own until it's changed. */}
                    {!(CLOCK_CHOICES as readonly string[]).includes(row.kind) && <option value={row.kind}>{kindLabel(row.kind)}</option>}
                  </select>
                </label>
                <label>
                  {t("Start time")}
                  <input className="input" type="time" value={row.start} disabled={locked} onChange={(e) => change(i, { start: e.target.value })} />
                </label>
                <label>
                  {t("End time")}
                  <input className="input" type="time" value={row.end} disabled={locked} onChange={(e) => change(i, { end: e.target.value })} />
                </label>
                <Button variant="ghost" icon="x" aria-label={t("Remove this block")} disabled={locked} onClick={() => remove(i)} />
              </div>
            ))}
            <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
              <Button icon="plus" disabled={locked} onClick={add}>{t("Add a block")}</Button>
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>{t("Leave the end time empty only if you're still working.")}</p>
          </>
        )}
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!drafts || locked}>{t("Save times")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
