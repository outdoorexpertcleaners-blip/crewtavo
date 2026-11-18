/**
 * Settings → Proposal (Outdoor Expert Cleaners' modification; core proposal.ts, api
 * services/proposal.ts): the Big Proposal clients see on a quote's link, one look per brand. The
 * switch turns it on; each brand has its letterhead, its letters (with fill-ins), its insurance
 * certificate, photos and testimonials, its agreement and its terms link. A picture uploads as soon
 * as it's chosen (PUT /company/proposal/picture) and goes into use when Save is pressed (PUT
 * /company/proposal), which also removes the pictures no longer used.
 */
import { BRAND_LABEL, PROPOSAL_BRANDS, PROPOSAL_FILL_INS, PROPOSAL_MAX_PHOTOS, type BrandProposal, type ProposalBrand, type ProposalSettings as Settings } from "@crewtavo/core/proposal";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { base64Of, compressImage } from "@/lib/files";
import { toast } from "@/lib/toast";
import { useSession } from "@/lib/session";

const RichTextEditor = lazy(() => import("@/components/ui/RichTextEditor").then((m) => ({ default: m.RichTextEditor })));

const FILL_LABELS: Record<(typeof PROPOSAL_FILL_INS)[number], string> = {
  first_name: "Client's first name",
  client_name: "Client's full name",
  company: "Company name",
  phone: "Phone",
  email: "Email",
  owner: "Signed by",
};
const FILL_INS = PROPOSAL_FILL_INS.map((k) => ({ token: `{${k}}`, label: FILL_LABELS[k] }));

/** A stored picture's address (the public route serves it once saved settings use it). */
const pictureUrl = (path: string) => `/api/public/proposal/${path.replace("/proposal/", "/")}`;

export function ProposalSettings() {
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ["proposal", session.company.id];
  const loaded = useQuery({ queryKey: key, queryFn: () => api.get<{ proposal: Settings }>("/company/proposal") });
  const [draft, setDraft] = useState<Settings | null>(null);
  const [brand, setBrand] = useState<ProposalBrand>("washing");
  // Pictures uploaded since loading: shown from the file itself until they're saved.
  const previews = useRef(new Map<string, string>());
  useEffect(() => {
    if (loaded.data && !draft) setDraft(loaded.data.proposal);
  }, [loaded.data, draft]);
  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const save = useMutation({
    mutationFn: (next: Settings) => api.put<{ proposal: Settings }>("/company/proposal", next),
    onSuccess: (res) => {
      queryClient.setQueryData(key, res);
      setDraft(res.proposal);
      toast.success("Proposal saved");
    },
  });

  if (loaded.isPending || !draft) return <div className="card card-pad"><Skeleton height={320} radius={12} /></div>;
  if (loaded.error) return <div className="card"><ErrorState error={loaded.error} onRetry={() => loaded.refetch()} /></div>;

  const b = draft.brands[brand];
  // From the latest draft, not this render's: an upload or a second editor can finish after other
  // changes, and building on an older copy would undo them. The brand is the one shown when the
  // change started, so a picture still uploading lands on the brand it was added to.
  const change = (patch: Partial<BrandProposal>, on: ProposalBrand = brand) =>
    setDraft((d) => (d ? { ...d, brands: { ...d.brands, [on]: { ...d.brands[on], ...patch } } } : d));
  const src = (path: string) => previews.current.get(path) ?? pictureUrl(path);
  const upload = async (file: File): Promise<string> => {
    const body = await compressImage(file, 1600, 0.82);
    const { path } = await api.put<{ path: string }>("/company/proposal/picture", { picture: await base64Of(body) });
    previews.current.set(path, URL.createObjectURL(body));
    return path;
  };

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(draft);
      }}
    >
      <div className="card card-pad stack-sm" style={{ gap: 12 }}>
        <strong>Big Proposal</strong>
        <span className="muted small">
          When it's on, a quote's link opens as your Big Proposal: your letterhead, an introduction, your insurance, photos, testimonials, the price and a closing letter, with Accept and Decline at the top. Accept asks for their preferred dates, then they sign as usual. A quote with a lighting job on it (roofline, lights, wreaths…) uses the Christmas lights look; every other quote uses pressure washing.
        </span>
        <label className="switch-row">
          <input type="checkbox" className="switch" checked={draft.enabled} onChange={(e) => { const enabled = e.target.checked; setDraft((d) => (d ? { ...d, enabled } : d)); }} />
          Use the Big Proposal for client quotes
        </label>
      </div>

      <div className="segmented" role="group" aria-label="Brand" style={{ justifySelf: "start" }}>
        {PROPOSAL_BRANDS.map((x) => (
          <button key={x} type="button" aria-pressed={x === brand} onClick={() => setBrand(x)}>{BRAND_LABEL[x]}</button>
        ))}
      </div>

      <Card title="Letterhead" hint="Shown at the top of the proposal. Left empty, your company's own name, phone, email, address and logo are used.">
        <div className="grid-2" style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <Field label="Company name" optional><input className="input" value={b.name} maxLength={120} onChange={(e) => change({ name: e.target.value })} placeholder="Outdoor Expert Cleaners LLC." /></Field>
          <Field label="Letters signed by" optional><input className="input" value={b.owner} maxLength={120} onChange={(e) => change({ owner: e.target.value })} placeholder="William McHugh" /></Field>
          <Field label="Phone" optional><input className="input" value={b.phone} maxLength={40} onChange={(e) => change({ phone: e.target.value })} /></Field>
          <Field label="Email" optional><input className="input" type="email" value={b.email} maxLength={200} onChange={(e) => change({ email: e.target.value })} /></Field>
        </div>
        <Field label="Address" hint="One line each, like the street, then City, ST ZIP." optional>
          <textarea className="textarea" rows={2} value={b.address.join("\n")} onChange={(e) => change({ address: e.target.value.split("\n").slice(0, 6) })} />
        </Field>
        <div className="row wrap" style={{ gap: 16, alignItems: "end" }}>
          <Field label="Brand color">
            <input type="color" value={b.color} onChange={(e) => change({ color: e.target.value })} style={{ width: 64, height: 36, padding: 2 }} />
          </Field>
          <PictureField label="Logo" path={b.logo} src={src} upload={upload} onChange={(logo) => change({ logo })} />
        </div>
      </Card>

      <Card title="Introduction" hint="The first page they see. Fill-ins: {first_name}, {company}, {phone}, {email}, {owner}.">
        <Editor key={`${brand}-intro`} html={b.intro_html} onChange={(intro_html) => change({ intro_html })} label="Introduction" />
      </Card>

      <Card title="Insurance" hint="A picture of your certificate of insurance (a screenshot or photo of the PDF).">
        <PictureField label="Certificate" path={b.insurance_picture} src={src} upload={upload} onChange={(insurance_picture) => change({ insurance_picture })} large />
      </Card>

      <Card title="Photos">
        <div className="row wrap" style={{ gap: 12 }}>
          <Field label="Section title"><input className="input" value={b.photos_title} maxLength={60} required onChange={(e) => change({ photos_title: e.target.value })} /></Field>
          <Field label="Caption" optional><input className="input" value={b.photos_caption} maxLength={200} onChange={(e) => change({ photos_caption: e.target.value })} placeholder="Recent Projects!" /></Field>
        </div>
        <Photos paths={b.photos} src={src} upload={upload} onChange={(photos) => change({ photos })} />
      </Card>

      <Card title="Testimonials" hint="Words, a picture (like a screenshot of your Google reviews), or both.">
        <Editor key={`${brand}-testimonials`} html={b.testimonials_html} onChange={(testimonials_html) => change({ testimonials_html })} label="Testimonials" minHeight={140} />
        <PictureField label="Picture" path={b.testimonials_picture} src={src} upload={upload} onChange={(testimonials_picture) => change({ testimonials_picture })} large />
      </Card>

      <Card title="Agreement" hint="Your terms of service. Left empty, there's no Agreement section.">
        <Editor key={`${brand}-agreement`} html={b.agreement_html} onChange={(agreement_html) => change({ agreement_html })} label="Agreement" minHeight={140} />
      </Card>

      <Card title="Proposal">
        <Field label="Terms and conditions link" hint="Shown under the price as “For Terms and Conditions Click Here”." optional>
          <input className="input" type="url" value={b.terms_url} maxLength={500} onChange={(e) => change({ terms_url: e.target.value })} placeholder="https://docs.google.com/…" />
        </Field>
        <label className="switch-row">
          <input type="checkbox" className="switch" checked={b.show_expiry} onChange={(e) => change({ show_expiry: e.target.checked })} />
          Show “Expires” with the quote's valid-until date
        </label>
      </Card>

      <Card title="In Closing" hint="The last page. Same fill-ins as the introduction.">
        <Editor key={`${brand}-closing`} html={b.closing_html} onChange={(closing_html) => change({ closing_html })} label="In Closing" />
      </Card>

      <div className="row" style={{ gap: 8, position: "sticky", bottom: 0, padding: "12px 0", background: "var(--page)", borderTop: "1px solid var(--border)" }}>
        <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
        {save.error && <span className="error-text small">{(save.error as Error).message}</span>}
      </div>
    </form>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="card card-pad stack-sm" style={{ gap: 12 }}>
      <div className="stack-sm" style={{ gap: 2 }}>
        <strong>{title}</strong>
        {hint && <span className="muted small">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Editor({ html, onChange, label, minHeight = 220 }: { html: string; onChange: (html: string) => void; label: string; minHeight?: number }) {
  return (
    <Suspense fallback={<Skeleton height={minHeight} radius={12} />}>
      <RichTextEditor mode="contract" initialHtml={html} label={label} minHeight={minHeight} fillIns={FILL_INS} onChange={(h, text) => onChange(text.trim() ? h : "")} />
    </Suspense>
  );
}

function PictureField({ label, path, src, upload, onChange, large = false }: { label: string; path: string | null; src: (p: string) => string; upload: (f: File) => Promise<string>; onChange: (path: string | null) => void; large?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const add = useMutation({ mutationFn: upload, onSuccess: onChange, onError: (e) => toast.error((e as Error).message) });
  return (
    <div className="stack-sm" style={{ gap: 6 }}>
      <span className="small" style={{ fontWeight: 600 }}>{label}</span>
      {path && <img src={src(path)} alt="" style={{ display: "block", maxWidth: large ? 320 : 200, maxHeight: large ? 320 : 120, objectFit: "contain", border: "1px solid var(--border)", borderRadius: 6, background: "#fff" }} />}
      <div className="row wrap" style={{ gap: 8 }}>
        <Button size="sm" icon="upload" type="button" loading={add.isPending} onClick={() => input.current?.click()}>{path ? "Change" : "Add a picture"}</Button>
        {path && <Button size="sm" variant="ghost" type="button" onClick={() => onChange(null)}>Remove</Button>}
      </div>
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) add.mutate(f); }} />
    </div>
  );
}

function Photos({ paths, src, upload, onChange }: { paths: string[]; src: (p: string) => string; upload: (f: File) => Promise<string>; onChange: (paths: string[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(paths);
  latest.current = paths;
  const add = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files.slice(0, PROPOSAL_MAX_PHOTOS - latest.current.length)) {
        const p = await upload(f);
        latest.current = [...latest.current, p];
        onChange(latest.current);
      }
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const move = (i: number, by: number) => {
    const next = [...paths];
    const [x] = next.splice(i, 1);
    next.splice(i + by, 0, x!);
    onChange(next);
  };
  return (
    <div className="stack-sm">
      {paths.length > 0 && (
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
          {paths.map((p, i) => (
            <div key={p} className="stack-sm" style={{ gap: 4 }}>
              <img src={src(p)} alt={`Photo ${i + 1}`} style={{ width: "100%", aspectRatio: "4 / 3", objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} />
              <div className="row" style={{ gap: 4 }}>
                <Button size="sm" variant="ghost" type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move photo ${i + 1} earlier`}>←</Button>
                <Button size="sm" variant="ghost" type="button" disabled={i === paths.length - 1} onClick={() => move(i, 1)} aria-label={`Move photo ${i + 1} later`}>→</Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => onChange(paths.filter((x) => x !== p))}>Remove</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="row wrap" style={{ gap: 8, alignItems: "center" }}>
        <Button size="sm" icon="upload" type="button" loading={add.isPending} disabled={paths.length >= PROPOSAL_MAX_PHOTOS} onClick={() => input.current?.click()}>Add photos</Button>
        <span className="muted small">{paths.length} of {PROPOSAL_MAX_PHOTOS}. Shown two across, in this order.</span>
      </div>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; if (fs.length) add.mutate(fs); }} />
    </div>
  );
}
