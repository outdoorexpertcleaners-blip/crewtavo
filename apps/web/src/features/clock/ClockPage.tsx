/**
 * The Clock, copied from the owner's own "OEC Time Clock" page.
 *
 * A tech sees their clock: what they're on and for how long, big buttons to clock in to Pressure
 * washing, Christmas lights or the shop, switch (a break too) or clock out, today's blocks with Fix
 * times, and the week's hours by kind. Breaks are never hours worked.
 *
 * The office (with the Timesheets area) sees the pay period instead: 14 days from a Monday, a card
 * for each person who keeps time with their clock and the punch buttons to clock them in or out, and
 * their hours by day and kind with a subtotal for each week. Tapping a day fixes that person's times
 * for it; "•" marks a day with time changed by hand (clockData.ts says what counts). The office can
 * switch to their own clock too. Pay rates and pay are never shown here (they're on Timesheets → Pay,
 * for the office with job costs).
 *
 * Punches are the same clock taps as the clock card: they wait on the phone with no signal, and the
 * database keeps one clock running per person (fieldActions.setClock).
 */
import { localDate } from "@crewtavo/core/time";
import { CLOCK_KIND_LABELS, hoursAndMinutes, hoursCell, payPeriodStart, PAY_PERIOD_DAYS, periodDays, sumTallies, tally, tallyByDay, timesheetCsvRows, weekStart, type ClockKind, type Tally } from "@crewtavo/core/timeclock";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { downloadCsv, toCsv } from "@/lib/csv";
import { addDaysIso, formatTime, todayIn } from "@/lib/format";
import { inEnglish, intlLocale, t } from "@/lib/i18n";
import { can, hasRole, keepsTime, useSession } from "@/lib/session";
import { CLOCK_CHOICES, crewAfter, waitingClockTaps, type ClockTarget, type CrewClockRow, type ShownClock } from "../field/clockTaps";
import { useRunningTimer } from "../field/fieldData";
import { memberName, type NamedMember } from "../subs/memberName";
import { handEditedDays, loadEdits, loadTime, usePunch, type ClockEntry } from "./clockData";
import { FixTimesDialog } from "./FixTimesDialog";
import styles from "./clock.module.css";

/** Someone on the team as GET /team?with_subs=1 gives them (no pay rates here). */
interface Member extends NamedMember {
  user_id: string;
  role: string;
  active: boolean;
}

/** The roles whose time the office keeps by default; anyone else shows once they have time in the period. */
const CREW_ROLES = ["field_crew", "crew_lead"];

/** Which of the four a running clock shows as (older kinds as Shop / other). */
const kindOf = (category: string): ClockKind => (category === "washing" || category === "lights" || category === "break" ? category : "shop");

/** "Mon Sep 28" in the language on screen. */
const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(intlLocale(), { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).replace(/,/g, "");
/** "Sep 28". */
const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(intlLocale(), { month: "short", day: "numeric", timeZone: "UTC" });

/** The time now, ticking every 30 seconds, for clocks still running. */
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function ClockPage() {
  const session = useSession();
  const isOffice = hasRole(session, "admin", "office") && can(session, "timesheets");
  const [view, setView] = useState<"team" | "mine">(isOffice ? "team" : "mine");
  const showTeam = isOffice && view === "team";
  return (
    <div className={styles.page}>
      <PageHeader
        title={t("Clock in")}
        actions={isOffice ? <Link className="btn btn-sm" to="/timesheets"><Icon name="clock" size={14} />{t("Approvals and pay")}</Link> : undefined}
      />
      {isOffice && keepsTime(session) && (
        <div className="segmented" role="group" aria-label={t("Whose time")}>
          <button type="button" aria-pressed={view === "team"} onClick={() => setView("team")}>{t("Team")}</button>
          <button type="button" aria-pressed={view === "mine"} onClick={() => setView("mine")}>{t("My clock")}</button>
        </div>
      )}
      {showTeam ? <TeamPeriod /> : keepsTime(session) ? <MyClock /> : <div className="card"><EmptyState icon="clock" title={t("The office doesn't keep your hours")} /></div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------------

/** The big colored buttons: clock in to one of three (clocked out), or switch to the others and clock out. */
function PunchButtons({ current, busy, small, onPunch }: { current: string | null; busy: boolean; small?: boolean; onPunch: (target: ClockTarget | null) => void }) {
  const choices = current ? CLOCK_CHOICES.filter((k) => k !== current) : CLOCK_CHOICES.filter((k) => k !== "break");
  return (
    <div className={cx(small && styles.small)}>
      <div className={styles.groupLabel}>{current ? t("Switch to") : t("Clock in to")}</div>
      <div className={styles.kinds}>
        {choices.map((k) => (
          <button key={k} type="button" className={cx(styles.kind, styles.kindButton)} data-kind={k} disabled={busy} onClick={() => onPunch({ category: k })}>
            {t(CLOCK_KIND_LABELS[k])}
          </button>
        ))}
      </div>
      {current && (
        <button type="button" className={styles.clockOut} disabled={busy} onClick={() => onPunch(null)}>
          <Icon name="pause" size={18} />
          {t("Clock out")}
        </button>
      )}
    </div>
  );
}

function KindChip({ category }: { category: string }) {
  const kind = kindOf(category);
  return <span className={cx(styles.kind, styles.chip)} data-kind={kind}>{t(CLOCK_KIND_LABELS[kind])}</span>;
}

// ---------------------------------------------------------------------------------------------
// A tech's own clock
// ---------------------------------------------------------------------------------------------

function MyClock() {
  const session = useSession();
  const tz = session.company.timezone;
  const today = todayIn(tz);
  const week = weekStart(today);
  const now = useNow();
  const timer = useRunningTimer(session.company.id, session.userId);
  const { punch, busy } = usePunch();
  const [fixing, setFixing] = useState<string | null>(null);
  const entries = useQuery({
    queryKey: ["time", session.company.id, "clock-week", session.userId, week],
    queryFn: () => loadTime({ companyId: session.company.id, userId: session.userId, from: week, days: 7, timeZone: tz }),
  });

  const running = timer.data ?? null;
  const firstName = (session.profile.full_name ?? "").trim().split(/\s+/)[0];
  const startedOn = running ? localDate(new Date(running.started_at), tz) : null;
  const blocks = withRunning(entries.data ?? [], running).filter((e) => localDate(new Date(e.started_at), tz) === today);
  const todayTally = tally(blocks, now);
  const weekTally = tally(withRunning(entries.data ?? [], running), now);
  const elapsedHours = running ? Math.max(0, (now - Date.parse(running.started_at)) / 3_600_000) : 0;
  const state = !running ? t("Clocked out") : running.category === "break" ? t("On break") : t(CLOCK_KIND_LABELS[kindOf(running.category)]);

  return (
    <>
      <section className="card">
        <div className={styles.status}>
          <div className={styles.eyebrow}>{firstName ? t("Hi {name}", { name: firstName }) : t("Hi")}</div>
          <div className={cx(styles.state, running && styles.kind)} data-kind={running ? kindOf(running.category) : undefined}>{state}</div>
          {running && (
            <>
              <div className={styles.timer} aria-live="polite">{`${Math.floor(elapsedHours)}h ${String(Math.floor((elapsedHours * 60) % 60)).padStart(2, "0")}m`}</div>
              <div className={styles.since}>{t("since {time}", { time: formatTime(running.started_at, tz) })}</div>
            </>
          )}
          {running && startedOn && startedOn < today && (
            <div className={styles.stale} style={{ marginTop: 12 }}>
              <span>{t("You're still clocked in from {day} at {time}. Set the time you actually stopped.", { day: dayLabel(startedOn), time: formatTime(running.started_at, tz) })}</span>
              <Button onClick={() => setFixing(startedOn)}>{t("Fix {day}'s times", { day: new Date(`${startedOn}T12:00:00Z`).toLocaleDateString(intlLocale(), { weekday: "short", timeZone: "UTC" }) })}</Button>
            </div>
          )}
          {!running && <div className={styles.pickHint}>{t("Pick what you're starting on")}</div>}
          <PunchButtons current={running?.category ?? null} busy={busy(session.userId)} onPunch={(target) => void punch(session.userId, target)} />
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <strong>{t("Today")}</strong>
          <Button size="sm" icon="edit" onClick={() => setFixing(today)}>{t("Fix times")}</Button>
        </div>
        {entries.isPending && <Loading><CardSkeleton lines={2} /></Loading>}
        {entries.error && <ErrorState compact error={entries.error} onRetry={() => entries.refetch()} />}
        {entries.data && (blocks.length === 0 ? (
          <div className={styles.empty}>{t("Nothing yet today.")}</div>
        ) : (
          <div className={styles.blocks}>
            {blocks.map((b) => (
              <div key={b.id} className={styles.block}>
                <KindChip category={b.category} />
                <span className={styles.span}>{formatTime(b.started_at, tz)} – {b.ended_at ? formatTime(b.ended_at, tz) : t("now")}</span>
                <span className={styles.length}>{hoursAndMinutes(((b.ended_at ? Date.parse(b.ended_at) : now) - Date.parse(b.started_at)) / 3_600_000)}</span>
              </div>
            ))}
          </div>
        ))}
        <div className={styles.worked}>{t("{time} worked", { time: hoursAndMinutes(todayTally.total) })}</div>
      </section>

      <section className="card">
        <div className="card-head"><strong>{t("This week · {from} – {to}", { from: shortDate(week), to: shortDate(addDaysIso(week, 6)) })}</strong></div>
        <WeekTiles tally={weekTally} />
      </section>

      {fixing && <FixTimesDialog userId={session.userId} date={fixing} onClose={() => setFixing(null)} />}
    </>
  );
}

/**
 * Someone's entries with their clock as this phone shows it on top: a punch still waiting for
 * signal has started a block the server doesn't have yet, which ends the one before it.
 */
function withRunning(entries: readonly ClockEntry[], running: ShownClock | null): Array<Pick<ClockEntry, "id" | "category" | "started_at" | "ended_at">> {
  if (!running?.id.startsWith("tap:")) return [...entries];
  const closed = entries.map((e) => (!e.ended_at && Date.parse(e.started_at) < Date.parse(running.started_at) ? { ...e, ended_at: running.started_at } : e));
  return [...closed, { id: running.id, category: running.category, started_at: running.started_at, ended_at: null }];
}

function WeekTiles({ tally: week }: { tally: Tally }) {
  const tiles: Array<{ label: string; hours: number; kind?: ClockKind }> = [
    { label: t("Total hours"), hours: week.total },
    { label: t(CLOCK_KIND_LABELS.washing), hours: week.washing, kind: "washing" },
    { label: t(CLOCK_KIND_LABELS.lights), hours: week.lights, kind: "lights" },
    { label: t(CLOCK_KIND_LABELS.shop), hours: week.shop, kind: "shop" },
  ];
  return (
    <div className={styles.tiles}>
      {tiles.map((tile) => (
        <div key={tile.label} className={cx(styles.tile, tile.kind && styles.kind)} data-kind={tile.kind}>
          <span className={styles.tileLabel}>{tile.label}</span>
          <span className={styles.tileValue}>{tile.hours.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The office: the team's pay period
// ---------------------------------------------------------------------------------------------

function TeamPeriod() {
  const session = useSession();
  const queryClient = useQueryClient();
  const tz = session.company.timezone;
  const today = todayIn(tz);
  const now = useNow();
  const [start, setStart] = useState(payPeriodStart(today));
  const [fixing, setFixing] = useState<{ userId: string; date: string; pick?: boolean } | null>(null);
  const days = periodDays(start);
  const data = useQuery({
    queryKey: ["time", session.company.id, "clock-period", start],
    queryFn: async () => {
      const [entries, team, edits] = await Promise.all([
        loadTime({ companyId: session.company.id, from: start, days: PAY_PERIOD_DAYS, timeZone: tz }),
        api.get<Member[]>("/team?with_subs=1"),
        loadEdits(session.company.id, start, PAY_PERIOD_DAYS, tz),
      ]);
      return { entries, team, edits };
    },
  });
  // Who's on the clock now, whenever they clocked in (a clock left running from before the period too).
  const running = useQuery({
    queryKey: ["time", session.company.id, "clock-running"],
    refetchInterval: 60_000,
    queryFn: async () =>
      unwrap(await supabase().from("time_entries").select("id, user_id, category, started_at").eq("company_id", session.company.id).is("ended_at", null).limit(500)).map((r) => ({ ...r, visit: null })) as CrewClockRow[],
  });
  const team = data.data?.team ?? [];
  const nameOf = (id: string) => memberName(team.find((m) => m.user_id === id), t("Team member"));
  const { punch, busy } = usePunch(nameOf);

  const entries = data.data?.entries ?? [];
  const people = [
    ...new Set([
      ...team.filter((m) => m.active && CREW_ROLES.includes(m.role)).map((m) => m.user_id),
      ...entries.map((e) => e.user_id),
      ...(running.data ?? []).map((r) => r.user_id),
    ]),
  ].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  // Punches still waiting on this phone show at once, over what the server last said.
  const clocks = crewAfter(running.data ?? [], people, waitingClockTaps(queryClient, session.company.id));
  const edited = handEditedDays(entries, data.data?.edits ?? [], tz);
  const sheets = people.map((userId) => {
    const mine = entries.filter((e) => e.user_id === userId);
    const byDay = tallyByDay(mine, days, tz, now);
    return { userId, name: nameOf(userId), byDay, total: sumTallies(Object.values(byDay)).total };
  });

  const exportCsv = () =>
    downloadCsv(
      `hours-${start}.csv`,
      inEnglish(() =>
        toCsv(
          timesheetCsvRows(sheets.map((s) => ({ name: s.name, days: days.map((date) => ({ date, tally: s.byDay[date]! })) }))) as unknown as Array<Record<string, unknown>>,
          [
            { key: "person", label: t("Person") }, { key: "date", label: t("Date") }, { key: "washing", label: t(CLOCK_KIND_LABELS.washing) },
            { key: "lights", label: t("Lights") }, { key: "shop", label: t("Shop") }, { key: "total", label: t("Total") },
          ],
        ),
      ),
    );

  return (
    <>
      <section className="card card-pad stack" style={{ gap: 10 }}>
        <div className={styles.cardTitle}>
          <strong>{t("Pay period")}</strong>
          <Button size="sm" icon="download" disabled={!sheets.some((s) => s.total > 0)} onClick={exportCsv}>{t("Download hours (CSV)")}</Button>
        </div>
        <div className={styles.periodNav}>
          <Button size="sm" icon="chevronLeft" aria-label={t("Previous pay period")} onClick={() => setStart(addDaysIso(start, -PAY_PERIOD_DAYS))} />
          <span className={styles.periodRange}>{shortDate(start)} – {shortDate(addDaysIso(start, PAY_PERIOD_DAYS - 1))}</span>
          <Button size="sm" icon="chevronRight" aria-label={t("Next pay period")} onClick={() => setStart(addDaysIso(start, PAY_PERIOD_DAYS))} />
          {start !== payPeriodStart(today) && <Button size="sm" variant="ghost" onClick={() => setStart(payPeriodStart(today))}>{t("This period")}</Button>}
        </div>
        <p className={styles.hint}>{t("Clock a tech in or out with the buttons, or tap a day to add or fix hours. • means times were changed by hand. Breaks are left out of the hours.")}</p>
      </section>

      {data.isPending && <Loading><div className="stack">{[0, 1].map((i) => <CardSkeleton key={i} lines={6} />)}</div></Loading>}
      {data.error && <div className="card"><ErrorState error={data.error} onRetry={() => data.refetch()} /></div>}
      {data.data && people.length === 0 && <div className="card"><EmptyState icon="clock" title={t("Nobody keeps time yet")} /></div>}

      {data.data && sheets.map((sheet) => {
        const clock = clocks.find((c) => c.user_id === sheet.userId) ?? null;
        const runningDay = clock ? localDate(new Date(clock.started_at), tz) : null;
        return (
          <section key={sheet.userId} className="card">
            <div className={styles.person}>
              <div className={styles.personHead}>
                <span className={styles.personName}>{sheet.name}</span>
                {clock ? <span className="chip chip-green">{t("Clocked in")}</span> : <span className="chip">{t("Clocked out")}</span>}
                <Button size="sm" icon="plus" onClick={() => setFixing({ userId: sheet.userId, date: today >= start && today <= days.at(-1)! ? today : start, pick: true })}>{t("Add hours")}</Button>
              </div>
              {clock && <div className="small muted">{t("{what} since {time}", { what: clock.category === "break" ? t("On break") : t(CLOCK_KIND_LABELS[kindOf(clock.category)]), time: formatTime(clock.started_at, tz) })}</div>}
              <PunchButtons small current={clock?.category ?? null} busy={busy(sheet.userId)} onPunch={(target) => void punch(sheet.userId, target)} />
              <div className={styles.periodTotal}>{t("Hours this period · {hours} total", { hours: sheet.total.toFixed(2) })}</div>
              <table className={styles.sheet}>
                <thead>
                  <tr>
                    <th>{t("Day")}</th>
                    <th>{t(CLOCK_KIND_LABELS.washing)}</th>
                    <th>{t("Lights")}</th>
                    <th>{t("Shop")}</th>
                    <th>{t("Total")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[0, 1].map((w) => {
                    const weekDays = days.slice(w * 7, w * 7 + 7);
                    const sum = sumTallies(weekDays.map((d) => sheet.byDay[d]!));
                    return [
                      ...weekDays.map((d) => {
                        const day = sheet.byDay[d]!;
                        const open = () => setFixing({ userId: sheet.userId, date: d });
                        const cells = [day.washing, day.lights, day.shop, day.total];
                        return (
                          <tr key={d} data-today={d === today || undefined}>
                            <td>
                              <button type="button" onClick={open} disabled={d > today} aria-label={t("Fix {name}'s times on {day}", { name: sheet.name, day: dayLabel(d) })}>
                                {dayLabel(d)}
                                {edited.has(`${sheet.userId}|${d}`) && <span className={styles.dot} title={t("Times changed by hand")}>•</span>}
                                {runningDay === d && <span className={styles.live} title={t("Clocked in now")} />}
                              </button>
                            </td>
                            {cells.map((h, i) => (
                              <td key={i} className={cx(i === 3 && styles.total)}>
                                <button type="button" tabIndex={-1} aria-hidden onClick={open} disabled={d > today}>
                                  {h >= 0.005 ? hoursCell(h) : <span className={styles.dash}>–</span>}
                                </button>
                              </td>
                            ))}
                          </tr>
                        );
                      }),
                      <tr key={`week-${w}`} className={styles.week}>
                        <td>{t("Week {number}", { number: w + 1 })}</td>
                        <td>{hoursCell(sum.washing)}</td>
                        <td>{hoursCell(sum.lights)}</td>
                        <td>{hoursCell(sum.shop)}</td>
                        <td>{hoursCell(sum.total)}</td>
                      </tr>,
                    ];
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {data.data && people.length > 0 && <p className={styles.hint}>{t("These are hours worked, by day. Pay rates and pay aren't shown here.")}</p>}

      {fixing && <FixTimesDialog userId={fixing.userId} name={nameOf(fixing.userId)} date={fixing.date} pickDate={fixing.pick} onClose={() => setFixing(null)} />}
    </>
  );
}
