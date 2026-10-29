import { test, expect } from "bun:test";
import {
  buildLanes,
  computeConcurrency,
  isEslintFile,
  isSafePath,
  plannedLaneCount,
  routeEslintFiles,
  runLanes,
  withFileArgs,
  type LaneHandle,
  type LaneSpec,
  type StepResult,
} from "../scripts/pre-push";

// ── Pure helpers ─────────────────────────────────────────────────────────────

test("isEslintFile: matches eslint-handled extensions only", () => {
  expect(isEslintFile("src/a.ts")).toBe(true);
  expect(isEslintFile("ui/src/X.svelte")).toBe(true);
  expect(isEslintFile("src/store.svelte.ts")).toBe(true);
  expect(isEslintFile("src/pty-attach.mjs")).toBe(true);
  expect(isEslintFile("README.md")).toBe(false);
  expect(isEslintFile("ui/messages/en.json")).toBe(false);
});

test("routeEslintFiles: ui/src→root, extension/src→ext(relative), paraglide+non-code dropped", () => {
  const { root, ext } = routeEslintFiles([
    "src/server.ts",
    "test/foo.test.ts",
    "ui/src/lib/components/Foo.svelte",
    "ui/src/lib/paraglide/messages.js", // generated → ignored
    "extension/src/recorder.ts",
    "extension/src/lib/paraglide/runtime.js", // generated → ignored
    "docs/whatever.md", // outside roots + non-eslint
    "ui/messages/en.json", // non-eslint
  ]);
  expect(root).toEqual(["src/server.ts", "test/foo.test.ts", "ui/src/lib/components/Foo.svelte"]);
  // extension files are returned relative to extension/ (eslint runs with cwd=extension)
  expect(ext).toEqual(["src/recorder.ts"]);
});

test("isSafePath: rejects dash-leading paths (argv flag-smuggling guard)", () => {
  expect(isSafePath("src/server.ts")).toBe(true);
  expect(isSafePath("ui/src/lib/-weird.ts")).toBe(true); // dash mid-path is fine
  expect(isSafePath("-rf")).toBe(false);
  expect(isSafePath("--config")).toBe(false);
  expect(isSafePath("--check-foo.js")).toBe(false);
});

test("withFileArgs: inserts a `--` terminator before the spread file list", () => {
  expect(withFileArgs(["prettier", "--check", "--ignore-unknown"], ["-rf", "src/a.ts"])).toEqual([
    "prettier",
    "--check",
    "--ignore-unknown",
    "--",
    "-rf",
    "src/a.ts",
  ]);
  // empty file list still terminates options (harmless; no dash-file can slip through)
  expect(withFileArgs(["eslint", "--no-error-on-unmatched-pattern"], [])).toEqual([
    "eslint",
    "--no-error-on-unmatched-pattern",
    "--",
  ]);
});

test("computeConcurrency: laneCap scales with cores and laneCap×maxWorkers ≤ cores", () => {
  for (const cores of [4, 8, 16, 32]) {
    const { laneCap, maxWorkers } = computeConcurrency(cores, 7);
    expect(laneCap * maxWorkers).toBeLessThanOrEqual(cores);
    expect(laneCap).toBeGreaterThanOrEqual(2);
    expect(maxWorkers).toBeGreaterThanOrEqual(1);
  }
  expect(computeConcurrency(4, 7).laneCap).toBe(2);
  expect(computeConcurrency(8, 7).laneCap).toBe(3);
  expect(computeConcurrency(64, 7).laneCap).toBe(7); // capped at numLanes
});

test("computeConcurrency: SHEPHERD_PREPUSH_LANES override clamps to [1, numLanes]", () => {
  expect(computeConcurrency(32, 7, 2).laneCap).toBe(2); // modest-box sim
  expect(computeConcurrency(32, 7, 99).laneCap).toBe(7);
  expect(computeConcurrency(32, 7, 1).laneCap).toBe(1);
});

const laneCases: [boolean, string[], boolean, number][] = [
  [true, ["src/server.ts"], true, 6],
  [true, ["ui/messages/en.json"], true, 5],
  [true, ["extension/src/recorder.ts"], true, 6],
  [true, [], true, 4],
  [true, ["cli/src/lib.rs"], true, 5],
  [true, ["contracts/openapi.rust.yaml"], true, 5],
  [true, ["docs/a.md"], false, 2],
  [true, [], false, 1],
  [false, [], true, 6],
];

test("plannedLaneCount: equals the local check lanes for every inclusion case", () => {
  for (const [delta, changed, codeChecks, count] of laneCases) {
    const lanes = buildLanes("/repo", { delta, changed, codeChecks });
    expect(plannedLaneCount(delta, changed, codeChecks)).toBe(count);
    expect(lanes).toHaveLength(count);
  }
});

test("buildLanes: never launches suites, browser installation or the full CLI gate", () => {
  for (const [delta, changed, codeChecks] of laneCases) {
    const lanes = buildLanes("/repo", { delta, changed, codeChecks });
    expect(lanes.map((lane) => lane.name)).not.toContain("root-tests");
    expect(lanes.map((lane) => lane.name)).not.toContain("cli");
    for (const step of lanes.flatMap((lane) => lane.steps)) {
      expect(step.args).not.toContain("test");
      expect(step.args).not.toContain("vitest");
      expect(step.args).not.toContain("playwright");
      expect(step.args).not.toContain("clippy");
      expect(step.args).not.toContain("scripts/check-cli.sh");
    }
  }
});

test("buildLanes: docs-only keeps docs-reading gates and skips code checks", () => {
  const lanes = buildLanes("/repo", {
    delta: true,
    changed: ["docs/research/x.md"],
    codeChecks: false,
  });
  expect(lanes.map((l) => l.name)).toEqual(["gates", "prettier"]);
  expect(lanes[0]!.steps.map((s) => s.label)).toContain("docs manifest freshness");
});

test("buildLanes: code changes keep type checks, i18n checks and builds", () => {
  const lanes = buildLanes("/repo", {
    delta: true,
    changed: ["src/server.ts"],
    codeChecks: true,
  });
  expect(lanes.map((l) => l.name)).toEqual(["gates", "prettier", "eslint", "tsc", "ui", "ext"]);
  expect(lanes.find((l) => l.name === "tsc")!.steps[0]!.args).toEqual(["run", "typecheck"]);
  for (const name of ["ui", "ext"]) {
    expect(lanes.find((l) => l.name === name)!.steps.map((s) => s.label)).toEqual([
      "svelte-check",
      "i18n parity",
      "build",
    ]);
  }
});

// ── Scheduler lifecycle (injected fakes — no real processes) ─────────────────

function lane(name: string): LaneSpec {
  return { name, timeoutMs: 10_000, steps: [] };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test("runLanes: never runs more than laneCap lanes at once", async () => {
  const lanes = ["a", "b", "c", "d", "e", "f"].map(lane);
  const start = (): LaneHandle => ({
    // resolve on the next macrotask so the pool genuinely overlaps
    done: new Promise<StepResult>((res) => setTimeout(() => res({ ok: true }), 5)),
    kill: () => {},
  });
  const { outcomes, maxConcurrent } = await runLanes(lanes, { laneCap: 2, start });
  expect(maxConcurrent).toBe(2);
  expect(outcomes.every((o) => o.status === "PASS")).toBe(true);
});

test("runLanes: a hung lane is killed at its timeout and marked TIMEOUT", async () => {
  let killed = false;
  const hung = lane("hung");
  hung.timeoutMs = 20;
  const start = (): LaneHandle => ({
    done: deferred<StepResult>().promise, // never resolves
    kill: () => {
      killed = true;
    },
    logPath: "/logs/prepush-hung.log",
  });
  const { outcomes } = await runLanes([hung], { laneCap: 1, start, graceMs: 5 });
  expect(outcomes[0]!.status).toBe("TIMEOUT");
  expect(killed).toBe(true);
  // logPath is carried from the handle so the summary cites the partial log, not "(no log)".
  expect(outcomes[0]!.logPath).toBe("/logs/prepush-hung.log");
});

test("runLanes: one failing lane doesn't abort the others; all settle, exit reflects failure", async () => {
  const lanes = ["ok1", "bad", "ok2"].map(lane);
  const start = (l: LaneSpec): LaneHandle => ({
    done: Promise.resolve<StepResult>(
      l.name === "bad" ? { ok: false, logPath: "/x.log", failedStep: "step1" } : { ok: true },
    ),
    kill: () => {},
  });
  const { outcomes } = await runLanes(lanes, { laneCap: 3, start });
  expect(outcomes.map((o) => o.status)).toEqual(["PASS", "FAIL", "PASS"]);
  expect(outcomes.find((o) => o.name === "bad")!.failedStep).toBe("step1");
  expect(outcomes.some((o) => o.status !== "PASS")).toBe(true); // → push exits 1
});

test("runLanes: all-pass yields all PASS", async () => {
  const lanes = ["x", "y"].map(lane);
  const start = (): LaneHandle => ({
    done: Promise.resolve<StepResult>({ ok: true }),
    kill: () => {},
  });
  const { outcomes } = await runLanes(lanes, { laneCap: 2, start });
  expect(outcomes.every((o) => o.status === "PASS")).toBe(true);
});
