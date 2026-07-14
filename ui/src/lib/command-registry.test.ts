import { describe, it, expect, vi } from "vitest";
import { buildCommands, type CommandCtx } from "./command-registry";

function ctx(overrides: Partial<CommandCtx> = {}): CommandCtx {
  return {
    onNewTask: vi.fn(),
    onBroadcast: vi.fn(),
    onSettings: vi.fn(),
    onUsage: vi.fn(),
    onRetry: vi.fn(),
    onNextNeedsYou: vi.fn(),
    onLearnings: vi.fn(),
    onDiagnoseEpic: vi.fn(),
    onDecommission: vi.fn(),
    decommissionDesig: "TASK-07",
    hasSessions: true,
    retryReady: true,
    otherNeedsYouCount: 1,
    hasLearnings: true,
    ...overrides,
  };
}

const ids = (c: CommandCtx) => buildCommands(c).map((x) => x.id);

describe("buildCommands — availability", () => {
  it("offers every verb when all gates are open", () => {
    expect(ids(ctx())).toEqual([
      "new-task",
      "broadcast",
      "settings",
      "usage",
      "learnings",
      "retry",
      "diagnose-epic",
      "next-needs-you",
      "decommission",
    ]);
  });

  it("hides Decommission when no visible session is selected", () => {
    expect(ids(ctx({ decommissionDesig: null }))).not.toContain("decommission");
  });

  it("hides Broadcast when there are no sessions", () => {
    expect(ids(ctx({ hasSessions: false }))).not.toContain("broadcast");
  });

  it("hides Retry unless retryReady (mirrors SteerBar's chip gate)", () => {
    expect(ids(ctx({ retryReady: false }))).not.toContain("retry");
  });

  it("hides Jump-to-next-needs-you when none are waiting", () => {
    expect(ids(ctx({ otherNeedsYouCount: 0 }))).not.toContain("next-needs-you");
  });

  it("hides Learnings unless hasLearnings", () => {
    expect(ids(ctx({ hasLearnings: false }))).not.toContain("learnings");
  });

  it("always offers New task, Settings, Usage and Diagnose epic", () => {
    const bare = ids(
      ctx({
        hasSessions: false,
        retryReady: false,
        otherNeedsYouCount: 0,
        hasLearnings: false,
        decommissionDesig: null,
      }),
    );
    expect(bare).toEqual(["new-task", "settings", "usage", "diagnose-epic"]);
  });
});

describe("buildCommands — Decommission", () => {
  const decom = (c: CommandCtx) => buildCommands(c).find((x) => x.id === "decommission")!;

  it("names the target session in both the label and the spoken confirm sentence", () => {
    const cmd = decom(ctx({ decommissionDesig: "TASK-07" }));
    expect(cmd.label()).toContain("TASK-07");
    expect(cmd.confirmAria?.()).toContain("TASK-07");
  });

  it("is the only two-step (destructive) verb — it alone carries confirmLabel", () => {
    const twoStep = buildCommands(ctx())
      .filter((c) => c.confirmLabel)
      .map((c) => c.id);
    expect(twoStep).toEqual(["decommission"]);
    expect(decom(ctx()).confirmLabel!().length).toBeGreaterThan(0);
  });

  it("run() decommissions via the context callback", () => {
    const c = ctx();
    decom(c).run();
    expect(c.onDecommission).toHaveBeenCalledOnce();
  });
});

describe("buildCommands — run() wiring", () => {
  it("each command's run() invokes the matching context callback", () => {
    const c = ctx();
    const byId = Object.fromEntries(buildCommands(c).map((x) => [x.id, x]));
    byId["new-task"].run();
    byId["broadcast"].run();
    byId["settings"].run();
    byId["usage"].run();
    byId["learnings"].run();
    byId["retry"].run();
    byId["diagnose-epic"].run();
    byId["next-needs-you"].run();
    expect(c.onNewTask).toHaveBeenCalledOnce();
    expect(c.onBroadcast).toHaveBeenCalledOnce();
    expect(c.onSettings).toHaveBeenCalledOnce();
    expect(c.onUsage).toHaveBeenCalledOnce();
    expect(c.onLearnings).toHaveBeenCalledOnce();
    expect(c.onRetry).toHaveBeenCalledOnce();
    expect(c.onDiagnoseEpic).toHaveBeenCalledOnce();
    expect(c.onNextNeedsYou).toHaveBeenCalledOnce();
  });

  it("exposes a non-empty localized label per command", () => {
    for (const cmd of buildCommands(ctx())) {
      expect(cmd.label().length).toBeGreaterThan(0);
    }
  });
});
