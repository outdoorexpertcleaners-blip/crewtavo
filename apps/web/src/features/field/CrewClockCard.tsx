/**
 * For a crew lead on My day: the crew's clocks in one place. Clock everyone in (onto Pressure
 * washing, Christmas lights or the shop), switch them (to lunch and back) or clock them out with one
 * tap, or one person at a time. Their time lands on their own
 * timesheets, ready for the office.
 *
 * Its taps work with no signal, like the lead's own clock card: saved on the phone with when they
 * were tapped and sent in order (clockTaps.ts, fieldActions.setClock).
 */
import { onlineManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Spinner } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Skeleton";
import { initials } from "@/components/ui/Avatar";
import { supabase, unwrap } from "@/lib/api";
import { FIELD_SCOPE } from "@/lib/offline";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { useMyCrews } from "../schedule/myCrews";
import { useDispatchOptions } from "../schedule/VisitDialog";
import { CLOCK_CHOICES, clockChange, clockSaved, crewAfter, showClockTap, waitingClockTaps, type ClockChange, type ClockTarget, type CrewClockRow } from "./clockTaps";
import { CLOCK_KIND_LABELS } from "@crewtavo/core/timeclock";
import { CATEGORY_LABELS, clockPlace, formatDuration, type TimerCategory } from "./fieldData";
import { msg, t } from "@/lib/i18n";

interface VisitTarget { id: string; title: string; job: { id: string } | null; status: string }

/** `visits`: My day's visits. No longer offered as targets (the clock goes on a brand, not a visit); kept so My day needn't change. */
export function CrewClockCard(_props: { visits: VisitTarget[] }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const crews = useMyCrews();
  const options = useDispatchOptions();
  const mine = crews.data ?? [];
  const leads = (options.data?.crews ?? []).filter((c) => c.lead_user_id === session.userId && mine.includes(c.id));
  const crewIds = new Set(leads.map((c) => c.id));
  const people = [
    ...new Set([session.userId, ...(options.data?.crewMembers ?? []).filter((m) => crewIds.has(m.crew_id)).map((m) => m.user_id)]),
  ].filter((id) => options.data?.team.some((m) => m.user_id === id));
  const key = ["crew-clock", session.company.id, people.join(",")];
  const nameOf = (id: string) => options.data?.team.find((m) => m.user_id === id)?.profile?.full_name || t("Crew member");

  const running = useQuery({
    queryKey: key,
    enabled: people.length > 1,
    refetchInterval: 60_000,
    queryFn: async (): Promise<CrewClockRow[]> => {
      const rows = unwrap(
        await supabase()
          .from("time_entries")
          .select("id, user_id, category, started_at, visit:visits(id, title)")
          .eq("company_id", session.company.id)
          .in("user_id", people)
          .is("ended_at", null),
      );
      // With the taps still waiting on this phone on top: what the server says is older than those.
      return crewAfter(rows, people, waitingClockTaps(queryClient, session.company.id));
    },
  });

  // Sent by the action registered for it (fieldActions.ts), not a mutationFn here: lib/offline.ts
  // notes when it's on its way, for the count of updates waiting.
  const act = useMutation({
    mutationKey: ["clock"],
    scope: FIELD_SCOPE,
    meta: { success: (result: { lost: string[] }, change: ClockChange) => clockSaved(result, change, { nameOf }) },
    onMutate: (change: ClockChange) => {
      if (!onlineManager.isOnline()) toast.info(t("Saved on this phone"), { description: t("It sends when you have signal.") });
      showClockTap(queryClient, { key: "clock", change });
    },
    onSettled: () => {
      for (const k of ["crew-clock", "running-timer", "time", "field"]) queryClient.invalidateQueries({ queryKey: [k] });
    },
  });
  // Where the lead's phone is comes first (the crew is with them when they clock everyone in or
  // out) and can take a few seconds; the tap is dated before it.
  const [locating, setLocating] = useState<{ who: string[]; target: ClockTarget | null } | null>(null);
  const tap = async (who: string[], target: ClockTarget | null) => {
    const at = new Date().toISOString();
    setLocating({ who, target });
    const place = await clockPlace(session);
    setLocating(null);
    act.mutate(clockChange(session, who, target, place, at));
  };
  // The tap on its way. One waiting for signal isn't: the card is free for the next.
  const going = locating ?? (act.isPending && !act.isPaused && act.variables ? { who: act.variables.who, target: act.variables.target } : null);

  if (!leads.length) return null;
  if (options.isPending || crews.isPending || running.isPending) return <div className="card card-pad"><Skeleton height={80} /></div>;
  if (people.length < 2) return null;

  const entryOf = (id: string) => running.data?.find((r) => r.user_id === id);
  const off = people.filter((p) => !entryOf(p));
  const on = people.filter((p) => entryOf(p));
  // The owner's four (core/timeclock.ts): a break is lunch for the whole crew; clock them back onto the brand after.
  const targets: Array<{ label: string; target: ClockTarget }> = CLOCK_CHOICES.map((category) => ({ label: t(CLOCK_KIND_LABELS[category]), target: { category } }));
  const clockIn = (who: string[], label: string, text = label) => (
    <Menu
      label={label}
      triggerClassName="btn btn-sm"
      trigger={<>{going?.target && going.who.join() === who.join() ? <Spinner size={14} /> : <Icon name="play" size={14} />}{text}</>}
      items={targets.map((x) => ({ label: x.label, disabled: going !== null, onSelect: () => void tap(who, x.target) }))}
    />
  );

  return (
    <section className="card">
      <div className="card-head" style={{ flexWrap: "wrap", gap: 8 }}>
        <strong className="grow">{t("Crew clock")}</strong>
        {off.length > 0 && clockIn(off, off.length === people.length ? t("Clock everyone in") : t("Clock in {count} more", { count: off.length }))}
        {/* Everyone on the clock onto something else at once: lunch, and back onto the visit after. */}
        {on.length > 0 && clockIn(on, on.length === people.length ? t("Switch everyone") : t("Switch the {count} on the clock", { count: on.length }), t("Switch"))}
        {on.length > 0 && <Button size="sm" variant="dark" icon="pause" loading={going?.target === null && going.who.length > 1} onClick={() => void tap(on, null)}>{t("Clock everyone out")}</Button>}
      </div>
      {people.map((id) => {
        const entry = entryOf(id);
        const visit = entry?.visit;
        const name = nameOf(id);
        return (
          <div key={id} className="card-row">
            <span className="avatar" style={{ width: 30, height: 30, fontSize: 11, background: entry ? "var(--green-solid)" : "var(--fill-3)", color: entry ? "#fff" : "var(--text-2)" }}>{initials(name)}</span>
            <span className="grow" style={{ minWidth: 0 }}>
              <strong>{name}{id === session.userId ? t(" (you)") : ""}</strong>
              <span className="muted small" style={{ display: "block" }}>
                {entry ? `${visit?.title ?? t(CATEGORY_LABELS[entry.category as TimerCategory] ?? msg("Working"))} · ${formatDuration(Date.now() - Date.parse(entry.started_at))}` : t("Clock is off")}
              </span>
            </span>
            {entry ? (
              <Button size="sm" variant="ghost" icon="pause" aria-label={t("Clock out {name}", { name })} loading={going?.target === null && going.who.length === 1 && going.who[0] === id} onClick={() => void tap([id], null)} />
            ) : (
              clockIn([id], t("Clock in {name}", { name }), t("Clock in"))
            )}
          </div>
        );
      })}
    </section>
  );
}
