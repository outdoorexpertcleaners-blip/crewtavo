/**
 * An email Marketing sends a client (a review ask or its reminder, a referral ask, an automated
 * campaign): in the company's look, from the company, with one-click unsubscribe
 * (clients.marketing_opt_out stops every one of them, as it stops campaigns) in the footer and the
 * List-Unsubscribe headers, and the company's name and postal address in the footer (`footer`:
 * every sender passes lib/email.ts companyFooter). A campaign email also carries its tracked links
 * and pixel (services/automatedCampaigns.ts). Close pending quotes carries the link as well; only
 * the copies of it that go to a client's contacts don't (`unsubscribe: false`).
 */
import type { Env } from "../env";
import { renderEmail } from "../lib/email";
import { clientLink } from "../lib/links";
import { sendEmail, type SendResult } from "../lib/notify";
import { logoImage } from "./logo";

export interface MarketingCompany {
  name: string;
  email: string | null;
  settings: unknown;
}

export async function emailClient(
  env: Env,
  d: {
    companyId: string;
    company: MarketingCompany;
    client: { id: string; email: string | null };
    subject: string;
    text: string;
    baseUrl: string;
    /** Under the message: the company's name and postal address. */
    footer?: string | null;
    track?: { href: (url: string) => string; pixel: string } | null;
    unsubscribe?: boolean;
    /** Labels for links on their own line (lib/email.ts renderEmail). */
    buttons?: Record<string, string>;
    /** Links written out under their button too, to copy (lib/email.ts renderEmail). */
    showUrls?: readonly string[];
    /** The brand it's about (services/brand.ts): a Christmas lights client's goes from the lights mailbox, when one is connected. */
    brand?: "washing" | "lights" | null;
  },
): Promise<SendResult> {
  const unsubscribe = d.unsubscribe === false ? null : await clientLink(env, d.baseUrl, { c: d.companyId, t: "unsub", id: d.client.id });
  return sendEmail(
    env,
    {
      to: d.client.email!.trim(),
      subject: d.subject,
      ...renderEmail({
        companyName: d.company.name,
        logo: logoImage(d.baseUrl, d.companyId, d.company.settings),
        text: d.text,
        footer: d.footer,
        unsubscribeUrl: unsubscribe,
        href: d.track?.href,
        pixel: d.track?.pixel,
        buttons: d.buttons,
        showUrls: d.showUrls,
      }),
      replyTo: d.company.email ?? undefined,
      fromName: d.company.name,
      brand: d.brand ?? null,
      ...(unsubscribe
        ? { headers: { "List-Unsubscribe": `<${unsubscribe.replace("/u/", "/api/public/unsubscribe/")}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }
        : {}),
    },
    d.companyId,
  );
}
