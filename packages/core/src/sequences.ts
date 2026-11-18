/**
 * Sequences: GoHighLevel-style workflows (supabase/migrations/20261118000100_sequences.sql). A client
 * goes through the steps one at a time; the engine (apps/api/src/services/sequences.ts) runs them.
 *
 * Steps, in order unless a step says where to go:
 *   wait   - wait so many minutes, then (optionally) until the next opening of a time window
 *   text   - text the client, from the Quo line of the sequence's brand
 *   alert  - text the office's alert number and notify the office in the app
 *   task   - make a task on the schedule, due so many days from now
 *   stage  - move the lead to a sales-board stage
 *   hours  - inside the hours, go on; outside them, go to another step
 *   goto   - go to another step
 *   end    - stop here
 *
 * What a reply does is the sequence's (on_reply): "hot" stops it, moves the lead to Hot Inbound Lead
 * and tells the office; "pause" holds it until someone resumes it (then the next text goes right
 * away, as GoHighLevel's resume follow-up tag does); "stop" just stops it.
 *
 * TEMPLATES are the business's GoHighLevel workflows as they were on Nov 17, 2026, word for word,
 * except that the call that rang Will and connected the lead is a text to the office instead (Quo's
 * API can't place calls), and any reply counts where GHL's AI judged "yes, let's schedule".
 */
import { isLeadStage, type Brand, type LeadStage } from "./pipeline";
import { zoneOffsetMs, zonedTimeToUtc } from "./time";

export const SEQUENCE_TRIGGERS = ["request.created", "quote.sent", "job.completed"] as const;
export type SequenceTrigger = (typeof SEQUENCE_TRIGGERS)[number];
export const TRIGGER_LABEL: Record<SequenceTrigger, string> = {
  "request.created": "A lead comes in",
  "quote.sent": "A quote is sent",
  "job.completed": "A job is completed",
};

export const ON_REPLY = ["hot", "pause", "stop"] as const;
export type OnReply = (typeof ON_REPLY)[number];
export const ON_REPLY_LABEL: Record<OnReply, string> = {
  hot: "Stop, move the lead to Hot Inbound Lead and tell the office",
  pause: "Pause until someone resumes it, and tell the office",
  stop: "Stop",
};

/** When texts may go, in the company's time zone. Days: 0 Sunday to 6 Saturday. */
export interface SendWindow {
  days: number[];
  start: string;
  end: string;
}

export type SequenceStep =
  | { kind: "wait"; minutes: number; window?: SendWindow | null }
  | { kind: "text"; body: string }
  | { kind: "alert"; body: string }
  | { kind: "task"; title: string; days: number }
  | { kind: "stage"; stage: LeadStage }
  | { kind: "hours"; start: string; end: string; otherwise: number }
  | { kind: "goto"; step: number }
  | { kind: "end" };

export type StepKind = SequenceStep["kind"];
export const STEP_LABEL: Record<StepKind, string> = {
  wait: "Wait",
  text: "Send SMS",
  alert: "Alert the office",
  task: "Create task",
  stage: "Move to stage",
  hours: "If business hours",
  goto: "Go to step",
  end: "End",
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const clampInt = (n: unknown, lo: number, hi: number, fallback: number) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};

export function sendWindow(raw: unknown): SendWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Partial<SendWindow>;
  const days = Array.isArray(w.days) ? [...new Set(w.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
  if (!days.length || typeof w.start !== "string" || typeof w.end !== "string" || !TIME.test(w.start) || !TIME.test(w.end) || w.start >= w.end) return null;
  return { days, start: w.start, end: w.end };
}

/** One step as kept, made safe: unknown kinds and bad values become something that does no harm. */
export function sequenceStep(raw: unknown): SequenceStep {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  switch (s.kind) {
    case "wait":
      return { kind: "wait", minutes: clampInt(s.minutes, 0, 60 * 24 * 90, 0), window: sendWindow(s.window) };
    case "text":
      return { kind: "text", body: text(s.body, 1600) };
    case "alert":
      return { kind: "alert", body: text(s.body, 1000) };
    case "task":
      return { kind: "task", title: text(s.title, 200), days: clampInt(s.days, 0, 365, 0) };
    case "stage":
      return { kind: "stage", stage: isLeadStage(s.stage as string) ? (s.stage as LeadStage) : "hot" };
    case "hours":
      return {
        kind: "hours",
        start: typeof s.start === "string" && TIME.test(s.start) ? s.start : "07:00",
        end: typeof s.end === "string" && TIME.test(s.end) ? s.end : "20:00",
        otherwise: clampInt(s.otherwise, 0, 200, 0),
      };
    case "goto":
      return { kind: "goto", step: clampInt(s.step, 0, 200, 0) };
    default:
      return { kind: "end" };
  }
}

export const sequenceSteps = (raw: unknown): SequenceStep[] => (Array.isArray(raw) ? raw.slice(0, 200).map(sequenceStep) : []);

const parts = (instant: Date, timeZone: string) => {
  const local = new Date(instant.getTime() + zoneOffsetMs(instant, timeZone));
  return { date: local.toISOString().slice(0, 10), time: local.toISOString().slice(11, 16), day: local.getUTCDay() };
};

/** Whether an instant is inside hours ("07:00" to "20:00", start included, end not) where the business is. */
export function inHours(instant: Date, start: string, end: string, timeZone: string): boolean {
  const { time } = parts(instant, timeZone);
  return time >= start && time < end;
}

/** Whether an instant is inside a window. No window: always. */
export function inWindow(instant: Date, window: SendWindow | null | undefined, timeZone: string): boolean {
  if (!window) return true;
  const { time, day } = parts(instant, timeZone);
  return window.days.includes(day) && time >= window.start && time < window.end;
}

/** The instant itself when it's inside the window, else the window's next opening. */
export function nextInWindow(instant: Date, window: SendWindow | null | undefined, timeZone: string): Date {
  if (!window || inWindow(instant, window, timeZone)) return instant;
  const { date, time, day } = parts(instant, timeZone);
  for (let ahead = 0; ahead <= 7; ahead++) {
    const d = (day + ahead) % 7;
    if (!window.days.includes(d)) continue;
    if (ahead === 0 && time >= window.start) continue;
    const day0 = new Date(`${date}T00:00:00Z`);
    day0.setUTCDate(day0.getUTCDate() + ahead);
    return zonedTimeToUtc(day0.toISOString().slice(0, 10), window.start, timeZone);
  }
  return instant;
}

/** What {{first_name}} and the rest fill in with. */
export interface SequenceVars {
  first_name?: string;
  name?: string;
  email?: string;
  phone?: string;
  owner_first_name?: string;
  company?: string;
  review_link?: string;
}
export const SEQUENCE_FILL_INS: Array<keyof SequenceVars> = ["first_name", "name", "email", "phone", "owner_first_name", "company", "review_link"];

/** The words with {{first_name}} and the rest filled in. A fill-in with nothing for it is left empty. */
export const fillSequence = (text: string, vars: SequenceVars) =>
  text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key: string) => ((SEQUENCE_FILL_INS as string[]).includes(key) ? (vars[key as keyof SequenceVars] ?? "") : whole));

export interface SequenceTemplate {
  key: string;
  name: string;
  brand: Brand | null;
  trigger: SequenceTrigger;
  on_reply: OnReply;
  send_window: SendWindow | null;
  steps: SequenceStep[];
}

const LEAD_ALERT = (brand: string) => `New ${brand} Lead!\n\nName: {{name}}\nEmail: {{email}}\nPhone: {{phone}}`;
const RESPONDED = 'Lead responded - {{name}} has been placed in "Hot Inbound Lead".\n\nPlease respond ASAP!\nName: {{name}}\nEmail: {{email}}\nPhone: {{phone}}';
const PAUSED = "Estimate follow-up paused: {{name}} replied. If it was just an acknowledgment, resume the follow-up on their quote to continue the texts.";
const MON_SAT_9_7: SendWindow = { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "19:00" };
const EVERY_DAY_9_5: SendWindow = { days: [0, 1, 2, 3, 4, 5, 6], start: "09:00", end: "17:00" };
const WEEKDAYS_1030_5: SendWindow = { days: [1, 2, 3, 4, 5], start: "10:30", end: "17:00" };

/**
 * The dialing workflow (PW / XL - Phone Dialing System & SMS): alert the office, text after the
 * voicemail would have been left, then "Let us know" and "Keep us posted"; after hours, one text
 * and a wait for the next weekday morning. A reply ends it (on_reply "hot").
 */
function dialing(brand: Brand): SequenceTemplate {
  const name = brand === "lights" ? "Outdoor Expert Lighting" : "Outdoor Expert Cleaners";
  const getStarted = brand === "lights" ? "we'll get started on your design." : "we'll get started on your estimate!";
  // Steps 0-9 in business hours; 10-12 after hours, which goes on at step 5 the next weekday morning.
  return {
    key: `dialing-${brand}`,
    name: brand === "lights" ? "XL - Phone Dialing System & SMS Christmas Lights" : "PW - Phone Dialing System & SMS",
    brand,
    trigger: "request.created",
    on_reply: "hot",
    send_window: null,
    steps: [
      { kind: "hours", start: "07:00", end: "20:00", otherwise: 10 },
      { kind: "alert", body: LEAD_ALERT(brand === "lights" ? "Christmas" : "Business") + "\n\nCall them from Quo now." },
      { kind: "wait", minutes: 10, window: null },
      { kind: "text", body: `Hey {{first_name}}!\n\nThis is {{owner_first_name}} with ${name}, we left you a voicemail as well.\n\nFeel free to reach back out at your earliest convenience, and ${getStarted}` },
      { kind: "wait", minutes: 60, window: null },
      { kind: "text", body: "Let us know, happy to help!" },
      { kind: "wait", minutes: 120, window: null },
      { kind: "wait", minutes: 60 * 24, window: EVERY_DAY_9_5 },
      { kind: "text", body: "Keep us posted!" },
      { kind: "end" },
      { kind: "text", body: `Hey {{first_name}}!\n\nThis is {{owner_first_name}} with ${name}. We just saw your form come in after business hours, but I wanted to shoot you a text to show you we're on it!\n\nHow does your schedule look tomorrow after 9am to chat and get your estimate dialed in?` },
      { kind: "alert", body: LEAD_ALERT(brand === "lights" ? "Christmas" : "Business") + "\n\nCame in after hours: they've been texted." },
      { kind: "wait", minutes: 60, window: WEEKDAYS_1030_5 },
      { kind: "goto", step: 5 },
    ],
  };
}

function followUp(brand: Brand): SequenceTemplate {
  const lights = brand === "lights";
  return {
    key: `follow-up-${brand}`,
    name: lights ? "XL - Estimate Follow-Up - Christmas Lights" : "PW - Estimate Follow-Up - Pressure Washing",
    brand,
    trigger: "quote.sent",
    on_reply: "pause",
    send_window: MON_SAT_9_7,
    steps: [
      { kind: "wait", minutes: 60 * 24, window: null },
      {
        kind: "text",
        body: lights
          ? "Hi {{first_name}}, it's Will with Outdoor Expert Lighting. Thanks again for having me out! Any questions on your Christmas lights estimate, just reply here."
          : "Hi {{first_name}}, it's Will with Outdoor Expert Cleaners. Thanks again for having me out! Any questions on your estimate at all, just reply here.",
      },
      { kind: "wait", minutes: 60 * 24 * 2, window: null },
      {
        kind: "text",
        body: lights
          ? "Hey {{first_name}}, any questions about your light design or pricing? Happy to tweak anything."
          : "Hey {{first_name}}, any questions on the estimate? Happy to adjust anything, since you can pick and choose which services you want.",
      },
      { kind: "wait", minutes: 60 * 24 * 4, window: null },
      {
        kind: "text",
        body: lights
          ? "Hi {{first_name}}, install dates are filling up fast for the season. Want me to lock in your spot before the holidays?"
          : "Hi {{first_name}}, our schedule is filling up for the next few weeks. Want me to save you a spot?",
      },
      { kind: "wait", minutes: 60 * 24 * 7, window: null },
      {
        kind: "text",
        body: lights
          ? "Hey {{first_name}}, last check-in from me! Should I hold your install spot, or close the estimate out for now?"
          : "Hey {{first_name}}, I don't want to keep bugging you! Should I close out your estimate for now, or keep it open?",
      },
      { kind: "wait", minutes: 60 * 24 * 3, window: null },
      { kind: "task", title: "Estimate follow-up finished with no reply - call or text manually: {{name}}", days: 1 },
    ],
  };
}

function reviewRequest(brand: Brand): SequenceTemplate {
  const lights = brand === "lights";
  return {
    key: `review-${brand}`,
    name: lights ? "XL - Review Request - Christmas Lights" : "PW - Review Request - Pressure Washing",
    brand,
    trigger: "job.completed",
    on_reply: "stop",
    // Lights: in the evening, when the lights are on.
    send_window: lights ? { days: [0, 1, 2, 3, 4, 5, 6], start: "18:00", end: "20:30" } : { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "17:00" },
    steps: [
      { kind: "wait", minutes: 60 * 12, window: null },
      {
        kind: "text",
        body: lights
          ? "Hi {{first_name}}, this is Will with Outdoor Expert Lighting. Hope you're enjoying the lights. If you have a minute, a quick Google review would mean a lot to our small business (a nighttime photo of the lights is a bonus): {{review_link}}"
          : "Hi {{first_name}}, this is Will with Outdoor Expert Cleaners. Thanks for having us out. If you have a minute, a quick Google review would mean a lot to our small business: {{review_link}}",
      },
      { kind: "wait", minutes: 60 * 48, window: null },
      {
        kind: "text",
        body: lights
          ? "Hi {{first_name}}, friendly reminder from Outdoor Expert Lighting. If you get a chance tonight, we'd really appreciate a quick Google review, and photos of the lights are always welcome: {{review_link}} Thank you."
          : "Hi {{first_name}}, just a friendly reminder from Outdoor Expert Cleaners. If you get a chance, we'd really appreciate a quick Google review: {{review_link}} Thank you.",
      },
      { kind: "wait", minutes: 60 * 96, window: null },
      {
        kind: "text",
        body: lights
          ? "Hi {{first_name}}, last nudge from us. A Google review takes about 30 seconds and really helps our small business: {{review_link}} Merry Christmas from the Outdoor Expert Lighting crew."
          : "Hi {{first_name}}, last nudge from us. A Google review takes about 30 seconds and really helps a small local business like ours: {{review_link}} Thanks again for choosing Outdoor Expert Cleaners.",
      },
    ],
  };
}

export const SEQUENCE_TEMPLATES: SequenceTemplate[] = [dialing("washing"), dialing("lights"), followUp("washing"), followUp("lights"), reviewRequest("washing"), reviewRequest("lights")];

/** The alert that tells the office a lead replied, for on_reply "hot". */
export const RESPONDED_ALERT = RESPONDED;
/** The alert that tells the office a follow-up paused, for on_reply "pause". */
export const PAUSED_ALERT = PAUSED;

/**
 * Whether a run should go on, by the record it's about, as GoHighLevel's stop workflows decided:
 * a lead's texts stop once it's moved past Inbound Lead or has a quote; a follow-up once the quote
 * is answered; a review request runs to its end.
 */
export function stillGoing(trigger: SequenceTrigger, subject: { status?: string | null; stage?: string | null } | null): { going: boolean; why?: string } {
  if (!subject) return { going: false, why: "The record was deleted" };
  if (trigger === "request.created") {
    if (!["new", "assessment_scheduled", "assessment_complete"].includes(subject.status ?? "")) return { going: false, why: "The lead has a quote now, or was archived" };
    if (subject.stage && subject.stage !== "inbound") return { going: false, why: "The lead was moved past Inbound Lead" };
    return { going: true };
  }
  if (trigger === "quote.sent") {
    if (!["sent", "changes_requested"].includes(subject.status ?? "")) return { going: false, why: "The quote was answered" };
    return { going: true };
  }
  return { going: true };
}

/** How long a wait is, in words: "10 minutes", "1 day", "2 hours". */
export function waitWords(minutes: number): string {
  if (minutes % (60 * 24) === 0 && minutes > 0) return `${minutes / (60 * 24)} ${minutes === 60 * 24 ? "day" : "days"}`;
  if (minutes % 60 === 0 && minutes > 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}
