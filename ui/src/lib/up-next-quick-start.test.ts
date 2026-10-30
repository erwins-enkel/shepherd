import { describe, expect, it } from "vitest";
import { quickStartChips, quickStartTip } from "./up-next-quick-start";
import { m } from "#lib/paraglide/messages.js";
import type { AgentProvider, DiagnosticsSnapshot, UpNextQuickStarts, UsageLimits } from "./types";

const NOW = new Date(2026, 0, 5, 10, 0).getTime();
const RESET = new Date(2026, 0, 5, 13, 30).getTime();

const diagnostics = (ok: AgentProvider[]): DiagnosticsSnapshot => ({
  checks: (["claude", "codex"] as const).map((id) => ({
    id,
    state: ok.includes(id) ? "ok" : "error",
    hintKey: "x",
  })),
  generatedAt: 0,
  overall: "ok",
});

const limits = (pct5h: number, pctWeek = 10): UsageLimits => ({
  session5h: { pct: pct5h, resetAt: RESET },
  week: { pct: pctWeek, resetAt: RESET + 86_400_000 },
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: 0,
  subscriptionOnly: false,
});

const presets: UpNextQuickStarts = {
  claude: { enabled: true, model: "opus", effort: "high" },
  codex: { enabled: true, model: null, effort: null },
};

const chips = (over: Partial<Parameters<typeof quickStartChips>[0]> = {}) =>
  quickStartChips({
    quickStarts: presets,
    diagnostics: diagnostics(["claude", "codex"]),
    limits: limits(30),
    holdLikely: false,
    holdPct: 80,
    nowMs: NOW,
    ...over,
  });

describe("quickStartChips", () => {
  it("gives one ready chip per enabled preset, in provider order, with the 5h usage", () => {
    const got = chips();
    expect(got.map((c) => [c.provider, c.state])).toEqual([
      ["claude", "ready"],
      ["codex", "ready"],
    ]);
    expect(got[0]!.usedPct).toBe(30);
  });

  it("shows no chip for a CLI without a preset or with the preset switched off", () => {
    expect(chips({ quickStarts: {} })).toEqual([]);
    expect(
      chips({ quickStarts: { claude: { enabled: false, model: null, effort: null } } }),
    ).toEqual([]);
    expect(chips({ quickStarts: { codex: presets.codex! } }).map((c) => c.provider)).toEqual([
      "codex",
    ]);
  });

  it("blocks a chip whose CLI isn't ready", () => {
    const got = chips({ diagnostics: diagnostics(["claude"]) });
    expect(got.map((c) => c.state)).toEqual(["ready", "blocked"]);
    expect(chips({ diagnostics: null }).every((c) => c.state === "blocked")).toBe(true);
  });

  it("holds only Claude over the threshold, until the window over it resets", () => {
    const got = chips({ holdLikely: true, limits: limits(85) });
    expect(got.map((c) => c.state)).toEqual(["hold", "ready"]);
    expect(got[0]!.holdUntil).toBe(RESET);
  });

  it("waits for the latest reset when both windows are over the threshold", () => {
    const got = chips({ holdLikely: true, limits: limits(85, 90) });
    expect(got[0]!.holdUntil).toBe(RESET + 86_400_000);
  });

  it("has no hold time when the reset is unknown or past", () => {
    const stale = { ...limits(85), session5h: { pct: 85, resetAt: NOW - 1 } };
    expect(chips({ holdLikely: true, limits: stale })[0]!.holdUntil).toBeNull();
  });
});

describe("quickStartTip", () => {
  it("explains title, summary, model, effort, capacity and how to change it", () => {
    const chip = chips()[0]!;
    const tip = quickStartTip(chip, 7, limits(30), NOW);
    expect(tip.title).toBe(m.upnext_quickstart_tip_title({ cli: "Claude Code" }));
    expect(tip.summary).toBe(m.upnext_quickstart_tip_summary({ number: 7 }));
    expect(tip.sections.map((s) => s.label)).toEqual([
      m.upnext_quickstart_tip_model(),
      m.upnext_quickstart_tip_effort(),
      m.upnext_quickstart_tip_capacity(),
      m.upnext_quickstart_tip_change(),
    ]);
    expect(tip.sections[2]!.rows).toHaveLength(2);
  });

  it("names the reason on a blocked chip and says when a held start lifts", () => {
    const blocked = chips({ diagnostics: diagnostics(["claude"]) })[1]!;
    expect(quickStartTip(blocked, 7, null, NOW).sections[2]!.note).toBe(
      m.upnext_quickstart_tip_blocked({ cli: "Codex" }),
    );
    const hold = chips({ holdLikely: true, limits: limits(85) })[0]!;
    expect(quickStartTip(hold, 7, limits(85), NOW).sections[2]!.note).toContain("13:30");
  });
});
