import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { matchCount, sectionSearchRows } from "./settings-search";

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

const sessionRows = (): string[][] => sectionSearchRows({ provider: "claude" }).session;

describe("the Session section's searchable rows mirror the panel", () => {
  it("registers exactly as many rows as the panel renders", () => {
    // The first entry of the section's rows is its own tab label, not a row.
    const registered = sessionRows().length - 1;
    const rendered = PANEL.match(/<SettingRow\b/g)?.length ?? 0;
    expect(rendered).toBeGreaterThan(0);
    expect(registered).toBe(rendered);
  });

  it("finds the judge rows by title and by hint", () => {
    const rows = sessionRows();
    // Both judge rows, by a word from each title.
    expect(matchCount(rows, "classifier")).toBeGreaterThanOrEqual(2);
    // And by hint prose, which is how an operator who knows the concept but not our label searches.
    expect(matchCount(rows, "decision model")).toBeGreaterThan(0);
    expect(matchCount(rows, "daily limit")).toBeGreaterThan(0);
  });

  it("finds the judge toggle whichever hint its key state renders", () => {
    const rows = sessionRows();
    // The row swaps its description depending on whether a credential is configured. A row counts
    // once however many of its strings hit, so carrying both keeps it findable either way.
    expect(matchCount(rows, "frees subscription quota")).toBe(1);
    expect(matchCount(rows, "keeps using a Claude agent spawn")).toBe(1);
    // THREE key-gated rows now point at the same credential file — the judge toggle, the
    // blocked-pane backstop and the house-rule relevance gate — and each must be findable by it.
    expect(matchCount(rows, "~/.shepherd/env")).toBe(3);
  });

  it("finds the blocked-pane backstop row by title and by either hint", () => {
    const rows = sessionRows();
    expect(matchCount(rows, "Blocked-pane double check")).toBe(1);
    expect(matchCount(rows, "just text the agent printed")).toBe(1);
    expect(matchCount(rows, "panes are announced exactly as they are today")).toBe(1);
  });

  it("finds the house-rule relevance row by title and by either hint", () => {
    const rows = sessionRows();
    expect(matchCount(rows, "House rules for this task only")).toBe(1);
    // Same dual-hint contract as the judge toggle: the row renders whichever matches the key state.
    expect(matchCount(rows, "leave the rest out of the agent")).toBe(1);
    expect(matchCount(rows, "Needs the fast stop classifier turned on")).toBe(1);
  });
});
