import { isStaff, type Permission } from "@crewtavo/core/roles";
import { can, hasRole, type Session } from "@/lib/session";
import type { IconName } from "../ui/Icon";
import { msg, t } from "@/lib/i18n";

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  roles?: string[]; // limit to these access levels (owners always see everything)
  perm?: Permission | Permission[]; // and to roles that include this area (all of them, for a list)
  only?: string[]; // only these access levels, owners included (e.g. "My day" for crews); a sub sees nothing else
  except?: string[]; // screens under this one that are a section of their own (not highlighted here)
  also?: string[]; // other screens that count as this section (highlighted in the sidebar)
  keywords?: string; // other words people search for it by
  feature?: "team_chat" | "website" | "careers" | "drive" | "marketing" | "paving_app" | "roofing_app" | "snow_app"; // only while the business has this app on (Apps)
  foot?: boolean; // kept with Settings at the sidebar's foot, in view however long the list is
}

/**
 * Kept short on purpose: the day first, then the everyday work, the trade apps the business turned
 * on, and the tools for running it. Setup screens (automations, online booking) live in Settings,
 * the sales board and map measuring open from Quotes.
 */
export const NAV_GROUPS: NavItem[][] = [
  [
    { to: "/", label: msg("Home"), icon: "home", keywords: "dashboard today overview" },
    { to: "/field", label: msg("My day"), icon: "clock", only: ["crew_lead", "field_crew", "subcontractor"], except: ["/field/paperwork", "/field/jobs"], keywords: "today my visits route" },
    { to: "/field/jobs", label: msg("My jobs"), icon: "job", only: ["subcontractor"], keywords: "offers accept decline take turn down price owed paid 1099 total" },
    { to: "/field/paperwork", label: msg("My paperwork"), icon: "file", only: ["subcontractor"], keywords: "w-9 w9 insurance certificate liability workers comp upload send" },
    { to: "/clock", label: msg("Clock"), icon: "history", only: ["crew_lead", "field_crew"], keywords: "time clock clock in clock out punch hours break lunch my time" },
    { to: "/schedule", label: msg("Schedule"), icon: "calendar", keywords: "calendar visits appointments dispatch route crews tasks" },
    { to: "/chat", label: msg("Team chat"), icon: "chat", feature: "team_chat", keywords: "chat channels messages talk team crew announcements" },
  ],
  [
    { to: "/clients", label: msg("Clients"), icon: "clients", keywords: "customers contacts properties addresses client hub portal" },
    { to: "/messages", label: msg("Messages"), icon: "messages", roles: ["admin", "office", "estimator"], keywords: "texts sms email inbox conversations quo" },
    { to: "/pipeline", label: msg("Pipeline"), icon: "pipeline", roles: ["admin", "office", "estimator"], keywords: "sales board pipeline leads deals opportunities" },
    { to: "/workflows", label: msg("Workflows"), icon: "bolt", roles: ["admin", "office"], keywords: "automation workflows sequences follow-up texts drip gohighlevel" },
    { to: "/requests", label: msg("Requests"), icon: "requests", keywords: "inquiries leads assessments website form messages contact form" },
    { to: "/quotes", label: msg("Quotes"), icon: "quote", roles: ["admin", "office", "estimator"], also: ["/measure"], keywords: "estimates proposals bids" },
    { to: "/jobs", label: msg("Jobs"), icon: "job", keywords: "work orders projects recurring visits job costing" },
    { to: "/invoices", label: msg("Invoices"), icon: "invoice", roles: ["admin", "office"], perm: "invoices", also: ["/payouts"], keywords: "billing bills payments batch invoicing collect payments" },
    { to: "/drive", label: msg("Drive"), icon: "folder", roles: ["admin", "office", "estimator"], feature: "drive", keywords: "files documents folders google drive upload pdf word docx trash" },
  ],
  [
    { to: "/paving", label: msg("Paving"), icon: "paving", roles: ["admin", "office", "estimator"], perm: "sales", feature: "paving_app", keywords: "takeoff asphalt sealcoat striping stalls parking lot estimate proposal find paving" },
    { to: "/roofing", label: msg("Roofing"), icon: "roofing", roles: ["admin", "office", "estimator"], perm: "sales", feature: "roofing_app", keywords: "roof estimate squares pitch shingles metal tear-off measure good better best proposal" },
    { to: "/snow", label: msg("Snow"), icon: "snow", roles: ["admin", "office"], perm: "schedule", feature: "snow_app", keywords: "snow plow plowing salt trigger inches storm forecast" },
  ],
  [
    { to: "/marketing", label: msg("Marketing"), icon: "marketing", roles: ["admin", "office"], perm: "marketing", feature: "marketing", keywords: "campaigns email blasts automated campaigns re-engage win back close pending quotes reviews google reviews referrals social facebook instagram posts promo promos codes coupons discounts website visits" },
    { to: "/website", label: msg("Website"), icon: "globe", roles: ["admin", "office"], perm: "marketing", feature: "website", keywords: "site web page blog posts edit content cms sveltia decap" },
    { to: "/finance", label: msg("Finance"), icon: "finance", roles: ["admin", "office"], perm: ["reports", "invoices"], keywords: "reports revenue profit payments money collected net volume fees deposits owed goal job costing expenses" },
    { to: "/metrics", label: msg("Metrics"), icon: "metrics", roles: ["admin", "office"], perm: "reports", keywords: "reports analytics numbers sales conversion lead sources visits hours team clients" },
    { to: "/timesheets", label: msg("Timesheets"), icon: "clock", keywords: "time clock hours payroll time tracking timesheet" },
    { to: "/applicants", label: msg("Applicants"), icon: "user", roles: ["admin", "office"], perm: "hiring", feature: "careers", keywords: "careers jobs hiring applications apply candidates resumes cv interviews employment" },
    { to: "/subs", label: msg("Subcontractors"), icon: "users", roles: ["admin", "office"], perm: "subs", keywords: "subs contractors 1099 w-9 w9 insurance certificates coi liability workers comp audit paperwork vendors" },
    { to: "/equipment", label: msg("Equipment"), icon: "truck", keywords: "trucks mowers trailers tools fleet maintenance" },
    { to: "/kb", label: msg("Knowledge base"), icon: "book", keywords: "sop procedures training how to guides" },
    { to: "/apps", label: msg("Apps"), icon: "apps", roles: ["admin"], perm: "apps", foot: true, keywords: "integrations connect app store team chat website forms formspree contact form careers job applications hiring drive files documents google drive marketing reviews referrals campaigns google reviews google business profile facebook instagram social posts quickbooks zoho books stripe payments google calendar outlook twilio texts sms claude chatgpt ai assistant sveltia cms website" },
  ],
];

/** The name over each of NAV_GROUPS in the sidebar. The first, the day, needs none. */
export const NAV_GROUP_LABELS: Array<string | null> = [null, msg("Work"), msg("Trades"), msg("Business")];

/** Screens that open from another one rather than the sidebar. Search lists them with the rest. */
export const OTHER_SCREENS: NavItem[] = [
  { to: "/measure", label: msg("Measure"), icon: "area", roles: ["admin", "office", "estimator"], keywords: "measurement map draw area length count square feet acres satellite aerial property" },
  { to: "/payouts", label: msg("Stripe deposits"), icon: "dollar", roles: ["admin", "office"], perm: "invoices", keywords: "payouts bank stripe fees" },
  // Marketing's own tabs, so searching for one opens it rather than Campaigns.
  { to: "/marketing?tab=reviews", label: msg("Reviews"), icon: "star", roles: ["admin", "office"], perm: "marketing", feature: "marketing", keywords: "marketing google reviews review requests ask for a review reminders ratings replies" },
  { to: "/marketing?tab=referrals", label: msg("Referrals"), icon: "gift", roles: ["admin", "office"], perm: "marketing", feature: "marketing", keywords: "marketing referral credits refer a friend rewards" },
  { to: "/marketing?tab=social", label: msg("Social posts"), icon: "share", roles: ["admin", "office"], perm: "marketing", feature: "marketing", keywords: "marketing social facebook instagram google posts photos share" },
  { to: "/marketing?tab=promos", label: msg("Promo codes"), icon: "tag", roles: ["admin", "office"], perm: "marketing", feature: "marketing", keywords: "marketing promo promos codes coupons discounts" },
  // Every file deleted in Crewtavo waits here, for the whole team, whether or not Drive is installed.
  { to: "/drive/trash", label: msg("Trash"), icon: "trash", keywords: "deleted files removed photos restore undo undelete recycle bin get back" },
  { to: "/clients/duplicates", label: msg("Possible duplicates"), icon: "users", roles: ["admin", "office"], perm: "invoices", keywords: "duplicate clients merge combine same email phone address" },
  { to: "/subs/1099", label: msg("Year-end totals"), icon: "dollar", roles: ["admin", "office"], perm: "subs", keywords: "1099 nec subcontractors subs paid this year tax report" },
  { to: "/subs/workers-comp", label: msg("Workers' comp audit"), icon: "clipboard", roles: ["admin", "office"], perm: "subs", keywords: "workers comp compensation audit subcontractors subs insurance report csv" },
  { to: "/roofing/catalog", label: msg("Roofing catalog"), icon: "truck", roles: ["admin", "office", "estimator"], perm: "sales", feature: "roofing_app", keywords: "abc supply materials catalog shingles products prices branch" },
  { to: "/chat/settings", label: msg("Chat settings"), icon: "chat", roles: ["admin"], feature: "team_chat", keywords: "team chat channels roles who can see post manage" },
];

export const SETTINGS_ITEM: NavItem = { to: "/settings", label: msg("Settings"), icon: "settings", also: ["/automations", "/booking"] };
/** A sub's settings are their profile and notifications, and so are field crew's. */
export const PROFILE_ITEM: NavItem = { to: "/settings?tab=profile", label: msg("Profile"), icon: "user", only: ["subcontractor"] };

/**
 * Field crew ("Employee"): the screens their menus show, in this order. They see the whole team's
 * schedule and every client, and nothing about money or how the business is run (no Home, no
 * requests, jobs, quotes or reports). Settings shows them only their own profile (settingsGroups).
 */
export const CREW_SCREENS = ["/field", "/schedule", "/clock", "/clients"] as const;

/** The sidebar's last link: Settings, or a sub's or field crew's profile. */
export const settingsItem = (session: { role: string }) => (session.role === "subcontractor" || session.role === "field_crew" ? PROFILE_ITEM : SETTINGS_ITEM);

/** Bottom bar on phones for the team; everything else lives under More. */
export const MOBILE_TABS: NavItem[] = [
  { to: "/", label: msg("Home"), icon: "home" },
  { to: "/field", label: msg("My day"), icon: "clock" },
  { to: "/schedule", label: msg("Schedule"), icon: "calendar" },
  { to: "/chat", label: msg("Chat"), icon: "chat", feature: "team_chat" },
  { to: "/clients", label: msg("Clients"), icon: "clients" },
];
/** A sub's bottom bar: all they have, so there's no More. */
export const SUB_TABS: NavItem[] = [
  { to: "/field", label: msg("My day"), icon: "clock", only: ["subcontractor"], except: ["/field/paperwork", "/field/jobs"] },
  { to: "/field/jobs", label: msg("My jobs"), icon: "job", only: ["subcontractor"] },
  { to: "/field/paperwork", label: msg("Paperwork"), icon: "file", only: ["subcontractor"] },
  { to: "/settings?tab=profile", label: msg("Profile"), icon: "user", only: ["subcontractor"] },
];

/** Field crew's bottom bar: their four screens; Settings (their profile) is under More. */
export const CREW_TABS: NavItem[] = [
  { to: "/field", label: msg("My day"), icon: "clock" },
  { to: "/schedule", label: msg("Schedule"), icon: "calendar" },
  { to: "/clock", label: msg("Clock"), icon: "history" },
  { to: "/clients", label: msg("Clients"), icon: "clients" },
];

/** The phone's bottom bar for this person. */
export function mobileTabs(session: { role: string; company?: { settings?: Record<string, unknown> | null } }): NavItem[] {
  if (session.role === "subcontractor") return SUB_TABS;
  if (session.role === "field_crew") return CREW_TABS;
  return MOBILE_TABS.filter((item) => !item.feature || featureOn(session.company?.settings, item.feature));
}

/**
 * The screens a sub can open: My day and their visits, My jobs and an offer in it, My paperwork, and
 * Settings (which shows them only their profile). Anything else opened by its address goes to My day.
 */
export const subCanOpen = (pathname: string) => /^\/field(\/paperwork|\/jobs(\/[^/]+)?|\/visits\/[^/]+)?\/?$/.test(pathname) || /^\/settings\/?$/.test(pathname);

/**
 * The screens field crew can open: My day and any visit (their own to work, anyone's to look at),
 * the schedule, the clock, the clients and a client's page, and Settings (which shows them only
 * their profile). Anything else opened by its address (Home, the pipeline, quotes, invoices,
 * finance, timesheets' approvals...) goes to My day. The database keeps the money closed to them
 * either way; this keeps them off screens that would only show them empty lists or errors. A sub's
 * own field screens (/field/jobs, what they're paid; /field/paperwork) aren't theirs either.
 */
export const crewCanOpen = (pathname: string) =>
  /^\/field(\/visits\/[^/]+)?\/?$/.test(pathname) || /^\/(schedule|clock|settings)\/?$/.test(pathname) || (/^\/clients(\/[^/]+)?\/?$/.test(pathname) && !/^\/clients\/duplicates\/?$/.test(pathname));

/** Whether this person can open a screen by its address: subs and field crew have short lists, everyone else every screen. */
export function canOpen(session: { role: string }, pathname: string): boolean {
  if (session.role === "subcontractor") return subCanOpen(pathname);
  if (session.role === "field_crew") return crewCanOpen(pathname);
  return true;
}

/** Where the business's logo and a screen they can't open take someone: My day for subs and field crew. */
export const homePath = (session: { role: string }) => (session.role === "subcontractor" || session.role === "field_crew" ? "/field" : "/");

/** What people start most often: the sidebar's Create menu, the phone's More sheet and search. */
export function createItems(session: Pick<Session, "role" | "permissions">): Array<{ to: string; label: string; newLabel: string; icon: IconName; keywords: string }> {
  if (!isStaff(session.role)) return [];
  const canSell = hasRole(session, "admin", "office", "estimator");
  // newLabel whole, not "New " + the label: Spanish says "Nuevo cliente" but "Nueva cotización".
  return [
    ...(canSell
      ? [
          { to: "/clients?new=1", label: msg("Client"), newLabel: t("New client"), icon: "clients" as const, keywords: "add customer lead" },
          { to: "/requests?new=1", label: msg("Request"), newLabel: t("New request"), icon: "requests" as const, keywords: "inquiry lead" },
          ...(can(session, "sales") ? [{ to: "/quotes?new=1", label: msg("Quote"), newLabel: t("New quote"), icon: "quote" as const, keywords: "estimate proposal" }] : []),
          { to: "/measure", label: msg("Measurement"), newLabel: t("New measurement"), icon: "area" as const, keywords: "measure map draw area" },
        ]
      : []),
    ...(hasRole(session, "admin", "office") && can(session, "invoices") ? [{ to: "/invoices?new=1", label: msg("Invoice"), newLabel: t("New invoice"), icon: "invoice" as const, keywords: "bill" }] : []),
    ...(hasRole(session, "admin", "office", "estimator", "crew_lead") && can(session, "schedule") ? [{ to: "/schedule?new=1", label: msg("Visit or task"), newLabel: t("New visit or task"), icon: "calendar" as const, keywords: "schedule appointment" }] : []),
  ];
}

/** Whether a person sees a navigation item. */
export function navVisible(session: { role: string; permissions: readonly string[]; company?: { settings?: Record<string, unknown> | null } }, item: NavItem): boolean {
  // A sub sees only what's listed for them by name: everything else is the team's.
  if (session.role === "subcontractor") return Boolean(item.only?.includes("subcontractor"));
  // Field crew see their few screens by address, whatever else is listed or turned on.
  if (session.role === "field_crew") return (CREW_SCREENS as readonly string[]).includes(item.to);
  if (item.feature && !featureOn(session.company?.settings, item.feature)) return false;
  if (item.only) return item.only.includes(session.role);
  if (session.role === "owner") return true;
  if (item.roles && !item.roles.includes(session.role)) return false;
  return [item.perm ?? []].flat().every((p) => session.permissions.includes(p));
}

/**
 * An app the business turned on in Apps: companies.settings.team_chat.enabled, .careers.enabled,
 * .drive.enabled, .marketing.enabled, .paving_app.enabled, .roofing_app.enabled, .snow_app.enabled (not .roofing, which
 * holds the price ranges), or .website.enabled once its editor is added.
 */
export function featureOn(settings: Record<string, unknown> | null | undefined, feature: NonNullable<NavItem["feature"]>): boolean {
  return (settings?.[feature] as { enabled?: boolean } | undefined)?.enabled === true;
}
