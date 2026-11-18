/**
 * Field crew see the whole team's schedule, and a visit opened from it comes here even when they're
 * not on it. Then they only look: On my way, Start and Complete are for the people on the visit (the
 * database lets only them change it, visits_update_assigned), so those buttons aren't offered.
 */
import { onVisit, type VisitCrewAndPeople } from "@crewtavo/core/visitPeople";

/**
 * Whether this person is only looking at a visit: field crew who aren't on it (not listed, and with
 * nobody listed, not on its crew). Undefined crews (still loading, or no signal) count as on it, so
 * My day's own visits never lose their buttons while that loads.
 */
export function onlyLooking(session: { role: string; userId: string }, visit: VisitCrewAndPeople, myCrews: readonly string[] | undefined): boolean {
  if (session.role !== "field_crew" || !myCrews) return false;
  return !onVisit(visit, session.userId, new Map(myCrews.map((crew) => [crew, [session.userId]])));
}
