/**
 * The notice a worker sees once, before Crewtavo first reads where their phone is: what's saved
 * when they clock in and out, and, with the clock at the property on, that the phone compares its
 * position with the property without saving it. Shown where the clock is (My day, a visit's
 * screen, Timesheets). OK keeps the date (locationNotice.ts); closing it without OK saves nothing,
 * reads no position, and it's shown again next time.
 */
import { onlineManager, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { supabase, unwrap } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { acknowledgeHere, learnAcknowledged, markSent, noticesFor, noticesToShow, noticesVersion, subscribeNotices, unsentNotices, type NoticeKind } from "./locationNotice";

/** One dialog at a time, however many of the screen's cards ask for it. */
let showing: symbol | null = null;

export function LocationNotice() {
  const session = useSession();
  // Re-read what's acknowledged whenever that changes.
  useSyncExternalStore(subscribeNotices, noticesVersion);
  const applies = noticesFor(session);
  const missing = noticesToShow(session);
  const [later, setLater] = useState(false);
  const [me] = useState(() => Symbol("location-notice"));

  // A phone they haven't used before: the server may already have their acknowledgement.
  const onRecord = useQuery({
    queryKey: ["worker-notices", session.company.id, session.userId],
    enabled: missing.length > 0,
    staleTime: Infinity,
    retry: false,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("worker_notices").select("notice, acknowledged_at").eq("company_id", session.company.id).eq("user_id", session.userId)),
  });
  useEffect(() => {
    if (onRecord.data) learnAcknowledged(session, onRecord.data);
  }, [onRecord.data, session]);

  // Acknowledged with no signal: sent when there is some. The first date stands, so sending twice is harmless.
  const send = useCallback(async () => {
    const waiting = unsentNotices(session);
    if (!waiting || !onlineManager.isOnline()) return;
    const { error } = await supabase().rpc("acknowledge_worker_notices", { p_company: session.company.id, p_notices: waiting.notices, p_at: waiting.at });
    if (!error) for (const notice of waiting.notices) markSent(session, notice);
  }, [session]);
  useEffect(() => {
    if (!applies.length) return;
    void send();
    return onlineManager.subscribe(() => void send());
  }, [applies.length, send]);

  // Not while the server is still being asked (it flashes for someone who acknowledged on another phone); with no signal, ask.
  const asking = missing.length > 0 && !later && !(onRecord.isPending && onRecord.fetchStatus === "fetching");
  useEffect(() => {
    if (!asking) return;
    showing ??= me;
    return () => {
      if (showing === me) showing = null;
    };
  }, [asking, me]);
  if (!asking || (showing !== null && showing !== me)) return null;

  const has = (notice: NoticeKind) => missing.includes(notice);
  const ok = () => {
    acknowledgeHere(session, missing);
    void send();
  };
  return (
    <Dialog open onClose={() => setLater(true)} title={t("Before the app uses your location")} focusField={false}>
      <div className="dialog-body stack">
        {has("clock_location") && (
          <p style={{ margin: 0 }}>
            {t("{company} saves where you are when you clock in and when you clock out: where this phone is at that moment, and how exact that is. It's kept with your time, where the office and your crew lead can see it on Timesheets. It isn't saved at any other time.", { company: session.company.name })}
          </p>
        )}
        {has("clock_at_property") && (
          <p style={{ margin: 0 }}>
            {t("While Crewtavo is open on this phone, it compares where the phone is with the property of your visit, to remind you to start and finish or to move your clock. That's worked out on this phone: your position isn't saved and isn't sent anywhere.")}
          </p>
        )}
        <p style={{ margin: 0 }}>{t("Your phone will ask you to allow location. If you say no, or turn it off later in your phone's settings, your clock still works.")}</p>
        <p className="small muted" style={{ margin: 0 }}>{t("You see this once. The date you tap OK is kept.")}</p>
      </div>
      <div className="form-actions">
        <Button variant="primary" onClick={ok}>{t("OK, I understand")}</Button>
      </div>
    </Dialog>
  );
}
