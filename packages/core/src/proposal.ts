/**
 * The Big Proposal (Outdoor Expert Cleaners' modification): a quote's client page laid out as a
 * tabbed proposal, the way Customer Factor's "Big Proposal" looked, with one look per brand. Its
 * settings live in companies.settings.big_proposal (no migration: settings is the company's own
 * JSON) and are changed in Settings → Proposal (PUT /api/company/proposal). Its pictures are kept in
 * the files bucket at <company>/proposal/<uuid>.(jpg|png) and served to clients from
 * /api/public/proposal/<company>/<uuid>.(jpg|png) (apps/api services/proposal.ts).
 *
 * What's here is platform-free: the shape of the settings and how they're read, which brand a quote
 * is, and the fill-ins in the business's own words.
 */

export const PROPOSAL_BRANDS = ["washing", "lights"] as const;
export type ProposalBrand = (typeof PROPOSAL_BRANDS)[number];

/** One brand's proposal: its letterhead, its words and its pictures (stored paths). */
export interface BrandProposal {
  name: string;
  /** Who signs the letters ("William McHugh"): the {owner} fill-in. */
  owner: string;
  address: string[];
  phone: string;
  email: string;
  color: string;
  logo: string | null;
  intro_html: string;
  closing_html: string;
  agreement_html: string;
  testimonials_html: string;
  testimonials_picture: string | null;
  insurance_picture: string | null;
  photos: string[];
  photos_title: string;
  photos_caption: string;
  terms_url: string;
  show_expiry: boolean;
}

export interface ProposalSettings {
  enabled: boolean;
  brands: Record<ProposalBrand, BrandProposal>;
}

export const BRAND_LABEL: Record<ProposalBrand, string> = { washing: "Pressure washing", lights: "Christmas lights" };

/**
 * A brand's name as clients know it ("Outdoor Expert Cleaners", "Outdoor Expert Lighting"): the one
 * on its Big Proposal letterhead, else the company's own name. For texts that say who's writing.
 */
export function brandName(settings: unknown, brand: ProposalBrand | null | undefined, companyName: string): string {
  return (brand && proposalSettings(settings).brands[brand].name.trim()) || companyName;
}

/**
 * A brand's name as said in a text: the letterhead's without the legal ending ("Outdoor Expert
 * Cleaners LLC." reads "Outdoor Expert Cleaners"), so "this is Mike with {{brand.name}}." doesn't
 * end in "LLC.." or sound like a contract.
 */
export function spokenName(name: string): string {
  const spoken = name.trim().replace(/[\s,]+(L\.?L\.?C|Inc|Co|Corp|Ltd)\.?$/i, "").replace(/[.\s]+$/, "");
  return spoken || name.trim();
}

const INTRO = (word: string) =>
  `<p>Dear {first_name},</p><p>We would like to start by thanking you for the opportunity to present our service(s) to you. At {company} we pride ourselves on providing an elite level of service and we look forward to demonstrating that same value to you. We offer something much more than a simple ${word} service; we are a partner!</p><p>Please take a moment to get to know us a little better as we have included information regarding the services offered, the clients we service, our credentials, our insurance and contact info, the scope of the work discussed and finally a firm quote. In this packet of information you can accept the quote at any time simply by clicking the "Accept" button at the top of this page. However, if you have any questions please don't hesitate to call us and we will be happy to answer any questions you may have.</p><p>Respectfully Submitted,</p><p>{owner}<br>{company}<br>{phone}</p>`;

const CLOSING =
  "<p><strong>Thanks for reviewing this proposal {first_name}.</strong> We truly value our customers and we'll provide you a high quality service that you'll remember! If you're not 100% convinced of that then I encourage you to review this proposal again. And please don't hesitate to contact us. You can call us at {phone}, reply to the email which has this proposal link in it, or send an email directly to {email}.</p><p>We are standing by ready to take care of your needs! Thank you once again for the opportunity to present our service and pricing to you.</p><p>Best Regards,</p><p>{owner}<br>{company}<br>{phone}<br>{email}</p>";

const blank = (color: string, word: string, photosTitle: string): BrandProposal => ({
  name: "",
  owner: "",
  address: [],
  phone: "",
  email: "",
  color,
  logo: null,
  intro_html: INTRO(word),
  closing_html: CLOSING,
  agreement_html: "",
  testimonials_html: "",
  testimonials_picture: null,
  insurance_picture: null,
  photos: [],
  photos_title: photosTitle,
  photos_caption: "",
  terms_url: "",
  show_expiry: false,
});

/** What a business starts with: off, a navy washing look and a red lights look, CF's own wording. */
export const defaultProposal = (): ProposalSettings => ({
  enabled: false,
  brands: {
    washing: blank("#000080", "cleaning", "Before & After Photos"),
    lights: { ...blank("#ff0000", "installation", "Our projects"), show_expiry: true },
  },
});

const HEX = /^#[0-9a-f]{6}$/i;
const str = (v: unknown, max: number, fallback = "") => (typeof v === "string" ? v.slice(0, max) : fallback);
const pathOr = (v: unknown) => (typeof v === "string" && v ? v : null);

/** The stored settings read safely: anything missing or malformed falls back to the default. */
export function proposalSettings(settings: unknown): ProposalSettings {
  const base = defaultProposal();
  const raw = settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
  const bp = raw.big_proposal && typeof raw.big_proposal === "object" ? (raw.big_proposal as Record<string, unknown>) : {};
  const brands = bp.brands && typeof bp.brands === "object" ? (bp.brands as Record<string, unknown>) : {};
  const read = (brand: ProposalBrand): BrandProposal => {
    const d = base.brands[brand];
    const b = brands[brand] && typeof brands[brand] === "object" ? (brands[brand] as Record<string, unknown>) : {};
    return {
      name: str(b.name, 120),
      owner: str(b.owner, 120),
      address: Array.isArray(b.address) ? b.address.filter((l): l is string => typeof l === "string").slice(0, 6).map((l) => l.slice(0, 120)) : [],
      phone: str(b.phone, 40),
      email: str(b.email, 200),
      color: typeof b.color === "string" && HEX.test(b.color) ? b.color : d.color,
      logo: pathOr(b.logo),
      intro_html: typeof b.intro_html === "string" ? b.intro_html : d.intro_html,
      closing_html: typeof b.closing_html === "string" ? b.closing_html : d.closing_html,
      agreement_html: str(b.agreement_html, 100_000),
      testimonials_html: str(b.testimonials_html, 100_000),
      testimonials_picture: pathOr(b.testimonials_picture),
      insurance_picture: pathOr(b.insurance_picture),
      photos: Array.isArray(b.photos) ? b.photos.filter((p): p is string => typeof p === "string" && Boolean(p)).slice(0, PROPOSAL_MAX_PHOTOS) : [],
      photos_title: str(b.photos_title, 60, d.photos_title) || d.photos_title,
      photos_caption: str(b.photos_caption, 200),
      terms_url: str(b.terms_url, 500),
      show_expiry: typeof b.show_expiry === "boolean" ? b.show_expiry : d.show_expiry,
    };
  };
  return { enabled: bp.enabled === true, brands: { washing: read("washing"), lights: read("lights") } };
}

export const PROPOSAL_MAX_PHOTOS = 24;

/** Every stored picture the settings point at, for cleaning up the ones no longer used. */
export const proposalPictures = (p: ProposalSettings): string[] =>
  PROPOSAL_BRANDS.flatMap((b) => {
    const x = p.brands[b];
    return [x.logo, x.testimonials_picture, x.insurance_picture, ...x.photos].filter((v): v is string => Boolean(v));
  });

/** Words in a line's name that make it a Christmas-lights job, as the CF → GHL sync decides. */
const LIGHTS = /\b(roofline|lighting|lights?|christmas|holiday|wreaths?|garlands?|cedar|tree wrap)\b/i;

/** Which brand a quote is: lights when any line is a lighting job, else washing. */
export function proposalBrand(lines: ReadonlyArray<{ name: string; category?: string | null }>): ProposalBrand {
  return lines.some((l) => /christmas lights/i.test(l.category ?? "") || LIGHTS.test(l.name)) ? "lights" : "washing";
}

/** The first word of the client's name, as the letter says "Dear Jane,". */
export const firstName = (displayName: string | null | undefined) => (displayName ?? "").trim().split(/\s+/)[0] ?? "";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const PROPOSAL_FILL_INS = ["first_name", "client_name", "company", "phone", "email", "owner"] as const;
export type ProposalFillIns = Partial<Record<(typeof PROPOSAL_FILL_INS)[number], string>>;

/** The business's words with {first_name} and the rest filled in (escaped: it's HTML). Unknown ones stay as typed. */
export function fillProposal(html: string, values: ProposalFillIns): string {
  return html.replace(/\{([a-z_]+)\}/g, (whole, key: string) => (key in values && values[key as keyof ProposalFillIns] != null ? escapeHtml(values[key as keyof ProposalFillIns]!) : whole));
}

/** "Nov 29, 2026" from "2026-11-29", as CF wrote the expiry. */
export function proposalDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return y && m && d ? `${months[m - 1]} ${String(d).padStart(2, "0")}, ${y}` : isoDate;
}
