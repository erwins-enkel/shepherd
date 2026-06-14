import { test, expect } from "bun:test";
import {
  parseRecapVerdict,
  buildTranscriptDigest,
  buildRecapPrompt,
  isSettledIdle,
  needsRecap,
  RECAP_VERDICTS,
  RECAP_HEADLINE_MAX,
  RECAP_DIGEST_MAX_CHARS,
} from "../src/recap-core";
import type { Recap } from "../src/types";

// ── parseRecapVerdict ────────────────────────────────────────────────────────

test("parseRecapVerdict: valid object returns normalized shape", () => {
  const result = parseRecapVerdict({
    verdict: "ready",
    headline: "All done",
    body: "## Summary\nEverything looks good.",
    openItems: ["Deploy to staging"],
  });
  expect(result).not.toBeNull();
  expect(result?.verdict).toBe("ready");
  expect(result?.headline).toBe("All done");
  expect(result?.body).toBe("## Summary\nEverything looks good.");
  expect(result?.openItems).toEqual(["Deploy to staging"]);
});

test("parseRecapVerdict: parked and needs_attention verdicts accepted", () => {
  expect(
    parseRecapVerdict({ verdict: "parked", headline: "x", body: "", openItems: [] })?.verdict,
  ).toBe("parked");
  expect(
    parseRecapVerdict({ verdict: "needs_attention", headline: "x", body: "", openItems: [] })
      ?.verdict,
  ).toBe("needs_attention");
});

test("parseRecapVerdict: invalid verdict returns null", () => {
  expect(
    parseRecapVerdict({ verdict: "approve", headline: "x", body: "", openItems: [] }),
  ).toBeNull();
  expect(parseRecapVerdict({ verdict: null, headline: "x", body: "", openItems: [] })).toBeNull();
  expect(parseRecapVerdict({ verdict: 42, headline: "x", body: "", openItems: [] })).toBeNull();
});

test("parseRecapVerdict: headline > RECAP_HEADLINE_MAX is clamped", () => {
  const long = "a".repeat(RECAP_HEADLINE_MAX + 20);
  const result = parseRecapVerdict({ verdict: "ready", headline: long, body: "", openItems: [] });
  expect(result?.headline.length).toBe(RECAP_HEADLINE_MAX);
});

test("parseRecapVerdict: openItems filters out non-strings", () => {
  const result = parseRecapVerdict({
    verdict: "ready",
    headline: "x",
    body: "",
    openItems: ["valid", 42, null, "also valid", true],
  });
  expect(result?.openItems).toEqual(["valid", "also valid"]);
});

test("parseRecapVerdict: non-object/garbage returns null", () => {
  expect(parseRecapVerdict(null)).toBeNull();
  expect(parseRecapVerdict(undefined)).toBeNull();
  expect(parseRecapVerdict("string")).toBeNull();
  expect(parseRecapVerdict(42)).toBeNull();
  expect(parseRecapVerdict([])).toBeNull();
});

test("parseRecapVerdict: missing headline/body/openItems defaults gracefully", () => {
  const result = parseRecapVerdict({ verdict: "ready" });
  expect(result).not.toBeNull();
  expect(result?.headline).toBe("");
  expect(result?.body).toBe("");
  expect(result?.openItems).toEqual([]);
});

// ── isSettledIdle ────────────────────────────────────────────────────────────

test("isSettledIdle: idle status + over threshold → true", () => {
  expect(isSettledIdle("idle", 5000, 3000)).toBe(true);
});

test("isSettledIdle: done status + over threshold → true", () => {
  expect(isSettledIdle("done", 5000, 3000)).toBe(true);
});

test("isSettledIdle: idle status + exactly at threshold → true", () => {
  expect(isSettledIdle("idle", 3000, 3000)).toBe(true);
});

test("isSettledIdle: idle status + under threshold → false", () => {
  expect(isSettledIdle("idle", 2999, 3000)).toBe(false);
});

test("isSettledIdle: running status → false", () => {
  expect(isSettledIdle("running", 9999, 3000)).toBe(false);
});

test("isSettledIdle: blocked status → false", () => {
  expect(isSettledIdle("blocked", 9999, 3000)).toBe(false);
});

test("isSettledIdle: empty string status → false", () => {
  expect(isSettledIdle("", 9999, 3000)).toBe(false);
});

// ── needsRecap ───────────────────────────────────────────────────────────────

const baseRecap = (over: Partial<Recap> = {}): Recap => ({
  sessionId: "s1",
  state: "ready",
  headSha: "sha-abc",
  verdict: "ready",
  headline: "done",
  body: "",
  openItems: [],
  changedFiles: [],
  spawnSessionId: "spawn-1",
  cwd: "/tmp/x",
  model: null,
  spawnedAt: 1000,
  generatedAt: 2000,
  updatedAt: 2000,
  ...over,
});

test("needsRecap: null existing → true (no recap yet)", () => {
  expect(needsRecap(null, "sha-abc")).toBe(true);
});

test("needsRecap: same head (state=ready) → false", () => {
  expect(needsRecap(baseRecap({ state: "ready", headSha: "sha-abc" }), "sha-abc")).toBe(false);
});

test("needsRecap: same head (state=generating) → false", () => {
  expect(needsRecap(baseRecap({ state: "generating", headSha: "sha-abc" }), "sha-abc")).toBe(false);
});

test("needsRecap: same head (state=failed) → false (no auto-retry)", () => {
  expect(needsRecap(baseRecap({ state: "failed", headSha: "sha-abc" }), "sha-abc")).toBe(false);
});

test("needsRecap: same head (state=empty) → false", () => {
  expect(needsRecap(baseRecap({ state: "empty", headSha: "sha-abc" }), "sha-abc")).toBe(false);
});

test("needsRecap: different head → true", () => {
  expect(needsRecap(baseRecap({ headSha: "sha-old" }), "sha-new")).toBe(true);
});

// ── buildTranscriptDigest ─────────────────────────────────────────────────────

test("buildTranscriptDigest: empty entries → empty string", () => {
  expect(buildTranscriptDigest([])).toBe("");
});

test("buildTranscriptDigest: includes tool+summary per entry", () => {
  const entries = [
    { ts: 1, tool: "Edit", summary: "edited server.ts", status: "ok" as const },
    { ts: 2, tool: "Bash", summary: "$ bun test", status: "ok" as const },
  ];
  const digest = buildTranscriptDigest(entries);
  expect(digest).toContain("[Edit] edited server.ts");
  expect(digest).toContain("[Bash] $ bun test");
});

test("buildTranscriptDigest: respects maxChars cap", () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({
    ts: i,
    tool: "Edit",
    summary: `edited file-${i}.ts`,
    status: "ok" as const,
  }));
  const maxChars = 200;
  const digest = buildTranscriptDigest(entries, maxChars);
  expect(digest.length).toBeLessThanOrEqual(maxChars);
});

test("buildTranscriptDigest: single entry within cap is fully included", () => {
  const entries = [{ ts: 1, tool: "Write", summary: "wrote store.ts", status: "ok" as const }];
  const digest = buildTranscriptDigest(entries, 4000);
  expect(digest).toBe("[Write] wrote store.ts");
});

test("buildTranscriptDigest: oversized single entry is truncated to maxChars, not empty", () => {
  const maxChars = 20;
  const longSummary = "x".repeat(100);
  const entries = [{ ts: 1, tool: "Edit", summary: longSummary, status: "ok" as const }];
  const digest = buildTranscriptDigest(entries, maxChars);
  expect(digest.length).toBe(maxChars);
  expect(digest).toBe(`[Edit] ${longSummary}`.slice(0, maxChars));
});

test("RECAP_DIGEST_MAX_CHARS is exported and equals the default cap", () => {
  expect(typeof RECAP_DIGEST_MAX_CHARS).toBe("number");
  expect(RECAP_DIGEST_MAX_CHARS).toBe(4000);
});

// ── buildRecapPrompt ──────────────────────────────────────────────────────────

test("buildRecapPrompt: includes .shepherd-recap.json filename", () => {
  const p = buildRecapPrompt({
    taskPrompt: "Implement recap",
    plan: "",
    changedFiles: [],
    digest: "",
    context: "",
  });
  expect(p).toContain(".shepherd-recap.json");
});

test("buildRecapPrompt: includes all three verdict enum values", () => {
  const p = buildRecapPrompt({
    taskPrompt: "t",
    plan: "",
    changedFiles: [],
    digest: "",
    context: "",
  });
  for (const v of RECAP_VERDICTS) {
    expect(p).toContain(v);
  }
});

test("buildRecapPrompt: injects task prompt", () => {
  const p = buildRecapPrompt({
    taskPrompt: "Refactor the drain module",
    plan: "",
    changedFiles: [],
    digest: "",
    context: "",
  });
  expect(p).toContain("Refactor the drain module");
});

test("buildRecapPrompt: injects plan when non-empty", () => {
  const p = buildRecapPrompt({
    taskPrompt: "t",
    plan: "Step 1: do x",
    changedFiles: [],
    digest: "",
    context: "",
  });
  expect(p).toContain("Step 1: do x");
});

test("buildRecapPrompt: injects changedFiles", () => {
  const p = buildRecapPrompt({
    taskPrompt: "t",
    plan: "",
    changedFiles: ["src/store.ts", "src/types.ts"],
    digest: "",
    context: "",
  });
  expect(p).toContain("src/store.ts");
  expect(p).toContain("src/types.ts");
});

test("buildRecapPrompt: injects digest when non-empty", () => {
  const p = buildRecapPrompt({
    taskPrompt: "t",
    plan: "",
    changedFiles: [],
    digest: "[Edit] edited server.ts",
    context: "",
  });
  expect(p).toContain("[Edit] edited server.ts");
});

test("buildRecapPrompt: skips plan section when plan is empty", () => {
  const p = buildRecapPrompt({
    taskPrompt: "t",
    plan: "",
    changedFiles: [],
    digest: "",
    context: "",
  });
  expect(p).not.toContain("Plan that was executed");
});
