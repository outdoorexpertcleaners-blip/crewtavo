/**
 * Texting the client from the field inside the app, and hearing whether the On my way text went.
 *
 * The visit's Text button opens a sheet: to the client's phone, from the Wash line or the Lighting
 * line (starting on the visit's brand), through the business's Quo, so the text is kept on the
 * client's timeline and their replies come back to the office (POST /api/field/text). It's for the
 * team; a sub keeps the phone's own texting app, when the office lets them contact clients.
 *
 * After On my way, the visit says whether the client was texted, from which line, or why not
 * (OnMyWayNote). The tap itself still works with no signal; the note asks once there's signal.
 */
import { textsOff } from "@crewtavo/core/marketing";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { isSub, useSession } from "@/lib/session";
import { lineName, ON_MY_WAY_POLL_FOR_MS, ON_MY_WAY_POLL_MS, onMyWayWords, type Line, type OnMyWayText } from "./onMyWay";

interface TextLines { lines: Array<{ brand: Line; name: string }>; test_only: boolean; brand: Line }

/** The lines a text can go from, and the one this visit's starts on. Kept a while: they rarely change. */
export function useTextLines(visitId: string | null, clientId: string | null, enabled = true) {
  const session = useSession();
  return useQuery({
    queryKey: ["field-text-lines", session.company.id, visitId, clientId],
    enabled: enabled && !isSub(session),
    staleTime: 5 * 60_000,
    meta: { silent: true },
    queryFn: () => {
      const q = new URLSearchParams();
      if (visitId) q.set("visit_id", visitId);
      if (clientId) q.set("client_id", clientId);
      return api.get<TextLines>(`/field/text-lines?${q}`);
    },
  });
}

/** Whether texts can go out at all: through Quo (its lines) or the server's texting. */
export function canText(lines: TextLines | undefined, serverTexts: boolean) {
  return Boolean(lines?.lines.length) || serverTexts;
}

export function TextClientDialog({
  client,
  visitId,
  lines,
  onClose,
}: {
  client: { id: string; display_name: string; phone: string | null; sms_opt_out_at?: string | null };
  visitId: string | null;
  lines: TextLines | undefined;
  onClose: () => void;
}) {
  const [from, setFrom] = useState<Line>(lines?.brand ?? "washing");
  const [body, setBody] = useState("");
  const send = useMutation({
    meta: { inline: true, success: () => t("Text sent from the {line}", { line: lineName(from) }) },
    mutationFn: () => api.post("/field/text", { client_id: client.id, ...(visitId ? { visit_id: visitId } : {}), ...(lines?.lines.length ? { brand: from } : {}), body: body.trim() }),
    onSuccess: onClose,
  });
  const stopped = textsOff(client);
  const problem = !client.phone ? t("No phone number on file for this client.") : stopped ? t("This client asked not to get texts.") : null;
  return (
    <Dialog open onClose={onClose} title={t("Text {name}", { name: client.display_name })} description={client.phone ?? undefined} size="sm">
      <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); if (!problem && body.trim() && !send.isPending) send.mutate(); }}>
        {/* Both lines only when the business has both; with one, that's the one it goes from. */}
        {(lines?.lines.length ?? 0) > 1 && (
          <div className="segmented" role="group" aria-label={t("Send from")}>
            {lines!.lines.map((l) => (
              <button key={l.brand} type="button" aria-pressed={from === l.brand} onClick={() => setFrom(l.brand)}>{lineName(l.brand)}</button>
            ))}
          </div>
        )}
        {lines?.test_only && <span className="muted small"><Icon name="lock" size={12} /> {t("Test mode: only the test numbers get texts.")}</span>}
        {problem && <span className="small" style={{ color: "var(--warning)", fontWeight: 600 }}>{problem}</span>}
        <Field label={t("Message")}>
          <textarea className="textarea" rows={4} value={body} maxLength={1600} onChange={(e) => { setBody(e.target.value); if (send.isError) send.reset(); }} disabled={Boolean(problem)} />
        </Field>
        <FormError error={send.error} />
        <div className="form-actions">
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" icon="send" loading={send.isPending} disabled={Boolean(problem) || !body.trim()}>{t("Send")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Under a visit that's on its way: whether the client got the text. Asked every few seconds while
 * it's going out, and for a little while after the tap in case the tap is still reaching the server.
 */
export function OnMyWayNote({ visitId, status }: { visitId: string; status: string }) {
  const session = useSession();
  const on = status === "en_route" && !isSub(session);
  // The asking window starts when the visit turns "on the way", not when the screen opened: My day
  // can sit open all morning before the tap, and the text is only on its way after it.
  const since = useRef(Date.now());
  const wasOn = useRef(on);
  if (on && !wasOn.current) since.current = Date.now();
  wasOn.current = on;
  const text = useQuery({
    queryKey: ["on-my-way", visitId],
    enabled: on,
    meta: { silent: true },
    queryFn: () => api.get<OnMyWayText>(`/visits/${visitId}/on-my-way`),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      const early = Date.now() - since.current < ON_MY_WAY_POLL_FOR_MS;
      return early && (state === "waiting" || state === "none" || state === undefined) ? ON_MY_WAY_POLL_MS : false;
    },
  });
  const words = on ? onMyWayWords(text.data) : null;
  if (!words) return null;
  return (
    <div className={`callout ${words.tone === "good" ? "callout-good" : words.tone === "warn" ? "callout-warning" : "callout-info"}`} role="status">
      <Icon name={words.tone === "good" ? "check" : "messages"} size={18} />
      <div className="grow small">{words.text}</div>
    </div>
  );
}
