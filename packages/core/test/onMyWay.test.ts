/**
 * The On my way text as the owner wants it (20261119000200_on_my_way_from_the_tech.sql): "Hi Jane,
 * this is Mike with Outdoor Expert Cleaners. I'm on my way and should be there in about 20 minutes."
 * The words around a name that isn't known, the arrival time worded for "I'm on my way", and the
 * brand's name.
 */
import { describe, expect, it } from "vitest";
import { etaWords, renderTemplate, variablesForTrigger } from "../src/automations";
import { brandName } from "../src/proposal";

const STARTER = "Hi {{client.first_name}}, this is {{tech.first_name}} with {{brand.name}}. I'm on my way{{eta_there}}.";
const NOW = Date.parse("2026-11-19T15:00:00Z");
const in20 = new Date(NOW + 20.5 * 60_000).toISOString();

describe("the on my way text", () => {
  it("names who's on the way and the brand, with when they should be there", () => {
    const vars = { client: { first_name: "Jane" }, tech: { first_name: "Mike" }, brand: { name: "Outdoor Expert Cleaners" }, eta_there: etaWords(in20, NOW, "there") };
    expect(renderTemplate(STARTER, vars)).toBe("Hi Jane, this is Mike with Outdoor Expert Cleaners. I'm on my way and should be there in about 20 minutes.");
  });

  it("reads naturally with no arrival time or no name", () => {
    const vars = { client: { first_name: "Jane" }, tech: { first_name: "" }, brand: { name: "Outdoor Expert Lighting" }, eta_there: etaWords(null, NOW, "there") };
    expect(renderTemplate(STARTER, vars)).toBe("Hi Jane, this is Outdoor Expert Lighting. I'm on my way.");
    // No event at all (a rule tested by hand): the tech token isn't there.
    expect(renderTemplate(STARTER, { client: { first_name: "Jane" }, brand: { name: "Outdoor Expert Cleaners" } })).toBe("Hi Jane, this is Outdoor Expert Cleaners. I'm on my way.");
  });

  it("leaves a business's own {{eta}} wording as it was", () => {
    expect(etaWords(in20, NOW)).toBe(" and should arrive in about 20 minutes");
    expect(etaWords(in20, NOW, "there")).toBe(" and should be there in about 20 minutes");
    expect(etaWords(new Date(NOW + 95 * 60_000).toISOString(), NOW, "there")).toBe(" and should be there in about 1 hour 35 minutes");
  });

  it("only tidies \"this is\" right before \"with\", not other sentences with \"with\"", () => {
    expect(renderTemplate("We'll be there with {{brand.name}}.", { brand: { name: "Outdoor Expert Cleaners" } })).toBe("We'll be there with Outdoor Expert Cleaners.");
  });

  it("offers who's on the way and the brand in the rule editor", () => {
    const tokens = variablesForTrigger("visit.en_route").map((v) => v.token);
    expect(tokens).toEqual(expect.arrayContaining(["tech.first_name", "brand.name", "eta", "eta_there"]));
    expect(variablesForTrigger("visit.completed").map((v) => v.token)).not.toContain("tech.first_name");
  });
});

describe("a brand's name", () => {
  const settings = { big_proposal: { brands: { washing: { name: "Outdoor Expert Cleaners" }, lights: { name: "Outdoor Expert Lighting" } } } };

  it("is the one on the brand's Big Proposal", () => {
    expect(brandName(settings, "washing", "Outdoor Expert LLC")).toBe("Outdoor Expert Cleaners");
    expect(brandName(settings, "lights", "Outdoor Expert LLC")).toBe("Outdoor Expert Lighting");
  });

  it("is the company's name when the brand has none, or none is known", () => {
    expect(brandName({}, "lights", "Outdoor Expert LLC")).toBe("Outdoor Expert LLC");
    expect(brandName(settings, null, "Outdoor Expert LLC")).toBe("Outdoor Expert LLC");
  });
});
