/**
 * The Big Proposal's approval (Review, Sign, the signed copy) sits in the section card beside the
 * menu. The Hub's paper (.hub-document) is sized to break out of the plain Hub's 640px column, to
 * min(848px, 100vw - 32px); inside the Big Proposal that spilled past the screen's right edge at
 * 1024px wide, and the page scrolled sideways. Checked in the stylesheets' own source, with the
 * widths worked out from their numbers.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const big = source("../src/features/hub/BigProposal.module.css");
const shared = source("../src/styles/features.css");

/** The Hub's breakout width for the paper, as features.css sizes it: min(848px, 100vw - 32px). */
const breakout = (viewport: number) => Math.min(848, viewport - 32);
/** The section card's inner width in the Big Proposal: .wrap's 16px sides, the 264px menu and 29px gap above 991px, .main's 20px sides. */
const column = (viewport: number) => {
  const wrap = Math.min(1171, viewport) - 32;
  const main = viewport > 991 ? wrap - 264 - 29 : wrap;
  return main - 40;
};

describe("the Big Proposal's approval column", () => {
  it("is where the Hub's breakout would spill off a 1024px screen", () => {
    // The shared rule the override below undoes.
    expect(shared).toContain(".hub-document { --doc-w: min(848px, calc(100vw - 32px));");
    expect(big).toMatch(/\.cols \{[^}]*grid-template-columns: 264px minmax\(0, 1fr\)/);
    // Centered on the column, the breakout reaches past the screen's right edge (1024 - 16px - 20px).
    const spill = (breakout(1024) - column(1024)) / 2;
    expect(1024 - 16 - 20 + spill).toBeGreaterThan(1024);
  });

  it("keeps the paper to its column, in the review step and on the signed copy", () => {
    const rule = big.match(/\.approval :global\(\.hub-document\), \.after :global\(\.hub-document\) \{([^}]*)\}/);
    expect(rule?.[1]).toContain("width: auto");
    expect(rule?.[1]).toContain("margin-inline: 0");
    expect(big).toMatch(/\.approval \{[^}]*min-width: 0/);
    expect(big).toMatch(/\.main \{[^}]*min-width: 0/);
  });

  it("leaves a readable page at 1024, 768 and 375 wide (DocumentSheet scales 816px pages to fit)", () => {
    for (const viewport of [1024, 768, 375]) {
      const width = column(viewport);
      expect(width).toBeLessThanOrEqual(viewport - 72);
      // DocumentSheet's scale, floored at 0.2.
      expect(Math.min(1, width / 816)).toBeGreaterThan(0.35);
    }
  });
});
