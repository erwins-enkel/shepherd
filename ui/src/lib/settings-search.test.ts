import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { decisionModelRows, matchCount, sectionSearchRows } from "./settings-search";

// `sessionRows()` is a hand-maintained mirror of the Session panel's rows, and nothing structural
// keeps the two in step: a row added to the panel alone still renders and still highlights, but it
// contributes no match. Since the section's `matchCount` decides whether the whole section survives
// the mobile section filter, an unregistered row makes its setting UNREACHABLE via search while
// looking perfectly fine on screen — and undercounts the desktop rail badge. That is what these
// assert.

const PANEL = readFileSync(
  new URL("./components/settings/SettingsSessionPanel.svelte", import.meta.url),
  "utf8",
);

const sessionRows = (): string[][] => sectionSearchRows({}).session;

describe("the Session section's searchable rows mirror the panel", () => {
  it("registers exactly as many rows as the panel renders", () => {
    // The first entry of the section's rows is its own tab label, not a row.
    const registered = sessionRows().length - 1;
    const rendered = PANEL.match(/<SettingRow\b/g)?.length ?? 0;
    expect(rendered).toBeGreaterThan(0);
    expect(registered).toBe(rendered);
  });

  it("no longer carries the judge rows — they live in Decision model (#3071)", () => {
    expect(matchCount(sessionRows(), "judge")).toBe(0);
    expect(matchCount(sessionRows(), "jev")).toBe(0);
  });
});

// The section renders its rows across the panel and its Advanced child.
const DM_PANEL = ["SettingsDecisionModelPanel.svelte", "DecisionModelAdvanced.svelte"]
  .map((f) => readFileSync(new URL(`./components/settings/${f}`, import.meta.url), "utf8"))
  .join("\n");

describe("the Decision model section's searchable rows (#3071)", () => {
  it("registers every row the panel renders", () => {
    // The section's own tab row and the stop classifier's "rides along" note are not SettingRows.
    const registered = sectionSearchRows({}).decisionModel.length - 2;
    const rendered = DM_PANEL.match(/<SettingRow\b/g)?.length ?? 0;
    expect(rendered).toBeGreaterThan(0);
    expect(registered).toBe(rendered);
  });

  it("finds the section by jev, typesafe and judge", () => {
    // The German catalog is checked in SettingsDecisionModelPanel.browser.test.ts: Paraglide keeps
    // the locale in localStorage, which this node runner does not have.
    const rows = sectionSearchRows({}).decisionModel;
    for (const q of ["jev", "typesafe", "judge"]) expect(matchCount(rows, q), q).toBeGreaterThan(0);
  });

  it("finds each feature whichever hint its state renders", () => {
    const { uses } = decisionModelRows();
    expect(matchCount(uses, "frees subscription quota")).toBe(0);
    expect(matchCount(uses, "saves subscription quota")).toBe(1);
    expect(matchCount(uses, "Needs a JEV key above")).toBe(2);
    expect(matchCount(uses, "Turn on the fast stop classifier first")).toBe(1);
    expect(matchCount(uses, "just text")).toBe(0);
    expect(matchCount(uses, "only printed text")).toBe(1);
  });

  it("indexes the Advanced fields on their own, so search can open that group", () => {
    const { advanced } = decisionModelRows();
    expect(matchCount(advanced, "API address")).toBe(1);
    expect(matchCount(advanced, "snapshot")).toBe(1);
    expect(matchCount(advanced, "60000")).toBe(1);
  });
});
