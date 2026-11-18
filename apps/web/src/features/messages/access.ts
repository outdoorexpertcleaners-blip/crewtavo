/**
 * What Messages offers to whom. The whole team reads the inbox, texts from unknown numbers included:
 * on a job the crew deals with the client directly (gate codes, "can you move the truck?"). Field
 * crew and crew leads reply by text or add a note; email stays the office's and sales'
 * (routes/messages.ts textsOnly holds the server to the same). Attaching an unknown number to a
 * client is for whoever may edit clients (public.attach_unknown_texts), deleting its texts for the
 * office.
 */
import { hasRole } from "@/lib/session";

type Who = Parameters<typeof hasRole>[0];

/** Whether this person replies by text (and notes) only, without the Email tab. */
export const repliesByTextOnly = (session: Who) => !hasRole(session, "admin", "office", "estimator");

/** Who sees texts from unknown numbers: the whole team (the database holds to the same). */
export const seesUnknownNumbers = (session: Who) => hasRole(session, "admin", "office", "estimator", "crew_lead", "field_crew");

/** Who attaches an unknown number to a client. */
export const attachesUnknownNumbers = (session: Who) => hasRole(session, "admin", "office", "estimator");
