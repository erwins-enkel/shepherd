import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import type { AutoMergeStatus, HeavySlotSnapshot } from "#lib/types.js";
import type { HottestCapacityWindow } from "../usage-gauges";
import TopBarStatusLine from "./TopBarStatusLine.svelte";

afterEach(() => {
  document.body.innerHTML = "";
});

const slot = {
  enabled: true,
  capacity: 1,
  holders: [{ sessionId: "h", command: "vitest run", startedAt: 0, rssBytes: null }],
  waiters: [{ sessionId: "w", position: 1, reason: "slot" }],
  brake: { active: false, reason: null },
  pressure: { ramAvailableBytes: null, ramTotalBytes: null },
} as unknown as HeavySlotSnapshot;

const hottest = {
  provider: "claude",
  window: { key: "5H", usedPct: 62 },
  stale: false,
} as unknown as HottestCapacityWindow;

describe("TopBarStatusLine (phone variant E)", () => {
  it("folds the busy slot, merge train, held tasks and usage into one read-only row", async () => {
    render(TopBarStatusLine, {
      total: 14,
      working: 5,
      idle: 0,
      blocked: 1,
      statusFilter: "running",
      heavySlot: slot,
      autoMerge: { "/r/a": { repoPath: "/r/a", state: "merging" } as AutoMergeStatus },
      heldCount: 3,
      hottest,
      holdPct: 85,
    });
    const line = document.querySelector<HTMLElement>(".status-line")!;
    const text = line.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("1/1");
    expect(text).toMatch(/◔\s?1/);
    expect(text).toContain("↣");
    expect(text).toContain("62%");
    expect(line.querySelector(".held")?.textContent).toContain("3");
    // The active filter's tally is underlined; nothing is a control.
    expect(line.querySelectorAll(".seg.on").length).toBe(1);
    expect(line.querySelectorAll("button, a, [tabindex]").length).toBe(0);
    // Hairline fill tracks the hottest window, with a tick at the hold limit.
    const fill = line.querySelector<HTMLElement>(".hair i")!;
    expect(fill.style.width).toBe("62%");
    expect(line.querySelector<HTMLElement>(".hair u")!.style.left).toBe("85%");
  });

  it("drops the optional segments and the hairline when there is nothing to show", async () => {
    render(TopBarStatusLine, { total: 2, working: 0, idle: 2, blocked: 0 });
    const line = document.querySelector<HTMLElement>(".status-line")!;
    expect(line.textContent).not.toContain("↣");
    expect(line.querySelector(".hair")).toBeNull();
  });
});
