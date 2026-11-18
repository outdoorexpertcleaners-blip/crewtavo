/**
 * Message center, laid out as Quo's inbox: the business's lines on the left (with how many
 * conversations wait on a reply), the conversations, the open one, and the client's details on the
 * right. Conversations by client (emails, texts, notes), with replies by email or text, and texts
 * from unknown numbers to attach to a client. A line (messages.line) is the Quo line a text went
 * out on or came in to.
 */
import { textsOff, textsOffReason } from "@crewtavo/core/marketing";
import { phoneDisplay } from "@crewtavo/core/phone";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { initials } from "@/components/ui/Avatar";
import { ApiError, api, searchTerm, supabase, unwrap } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { hasRole, useSession } from "@/lib/session";
import { ClientPicker, type PickedClient } from "../clients/ClientForm";
import { MessageBody } from "../clients/MessageBody";
import { messageFrom, messagePeople } from "../clients/messagePeople";
import { ConnectEmailHint } from "../settings/ConnectEmailHint";
import { UnknownRows, UnknownThread, useUnknownNumbers } from "./UnknownNumbers";
import { matchingNumbers } from "./unknownTexts";

const FILTERS = [
  { key: "all", label: "All", channels: ["sms", "email", "note", "call"] },
  { key: "in", label: "Unresponded", channels: ["sms", "email", "note", "call"] },
  { key: "sms", label: "Texts", channels: ["sms"] },
  { key: "email", label: "Email", channels: ["email"] },
] as const;
type Line = "washing" | "lights";
interface QuoLines { lines: Array<{ brand: Line; name: string; number: string }>; test_only: boolean; practice: boolean }
const ICON: Record<string, IconName> = { email: "mail", sms: "messages", note: "note", call: "phone" };

interface Msg { id: string; channel: string; direction: string; subject: string | null; body: string; status: string; created_at: string; line: string | null; client: { id: string; display_name: string } | null }

export function MessagesPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [search, setSearch] = useState("");
  const [composing, setComposing] = useState(false);
  const term = useDeferredValue(searchTerm(search));
  const selected = params.get("client");
  // A number that isn't a client's or a contact's, by its last 10 digits (UnknownNumbers.tsx).
  const unknown = params.get("unknown");
  const strangers = useUnknownNumbers();
  const f = FILTERS.find((x) => x.key === filter)!;
  // The business's Quo lines, as Quo's inboxes. None without Quo: then there's only "All".
  const quoLines = useQuery({ queryKey: ["quo-lines", session.company.id], queryFn: () => api.get<QuoLines>("/quo/lines"), staleTime: 60_000 });
  const lines = quoLines.data?.lines ?? [];
  const lineParam = params.get("line");
  const line: Line | null = lineParam === "washing" || lineParam === "lights" ? lineParam : null;
  const setLine = (l: Line | null) => setParams((p) => { const n = new URLSearchParams(p); if (l) n.set("line", l); else n.delete("line"); n.delete("client"); n.delete("unknown"); return n; }, { replace: true });

  const messages = useQuery({
    queryKey: ["messages", session.company.id, filter, line],
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    queryFn: async () => {
      let q = supabase()
        .from("messages")
        .select("id, channel, direction, subject, body, status, created_at, line, client:clients(id, display_name)")
        .eq("company_id", session.company.id)
        .in("channel", [...f.channels])
        .not("client_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(500);
      if (line) q = q.eq("line", line);
      return unwrap(await q) as unknown as Msg[];
    },
  });
  // One row per client: their latest message.
  const conversations = useMemo(() => {
    const seen = new Map<string, Msg & { count: number }>();
    for (const m of messages.data ?? []) {
      if (!m.client) continue;
      const existing = seen.get(m.client.id);
      if (existing) existing.count++;
      else seen.set(m.client.id, { ...m, count: 1 });
    }
    // Unresponded: the latest message is theirs, as Quo's filter.
    return [...seen.values()].filter((c) => filter !== "in" || c.direction === "in").filter((c) => !term || c.client!.display_name.toLowerCase().includes(term.toLowerCase()) || c.body.toLowerCase().includes(term.toLowerCase()));
  }, [messages.data, term, filter]);
  // Each line's conversations waiting on a reply, for the counts beside them (as Quo's unread counts).
  const waiting = useQuery({
    queryKey: ["messages", session.company.id, "waiting"],
    enabled: lines.length > 0,
    refetchInterval: 30_000,
    queryFn: async () => {
      const rows = unwrap(await supabase().from("messages").select("client_id, direction, line").eq("company_id", session.company.id).eq("channel", "sms").not("line", "is", null).not("client_id", "is", null).order("created_at", { ascending: false }).limit(500));
      const latest = new Map<string, { direction: string; line: string | null }>();
      for (const r of rows) if (!latest.has(`${r.line}:${r.client_id}`)) latest.set(`${r.line}:${r.client_id}`, r);
      const counts: Record<string, number> = {};
      for (const r of latest.values()) if (r.direction === "in" && r.line) counts[r.line] = (counts[r.line] ?? 0) + 1;
      return counts;
    },
  });
  const open = (clientId: string | null) => setParams((p) => { const n = new URLSearchParams(); const l = p.get("line"); if (l) n.set("line", l); if (clientId) n.set("client", clientId); return n; }, { replace: true });
  // Texts from unknown numbers are texts from outside: not under Email.
  const unknownNumbers = filter === "email" ? [] : matchingNumbers(strangers.data ?? [], term);
  // Conversations move to the top as messages come in.
  const list = useListAnimation<HTMLDivElement>();

  const canCompose = hasRole(session, "admin", "office", "estimator");
  return (
    <div className="messages-page quo" data-open={selected || unknown ? "" : undefined}>
      {!session.config.features.email && !session.config.features.sms && (
        <div className="callout callout-info"><Icon name="info" size={20} /><div className="grow">Email and texting aren't turned on yet. You can still add notes.<ConnectEmailHint /></div></div>
      )}
      <div className="inbox quo-inbox" data-open={selected || unknown ? "" : undefined} data-rail={lines.length ? "" : undefined}>
        {lines.length > 0 && (
          <nav className="quo-rail" aria-label="Inboxes">
            <span className="quo-rail-title">Inboxes</span>
            <button type="button" className="quo-rail-item" aria-current={!line} onClick={() => setLine(null)}>
              <Icon name="messages" size={16} /><span className="grow">All inboxes</span>
            </button>
            {lines.map((l) => (
              <button key={l.brand} type="button" className="quo-rail-item" aria-current={line === l.brand} onClick={() => setLine(l.brand)}>
                <span className="quo-line-icon" data-brand={l.brand} aria-hidden="true">{l.brand === "lights" ? "✦" : "≋"}</span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="ellipsis" style={{ display: "block" }}>{l.name}</span>
                  {l.number && <span className="muted small">{phoneDisplay(l.number)}</span>}
                </span>
                {(waiting.data?.[l.brand] ?? 0) > 0 && <span className="quo-count">{waiting.data![l.brand]}</span>}
              </button>
            ))}
            {quoLines.data?.test_only && <span className="quo-test-note"><Icon name="lock" size={12} /> {quoLines.data.practice ? "Practice mode" : "Test only: texts go to test numbers only"}</span>}
          </nav>
        )}
        <section className="inbox-list quo-list" aria-label="Conversations">
          <div className="quo-list-head">
            <strong>{line ? lines.find((l) => l.brand === line)?.name ?? "Messages" : "Chats"}</strong>
            {canCompose && <button type="button" className="icon-btn" aria-label="New message" title="New message" onClick={() => setComposing(true)}><Icon name="edit" size={18} /></button>}
          </div>
          <div className="quo-chips" role="group" aria-label="Filter messages">
            {FILTERS.map((x) => <button key={x.key} type="button" className="quo-chip" aria-pressed={filter === x.key} onClick={() => setFilter(x.key)}>{x.label}</button>)}
          </div>
          <div className="input-group quo-search"><span className="addon"><Icon name="search" size={14} /></span><input className="input input-sm" type="search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search conversations" /></div>
          <div className={`quo-rows${messages.isPlaceholderData ? " is-stale" : ""}`} ref={list}>
            {messages.isPending && <Loading label="Loading conversations">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="card-row"><Skeleton width={36} height={36} circle /><span className="grow stack-sm"><Skeleton width="50%" /><Skeleton width="85%" height={10} /></span></div>)}</Loading>}
            {messages.error && <ErrorState compact error={messages.error} onRetry={() => messages.refetch()} />}
            {!line && <UnknownRows numbers={unknownNumbers} selected={unknown} onOpen={(key) => setParams({ unknown: key }, { replace: true })} />}
            {messages.data && conversations.length === 0 && (line || unknownNumbers.length === 0) && <EmptyState compact icon="messages" title={term ? "No conversations match" : filter === "in" ? "Nobody's waiting on a reply" : "No messages yet"} />}
            {conversations.map((c) => (
              <button key={c.client!.id} type="button" className="quo-row" aria-current={selected === c.client!.id} onClick={() => open(c.client!.id)}>
                <span className="quo-avatar">{initials(c.client!.display_name)}</span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="row-between" style={{ gap: 8 }}><strong className="ellipsis">{c.client!.display_name}</strong><span className="muted small nowrap">{timeAgo(c.created_at)}</span></span>
                  <span className="quo-preview ellipsis">
                    {c.direction === "in" ? "" : c.direction === "internal" ? "Note: " : "You: "}{c.subject ? `${c.subject} · ` : ""}<MessageBody body={c.body} />
                  </span>
                </span>
                {c.direction === "in" && <span className="quo-unread" title="Waiting on a reply" />}
              </button>
            ))}
          </div>
        </section>
        <section className="inbox-thread" style={{ minHeight: 0 }}>
          {unknown ? <UnknownThread key={unknown} phoneKey={unknown} onBack={() => open(null)} onAttached={(clientId) => open(clientId)} /> : selected ? <Thread key={selected} clientId={selected} onBack={() => open(null)} /> : (
            <div className="quo-empty">
              <EmptyState icon="messages" title="Pick a conversation" />
            </div>
          )}
        </section>
      </div>
      {composing && <NewMessage onClose={() => setComposing(false)} onSent={(id) => { setComposing(false); open(id); }} />}
    </div>
  );
}

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};

function Thread({ clientId, onBack }: { clientId: string; onBack: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const body = useRef<HTMLDivElement>(null);
  const thread = useQuery({
    queryKey: ["client", clientId, "thread"],
    refetchInterval: 15_000,
    queryFn: async () => {
      const [client, rows] = await Promise.all([
        supabase().from("clients").select("id, display_name, email, phone, sms_opt_out_at, company_name, status").eq("id", clientId).maybeSingle(),
        supabase().from("messages").select("id, channel, direction, subject, body, status, created_at, recipients, from_name, line").eq("client_id", clientId).order("created_at", { ascending: false }).limit(300),
      ]);
      return { client: unwrap(client), rows: unwrap(rows).reverse() };
    },
  });
  const count = thread.data?.rows.length ?? 0;
  useEffect(() => {
    // Keep the newest message in view (scroll the thread, never the page).
    const el = body.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: count && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
  }, [count]);
  if (thread.isPending)
    return (
      <Loading label="Loading conversation" className="card thread">
        <div className="thread-head"><Skeleton width={160} height={16} /></div>
        <div className="thread-body">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={i === 1 ? 70 : 48} width={i % 2 ? "55%" : "65%"} radius={12} style={{ alignSelf: i % 2 ? "flex-end" : "flex-start" }} />)}</div>
      </Loading>
    );
  if (thread.error || !thread.data.client) return <div className="card"><ErrorState error={thread.error ?? new ApiError("This client no longer exists. They may have been deleted.", 404)} onRetry={thread.error ? () => thread.refetch() : undefined} /></div>;
  const { client, rows } = thread.data;
  let lastDay = "";
  return (
    <div className="quo-thread-wrap">
    <div className="card thread">
      <div className="thread-head">
        <button type="button" className="icon-btn mobile-only" aria-label="Back to conversations" onClick={onBack}><Icon name="arrowLeft" size={20} /></button>
        <span className="who">
          <Link to={`/clients/${client.id}`} className="strong ellipsis" style={{ color: "var(--ink)" }}>{client.display_name}</Link>
          <span className="muted small ellipsis">{[client.phone, client.email].filter(Boolean).join(" · ") || "No phone or email on file"}</span>
        </span>
        {client.phone && <a className="icon-btn" href={`tel:${client.phone}`} aria-label={`Call ${client.display_name}`}><Icon name="phone" size={20} /></a>}
      </div>
      <div className="thread-body" ref={body}>
        {rows.length === 0 && <EmptyState compact icon="messages" title="No messages yet" />}
        {rows.map((m) => {
          const mine = m.direction !== "in";
          const note = m.direction === "internal";
          const day = dayLabel(m.created_at);
          const showDay = day !== lastDay;
          lastDay = day;
          // One message however many people it went to: who they were, and anyone it didn't reach.
          const sent = messagePeople(m);
          const from = messageFrom(m);
          return (
            <Fragment key={m.id}>
              {showDay && <span className="thread-day">{day}</span>}
              <div className="msg" data-mine={mine || undefined} data-note={note || undefined} data-failed={m.status === "failed" || undefined}>
                <div className="msg-bubble">{m.subject && <span className="msg-subject">{m.subject}</span>}<MessageBody body={m.body} /></div>
                <span className="msg-meta">
                  <Icon name={ICON[m.channel] ?? "messages"} size={12} />
                  {note ? "Internal note" : m.channel === "email" ? "Email" : m.channel === "sms" ? "Text" : "Call"}
                  {m.line && <> · {m.line === "lights" ? "Lighting line" : "Wash line"}</>}
                  {from && <> from {from}</>}
                  {sent.to && <span title={sent.toFull ?? undefined}> to {sent.to}</span>} · <span title={formatDateTime(m.created_at)}>{new Date(m.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
                  {m.status === "failed" && <span className="text-danger strong">· Not delivered</span>}
                  {sent.missed && <span className="text-danger">· Didn't reach {sent.missed}</span>}
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>
      <Composer key={client.id} client={client} onSent={() => { queryClient.invalidateQueries({ queryKey: ["client", clientId] }); queryClient.invalidateQueries({ queryKey: ["messages", session.company.id] }); }} />
    </div>
    <ContactPanel client={client} />
    </div>
  );
}

/** The client's details beside the conversation, as Quo shows the contact. */
function ContactPanel({ client }: { client: { id: string; display_name: string; email: string | null; phone: string | null; company_name?: string | null; status?: string | null } }) {
  return (
    <aside className="quo-contact" aria-label="Contact">
      <span className="quo-avatar quo-avatar-lg">{initials(client.display_name)}</span>
      <strong className="quo-contact-name">{client.display_name}</strong>
      <div className="row" style={{ gap: 8, justifyContent: "center" }}>
        {client.phone && <a className="icon-btn quo-round" href={`tel:${client.phone}`} aria-label={`Call ${client.display_name}`} title="Call"><Icon name="phone" size={16} /></a>}
        <Link className="icon-btn quo-round" to={`/clients/${client.id}`} aria-label="Open client" title="Open client"><Icon name="user" size={16} /></Link>
      </div>
      <span className="quo-contact-title">Contact</span>
      <dl className="quo-contact-fields">
        <dt><Icon name="phone" size={14} />Mobile</dt><dd>{client.phone ?? "—"}</dd>
        <dt><Icon name="mail" size={14} />Email</dt><dd className="ellipsis">{client.email ?? "—"}</dd>
        {client.company_name && <><dt><Icon name="clients" size={14} />Company</dt><dd>{client.company_name}</dd></>}
        {client.status && <><dt><Icon name="tag" size={14} />Status</dt><dd style={{ textTransform: "capitalize" }}>{client.status}</dd></>}
      </dl>
      <Link to={`/clients/${client.id}`} className="small">Open their page: requests, quotes and jobs</Link>
    </aside>
  );
}

function Composer({ client, onSent }: { client: { id: string; display_name: string; email: string | null; phone: string | null; sms_opt_out_at: string | null }; onSent: () => void }) {
  const session = useSession();
  const { features } = session.config;
  const [channel, setChannel] = useState<"email" | "sms" | "note">(client.phone && features.sms && !textsOff(client) ? "sms" : client.email && features.email ? "email" : "note");
  const [subject, setSubject] = useState(`A note from ${session.company.name}`);
  const [body, setBody] = useState("");
  const send = useMutation({
    // A note shows up in the thread right away; a sent email or text goes out to the client, so it's said.
    meta: { inline: true, success: () => (channel === "note" ? null : channel === "email" ? "Email sent" : "Text sent") },
    mutationFn: async () => {
      if (channel === "note") return unwrap(await supabase().from("messages").insert({ company_id: session.company.id, client_id: client.id, channel: "note", direction: "internal", body: body.trim() }));
      return api.post("/messages/send", { client_id: client.id, channel, subject: channel === "email" ? subject.trim() : undefined, body: body.trim() });
    },
    onSuccess: () => {
      setBody("");
      onSent();
    },
    // A failed email or text is still recorded (as "not delivered"), so refresh the thread either way.
    onError: onSent,
  });
  const problem =
    channel === "email" ? (!client.email ? "No email address on file for this client." : !features.email ? "Email isn't turned on yet." : null)
    : channel === "sms" ? (!client.phone ? "No phone number on file for this client." : textsOff(client) ? textsOffReason(client.display_name) : !features.sms ? "Texting isn't turned on yet." : null)
    : null;
  const canSend = body.trim().length > 0 && !problem && (channel !== "email" || subject.trim().length > 0);
  return (
    <form className="composer" onSubmit={(e: FormEvent) => { e.preventDefault(); if (canSend && !send.isPending) send.mutate(); }}>
      <div className="row wrap" style={{ gap: 10 }}>
        <div className="segmented" role="group" aria-label="Send as">
          <button type="button" aria-pressed={channel === "sms"} onClick={() => { setChannel("sms"); send.reset(); }}><Icon name="messages" size={14} />Text</button>
          <button type="button" aria-pressed={channel === "email"} onClick={() => { setChannel("email"); send.reset(); }}><Icon name="mail" size={14} />Email</button>
          <button type="button" aria-pressed={channel === "note"} onClick={() => { setChannel("note"); send.reset(); }}><Icon name="note" size={14} />Note</button>
        </div>
        {problem && <span className="small" style={{ color: "var(--warning)", fontWeight: 600 }}>{problem}</span>}
      </div>
      {channel === "email" && <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="Subject" aria-label="Subject" />}
      <div className="composer-row">
        <textarea
          className="textarea grow"
          rows={1}
          value={body}
          maxLength={channel === "sms" ? 1600 : 10000}
          onChange={(e) => { setBody(e.target.value); if (send.isError) send.reset(); }}
          placeholder={channel === "note" ? "Internal note (the client won't see it)" : "Write a message…"}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
          aria-label="Message"
          disabled={Boolean(problem)}
        />
        <Button type="submit" variant="primary" icon="send" loading={send.isPending} disabled={!canSend} aria-label={channel === "note" ? "Add note" : "Send"} title="Send (⌘/Ctrl + Enter)" />
      </div>
      {channel === "sms" && body.length > 160 && <span className="muted small">{body.length.toLocaleString()} characters · sends as {Math.ceil(body.length / 153)} texts</span>}
      <FormError error={send.error} />
    </form>
  );
}

function NewMessage({ onClose, onSent }: { onClose: () => void; onSent: (clientId: string) => void }) {
  const [client, setClient] = useState<PickedClient>(null);
  return (
    <Dialog open onClose={onClose} title="New message" size="sm">
      <div className="stack-sm">
        <ClientPicker value={client} onChange={(c) => { setClient(c); if (c) onSent(c.id); }} allowCreate={false} />
      </div>
    </Dialog>
  );
}
