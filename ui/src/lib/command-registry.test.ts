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
    ]);
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
      ctx({ hasSessions: false, retryReady: false, otherNeedsYouCount: 0, hasLearnings: false }),
    );
    expect(bare).toEqual(["new-task", "settings", "usage", "diagnose-epic"]);
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
