/**
 * My day's visits: today's and tomorrow's, the ones this person is on. Read by My day, and by the
 * clock at the property (geofence.ts) on My day and on a visit's own screen. Kept on the phone for
 * no signal (lib/offline.ts keeps "field").
 */
import { crewPeople, onVisit } from "@crewtavo/core/visitPeople";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, supabase, unwrap } from "@/lib/api";
import { addDaysIso, todayIn } from "@/lib/format";
import { isSub, useSession } from "@/lib/session";
import type { VisitContact } from "./contact";
import { pendingVisitStatus } from "./fieldActions";

export interface MyDayVisit {
  id: string;
  title: string;
  kind: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  scheduled_on: string | null;
  route_order: number | null;
  hold_reason: string | null;
  crew_id: string | null;
  job: { id: string; number: number; title: string; client: { display_name: string } | null } | null;
  property: { id: string; line1: string; line2?: string | null; city: string | null; region?: string | null; postal_code?: string | null; lat: number | null; lng: number | null } | null;
  /** Where an entry with no client property is (a task). */
  address?: string | null;
  assignees: Array<{ user_id: string }>;
  series_day: number | null;
  series_total: number | null;
  /** For a sub, who can't read clients: the client's name (visit_contact()). */
  contact?: VisitContact | null;
  /**
   * This person is on it by the one rule (core visitPeople): listed, or on its crew with nobody
   * listed. A sub is sent only their own visits. Undefined in a copy kept from before this was added.
   */
  mine?: boolean;
}

export const myDayKey = (companyId: string, today: string) => ["field", companyId, today];

/** The day's order: the route the office or crew lead set (Organize route), else timed visits by time, then the rest. */
export const dayOrder = (a: Pick<MyDayVisit, "route_order" | "starts_at">, b: Pick<MyDayVisit, "route_order" | "starts_at">) =>
  a.route_order != null && b.route_order != null
    ? a.route_order - b.route_order
    : a.starts_at && b.starts_at
      ? a.starts_at.localeCompare(b.starts_at)
      : a.starts_at
        ? -1
        : b.starts_at
          ? 1
          : (a.route_order ?? 999) - (b.route_order ?? 999);

/** `enabled` false: nothing is fetched (the clock at the property on a screen whose company has it off). */
export function useMyDay(enabled = true) {
  const session = useSession();
  const queryClient = useQueryClient();
  const today = todayIn(session.company.timezone);
  return useQuery({
    queryKey: myDayKey(session.company.id, today),
    enabled,
    refetchInterval: 60_000,
    queryFn: async () => {
      const [schedule, crews] = await Promise.all([
        api.get<{ visits: MyDayVisit[] }>(`/schedule?from=${today}&to=${addDaysIso(today, 1)}`),
        supabase().from("crew_members").select("crew_id").eq("user_id", session.userId),
      ]);
      // The visits I'm on: the ones I'm listed on, and my crews' visits with nobody listed (visitPeople).
      // A crew's visit with other people listed still shows to a foreman or the office, as it always
      // has. Field crew are sent the whole team's schedule now (to look at it on Schedule), so My day
      // keeps to the visits they're on.
      const myCrews = crewPeople(unwrap(crews).map((c) => ({ crew_id: c.crew_id, user_id: session.userId })));
      const crewsToo = session.role !== "field_crew";
      const mine = schedule.visits
        .map((v) => ({ ...v, mine: isSub(session) || onVisit(v, session.userId, myCrews) }))
        .filter((v) => v.status !== "cancelled" && (v.mine || (crewsToo && Boolean(v.crew_id && myCrews.has(v.crew_id)))))
        .map((v) => ({ ...v, status: pendingVisitStatus(queryClient, v.id) ?? v.status }));
      return { today: mine.filter((v) => v.scheduled_on === today), tomorrow: mine.filter((v) => v.scheduled_on !== today && !["completed", "cancelled"].includes(v.status)) };
    },
  });
}
