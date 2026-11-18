/**
 * Settings → Client notifications, Jobber's list of what a business sends its clients by itself.
 * Each switch is one automation rule: the starter rule every business gets
 * (private.install_default_automations, latest in 20261119000200_on_my_way_from_the_tech.sql, and for a visit
 * booked, moved or cancelled private.install_visit_notice_rules in
 * 20261113000510_visit_notice_rules.sql), so a deleted one comes back from the recipe here, word
 * for word.
 */
import { VISIT_MOVED_WORDS, VISIT_NOTICE_SETTLE_MIN } from "@crewtavo/core/automations";
import { AUTOMATED_CAMPAIGNS, type StarterRule } from "@crewtavo/core/campaigns";
import { askRuleUpdate } from "@crewtavo/core/marketing";
import type { RuleRow } from "../automations/AutomationsPage";

export interface ClientNotification {
  label: string;
  recipe: Omit<StarterRule, "description"> & { description: string | null };
  /** Not one of the starters every business gets: it's made the first time it's turned on. */
  added?: boolean;
  /** About one of the client's own visits: these are shown together, in the order they happen. */
  visit?: boolean;
  /** When it goes and when it doesn't, in more words than the rule's sentence has. */
  note?: string;
}

const SETTLES = `Goes ${VISIT_NOTICE_SETTLE_MIN} minutes after the change, with the visit as it is by then, so changing your mind sends one message or none.`;

export const CLIENT_NOTIFICATIONS: ClientNotification[] = [
  {
    label: "Request received",
    added: true,
    recipe: {
      template_key: "request_received",
      name: "Tell clients their request came in",
      description: "Sent when someone asks for work from a booking or website form, the Client Hub or a referral.",
      trigger: "request.created",
      delay_minutes: 0,
      // Not for requests the office types in: the client already knows.
      conditions: [{ field: "source", op: "in", value: ["web_form", "hub", "referral"] }],
      actions: [
        {
          type: "send_email",
          subject: "{{company.name}} got your request",
          body: "Hi {{client.first_name}},\n\nThanks for reaching out. We got your request and will be in touch soon about the next step.\n\nQuestions? Reply to this email or call {{company.phone}}.\n\n{{company.name}}",
        },
      ],
      enabled: false,
    },
  },
  {
    label: "Visit booked",
    visit: true,
    note: `When a visit or assessment goes on the schedule. Not for the visits a recurring job makes: those get the reminder. ${SETTLES}`,
    recipe: {
      template_key: "visit_scheduled",
      name: "Tell clients when a visit is booked",
      description: "Sent ten minutes after a visit or assessment goes on the schedule, with the time it has by then. Not for the visits a recurring job makes.",
      trigger: "visit.scheduled",
      delay_minutes: 0,
      conditions: [],
      actions: [
        {
          type: "send_email",
          subject: "Your visit with {{company.name}} is booked for {{date}}",
          body: "Hi {{client.first_name}},\n\nYour {{title}} visit is booked for {{date}}{{time}}.\n\nYou can see your visits, and ask to move one, here:\n\n{{link}}\n\nQuestions? Reply to this email or call {{company.phone}}.\n\n{{company.name}}",
        },
      ],
      enabled: false,
    },
  },
  {
    label: "Visit moved",
    visit: true,
    note: `${VISIT_MOVED_WORDS} Changing a recurring job's whole schedule doesn't message anyone either. ${SETTLES}`,
    recipe: {
      template_key: "visit_rescheduled",
      name: "Tell clients when a visit is moved",
      description: "Sent ten minutes after a visit moves to another day, or its start time changes by an hour or more.",
      trigger: "visit.rescheduled",
      delay_minutes: 0,
      conditions: [],
      actions: [
        {
          type: "send_email",
          subject: "Your visit with {{company.name}} has moved to {{date}}",
          body: "Hi {{client.first_name}},\n\nYour {{title}} visit has moved. It was {{old.date}}{{old.time}} and is now {{date}}{{time}}.\n\nIf that doesn't suit you, you can ask for another time here:\n\n{{link}}\n\nQuestions? Reply to this email or call {{company.phone}}.\n\n{{company.name}}",
        },
      ],
      enabled: false,
    },
  },
  {
    label: "Visit cancelled",
    visit: true,
    note: `When a visit still to come is cancelled, deleted or taken off the schedule. Not when a recurring job is paused, closed or its schedule changed. ${SETTLES}`,
    recipe: {
      template_key: "visit_cancelled",
      name: "Tell clients when a visit is cancelled",
      description: "Sent ten minutes after a visit still to come is cancelled, deleted or taken off the schedule.",
      trigger: "visit.cancelled",
      delay_minutes: 0,
      conditions: [],
      actions: [
        {
          type: "send_email",
          subject: "Your visit with {{company.name}} on {{date}} is cancelled",
          body: "Hi {{client.first_name}},\n\nYour {{title}} visit on {{date}}{{time}} is cancelled.\n\nQuestions, or want another time? Reply to this email or call {{company.phone}}.\n\n{{company.name}}",
        },
      ],
      enabled: false,
    },
  },
  {
    label: "Visit and assessment reminders",
    visit: true,
    note: "From 8 in the morning the day before, for every visit and assessment, a recurring job's too. A visit moved to another day after its reminder went gets one for its new day.",
    recipe: {
      template_key: "visit_reminder",
      name: "Remind clients the day before a visit",
      description: "Sent the day before each scheduled visit or assessment.",
      trigger: "visit.reminder",
      delay_minutes: 0,
      conditions: [],
      actions: [
        {
          type: "send_email",
          subject: "Reminder: {{company.name}} is coming {{date}}",
          body: "Hi {{client.first_name}},\n\nThis is a reminder that {{company.name}} is scheduled to visit {{address}} on {{date}}{{time}}.\n\nQuestions? Reply to this email or call {{company.phone}}.",
        },
      ],
      enabled: false,
    },
  },
  {
    label: "On my way",
    visit: true,
    recipe: {
      template_key: "on_my_way",
      name: "Text the client when the crew is on the way",
      description: "Sent when a crew taps “On my way” in the app.",
      trigger: "visit.en_route",
      delay_minutes: 0,
      conditions: [],
      // From the person who tapped it and the job's brand, from that brand's line. {{eta_there}}: " and
      // should be there in about 20 minutes", or nothing when that isn't known. With no name it reads
      // "this is Outdoor Expert Cleaners" (core renderTemplate).
      actions: [{ type: "send_sms", body: "Hi {{client.first_name}}, this is {{tech.first_name}} with {{brand.name}}. I'm on my way{{eta_there}}." }],
      enabled: false,
    },
  },
  { label: "Quote follow-up", recipe: AUTOMATED_CAMPAIGNS.close_quotes.starter },
  {
    label: "Invoice follow-up",
    recipe: {
      template_key: "invoice_overdue",
      name: "Remind clients when an invoice is past due",
      description: null,
      trigger: "invoice.overdue",
      delay_minutes: 0,
      conditions: [],
      actions: [
        {
          type: "send_email",
          subject: "Reminder: invoice #{{number}} from {{company.name}} is past due",
          body: "Hi {{client.first_name}},\n\nThis is a friendly reminder that invoice #{{number}} has a balance of {{balance}}. You can view and pay it here:\n\n{{link}}\n\nThank you,\n{{company.name}}",
        },
      ],
      enabled: true,
    },
  },
  // Marketing → Reviews edits the same rule.
  { label: "Review request after a job", recipe: askRuleUpdate(null, "after_job", { when: "job.completed", channel: "email", enabled: false }) as StarterRule },
];

type Rule = Pick<RuleRow, "id" | "template_key" | "trigger" | "actions" | "enabled">;

// The starter itself (its template_key), or else the first rule on the same trigger with the same kind of action.
export const ruleFor = <R extends Rule>(n: ClientNotification, rules: R[]): R | undefined =>
  rules.find((r) => r.template_key === n.recipe.template_key) ??
  rules.find((r) => r.trigger === n.recipe.trigger && r.actions.some((a) => a.type === n.recipe.actions[0]!.type));

/** Whether a rule emails the client, or texts them (a review ask does either or both). */
export const sendsEmail = (r: Pick<Rule, "actions">) => r.actions.some((a) => a.type === "send_email" || (a.type === "request_review" && a.channel !== "sms"));
export const sendsText = (r: Pick<Rule, "actions">) => r.actions.some((a) => a.type === "send_sms" || (a.type === "request_review" && a.channel !== "email"));

/**
 * The business's own rules that message a client about a visit, beyond the switches above (a
 * second reminder by text, a thank-you after each visit), so the screen shows every message a
 * client can get about one. Not the rules about a client's own request to move or cancel, which
 * are the office's.
 */
export const otherVisitRules = <R extends Rule>(rules: R[], shown: ReadonlyArray<R | undefined>): R[] =>
  rules.filter((r) => r.trigger.startsWith("visit.") && !r.trigger.endsWith("_requested") && (sendsEmail(r) || sendsText(r)) && !shown.some((s) => s?.id === r.id));

/** How a rule reaches the client, for its row: "Email", "Text" or "Email and text". */
export function channelsOf(r: Pick<Rule, "actions">): string {
  const email = sendsEmail(r);
  const text = sendsText(r);
  return email && text ? "Email and text" : text ? "Text" : email ? "Email" : "No message";
}
