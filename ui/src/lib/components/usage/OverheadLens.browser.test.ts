import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { mockBreakdown } from "$lib/usage-mock";

const { default: OverheadLens } = await import("./OverheadLens.svelte");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("OverheadLens", () => {
  it("overall tax caption renders a non-empty percentage", async () => {
    const breakdown = mockBreakdown("7d");
    render(OverheadLens, { breakdown });

    // Tax caption should contain a % sign
    const captions = document.querySelectorAll(".tax-caption");
    expect(captions.length, "tax caption rendered").toBeGreaterThan(0);
    const captionText = captions[0]?.textContent ?? "";
    expect(captionText).toMatch(/%/);
    expect(captionText.trim().length, "caption is non-empty").toBeGreaterThan(0);
  });

  it("per-task tax list shows ≤6 rows sorted with highest-tax task first and a +% label", async () => {
    const breakdown = mockBreakdown("7d");
    render(OverheadLens, { breakdown });

    const rows = document.querySelectorAll(".tax-task-row");
    expect(rows.length, "at least 1 tax task row").toBeGreaterThanOrEqual(1);
    expect(rows.length, "at most 6 tax task rows").toBeLessThanOrEqual(6);

    // First row should have the highest tax — check its +% label
    const firstPct = rows[0]?.querySelector(".tax-pct");
    expect(firstPct, "first row has a .tax-pct element").not.toBeNull();
    expect(firstPct?.textContent ?? "").toMatch(/^\+\d+%$/);

    // All pct labels should start with +
    rows.forEach((row, i) => {
      const pctEl = row.querySelector(".tax-pct");
      expect(pctEl?.textContent ?? "", `row ${i} has +% label`).toMatch(/^\+\d+%$/);
    });

    // Verify descending order: extract numeric values and check sorted
    const pctValues = Array.from(rows).map((row) => {
      const txt = row.querySelector(".tax-pct")?.textContent ?? "+0%";
      return parseInt(txt.replace(/^\+/, "").replace(/%$/, ""), 10);
    });
    for (let i = 1; i < pctValues.length; i++) {
      expect(pctValues[i], `row ${i} tax ≤ row ${i - 1} tax (sorted desc)`).toBeLessThanOrEqual(
        pctValues[i - 1],
      );
    }
  });

  it("satellite-by-type section renders one row per kind, sorted desc by units, with a count", async () => {
    const base = mockBreakdown("7d");
    const breakdown = {
      ...base,
      satelliteByKind: [
        {
          kind: "classifier",
          units: (base.satelliteByKind[0]?.units ?? 0) + 1,
          count: 2,
        },
        ...base.satelliteByKind,
      ],
    };
    render(OverheadLens, { breakdown });

    await expect.element(page.getByText("Satellite by type")).toBeInTheDocument();

    const rows = document.querySelectorAll(".bykind-row");
    expect(rows.length, "one row per kind").toBe(breakdown.satelliteByKind.length);
    expect(rows.length).toBeGreaterThan(0);

    // First row is the largest kind and carries the localized classifier label + count.
    const firstLabel = rows[0]?.querySelector(".bykind-label")?.textContent ?? "";
    expect(firstLabel).toBe("Classifier");
    const firstCount = rows[0]?.querySelector(".bykind-count")?.textContent ?? "";
    expect(firstCount).toBe("2×");

    // Each row shows a % share.
    rows.forEach((row, i) => {
      const pct = row.querySelector(".bykind-pct")?.textContent ?? "";
      expect(pct, `row ${i} has a % share`).toMatch(/%$/);
    });
  });

  it("satellite-by-type section is absent when there are no satellite passes", async () => {
    const breakdown = { ...mockBreakdown("7d"), satelliteByKind: [] };
    render(OverheadLens, { breakdown });

    expect(document.querySelectorAll(".bykind-row").length).toBe(0);
    expect(page.getByText("Satellite by type").elements().length).toBe(0);
  });

  it("cacheRead ratio section renders both cached-reads and generation shares", async () => {
    const breakdown = mockBreakdown("7d");
    render(OverheadLens, { breakdown });

    // The cache section heading should be present
    await expect.element(page.getByText("Cache efficiency")).toBeInTheDocument();

    // Both labels should be present
    await expect.element(page.getByText("cached reads")).toBeInTheDocument();
    await expect.element(page.getByText("generation")).toBeInTheDocument();

    // Both segments should exist in the DOM
    const cacheReadSeg = document.querySelector(".cacheread-seg");
    const generationSeg = document.querySelector(".generation-seg");
    expect(cacheReadSeg, "cacheread segment present").not.toBeNull();
    expect(generationSeg, "generation segment present").not.toBeNull();

    // Segments should have non-zero widths (style attribute set)
    const crStyle = (cacheReadSeg as HTMLElement)?.style.width ?? "";
    const genStyle = (generationSeg as HTMLElement)?.style.width ?? "";
    expect(crStyle, "cacheread segment has width").not.toBe("");
    expect(genStyle, "generation segment has width").not.toBe("");

    // The split-share spans for the cache section should contain % values
    const shareEls = document.querySelectorAll(".split-share");
    const sharePcts = Array.from(shareEls).map((el) => el.textContent ?? "");
    const hasPercent = sharePcts.some((t) => t.includes("%"));
    expect(hasPercent, "at least one share percentage displayed").toBe(true);
  });
});
