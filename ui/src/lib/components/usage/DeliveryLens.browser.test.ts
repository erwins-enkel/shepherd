import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "@vitest/browser/context";
import "../../../app.css";
import type { DeliveryMetrics, DeliverySample, DeliveryStats } from "$lib/types";

const { default: DeliveryLens } = await import("./DeliveryLens.svelte");

afterEach(async () => {
  document.body.innerHTML = "";
  await page.viewport(1280, 900);
});

const s = (value: number | null, n = value == null ? 0 : 4): DeliverySample => ({ value, n });

const stats = (over: Partial<DeliveryStats> = {}): DeliveryStats => ({
  mergedTasks: 4,
  firstPassRate: s(0.5),
  unreviewed: 0,
  reworkCyclesMedian: s(1.5),
  reworkCyclesMean: s(1.75),
  criticErrors: 0,
  planRoundsMedian: s(null),
  planReworkRate: s(null),
  timeToFirstReviewMs: s(600_000),
  leadTimeMs: s(23_400_000),
  ...over,
});

const metrics = (over: Partial<DeliveryMetrics> = {}): DeliveryMetrics => ({
  range: "7d",
  generatedAt: 1_000,
  since: 0,
  measuringSince: Date.UTC(2026, 8, 1),
  totals: stats(),
  repos: [
    { repoPath: "/repos/alpha", repo: "alpha", ...stats() },
    { repoPath: "/repos/beta", repo: "beta", ...stats({ mergedTasks: 1, firstPassRate: s(null) }) },
  ],
  incidents: [{ kind: "stall", occurrences: 3, sessions: 2 }],
  trend: [
    { dayKey: "2026-09-01", mergedTasks: 1, firstPassRate: 1, leadTimeMedianMs: 1000 },
    { dayKey: "2026-09-02", mergedTasks: 3, firstPassRate: 0.33, leadTimeMedianMs: 2000 },
  ],
  tasks: [],
  ...over,
});

const tileValues = () =>
  Array.from(document.querySelectorAll(".tile-value")).map((n) => n.textContent?.trim());

describe("DeliveryLens", () => {
  it("renders every indicator with its sample size", async () => {
    render(DeliveryLens, { metrics: metrics() });

    // first-pass, rework, plan rework, ttfr, lead time, merged
    expect(tileValues()).toEqual(["50%", "1.5", "—", "10m", "6h 30m", "4"]);
    expect(document.body.textContent).toContain("n = 4");
  });

  it("resolves glossary markers in tile labels instead of printing them raw", async () => {
    render(DeliveryLens, { metrics: metrics() });
    // GlossaryTerm renders the marker's LABEL plus its tooltip content, so match on containment.
    const labels = Array.from(document.querySelectorAll(".tile-label")).map(
      (n) => n.textContent ?? "",
    );
    expect(labels.some((l) => l.includes("Lead time"))).toBe(true);
    expect(document.body.textContent).not.toContain("[[");
  });

  it("renders an em dash — never a zero — for an empty sample", async () => {
    render(DeliveryLens, {
      metrics: metrics({
        totals: stats({
          firstPassRate: s(null),
          leadTimeMs: s(null),
          timeToFirstReviewMs: s(null),
        }),
      }),
    });
    const values = tileValues();
    expect(values[0]).toBe("—");
    expect(values[3]).toBe("—");
    expect(values[4]).toBe("—");
    expect(values).not.toContain("0%");
  });

  it("shows the measuring-since note so a sparse window reads as young instrumentation", async () => {
    render(DeliveryLens, { metrics: metrics() });
    expect(document.body.textContent).toContain(
      new Date(Date.UTC(2026, 8, 1)).toLocaleDateString(),
    );
  });

  it("distinguishes 'never instrumented' from 'nothing merged'", async () => {
    render(DeliveryLens, { metrics: metrics({ measuringSince: null }) });
    // The uninstrumented state replaces the whole lens — no tiles, no repo table.
    expect(document.querySelectorAll(".tile").length).toBe(0);
    expect(document.querySelector(".muted")).not.toBeNull();
  });

  it("keeps the incident row's two-column grid on narrow screens", async () => {
    // A media query adds NO specificity, so a bare `.row` override inside one would beat
    // `.incident-row` on source order and squeeze the count into the repo grid's 3rem track.
    await page.viewport(390, 800);
    render(DeliveryLens, { metrics: metrics() });
    const incident = document.querySelector<HTMLElement>(".incident-row")!;
    const cols = getComputedStyle(incident).gridTemplateColumns.split(" ");
    expect(cols.length).toBe(2);
    // The count cell must keep its intrinsic width, not collapse into a 3rem track.
    const count = incident.lastElementChild as HTMLElement;
    expect(count.getBoundingClientRect().width).toBeGreaterThan(48);
  });

  it("lists repos and surfaces critic errors when there are any", async () => {
    render(DeliveryLens, { metrics: metrics({ totals: stats({ criticErrors: 2 }) }) });
    const repos = Array.from(document.querySelectorAll(".repo-name")).map((n) =>
      n.textContent?.trim(),
    );
    expect(repos).toContain("alpha");
    expect(repos).toContain("beta");
    expect(repos).toContain("stall"); // incident rows reuse the name cell
    expect(document.body.textContent).toContain("2");
  });
});
