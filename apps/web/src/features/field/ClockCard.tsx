/**
 * The running clock: what I'm on, for how long, and start/stop/switch. Used on My day and Timesheets.
 * On My day it also offers the visits under way, to clock back onto one after a break. Not there for
 * a sub unless the office keeps their hours.
 *
 * On the whole-day clock (Settings → Company → Time clock) it runs between visits too, on the job's
 * brand, so the way to end the day is here: Stop for the day.
 *
 * What it switches to are the owner's four (core/timeclock.ts): Pressure washing, Christmas lights,
 * Shop / other and a break. A visit isn't one of them: the visit's own buttons put the clock on its
 * brand. The Clock screen (features/clock) is the full version of this card.
 *
 * Its taps work with no signal, like a visit's: each is saved on the phone with when it was tapped
 * and sent in order when there's signal (clockTaps.ts, fieldActions.setClock), and the card shows
 * what the waiting taps will do.
 */
import { onlineManager, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Spinner } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { FIELD_SCOPE } from "@/lib/offline";
import { hasRole, keepsTime, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { CLOCK_CHOICES, clockChange, clockSaved, showClockTap, type ClockChange, type ClockTarget } from "./clockTaps";
import { CATEGORY_LABELS, clockPlace, onDayClock, recordsPlaces, useElapsed, useRunningTimer, type TimerCategory } from "./fieldData";
import { CLOCK_KIND_LABELS } from "@crewtavo/core/timeclock";
import { LocationNotice } from "./LocationNoticeDialog";
import { msg, t } from "@/lib/i18n";

interface VisitUnderWay { id: string; title: string; job_id: string | null }

/** `visits`: the visits under way on My day. No longer offered (the clock goes on their brand); kept so My day needn't change. */
export function ClockCard(_props: { visits?: VisitUnderWay[] }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const clocks = keepsTime(session);
  const day = onDayClock(session);
  const timer = useRunningTimer(session.company.id, session.userId, clocks);
  const elapsed = useElapsed(timer.data?.started_at);
  // Sent by the action registered for it (fieldActions.ts), not a mutationFn here: lib/offline.ts
  // notes when it's on its way, for the count of updates waiting.
  const action = useMutation({
    mutationKey: ["clock"],
    scope: FIELD_SCOPE,
    meta: { success: (result: { lost: string[] }, change: ClockChange) => clockSaved(result, change, { day }) },
    onMutate: (change: ClockChange) => {
      if (!onlineManager.isOnline()) toast.info(t("Saved on this phone"), { description: t("It sends when you have signal.") });
      showClockTap(queryClient, { key: "clock", change });
    },
    onSettled: () => {
      for (const k of ["running-timer", "time", "field", "field-visit", "crew-clock"]) queryClient.invalidateQueries({ queryKey: [k] });
    },
  });
  // Finding where the phone is comes first and can take a few seconds; the tap is dated before it.
  const [locating, setLocating] = useState<"stop" | "start" | null>(null);
  const tap = async (target: ClockTarget | null) => {
    const at = new Date().toISOString();
    setLocating(target ? "start" : "stop");
    const place = await clockPlace(session);
    setLocating(null);
    action.mutate(clockChange(session, [session.userId], target, place, at));
  };
  const visit = timer.data?.visit as { id: string; title: string } | null | undefined;
  const on = Boolean(timer.data);
  // Which tap is on its way. One waiting for signal isn't: the card is free for the next.
  const going = locating ?? (action.isPending && !action.isPaused ? (action.variables?.target ? "start" : "stop") : null);
  if (!clocks) return null;
  return (
    <div className="card card-pad row wrap" style={{ gap: 12, background: on ? "var(--green-tint)" : undefined, borderColor: on ? "transparent" : undefined, transition: "background var(--dur), border-color var(--dur)" }}>
      {/* What's saved about where they are, said once before the first tap that would save it. */}
      <LocationNotice />
      <span className="avatar" style={{ width: 40, height: 40, background: on ? "var(--green-solid)" : "var(--fill-3)", color: on ? "#fff" : "var(--text-2)" }}><Icon name="clock" size={20} /></span>
      <div className="grow">
        {on ? (
          <>
            <div className="strong">{visit ? visit.title : t(CATEGORY_LABELS[timer.data!.category as TimerCategory] ?? msg("Working"))}</div>
            <div className="small" style={{ color: "var(--green-dark)" }}>{t("Clock running · {elapsed}", { elapsed })}</div>
            {day && <div className="small muted">{t("It runs between visits too, until you stop for the day.")}</div>}
          </>
        ) : (
          <>
            <div className="strong">{t("Clock is off")}</div>
            {day && <div className="small muted">{t("On my way or Start visit starts your day.")}</div>}
            {recordsPlaces(session.company) && !hasRole(session, "admin", "office") && <div className="small muted">{t("Clocking in and out saves where you are, for the office.")}</div>}
          </>
        )}
      </div>
      {on && <Button variant="dark" icon="pause" loading={going === "stop"} disabled={going === "start"} onClick={() => void tap(null)}>{day ? t("Stop for the day") : t("Stop")}</Button>}
      <Menu
        label={t("Start a timer")}
        triggerClassName="btn"
        trigger={<>{going === "start" ? <Spinner size={16} /> : <Icon name="play" size={16} />}{on ? t("Switch") : t("Start timer")}</>}
        items={CLOCK_CHOICES.filter((c) => !on || c !== timer.data?.category).map((c) => ({ label: t(CLOCK_KIND_LABELS[c]), disabled: going !== null, onSelect: () => void tap({ category: c }) }))}
      />
    </div>
  );
}
