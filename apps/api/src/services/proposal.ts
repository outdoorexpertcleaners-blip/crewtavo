/**
 * The Big Proposal's settings and pictures (core proposal.ts; Outdoor Expert Cleaners'
 * modification). The settings live in companies.settings.big_proposal; each picture is kept at
 * <company>/proposal/<uuid>.(jpg|png) in the files bucket. A picture is uploaded first (PUT
 * /company/proposal/picture) and goes into use when the settings that name it are saved; saving
 * removes the pictures the old settings used and the new ones don't. Clients see them from
 * /api/public/proposal/<company>/<uuid>.(jpg|png), and only while the settings use them.
 */
import { defaultProposal, PROPOSAL_BRANDS, PROPOSAL_MAX_PHOTOS, proposalPictures, proposalSettings, type ProposalSettings } from "@crewtavo/core/proposal";
import { z } from "zod";
import { dbError, HttpError } from "../lib/http";
import type { Db } from "../lib/supabase";
import { isPng } from "./logo";

/** The browser shrinks pictures to 1600 pixels first (lib/files compressImage): requests are capped at 2 MB (app.ts). */
export const PROPOSAL_PICTURE_MAX_BYTES = 1_500_000;

const isJpeg = (bytes: Uint8Array) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** A picture of this company's proposal, as stored: only ever in its own proposal folder. */
export const isProposalPath = (path: string, companyId: string) => new RegExp(`^${companyId}/proposal/[0-9a-f-]{36}\\.(jpg|png)$`).test(path);

/** Where a client's browser loads a stored picture from (`base` is "" on the app's own pages). */
export const proposalPictureUrl = (path: string, base = "") => `${base}/api/public/proposal/${path.replace("/proposal/", "/")}`;

/** Saves a picture (base64 JPEG or PNG) and returns its path; it's used once settings name it. */
export async function saveProposalPicture(admin: Db, companyId: string, base64: string): Promise<string> {
  const bytes = Buffer.from(base64, "base64");
  const png = isPng(bytes);
  if (!png && !isJpeg(bytes)) throw new HttpError(400, "That picture didn't come through. Try a JPEG or PNG.");
  if (bytes.length > PROPOSAL_PICTURE_MAX_BYTES) throw new HttpError(413, "That picture is too large. Try a smaller one.");
  const path = `${companyId}/proposal/${crypto.randomUUID()}.${png ? "png" : "jpg"}`;
  const { error } = await admin.storage.from("files").upload(path, bytes, { contentType: png ? "image/png" : "image/jpeg", cacheControl: "31536000", upsert: false });
  if (error) throw new HttpError(502, `Couldn't save the picture: ${error.message}`);
  return path;
}

const html = z.string().max(100_000);
const picture = z.string().max(200).nullable();
const brandSchema = z.object({
  name: z.string().trim().max(120),
  owner: z.string().trim().max(120),
  address: z.array(z.string().trim().max(120)).max(6),
  phone: z.string().trim().max(40),
  email: z.string().trim().max(200),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  logo: picture,
  intro_html: html,
  closing_html: html,
  agreement_html: html,
  testimonials_html: html,
  testimonials_picture: picture,
  insurance_picture: picture,
  photos: z.array(z.string().max(200)).max(PROPOSAL_MAX_PHOTOS),
  photos_title: z.string().trim().min(1).max(60),
  photos_caption: z.string().trim().max(200),
  terms_url: z.union([z.literal(""), z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), "The terms link must start with http:// or https://.")]),
  show_expiry: z.boolean(),
});
export const proposalSchema = z.object({ enabled: z.boolean(), brands: z.object({ washing: brandSchema, lights: brandSchema }) });

/** The proposal settings as stored now (defaults where nothing's saved). */
export async function currentProposal(admin: Db, companyId: string): Promise<{ settings: Record<string, unknown>; proposal: ProposalSettings }> {
  const { data, error } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new HttpError(404, "Company not found.");
  const settings = (data.settings ?? {}) as Record<string, unknown>;
  return { settings, proposal: proposalSettings(settings) };
}

/** Saves the settings: every picture they name must be this company's; pictures no longer used are removed. */
export async function saveProposal(admin: Db, companyId: string, next: ProposalSettings): Promise<ProposalSettings> {
  const used = proposalPictures(next);
  if (used.some((p) => !isProposalPath(p, companyId))) throw new HttpError(400, "One of the pictures isn't one of yours. Upload it again.");
  const { settings, proposal: old } = await currentProposal(admin, companyId);
  const saved = await admin.from("companies").update({ settings: { ...settings, big_proposal: next } as never }).eq("id", companyId);
  if (saved.error) throw dbError(saved.error);
  const gone = proposalPictures(old).filter((p) => !used.includes(p) && isProposalPath(p, companyId));
  if (gone.length) await admin.storage.from("files").remove(gone);
  return proposalSettings({ big_proposal: next });
}

/** The proposal as clients get it on the Hub: null while it's off; pictures as addresses, not paths. */
export function hubProposal(companyId: string, settings: unknown) {
  const p = proposalSettings(settings);
  if (!p.enabled) return null;
  const url = (path: string | null) => (path && isProposalPath(path, companyId) ? proposalPictureUrl(path) : null);
  return Object.fromEntries(
    PROPOSAL_BRANDS.map((b) => {
      const x = p.brands[b];
      return [
        b,
        {
          ...x,
          logo: url(x.logo),
          testimonials_picture: url(x.testimonials_picture),
          insurance_picture: url(x.insurance_picture),
          photos: x.photos.map(url).filter((u): u is string => Boolean(u)),
        },
      ];
    }),
  );
}

/** Whether `path` is a picture the company's proposal uses now (the public route serves only those). */
export const proposalUses = (companyId: string, settings: unknown, path: string) => isProposalPath(path, companyId) && proposalPictures(proposalSettings(settings)).includes(path);

export { defaultProposal };
