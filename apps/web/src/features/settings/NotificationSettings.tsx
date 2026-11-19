/**
 * How I hear about things outside the app: per kind of notification, by email, text, or a push to
 * this phone. The bell in the app always shows everything. Above it, where the browser offers it,
 * installing Crewtavo as an app on this device (lib/install.ts).
 */
import { isPlaceholderEmail } from "@crewtavo/core/email";
import { marketingOn } from "@crewtavo/core/marketing";
import { DEFAULT_NOTIFICATION_PREFS, NOTIFICATION_TOPICS, REVIEW_ACCESS_HINT, reviewNoticesFor, SOCIAL_ACCESS_HINT, type NotificationChannel, type NotificationTopic } from "@crewtavo/core/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { featureOn } from "@/components/shell/nav";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { api, supabase, unwrap } from "@/lib/api";
import { useInstallHint } from "@/lib/install";
import { disablePush, enablePush, pushState } from "@/lib/push";
import { hasRole, isSub, keepsTime, useSession, type Session } from "@/lib/session";
import { homeScreenSignInNote, subSignsInOnHomeScreen } from "../auth/textCode";
import { toast } from "@/lib/toast";
import { InstallAppButton } from "../field/InstallAppCard";
import { chatOn } from "../chat/data";
import { managesSubs } from "../subs/subsData";
import { msg, t, T } from "@/lib/i18n";

type Prefs = Record<NotificationChannel, NotificationTopic[]>;

/**
 * Hosting warnings go to owners and admins: Railway's (Settings → Hosting) and storage nearing its
 * limit (Settings → Storage). Off Railway there's only the storage one, so it's called that.
 */
const hostingWarnings = (session: Session) => hasRole(session, "admin");
const OFF_RAILWAY_HOSTING = { label: msg("Storage and backups"), hint: msg("When the company's files near the storage limit, or the nightly backup stops working") };

/**
 * Google reviews go to owners, admins and office staff with the marketing area, and Google Business
 * Profile needing someone to owners and admins who connect apps, while Marketing is installed. Social
 * posts reach the same people (Facebook & Instagram needing a sign-in goes to those who connect apps).
 */
const reviewNotices = (session: Session) => reviewNoticesFor(session, marketingOn(session.company.settings));

/** With Snow installed (Apps), snow tomorrow at one of your snow customers comes as schedule news. */
const withSnow = (session: Session) => <T extends { key: string; hint: string }>(t: T): T =>
  t.key === "schedule" && featureOn(session.company.settings, "snow_app") ? { ...t, hint: msg("Added to or taken off a visit, moved or cancelled, and snow on the way at your snow customers") } : t;

/**
 * The kinds this person hears about. A sub hears about their visits, their job offers and pay, and
 * their own paperwork, and their clock only if the office keeps their hours. The team never gets a
 * sub's job offers.
 */
function topicsFor(session: Session) {
  if (isSub(session)) {
    // (Each topic's words are shown with t() in the table: here they're only picked.)
    return NOTIFICATION_TOPICS.filter((t) => t.key === "schedule" || t.key === "jobs" || t.key === "subs" || (t.key === "time" && keepsTime(session))).map((t) =>
      t.key === "subs" ? { ...t, label: msg("My paperwork"), hint: msg("When your insurance is about to run out") } : t,
    ).map(withSnow(session));
  }
  const reviews = reviewNotices(session);
  return NOTIFICATION_TOPICS.filter((t) => t.key !== "jobs" && (t.key !== "chat" || chatOn(session)) && (t.key !== "hosting" || hostingWarnings(session)) && (t.key !== "subs" || managesSubs(session)) && (t.key !== "reviews" || reviews) && (t.key !== "social" || reviews)).map((t) =>
    t.key === "hosting" && session.config.platform !== "railway" ? { ...t, ...OFF_RAILWAY_HOSTING } : t.key === "reviews" && reviews === "access" ? { ...t, hint: REVIEW_ACCESS_HINT } : t.key === "social" && reviews === "access" ? { ...t, hint: SOCIAL_ACCESS_HINT } : t,
  ).map(withSnow(session));
}

const COLUMNS: Array<{ channel: NotificationChannel; label: string }> = [
  { channel: "push", label: msg("This phone") },
  { channel: "email", label: msg("Email") },
  { channel: "sms", label: msg("Text") },
];

export function NotificationSettings({ phone }: { phone: string | null }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ["notification-prefs", session.company.id, session.userId];
  const prefs = useQuery({
    queryKey: key,
    queryFn: async () => {
      const row = unwrap(await supabase().from("notification_prefs").select("email, sms, push").eq("company_id", session.company.id).eq("user_id", session.userId).maybeSingle());
      return (row ?? DEFAULT_NOTIFICATION_PREFS) as Prefs;
    },
  });
  const push = useQuery({ queryKey: ["push-state"], queryFn: pushState, staleTime: 0 });
  // On an iPhone, adding Crewtavo to the Home Screen is explained where notifications are turned on (PushRow).
  const canInstall = useInstallHint() === "prompt";

  const save = useMutation({
    mutationFn: async (next: Prefs) =>
      unwrap(await supabase().from("notification_prefs").upsert({ company_id: session.company.id, user_id: session.userId, ...next })),
    onMutate: (next) => {
      const previous = queryClient.getQueryData<Prefs>(key);
      queryClient.setQueryData(key, next);
      return { previous };
    },
    onError: (_e, _v, ctx) => ctx?.previous && queryClient.setQueryData(key, ctx.previous),
  });
  const pushToggle = useMutation({
    meta: { inline: true },
    mutationFn: async (on: boolean) => (on ? enablePush() : disablePush()),
    onSuccess: (_r, on) => toast.success(on ? t("Notifications are on for this phone") : t("Notifications are off for this phone")),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["push-state"] }),
  });
  const test = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post("/push/test", {}),
    onSuccess: () => toast.success(t("Test sent"), { description: t("It should pop up in a few seconds.") }),
  });

  const toggle = (channel: NotificationChannel, topic: NotificationTopic, on: boolean) => {
    const current = prefs.data ?? DEFAULT_NOTIFICATION_PREFS;
    save.mutate({ ...current, [channel]: on ? [...new Set([...current[channel], topic])] : current[channel].filter((x) => x !== topic) });
  };
  // A sub on a sign-in Crewtavo made for them is emailed at the address the office keeps for them
  // (their sign-in's own is a stand-in nothing is sent to), and texted at the phone they add here, or
  // else the office's (services/delivery.ts).
  const sub = isSub(session) && session.subcontractor?.own_sign_in ? session.subcontractor : null;
  const available = (channel: NotificationChannel) =>
    channel === "email"
      ? session.config.features.email && (sub ? Boolean(sub.has_email) : !isPlaceholderEmail(session.profile.email))
      : channel === "sms"
        ? session.config.features.sms && (Boolean(phone) || Boolean(sub?.phone_on_file))
        : true;
  const pushSub = isSub(session) ? { blocked: !subSignsInOnHomeScreen(session.config.features, session.subcontractor), note: homeScreenSignInNote(session.config.features, session.subcontractor) } : null;

  return (
    <>
    {canInstall && (
      <div className="card card-pad stack-sm">
        <strong>{t("App")}</strong>
        <span className="muted small">{t("Install the app on this device. It opens in its own window, from your home screen or app list, like any other app.")}</span>
        <InstallAppButton style={{ justifySelf: "start" }} />
      </div>
    )}
    <div className="card card-pad stack-sm">
      <strong>{t("Notifications")}</strong>
      <span className="muted small">{t("The bell shows everything. Choose what also reaches you when you're not in the app.")}</span>

      <PushRow state={push.data} sub={pushSub} busy={pushToggle.isPending} onToggle={(on) => pushToggle.mutate(on)} onTest={() => test.mutate()} testing={test.isPending} />
      <FormError error={pushToggle.error ?? test.error} />

      {prefs.isPending ? (
        <Skeleton height={140} radius={8} />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ minWidth: 340 }}>
            <thead>
              <tr>
                <th scope="col" style={{ paddingLeft: 0 }}>{t("Tell me about")}</th>
                {COLUMNS.map((c) => <th key={c.channel} scope="col" style={{ textAlign: "center", width: 64, padding: "10px 4px" }}>{t(c.label)}</th>)}
              </tr>
            </thead>
            <tbody>
              {topicsFor(session).map((topic) => (
                <tr key={topic.key}>
                  <th scope="row" style={{ fontWeight: 600, fontSize: 14, color: "var(--ink)", whiteSpace: "normal", padding: "10px 8px 10px 0" }}>
                    {t(topic.label)}
                    <span className="muted small" style={{ display: "block", fontWeight: 400 }}>{t(topic.hint)}</span>
                  </th>
                  {COLUMNS.map((c) => (
                    <td key={c.channel} style={{ textAlign: "center", padding: "10px 4px" }}>
                      <input
                        type="checkbox"
                        style={{ width: 20, height: 20 }}
                        aria-label={t("{topic} by {channel}", { topic: t(topic.label), channel: t(c.label).toLowerCase() })}
                        // Off where it can't reach them, whatever was saved: a box can't be ticked for nothing.
                        checked={available(c.channel) && (prefs.data ?? DEFAULT_NOTIFICATION_PREFS)[c.channel].includes(topic.key)}
                        disabled={!available(c.channel)}
                        onChange={(e) => toggle(c.channel, topic.key, e.target.checked)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!session.config.features.sms ? (
        <span className="muted small">{t("Texts need texting turned on for the company.")}</span>
      ) : !available("sms") ? (
        <span className="muted small">{isSub(session) ? t("Add your mobile phone above to get texts, or ask {company} to add it.", { company: session.company.name }) : t("Add your mobile phone above to get texts.")}</span>
      ) : null}
      {isSub(session)
        ? !available("email") && (
          <span className="muted small">
            {session.config.features.email ? t("Ask {company} to add your email to get these by email.", { company: session.company.name }) : t("{company} doesn't send email from the app yet.", { company: session.company.name })}
          </span>
        )
        : !session.config.features.email && <span className="muted small">{t("Email needs the company's email connected (Settings → Email).")}</span>}
      <FormError error={save.error} />
    </div>
    </>
  );
}

/**
 * Turning push on for this phone. On an iPhone it needs the app on the Home Screen, which keeps its
 * own sign-in: a sub is shown how only when they can sign in there (a code by text or email, or their
 * own password), and told what to do in it. A sub with neither needs a phone or email on file first.
 */
function PushRow({ state, sub, busy, testing, onToggle, onTest }: {
  state: Awaited<ReturnType<typeof pushState>> | undefined; sub: { blocked: boolean; note: string | null } | null; busy: boolean; testing: boolean; onToggle: (on: boolean) => void; onTest: () => void;
}) {
  if (!state) return <Skeleton height={38} radius={8} />;
  if (state === "needs-install" && sub?.blocked) {
    return <span className="muted small">{t("On an iPhone, notifications need the app on your Home Screen. To sign in there, the office needs your phone number or email on file. Ask them to add it. You'll still see everything in the bell.")}</span>;
  }
  if (state === "needs-install") {
    return (
      <div className="callout callout-info">
        <Icon name="phone" size={20} />
        <div className="grow small" style={{ fontWeight: 400 }}>
          <div style={{ fontWeight: 700 }}>{t("Get notifications on this iPhone")}</div>
          <T text="Tap the Share button, choose <b>Add to Home Screen</b>, then open the app from your Home Screen and turn notifications on here." b={(s) => <strong>{s}</strong>} />
          {sub?.note && <> {sub.note}</>}
        </div>
      </div>
    );
  }
  if (state === "unsupported") return <span className="muted small">{t("This browser can't show notifications. Email and text still work.")}</span>;
  if (state === "blocked") {
    return (
      <div className="callout callout-warning">
        <Icon name="bell" size={20} />
        <div className="grow small" style={{ fontWeight: 400 }}>{t("Notifications are blocked for the app in this browser. Allow them in the browser's site settings, then come back here.")}</div>
      </div>
    );
  }
  return (
    <div className="row wrap" style={{ gap: 8 }}>
      {state === "on" ? (
        <>
          <span className="chip chip-green"><Icon name="check" size={12} />{t("On for this phone")}</span>
          <Button size="sm" icon="send" loading={testing} onClick={onTest}>{t("Send a test")}</Button>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => onToggle(false)}>{t("Turn off")}</Button>
        </>
      ) : (
        <Button icon="bell" loading={busy} onClick={() => onToggle(true)}>{t("Turn on notifications")}</Button>
      )}
    </div>
  );
}
