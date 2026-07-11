import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyBlocked, hasActiveSpinner, quotaBlockReason } from "../src/blocked";
import type { Session, PlanGate } from "../src/types";

test("classifies a numbered permission menu", () => {
  const tail = [
    "│ Do you want to proceed?",
    "│ ❯ 1. Yes",
    "│   2. Yes, and don't ask again",
    "│   3. No, and tell Claude what to do differently",
  ].join("\n");
  const r = classifyBlocked(tail);
  expect(r.shape).toBe("menu");
  expect(r.options).toEqual([
    { label: "Yes", send: "1" },
    { label: "Yes, and don't ask again", send: "2" },
    { label: "No, and tell Claude what to do differently", send: "3" },
  ]);
  expect(r.tail.at(-1)).toContain("No, and tell Claude");
});

test("classifies a (y/n) prompt", () => {
  const r = classifyBlocked("Overwrite existing file? (y/n)");
  expect(r.shape).toBe("yes-no");
  expect(r.options).toEqual([
    { label: "Yes", send: "y" },
    { label: "No", send: "n" },
  ]);
});

test("falls back to awaiting-input when no shape matches", () => {
  const r = classifyBlocked("What should I name the component?\n>");
  expect(r.shape).toBe("awaiting-input");
  expect(r.options).toEqual([]);
  expect(r.tail.length).toBeGreaterThan(0);
});

test("ignores stray numbered prose, keeps the last 1..n run", () => {
  const tail = ["I considered 3 options earlier.", "❯ 1. Apply the patch", "  2. Skip it"].join(
    "\n",
  );
  const r = classifyBlocked(tail);
  expect(r.shape).toBe("menu");
  expect(r.options.map((o) => o.send)).toEqual(["1", "2"]);
});

test("keeps only the last 15 non-empty lines in tail", () => {
  const tail = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n\n");
  const r = classifyBlocked(tail);
  expect(r.tail.length).toBe(15);
  expect(r.tail[0]).toBe("line 15");
});

test("hasActiveSpinner detects real spinner variants", () => {
  expect(hasActiveSpinner("✶ Bunning… (1m 13s · ↑ 1.3k tokens)")).toBe(true);
  expect(
    hasActiveSpinner("* Adding i18n + final review… (1h 29m 49s · ↓ 2.4k tokens · thinking)"),
  ).toBe(true);
  expect(hasActiveSpinner("· Churning… (2m 5s · ↓ 1.1k tokens · thought for 8s)")).toBe(true);
  expect(hasActiveSpinner("⎿  Running… (4s)")).toBe(true);
  // legacy hint still counts — but only on a glyph-anchored spinner line
  expect(hasActiveSpinner("✻ Imagining… (esc to interrupt)")).toBe(true);
});

test("hasActiveSpinner detects a spinner with input-box/status lines after it", () => {
  const tail = [
    "· Churning… (2m 5s · ↓ 1.1k tokens · thought for 8s)",
    "╭──────────────────────────────────╮",
    "│ ❯                                │",
    "╰──────────────────────────────────╯",
    "⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");
  expect(hasActiveSpinner(tail)).toBe(true);
});

test("hasActiveSpinner rejects idle/blocked buffers", () => {
  expect(hasActiveSpinner("… +5 lines (ctrl+o to expand)")).toBe(false);
  expect(hasActiveSpinner("Opus 4.8 (1M context)")).toBe(false);
  expect(hasActiveSpinner("❯ 1. Yes\n  2. No")).toBe(false);
  expect(hasActiveSpinner("Enter to select · ↑/↓ to navigate · Esc to cancel")).toBe(false);
  expect(hasActiveSpinner("❯\n⏵⏵ bypass permissions on (shift+tab to cycle)")).toBe(false);
});

test("hasActiveSpinner rejects spinner-shaped text on non-glyph-anchored lines", () => {
  // prose quoting an elapsed time mid-text — no glyph anchor
  expect(hasActiveSpinner("the build finished… (3m 12s) faster than before")).toBe(false);
  // queued-input/prompt line — starts with ❯, not a spinner/tool glyph
  expect(hasActiveSpinner("❯ retry the failing test… (2m 30s)")).toBe(false);
  // the legacy hint outside a glyph-anchored spinner line no longer counts
  expect(hasActiveSpinner("press esc to interrupt")).toBe(false);
  expect(hasActiveSpinner("some output\nPress esc to interrupt\n❯")).toBe(false);
  // `+` is a markdown/diff line leader, not a spinner frame (dropped from the glyph class)
  expect(hasActiveSpinner("+ added a retry step… (2m 30s)")).toBe(false);
});

test("hasActiveSpinner ignores a spinner outside the 15-line tail window", () => {
  const filler = Array.from({ length: 16 }, (_, i) => `filler line ${i}`).join("\n");
  expect(hasActiveSpinner(`✶ Bunning… (1m 13s · ↑ 1.3k tokens)\n${filler}`)).toBe(false);
});

test("strips ANSI escape codes before classifying a menu", () => {
  const tail = ["\x1b[1m❯ 1. Yes\x1b[0m", "\x1b[2m  2. No\x1b[0m"].join("\n");
  const r = classifyBlocked(tail);
  expect(r.shape).toBe("menu");
  expect(r.options).toEqual([
    { label: "Yes", send: "1" },
    { label: "No", send: "2" },
  ]);
  // tail itself should be free of escape codes
  expect(r.tail.join("\n")).not.toContain("\x1b");
});

// ── quotaBlockReason: retained gate is inert during execution (issue #809) ───

function makeSession(planPhase: Session["planPhase"]): Session {
  return {
    id: "s1",
    desig: "TASK-01",
    name: "task",
    prompt: "",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "feat",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "a",
    claudeSessionId: "",
    model: null,
    effort: null,
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    mergingPrNumber: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    completionRepromptCount: 0,
    planGateEnabled: null,
    planPhase,
    research: false,
    epicAuthoring: false,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    autoMergeRebaseHead: null,
    auto: false,
    issueNumber: null,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    status: "idle",
    lastState: "working",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    spawnTerminalId: null,
    spawnAccountDir: null,
  };
}

const atCapGate: PlanGate = {
  sessionId: "s1",
  planHash: "abc",
  decision: "changes_requested",
  summary: "needs rework",
  body: "## issues",
  findings: ["fix X", "address Y"],
  round: 3,
  cap: 3,
  approved: false,
  plan: "do stuff",
  updatedAt: 1000,
};

test("quotaBlockReason: executing session with retained at-cap gate returns null (gate inert)", () => {
  // A gate retained into execution must NOT raise a quotaKind:"plan" block.
  const session = makeSession("executing");
  const result = quotaBlockReason(session, null, atCapGate, 2000);
  expect(result).toBeNull();
});

test("quotaBlockReason: planning session with at-cap gate still raises plan block (guard not over-suppressing)", () => {
  // Contrast: the same gate while planPhase:"planning" must still produce the quota block.
  const session = makeSession("planning");
  const result = quotaBlockReason(session, null, atCapGate, 2000);
  expect(result).not.toBeNull();
  expect(result?.quotaKind).toBe("plan");
});

// ── Fullscreen renderer fixtures ──────────────────────────────────────────────

const fixturesDir = join(import.meta.dir, "fixtures", "fullscreen");

test("fullscreen menu fixture classifies as menu with 3 options", () => {
  const text = readFileSync(join(fixturesDir, "fullscreen-menu.txt"), "utf8");
  const r = classifyBlocked(text);
  expect(r.shape).toBe("menu");
  expect(r.options).toHaveLength(3);
  expect(r.options.map((o) => o.send)).toEqual(["1", "2", "3"]);
  // The long packed option must be present
  expect(r.options.some((o) => o.label.includes("allow all edits"))).toBe(true);
});

test("classic menu fixture still classifies as menu with 3 options (no regression)", () => {
  const text = readFileSync(join(fixturesDir, "classic-menu.txt"), "utf8");
  const r = classifyBlocked(text);
  expect(r.shape).toBe("menu");
  expect(r.options).toHaveLength(3);
  expect(r.options.map((o) => o.send)).toEqual(["1", "2", "3"]);
});

test("decimal false-positive guard: '1.5 GB' / '2.5 GB' does not classify as menu", () => {
  const tail = ["Available space: 1.5 GB", "Used space: 2.5 GB"].join("\n");
  const r = classifyBlocked(tail);
  expect(r.shape).toBe("awaiting-input");
});

test("bare-token-run false-positive guard: '1.tsx'/'2.tsx' does not classify as menu", () => {
  const tail1 = ["1.tsx", "2.tsx"].join("\n");
  expect(classifyBlocked(tail1).shape).toBe("awaiting-input");

  const tail2 = ["1.x", "2.x"].join("\n");
  expect(classifyBlocked(tail2).shape).toBe("awaiting-input");
});

test("fullscreen-spinner.txt hasActiveSpinner returns true", () => {
  const text = readFileSync(join(fixturesDir, "fullscreen-spinner.txt"), "utf8");
  expect(hasActiveSpinner(text)).toBe(true);
});
