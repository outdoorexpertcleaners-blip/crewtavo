/**
 * The sales board's stages, named and ordered as the business's GoHighLevel pipelines have them (one
 * pipeline per brand: washing and Christmas lights), and where a request or quote sits on it.
 *
 * Leads (requests without a quote) sit in one of the first five stages: the office moves them there
 * by hand (requests.stage), and until it does a new request is an Inbound Lead and one with an
 * assessment booked or done is In Person Estimate Booked. From there a quote's status says where it
 * is: a draft is still being priced (with its lead), sent is Quote Sent, signed is Closed-Won, and
 * once its job is done it's Job Completed.
 */
import { proposalBrand, type ProposalBrand } from "./proposal";

export const PIPELINE_STAGES = [
  { key: "inbound", label: "Inbound Lead" },
  { key: "hot", label: "Hot Inbound Lead" },
  { key: "reached_out", label: "Reached Out (Sent Text)" },
  { key: "estimate_booked", label: "In Person Estimate Booked" },
  { key: "remote_quote", label: "Remote Quote Needed" },
  { key: "quote_sent", label: "Quote Sent-Pending Approval" },
  { key: "won", label: "Closed-Won" },
  { key: "lost", label: "Closed-Lost" },
  { key: "completed", label: "Job Completed" },
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number]["key"];

/** The stages a lead is moved between by hand (requests.stage). */
export const LEAD_STAGES = ["inbound", "hot", "reached_out", "estimate_booked", "remote_quote"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const isLeadStage = (s: string | null | undefined): s is LeadStage => (LEAD_STAGES as readonly string[]).includes(s ?? "");

/** The stage's name as the board shows it. */
export const stageLabel = (key: PipelineStage) => PIPELINE_STAGES.find((s) => s.key === key)!.label;

/**
 * Where a request sits, or null when it's not on the board as a lead: it has a quote (the quote
 * stands for it), became a job, or was archived.
 */
export function requestStage(r: { status: string; stage?: string | null }): LeadStage | null {
  if (!["new", "assessment_scheduled", "assessment_complete"].includes(r.status)) return null;
  if (isLeadStage(r.stage)) return r.stage;
  return r.status === "new" ? "inbound" : "estimate_booked";
}

/**
 * Where a quote sits, or null when it's off the board (archived). A draft stays with its lead: in
 * Remote Quote Needed when that's where its request was, else In Person Estimate Booked.
 * `jobStatus` is the status of the job it became, when it became one.
 */
export function quoteStage(q: { status: string; requestStage?: string | null; jobStatus?: string | null }): PipelineStage | null {
  switch (q.status) {
    case "draft":
      return q.requestStage === "remote_quote" ? "remote_quote" : "estimate_booked";
    case "sent":
    case "changes_requested":
      return "quote_sent";
    case "approved":
      return "won";
    case "converted":
      return q.jobStatus === "completed" ? "completed" : "won";
    case "lost":
      return "lost";
    default:
      return null;
  }
}

export const BRANDS = ["washing", "lights"] as const;
export type Brand = ProposalBrand;

const asBrand = (b: string | null | undefined): Brand | null => (b === "washing" || b === "lights" ? b : null);

/** A quote's brand: the one the office set, else lights when a line is a lighting job, else washing. */
export const quoteBrand = (q: { brand?: string | null; lines: ReadonlyArray<{ name: string; category?: string | null }> }): Brand =>
  asBrand(q.brand) ?? proposalBrand(q.lines);

/**
 * A request's brand: the one the office set, else its quote's (`quoteBrand`, when it has one), else
 * what its title says ("Christmas lights" → lights), else washing.
 */
export const requestBrand = (r: { brand?: string | null; title: string; quoteBrand?: Brand | null }): Brand =>
  asBrand(r.brand) ?? r.quoteBrand ?? proposalBrand([{ name: r.title }]);
