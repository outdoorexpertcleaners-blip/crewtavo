import { describe, expect, it } from "vitest";
import { LEAD_STAGES, PIPELINE_STAGES, isLeadStage, quoteBrand, quoteStage, requestBrand, requestStage, stageLabel } from "../src/pipeline";

describe("the sales board's stages", () => {
  it("are GoHighLevel's, in its order", () => {
    expect(PIPELINE_STAGES.map((s) => s.label)).toEqual([
      "Inbound Lead",
      "Hot Inbound Lead",
      "Reached Out (Sent Text)",
      "In Person Estimate Booked",
      "Remote Quote Needed",
      "Quote Sent-Pending Approval",
      "Closed-Won",
      "Closed-Lost",
      "Job Completed",
    ]);
    expect(LEAD_STAGES).toEqual(PIPELINE_STAGES.slice(0, 5).map((s) => s.key));
    expect(stageLabel("quote_sent")).toBe("Quote Sent-Pending Approval");
  });

  it("knows a lead stage", () => {
    expect(isLeadStage("hot")).toBe(true);
    expect(isLeadStage("won")).toBe(false);
    expect(isLeadStage(null)).toBe(false);
  });
});

describe("where a request sits", () => {
  it("follows its status until the office moves it", () => {
    expect(requestStage({ status: "new" })).toBe("inbound");
    expect(requestStage({ status: "new", stage: null })).toBe("inbound");
    expect(requestStage({ status: "assessment_scheduled" })).toBe("estimate_booked");
    expect(requestStage({ status: "assessment_complete" })).toBe("estimate_booked");
  });

  it("is where the office moved it", () => {
    expect(requestStage({ status: "new", stage: "reached_out" })).toBe("reached_out");
    expect(requestStage({ status: "assessment_scheduled", stage: "remote_quote" })).toBe("remote_quote");
  });

  it("ignores a stage that isn't a lead stage", () => {
    expect(requestStage({ status: "new", stage: "won" })).toBe("inbound");
  });

  it("is off the board once it's quoted, a job or archived", () => {
    for (const status of ["quoted", "converted", "archived"]) expect(requestStage({ status, stage: "hot" })).toBeNull();
  });
});

describe("where a quote sits", () => {
  it("keeps a draft with its lead", () => {
    expect(quoteStage({ status: "draft" })).toBe("estimate_booked");
    expect(quoteStage({ status: "draft", requestStage: "hot" })).toBe("estimate_booked");
    expect(quoteStage({ status: "draft", requestStage: "remote_quote" })).toBe("remote_quote");
  });

  it("follows its status after that", () => {
    expect(quoteStage({ status: "sent" })).toBe("quote_sent");
    expect(quoteStage({ status: "changes_requested" })).toBe("quote_sent");
    expect(quoteStage({ status: "approved" })).toBe("won");
    expect(quoteStage({ status: "converted", jobStatus: "active" })).toBe("won");
    expect(quoteStage({ status: "converted", jobStatus: "requires_invoicing" })).toBe("won");
    expect(quoteStage({ status: "converted", jobStatus: "completed" })).toBe("completed");
    expect(quoteStage({ status: "converted" })).toBe("won");
    expect(quoteStage({ status: "lost" })).toBe("lost");
    expect(quoteStage({ status: "archived" })).toBeNull();
  });
});

describe("which brand", () => {
  it("a quote is: the office's choice, else from its lines", () => {
    expect(quoteBrand({ lines: [{ name: "House Washing" }] })).toBe("washing");
    expect(quoteBrand({ lines: [{ name: "Basic Roofline Package" }] })).toBe("lights");
    expect(quoteBrand({ brand: "lights", lines: [{ name: "House Washing" }] })).toBe("lights");
    expect(quoteBrand({ brand: "washing", lines: [{ name: "Wreaths" }] })).toBe("washing");
    expect(quoteBrand({ brand: "other", lines: [{ name: "Wreaths" }] })).toBe("lights");
  });

  it("a request is: the office's choice, else its quote's, else its title's", () => {
    expect(requestBrand({ title: "House wash" })).toBe("washing");
    expect(requestBrand({ title: "Christmas lights" })).toBe("lights");
    expect(requestBrand({ title: "House wash", quoteBrand: "lights" })).toBe("lights");
    expect(requestBrand({ brand: "washing", title: "Christmas lights", quoteBrand: "lights" })).toBe("washing");
  });
});
