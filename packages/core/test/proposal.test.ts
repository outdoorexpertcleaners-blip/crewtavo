import { describe, expect, it } from "vitest";
import { defaultProposal, fillProposal, firstName, proposalBrand, proposalDate, proposalPictures, proposalSettings } from "../src/proposal";

describe("which brand a quote is", () => {
  it("is lights when any line is a lighting job", () => {
    expect(proposalBrand([{ name: "Basic Roofline Package" }])).toBe("lights");
    expect(proposalBrand([{ name: "House Washing" }, { name: "Bush Lighting Package" }])).toBe("lights");
    expect(proposalBrand([{ name: "Wreaths" }])).toBe("lights");
    expect(proposalBrand([{ name: "Custom item", category: "Christmas Lights" }])).toBe("lights");
  });

  it("is washing otherwise, including window and skylight work", () => {
    expect(proposalBrand([{ name: "House Washing" }, { name: "Driveway Cleaning" }])).toBe("washing");
    expect(proposalBrand([{ name: "Exterior Window Cleaning" }, { name: "Skylights" }])).toBe("washing");
    expect(proposalBrand([])).toBe("washing");
  });
});

describe("the proposal settings", () => {
  it("start off, navy for washing and red for lights", () => {
    const d = defaultProposal();
    expect(d.enabled).toBe(false);
    expect(d.brands.washing.color).toBe("#000080");
    expect(d.brands.lights.color).toBe("#ff0000");
    expect(d.brands.washing.photos_title).toBe("Before & After Photos");
    expect(d.brands.lights.photos_title).toBe("Our projects");
    expect(d.brands.lights.show_expiry).toBe(true);
  });

  it("read what's stored and fall back for anything missing or malformed", () => {
    const p = proposalSettings({
      big_proposal: {
        enabled: true,
        brands: { washing: { name: "Outdoor Expert Cleaners LLC.", color: "not a color", photos: ["a/proposal/1.jpg", 7, ""], address: ["15745 Burdette Ct", 3] } },
      },
    });
    expect(p.enabled).toBe(true);
    expect(p.brands.washing.name).toBe("Outdoor Expert Cleaners LLC.");
    expect(p.brands.washing.color).toBe("#000080");
    expect(p.brands.washing.photos).toEqual(["a/proposal/1.jpg"]);
    expect(p.brands.washing.address).toEqual(["15745 Burdette Ct"]);
    expect(p.brands.lights.intro_html).toContain("Dear {first_name},");
    expect(proposalSettings(null).enabled).toBe(false);
    expect(proposalSettings({ big_proposal: "yes" }).enabled).toBe(false);
  });

  it("list every picture they use", () => {
    const p = defaultProposal();
    p.brands.washing.logo = "c/proposal/logo.png";
    p.brands.washing.photos = ["c/proposal/1.jpg", "c/proposal/2.jpg"];
    p.brands.lights.insurance_picture = "c/proposal/coi.png";
    expect(proposalPictures(p).sort()).toEqual(["c/proposal/1.jpg", "c/proposal/2.jpg", "c/proposal/coi.png", "c/proposal/logo.png"]);
  });
});

describe("the business's words", () => {
  it("fill in the client and company, escaped", () => {
    expect(fillProposal("<p>Dear {first_name},</p><p>{company} · {unknown}</p>", { first_name: "Jane", company: "A & B <Co>" })).toBe("<p>Dear Jane,</p><p>A &amp; B &lt;Co&gt; · {unknown}</p>");
  });

  it("take the first name and write CF's dates", () => {
    expect(firstName("Jane  Sample")).toBe("Jane");
    expect(firstName(null)).toBe("");
    expect(proposalDate("2026-11-29")).toBe("Nov 29, 2026");
    expect(proposalDate("2026-12-02T00:00:00Z")).toBe("Dec 02, 2026");
  });
});

describe("a brand's name in a text", () => {
  it("leaves off the legal ending and the last period", async () => {
    const { spokenName } = await import("../src/proposal");
    expect(spokenName("Outdoor Expert Cleaners LLC.")).toBe("Outdoor Expert Cleaners");
    expect(spokenName("Outdoor Expert Lighting, LLC")).toBe("Outdoor Expert Lighting");
    expect(spokenName("Green Lawn Inc.")).toBe("Green Lawn");
    expect(spokenName("Outdoor Expert Cleaners")).toBe("Outdoor Expert Cleaners");
    expect(spokenName("LLC")).toBe("LLC");
  });
});
