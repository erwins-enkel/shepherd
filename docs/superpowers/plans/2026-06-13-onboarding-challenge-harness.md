# Onboarding Challenge & Regression Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a throw-away-environment harness that boots deliberately-messy Incus instances, runs Shepherd inside them in degraded mode, captures its diagnostics, applies the coaching, re-probes, and emits a gap report — manually in Phase 1, then green-gating releases in Phase 2.

**Architecture:** A standalone Bun/TS harness in `ci/onboarding-harness/`, separate from the shipped server. Six small units — an injectable `incus` CLI driver, a declarative scenario catalog, a seed engine, a diagnostics probe, an apply engine (agent path in P1, verbatim path added in P2), and a gap-report builder — wired by an orchestrator with guaranteed teardown. Phase 2 adds a harness-side structured-remediation catalog (no `src/` change) and ops wiring (nightly + release gate).

**Tech Stack:** Bun, TypeScript, `bun:test`, the `incus` CLI (system containers + VMs), Shepherd's existing `GET /api/diagnostics` HTTP API, the `claude` CLI (agent apply path).

> **Post-implementation revisions (PR critic review).** The shipped code supersedes a few blocks below — where they differ, the code in `ci/onboarding-harness/` is authoritative:
> 1. **Scoped success.** `reachedGreen` is evaluated over the scenario's **expected checks** (`scenario.expect.every(e => after.checks…state === "ok")`), not the global `after.overall === "ok"` shown in the Task 9 block — a throw-away instance can never reach all-7-green, so a global finish line would be permanently red.
> 2. **Detection-only class.** Auth/serve defects whose fix needs a human/secret (`gh-unauthed`, `gh-missing`, `tailscale-missing`) carry `detectionOnly: true` (new `Scenario` field): no apply, excluded from the green tally and the release gate, reported DETECTION-ONLY.
> 3. **Catalog trimmed.** `tailscale-not-serving` and `herdr-too-old` were **removed** (their fixtures — a faked tailnet, a pinned old herdr — aren't implemented; shipping them would be permanent detection gaps). They're deferred follow-ups.
> 4. **Gate filter.** `scripts/onboarding-gate.sh` selects `coaching === "structured" && !detectionOnly` (green-able deterministic subset): `herdr-missing`, `claude-missing`, `node-too-old`.

---

## File structure

| File | Responsibility |
| --- | --- |
| `ci/onboarding-harness/types.ts` | Shared harness types (`Scenario`, `ExpectedCheck`, `DetectionResult`, `ScenarioResult`, `IncusExec`, `IncusRunner`). |
| `ci/onboarding-harness/incus.ts` | `IncusDriver` — thin, injectable wrapper over the `incus` CLI (launch/exec/push/pull/delete/list/sweep). |
| `ci/onboarding-harness/scenarios.ts` | `SCENARIOS` — the declarative messy-environment catalog (pure data). |
| `ci/onboarding-harness/assert.ts` | `assertDetection` — pure: snapshot + expectations → `DetectionResult`. |
| `ci/onboarding-harness/report.ts` | `buildGapReport` — pure: `ScenarioResult[]` → markdown. |
| `ci/onboarding-harness/seed.ts` | `seedInstance` — launch, install bootable-Shepherd baseline, run scenario seed. |
| `ci/onboarding-harness/probe.ts` | `bootShepherd` + `probeDiagnostics` — start Shepherd, poll `GET /api/diagnostics?refresh=1`. |
| `ci/onboarding-harness/apply.ts` | `applyCoaching` — agent path (P1) and verbatim path (P2), dispatched by scenario `coaching`. |
| `ci/onboarding-harness/run.ts` | Orchestrator + CLI entry; per-scenario seed→probe→assert→apply→re-probe with `finally` teardown + orphan sweep; writes the report. |
| `ci/onboarding-harness/remediations.ts` | Phase 2: **harness-side** `REMEDIATIONS` map (hintKey → verbatim shell command). Keeps fixes out of the shipped diagnostics payload. |
| `scripts/onboarding-gate.sh` | Phase 2: runs the deterministic (verbatim) subset, exits non-zero on red, **bypasses (exit 0) when the Incus host is unavailable** — the release gate. |
| `ci/onboarding-harness/shepherd-onboarding.{service,timer}` | Phase 2: systemd units for the nightly run on the Incus host. |
| `test/onboarding-harness/*.test.ts` | Unit tests for the pure/injectable units (driver argv, catalog validity, assert, report, resolution, remediation map). |

**No `src/` product change.** Per plan review, structured remediations live **harness-side** (`remediations.ts`), not as a `remediation?` field on the shipped `DiagnosticCheck` payload — this preserves the exact-keys payload-purity contract (`test/diagnostics.test.ts:52`) and avoids a hidden, undiscoverable shipped field. A user-facing "click-to-fix" feature, if ever wanted, gets its own spec.

**Test strategy:** Logic with no real-Incus dependency (driver argv-building, catalog validity, `assertDetection`, `buildGapReport`, hintKey→text resolution, P2 remediation decoration) is unit-tested via `bun:test` with injected runners — mirroring `src/diagnostics.ts`'s injectable-deps pattern. The end-to-end seed→boot→apply→re-probe loop requires a real Incus host and is validated by a documented manual run (Task 9), not unit tests.

---

## Phase 1 — gap-report MVP (manual, no product change)

### Task 1: Scaffolding, shared types, and tooling globs

**Files:**
- Create: `ci/onboarding-harness/types.ts`
- Modify: `package.json` (lint glob)

- [ ] **Step 1: Create the shared types**

`ci/onboarding-harness/types.ts`:

```ts
import type { DiagnosticState, DiagnosticsSnapshot } from "../../src/types";

/** A single deliberately-messy environment definition (pure data). */
export interface Scenario {
  /** Stable kebab id; also the Incus instance name suffix. */
  id: string;
  /** Incus image ref, e.g. "images:ubuntu/24.04" or "images:debian/12". */
  image: string;
  /** Provision as a full VM instead of a system container (kernel/arch fidelity). */
  vm?: boolean;
  /** Shell commands run in order (each via `sh -c`) to produce the messy state. */
  seed: string[];
  /** Checks that MUST be flagged at the given state after seeding. */
  expect: ExpectedCheck[];
  /** Which apply path to use. In Phase 1 "structured" falls back to the agent path. */
  coaching: "structured" | "prose";
  /** The agent apply path runs `claude` INSIDE the instance; a scenario that
   *  removes claude (claude-missing) cannot use it. Such scenarios are
   *  detection-only in Phase 1 and switch to the verbatim path in Phase 2. */
  agentIncompatible?: boolean;
}

export interface ExpectedCheck {
  id: string;
  state: DiagnosticState;
}

/** Result of comparing a captured snapshot against a scenario's expectations. */
export interface DetectionResult {
  scenarioId: string;
  /** True when every expected check matched its expected state. */
  detected: boolean;
  /** Expected checks whose actual state diverged (incl. absent from snapshot). */
  misses: Array<{ id: string; want: DiagnosticState; got: DiagnosticState | "absent" }>;
}

/** Full per-scenario outcome the report is built from. */
export interface ScenarioResult {
  scenarioId: string;
  image: string;
  detection: DetectionResult;
  appliedVia: "agent" | "verbatim" | "skipped";
  reachedGreen: boolean;
  /** True when no apply was attempted BY DESIGN (e.g. claude-missing in Phase 1):
   *  the report classifies it DETECTION-ONLY, not an advice gap. */
  detectionOnly?: boolean;
  error?: string;
}

/** One `incus` CLI invocation result. */
export interface IncusExec {
  stdout: string;
  stderr: string;
  code: number;
}

/** Injectable `incus` runner: receives argv (after the `incus` binary), resolves
 *  with captured output. Tests inject a fake; production runs the real binary. */
export type IncusRunner = (args: string[]) => Promise<IncusExec>;

export type { DiagnosticsSnapshot };
```

- [ ] **Step 2: Add the harness to the lint glob**

In `package.json`, change the `lint` script to include the harness:

```json
"lint": "eslint --no-error-on-unmatched-pattern src test ui/src ci/onboarding-harness",
```

- [ ] **Step 3: Verify type-check + lint pass**

Run: `bun install && bunx tsc --noEmit && bun run lint`
Expected: PASS (no errors; the new file type-checks).

- [ ] **Step 4: Commit**

```bash
git add ci/onboarding-harness/types.ts package.json
git commit -m "feat(onboarding-harness): shared types + lint glob"
```

---

### Task 2: IncusDriver (injectable CLI wrapper)

**Files:**
- Create: `ci/onboarding-harness/incus.ts`
- Test: `test/onboarding-harness/incus.test.ts`

> **Run isolation (point 5):** the driver's `prefix` is the **per-run** prefix the orchestrator passes (`shep-onb-<runId>-`, Task 9), NOT a shared constant. Because `sweep()` only force-deletes instances matching its own prefix, two overlapping runs can never destroy each other's live instances. The unit test below uses a fixed `shep-onb-` prefix only for assertion simplicity. A separate `--reap-orphans` maintenance flag (Task 9) is the only thing that touches other prefixes, and it is never invoked automatically.

- [ ] **Step 1: Write the failing test**

`test/onboarding-harness/incus.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { IncusDriver } from "../../ci/onboarding-harness/incus";
import type { IncusExec } from "../../ci/onboarding-harness/types";

function recorder(reply: Partial<IncusExec> = {}) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<IncusExec> => {
    calls.push(args);
    return { stdout: "", stderr: "", code: 0, ...reply };
  };
  return { calls, run };
}

describe("IncusDriver", () => {
  it("launches a system container with the managed-name prefix and profile", async () => {
    const { calls, run } = recorder();
    const d = new IncusDriver(run, "shep-onb-");
    await d.launch("images:ubuntu/24.04", "gh-unauthed", { profile: "shep-onb" });
    expect(calls[0]).toEqual([
      "launch", "images:ubuntu/24.04", "shep-onb-gh-unauthed", "--profile", "shep-onb",
    ]);
  });

  it("adds --vm when the scenario requests a VM", async () => {
    const { calls, run } = recorder();
    const d = new IncusDriver(run, "shep-onb-");
    await d.launch("images:ubuntu/24.04", "kernel-x", { vm: true });
    expect(calls[0]).toContain("--vm");
  });

  it("execs a command inside the instance via -- separator", async () => {
    const { calls, run } = recorder({ stdout: "ok" });
    const d = new IncusDriver(run, "shep-onb-");
    const r = await d.exec("gh-unauthed", ["sh", "-c", "echo hi"]);
    expect(calls[0]).toEqual(["exec", "shep-onb-gh-unauthed", "--", "sh", "-c", "echo hi"]);
    expect(r.stdout).toBe("ok");
  });

  it("force-deletes an instance", async () => {
    const { calls, run } = recorder();
    const d = new IncusDriver(run, "shep-onb-");
    await d.delete("gh-unauthed");
    expect(calls[0]).toEqual(["delete", "shep-onb-gh-unauthed", "--force"]);
  });

  it("lists only managed instances and sweeps them", async () => {
    const { calls, run } = recorder({
      stdout: JSON.stringify([{ name: "shep-onb-a" }, { name: "unrelated" }, { name: "shep-onb-b" }]),
    });
    const d = new IncusDriver(run, "shep-onb-");
    expect(await d.listManaged()).toEqual(["shep-onb-a", "shep-onb-b"]);
    await d.sweep();
    // listManaged (1) + one delete per managed instance (2)
    expect(calls.filter((c) => c[0] === "delete")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/onboarding-harness/incus.test.ts`
Expected: FAIL — `Cannot find module '../../ci/onboarding-harness/incus'`.

- [ ] **Step 3: Write the implementation**

`ci/onboarding-harness/incus.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncusExec, IncusRunner } from "./types";

const execFileAsync = promisify(execFile);

/** Default runner: invokes the real `incus` binary, capturing output and never
 *  throwing on a non-zero exit (the caller inspects `code`). */
const defaultRunner: IncusRunner = async (args) => {
  try {
    const { stdout, stderr } = await execFileAsync("incus", args, { encoding: "utf8" });
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
};

/** Thin, throw-away-instance lifecycle wrapper over the `incus` CLI. All managed
 *  instances carry `prefix` in their name so `sweep()` can reap leaks. */
export class IncusDriver {
  constructor(
    private run: IncusRunner = defaultRunner,
    private prefix = "shep-onb-",
  ) {}

  private full(name: string): string {
    return this.prefix + name;
  }

  async launch(
    image: string,
    name: string,
    opts: { vm?: boolean; profile?: string } = {},
  ): Promise<void> {
    const args = ["launch", image, this.full(name)];
    if (opts.vm) args.push("--vm");
    if (opts.profile) args.push("--profile", opts.profile);
    const r = await this.run(args);
    if (r.code !== 0) throw new Error(`incus launch failed: ${r.stderr || r.stdout}`);
  }

  async exec(name: string, cmd: string[]): Promise<IncusExec> {
    return this.run(["exec", this.full(name), "--", ...cmd]);
  }

  async push(name: string, localPath: string, remotePath: string): Promise<void> {
    const r = await this.run(["file", "push", localPath, `${this.full(name)}${remotePath}`]);
    if (r.code !== 0) throw new Error(`incus file push failed: ${r.stderr}`);
  }

  async pull(name: string, remotePath: string, localPath: string): Promise<void> {
    const r = await this.run(["file", "pull", `${this.full(name)}${remotePath}`, localPath]);
    if (r.code !== 0) throw new Error(`incus file pull failed: ${r.stderr}`);
  }

  async delete(name: string): Promise<void> {
    await this.run(["delete", this.full(name), "--force"]);
  }

  /** Names of all instances carrying the managed prefix. */
  async listManaged(): Promise<string[]> {
    const r = await this.run(["list", "--format", "json"]);
    if (r.code !== 0) return [];
    const rows = JSON.parse(r.stdout) as Array<{ name: string }>;
    return rows.map((x) => x.name).filter((n) => n.startsWith(this.prefix));
  }

  /** Force-delete every managed instance (orphan reaper, run at start + teardown). */
  async sweep(): Promise<void> {
    for (const full of await this.listManaged()) {
      await this.run(["delete", full, "--force"]);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/onboarding-harness/incus.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ci/onboarding-harness/incus.ts test/onboarding-harness/incus.test.ts
git commit -m "feat(onboarding-harness): injectable Incus CLI driver"
```

---

### Task 3: Scenario catalog + validity test

**Files:**
- Create: `ci/onboarding-harness/scenarios.ts`
- Test: `test/onboarding-harness/scenarios.test.ts`

- [ ] **Step 1: Write the failing test**

`test/onboarding-harness/scenarios.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { SCENARIOS } from "../../ci/onboarding-harness/scenarios";

const CHECK_IDS = new Set(["bun", "node", "claude", "gh", "git", "herdr", "tailscale"]);

describe("scenario catalog", () => {
  it("has unique kebab-case ids", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("only expects known check ids", () => {
    for (const s of SCENARIOS) {
      for (const e of s.expect) expect(CHECK_IDS.has(e.id)).toBe(true);
    }
  });

  it("every scenario seeds at least one command and expects at least one flag", () => {
    for (const s of SCENARIOS) {
      expect(s.seed.length).toBeGreaterThan(0);
      expect(s.expect.length).toBeGreaterThan(0);
    }
  });

  it("covers each non-bun check id at least once", () => {
    const covered = new Set(SCENARIOS.flatMap((s) => s.expect.map((e) => e.id)));
    for (const id of ["node", "claude", "gh", "git", "herdr", "tailscale"]) {
      expect(covered.has(id)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/onboarding-harness/scenarios.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the catalog**

`ci/onboarding-harness/scenarios.ts`:

```ts
import type { Scenario } from "./types";

/**
 * The Phase 1 messy-environment catalog. Every baseline is assumed bootable
 * (the bun runtime is installed by the seed engine before these seeds run — see
 * seed.ts); defects are layered on top so degraded Shepherd can still boot and
 * self-diagnose. `coaching: "structured"` scenarios fall back to the agent path
 * in Phase 1 (no diagnostics remediation field exists yet) and switch to the
 * deterministic verbatim path in Phase 2.
 */
export const SCENARIOS: Scenario[] = [
  {
    id: "gh-unauthed",
    image: "images:ubuntu/24.04",
    seed: [
      "type gh >/dev/null 2>&1 || (apt-get update && apt-get install -y gh)",
      "rm -rf ~/.config/gh", // installed but never logged in
    ],
    expect: [{ id: "gh", state: "error" }],
    coaching: "prose",
  },
  {
    id: "gh-missing",
    image: "images:debian/12",
    seed: ["apt-get remove -y gh 2>/dev/null || true", "rm -f /usr/bin/gh /usr/local/bin/gh"],
    expect: [{ id: "gh", state: "error" }],
    coaching: "structured",
  },
  {
    id: "tailscale-missing",
    image: "images:ubuntu/24.04",
    seed: ["rm -f /usr/bin/tailscale /usr/sbin/tailscaled /usr/local/bin/tailscale"],
    expect: [{ id: "tailscale", state: "error" }],
    coaching: "structured",
  },
  {
    id: "tailscale-not-serving",
    image: "images:ubuntu/24.04",
    // tailscaled up + logged in but no `serve` mapping for the HUD port → warning.
    // Uses a faked tailnet so no real login is required (see seed.ts notes).
    seed: ["systemctl start tailscaled || true", "tailscale serve reset 2>/dev/null || true"],
    expect: [{ id: "tailscale", state: "warning" }],
    coaching: "prose",
  },
  {
    id: "herdr-missing",
    image: "images:archlinux",
    seed: ["rm -f /usr/local/bin/herdr ~/.local/bin/herdr"],
    expect: [{ id: "herdr", state: "error" }],
    coaching: "structured",
  },
  {
    // claudeProbe is PRESENCE-ONLY (a successful `claude --version` ⇒ ok; there is
    // NO auth/login probe, so there is deliberately no "claude-unauthed" scenario —
    // an unauthed-but-installed claude reports ok by design, which the gap report
    // notes as a known non-detection, not a discovered gap). Removing claude also
    // disables the agent apply path (the agent IS claude running in-instance), so
    // this scenario is detection-only in Phase 1 and verbatim-reinstalled in Phase 2.
    id: "claude-missing",
    image: "images:fedora/40",
    seed: ["rm -f /usr/local/bin/claude ~/.local/bin/claude"],
    expect: [{ id: "claude", state: "error" }],
    coaching: "structured",
    agentIncompatible: true,
  },
  {
    id: "git-missing",
    image: "images:alpine/3.20",
    seed: ["apk del git 2>/dev/null || true", "rm -f /usr/bin/git"],
    expect: [{ id: "git", state: "error" }],
    coaching: "structured",
  },
  {
    id: "node-too-old",
    image: "images:debian/12",
    // Debian 12's archive node is well below NODE_MIN_VERSION → warning.
    seed: ["apt-get update", "apt-get install -y nodejs"],
    expect: [{ id: "node", state: "warning" }],
    coaching: "structured",
  },
  {
    id: "herdr-too-old",
    image: "images:ubuntu/24.04",
    // Seed engine installs a pinned old herdr build at this path (see seed.ts).
    seed: ["echo 'placeholder: old herdr pinned by baseline' >/dev/null"],
    expect: [{ id: "herdr", state: "warning" }],
    coaching: "structured",
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/onboarding-harness/scenarios.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ci/onboarding-harness/scenarios.ts test/onboarding-harness/scenarios.test.ts
git commit -m "feat(onboarding-harness): messy-environment scenario catalog"
```

---

### Task 4: Detection assertion (pure)

**Files:**
- Create: `ci/onboarding-harness/assert.ts`
- Test: `test/onboarding-harness/assert.test.ts`

- [ ] **Step 1: Write the failing test**

`test/onboarding-harness/assert.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { assertDetection } from "../../ci/onboarding-harness/assert";
import type { DiagnosticsSnapshot } from "../../src/types";

function snap(checks: Array<[string, "ok" | "warning" | "error"]>): DiagnosticsSnapshot {
  return {
    checks: checks.map(([id, state]) => ({ id, state, hintKey: `k_${id}` })),
    generatedAt: 1,
    overall: checks.some(([, s]) => s === "error")
      ? "error"
      : checks.some(([, s]) => s === "warning")
        ? "warning"
        : "ok",
  };
}

describe("assertDetection", () => {
  it("detects when every expected check matches its state", () => {
    const r = assertDetection(snap([["gh", "error"], ["git", "ok"]]), "s", [
      { id: "gh", state: "error" },
    ]);
    expect(r.detected).toBe(true);
    expect(r.misses).toEqual([]);
  });

  it("reports a state mismatch as a miss", () => {
    const r = assertDetection(snap([["gh", "warning"]]), "s", [{ id: "gh", state: "error" }]);
    expect(r.detected).toBe(false);
    expect(r.misses).toEqual([{ id: "gh", want: "error", got: "warning" }]);
  });

  it("reports an absent expected check as a miss", () => {
    const r = assertDetection(snap([["git", "ok"]]), "s", [{ id: "gh", state: "error" }]);
    expect(r.misses).toEqual([{ id: "gh", want: "error", got: "absent" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/onboarding-harness/assert.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`ci/onboarding-harness/assert.ts`:

```ts
import type { DiagnosticsSnapshot } from "../../src/types";
import type { DetectionResult, ExpectedCheck } from "./types";

/** Pure: does the captured snapshot flag every expected check at its expected
 *  state? Any mismatch (wrong state, or check absent) is a detection gap. */
export function assertDetection(
  snapshot: DiagnosticsSnapshot,
  scenarioId: string,
  expected: ExpectedCheck[],
): DetectionResult {
  const byId = new Map(snapshot.checks.map((c) => [c.id, c.state]));
  const misses: DetectionResult["misses"] = [];
  for (const e of expected) {
    const got = byId.get(e.id) ?? "absent";
    if (got !== e.state) misses.push({ id: e.id, want: e.state, got });
  }
  return { scenarioId, detected: misses.length === 0, misses };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/onboarding-harness/assert.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add ci/onboarding-harness/assert.ts test/onboarding-harness/assert.test.ts
git commit -m "feat(onboarding-harness): detection assertion"
```

---

### Task 5: Gap-report builder (pure)

**Files:**
- Create: `ci/onboarding-harness/report.ts`
- Test: `test/onboarding-harness/report.test.ts`

- [ ] **Step 1: Write the failing test**

`test/onboarding-harness/report.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { buildGapReport } from "../../ci/onboarding-harness/report";
import type { ScenarioResult } from "../../ci/onboarding-harness/types";

const results: ScenarioResult[] = [
  {
    scenarioId: "gh-unauthed",
    image: "images:ubuntu/24.04",
    detection: { scenarioId: "gh-unauthed", detected: true, misses: [] },
    appliedVia: "agent",
    reachedGreen: true,
  },
  {
    scenarioId: "tailscale-missing",
    image: "images:ubuntu/24.04",
    detection: {
      scenarioId: "tailscale-missing",
      detected: false,
      misses: [{ id: "tailscale", want: "error", got: "absent" }],
    },
    appliedVia: "agent",
    reachedGreen: false,
    error: "agent gave up",
  },
];

describe("buildGapReport", () => {
  it("summarizes pass/fail counts and lists gaps", () => {
    const md = buildGapReport(results);
    expect(md).toContain("# Onboarding Gap Report");
    expect(md).toContain("1 / 2 scenarios reached green");
    expect(md).toContain("gh-unauthed");
    expect(md).toContain("tailscale-missing");
    expect(md).toContain("tailscale want=error got=absent");
    expect(md).toContain("agent gave up");
  });

  it("marks a detection-but-not-fixed scenario as an advice gap", () => {
    const md = buildGapReport([
      {
        scenarioId: "x",
        image: "i",
        detection: { scenarioId: "x", detected: true, misses: [] },
        appliedVia: "agent",
        reachedGreen: false,
      },
    ]);
    expect(md).toContain("ADVICE GAP");
  });

  it("classifies a by-design no-apply scenario as DETECTION-ONLY and excludes it from the denominator", () => {
    const md = buildGapReport([
      {
        scenarioId: "claude-missing",
        image: "images:fedora/40",
        detection: { scenarioId: "claude-missing", detected: true, misses: [] },
        appliedVia: "skipped",
        reachedGreen: false,
        detectionOnly: true,
      },
      {
        scenarioId: "gh-unauthed",
        image: "i",
        detection: { scenarioId: "gh-unauthed", detected: true, misses: [] },
        appliedVia: "agent",
        reachedGreen: true,
      },
    ]);
    expect(md).toContain("DETECTION-ONLY");
    expect(md).toContain("1 / 1 scenarios reached green"); // claude-missing excluded
    expect(md).not.toContain("## Gaps"); // DETECTION-ONLY is not a gap
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/onboarding-harness/report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`ci/onboarding-harness/report.ts`:

```ts
import type { ScenarioResult } from "./types";

/** Pure: render the per-scenario outcomes as a markdown gap report. Classifies
 *  each scenario as PASS, DETECTION GAP (defect missed/misclassified), ADVICE GAP
 *  (detected but coaching didn't reach green), or DETECTION-ONLY (detected with no
 *  apply attempted by design — e.g. claude-missing in Phase 1; NOT a gap). The
 *  green tally counts only apply-able scenarios so detection-only ones don't drag
 *  the denominator. */
function classify(r: ScenarioResult): "PASS" | "DETECTION GAP" | "ADVICE GAP" | "DETECTION-ONLY" {
  if (r.detectionOnly) return r.detection.detected ? "DETECTION-ONLY" : "DETECTION GAP";
  if (r.reachedGreen) return "PASS";
  return r.detection.detected ? "ADVICE GAP" : "DETECTION GAP";
}

export function buildGapReport(results: ScenarioResult[]): string {
  const applicable = results.filter((r) => !r.detectionOnly);
  const green = applicable.filter((r) => r.reachedGreen).length;
  const detectionOnly = results.length - applicable.length;
  const lines: string[] = [
    "# Onboarding Gap Report",
    "",
    `**${green} / ${applicable.length} scenarios reached green.**` +
      (detectionOnly ? ` (${detectionOnly} detection-only, by design — excluded.)` : ""),
    "",
    "| Scenario | Image | Detected | Applied | Green | Classification |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const gaps: string[] = [];
  for (const r of results) {
    const klass = classify(r);
    lines.push(
      `| ${r.scenarioId} | ${r.image} | ${r.detection.detected ? "yes" : "no"} | ${r.appliedVia} | ${r.reachedGreen ? "yes" : "no"} | ${klass} |`,
    );
    // Only genuine gaps go in the gaps section; PASS and DETECTION-ONLY do not.
    if (klass === "DETECTION GAP" || klass === "ADVICE GAP") {
      const misses = r.detection.misses.map((m) => `${m.id} want=${m.want} got=${m.got}`).join("; ");
      gaps.push(
        `- **${r.scenarioId}** (${klass})${misses ? ` — ${misses}` : ""}${r.error ? ` — ${r.error}` : ""}`,
      );
    }
  }
  if (gaps.length) {
    lines.push("", "## Gaps", "", ...gaps);
  }
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/onboarding-harness/report.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add ci/onboarding-harness/report.ts test/onboarding-harness/report.test.ts
git commit -m "feat(onboarding-harness): gap-report builder"
```

---

### Task 6: Seed engine

**Files:**
- Create: `ci/onboarding-harness/seed.ts`
- Test: `test/onboarding-harness/seed.test.ts`

The seed engine launches an instance, installs the **bootable-Shepherd baseline** (bun + the working-tree build + `bun install`, plus `claude` for the agent path), then runs the scenario's `seed`. The baseline install is what guarantees Shepherd can boot before defects are layered on. Unit-tested via the injected `IncusDriver` runner by asserting the command sequence.

- [ ] **Step 1: Write the failing test**

`test/onboarding-harness/seed.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { IncusDriver } from "../../ci/onboarding-harness/incus";
import { seedInstance } from "../../ci/onboarding-harness/seed";
import type { IncusExec } from "../../ci/onboarding-harness/types";

function recorder() {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<IncusExec> => {
    calls.push(args);
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, run };
}

const scenario = {
  id: "gh-unauthed",
  image: "images:ubuntu/24.04",
  seed: ["rm -rf ~/.config/gh"],
  expect: [{ id: "gh", state: "error" as const }],
  coaching: "prose" as const,
};

describe("seedInstance", () => {
  it("launches, installs the bun baseline, then runs the scenario seed in order", async () => {
    const { calls, run } = recorder();
    const d = new IncusDriver(run, "shep-onb-");
    await seedInstance(d, scenario, "/tmp/shepherd.tar");

    expect(calls[0][0]).toBe("launch");
    expect(calls[0]).toContain("images:ubuntu/24.04");

    const flat = calls.map((c) => c.join(" "));
    // baseline installs bun before the scenario seed runs
    const bunIdx = flat.findIndex((c) => c.includes("bun.sh/install"));
    const seedIdx = flat.findIndex((c) => c.includes("rm -rf ~/.config/gh"));
    expect(bunIdx).toBeGreaterThanOrEqual(0);
    expect(seedIdx).toBeGreaterThan(bunIdx);
  });

  it("pushes the Shepherd build tarball into the instance", async () => {
    const { calls, run } = recorder();
    const d = new IncusDriver(run, "shep-onb-");
    await seedInstance(d, scenario, "/tmp/shepherd.tar");
    const push = calls.find((c) => c[0] === "file" && c[1] === "push");
    expect(push).toBeDefined();
    expect(push!).toContain("/tmp/shepherd.tar");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/onboarding-harness/seed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`ci/onboarding-harness/seed.ts`:

```ts
import type { IncusDriver } from "./incus";
import type { Scenario } from "./types";

const SHEPHERD_DIR = "/opt/shepherd";

/** Commands that turn a fresh instance into a bootable-Shepherd baseline: bun
 *  runtime + the pushed working-tree build + deps + the claude CLI (agent path).
 *  Defects are layered AFTER this so degraded Shepherd can still boot. */
function baselineCommands(): string[] {
  return [
    "command -v curl >/dev/null 2>&1 || (apt-get update && apt-get install -y curl) || (apk add --no-cache curl) || (dnf install -y curl) || (pacman -Sy --noconfirm curl)",
    "curl -fsSL https://bun.sh/install | bash",
    `mkdir -p ${SHEPHERD_DIR} && tar -xf /root/shepherd.tar -C ${SHEPHERD_DIR}`,
    `cd ${SHEPHERD_DIR} && ~/.bun/bin/bun install`,
    // claude CLI for the agent apply path; harmless if a scenario removes it later.
    "curl -fsSL https://claude.ai/install.sh | bash || true",
  ];
}

/** Launch a fresh instance for `scenario`, install the bootable baseline, push
 *  the Shepherd build, then run the scenario's messy-state seed commands. */
export async function seedInstance(
  driver: IncusDriver,
  scenario: Scenario,
  tarballPath: string,
): Promise<void> {
  await driver.launch(scenario.image, scenario.id, {
    vm: scenario.vm,
    profile: "shep-onb",
  });
  // Wait for the instance's network/init to settle before exec.
  await driver.exec(scenario.id, ["sh", "-c", "for i in $(seq 1 30); do test -e /bin/sh && break; sleep 1; done"]);
  await driver.push(scenario.id, tarballPath, "/root/shepherd.tar");
  for (const cmd of baselineCommands()) {
    await driver.exec(scenario.id, ["sh", "-c", cmd]);
  }
  for (const cmd of scenario.seed) {
    await driver.exec(scenario.id, ["sh", "-c", cmd]);
  }
}
```

> **Note for the implementer:** `herdr-too-old` and `tailscale-not-serving` need real fixture state (a pinned old `herdr` binary; a faked tailnet so `resolveNodeHost` returns non-null without a real login). Add those as extra baseline branches keyed on `scenario.id` once the real-Incus run (Task 9) confirms the probe behavior; do not block Phase 1's other scenarios on them.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/onboarding-harness/seed.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add ci/onboarding-harness/seed.ts test/onboarding-harness/seed.test.ts
git commit -m "feat(onboarding-harness): seed engine (baseline + messy state)"
```

---

### Task 7: Diagnostics probe (boot Shepherd + capture snapshot)

**Files:**
- Create: `ci/onboarding-harness/probe.ts`
- Test: `test/onboarding-harness/probe.test.ts`

`probeDiagnostics` runs `curl` **inside** the instance against Shepherd's loopback API and parses the JSON snapshot. `bootShepherd` starts the server detached and polls until the API answers. Both are exercised via the injected driver runner.

- [ ] **Step 1: Write the failing test**

`test/onboarding-harness/probe.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { IncusDriver } from "../../ci/onboarding-harness/incus";
import { probeDiagnostics } from "../../ci/onboarding-harness/probe";
import type { IncusExec } from "../../ci/onboarding-harness/types";

describe("probeDiagnostics", () => {
  it("curls the diagnostics endpoint inside the instance and parses the snapshot", async () => {
    const snapshot = {
      checks: [{ id: "gh", state: "error", hintKey: "diagnostics_hint_gh_not_authenticated" }],
      generatedAt: 5,
      overall: "error",
    };
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<IncusExec> => {
      calls.push(args);
      return { stdout: JSON.stringify(snapshot), stderr: "", code: 0 };
    };
    const d = new IncusDriver(run, "shep-onb-");
    const snap = await probeDiagnostics(d, "gh-unauthed");
    expect(snap.overall).toBe("error");
    expect(snap.checks[0].id).toBe("gh");
    // exec'd a curl against the loopback diagnostics endpoint with refresh
    const cmd = calls[0].join(" ");
    expect(cmd).toContain("curl");
    expect(cmd).toContain("/api/diagnostics?refresh=1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/onboarding-harness/probe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`ci/onboarding-harness/probe.ts`:

```ts
import type { IncusDriver } from "./incus";
import type { DiagnosticsSnapshot } from "../../src/types";

const SHEPHERD_DIR = "/opt/shepherd";
const PORT = 7330; // config.port default

/** Start Shepherd detached inside the instance and poll until its HTTP API
 *  answers (or time out). Degraded boots are expected — we only need the server
 *  process up far enough to serve `/api/diagnostics`.
 *
 *  AUTH (point 7): `GET /api/diagnostics` passes through `checkAuth`, which only
 *  authorizes when `config.token` (`SHEPHERD_TOKEN`) is null. We boot with the
 *  var explicitly UNSET (`env -u SHEPHERD_TOKEN`) so the plain `curl` probe below
 *  is authorized — the harness controls the env, so this is safe and the simplest
 *  correct option. (If a future scenario needs a token, the probe must add
 *  `-H "Authorization: Bearer $SHEPHERD_TOKEN"` instead.) */
export async function bootShepherd(driver: IncusDriver, name: string): Promise<void> {
  await driver.exec(name, [
    "sh",
    "-c",
    `cd ${SHEPHERD_DIR} && env -u SHEPHERD_TOKEN nohup ~/.bun/bin/bun run start >/var/log/shepherd.log 2>&1 &`,
  ]);
  const poll = await driver.exec(name, [
    "sh",
    "-c",
    `for i in $(seq 1 60); do curl -sf localhost:${PORT}/api/diagnostics >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`,
  ]);
  if (poll.code !== 0) throw new Error(`Shepherd did not come up in ${name}`);
}

/** Capture a fresh diagnostics snapshot from inside the instance. */
export async function probeDiagnostics(
  driver: IncusDriver,
  name: string,
): Promise<DiagnosticsSnapshot> {
  const r = await driver.exec(name, [
    "sh",
    "-c",
    `curl -s localhost:${PORT}/api/diagnostics?refresh=1`,
  ]);
  if (r.code !== 0 || !r.stdout.trim()) {
    throw new Error(`diagnostics probe failed in ${name}: ${r.stderr || "empty"}`);
  }
  return JSON.parse(r.stdout) as DiagnosticsSnapshot;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/onboarding-harness/probe.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add ci/onboarding-harness/probe.ts test/onboarding-harness/probe.test.ts
git commit -m "feat(onboarding-harness): diagnostics probe + boot"
```

---

### Task 8: Apply engine — agent path + hintKey resolution

**Files:**
- Create: `ci/onboarding-harness/apply.ts`
- Test: `test/onboarding-harness/apply.test.ts`

Phase 1 applies coaching via a **Claude Code agent** acting as a proxy-user. The agent receives the diagnostics snapshot plus the **resolved EN coaching text** for each non-ok check (what a real user sees), and is let loose to fix the env. `resolveCoaching` is a pure, unit-tested function reading `ui/messages/en.json`; the agent invocation's command construction is also asserted. `coaching: "structured"` falls back to the agent path in Phase 1 (logged), since no remediation field exists yet.

- [ ] **Step 1: Write the failing test**

`test/onboarding-harness/apply.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { resolveCoaching, buildAgentPrompt } from "../../ci/onboarding-harness/apply";
import type { DiagnosticsSnapshot } from "../../src/types";

const snap: DiagnosticsSnapshot = {
  checks: [
    { id: "gh", state: "error", hintKey: "diagnostics_hint_gh_not_authenticated" },
    { id: "git", state: "ok", hintKey: "diagnostics_hint_git_ok" },
  ],
  generatedAt: 1,
  overall: "error",
};

describe("resolveCoaching", () => {
  it("resolves non-ok check hintKeys to their EN message text", () => {
    const messages = { diagnostics_hint_gh_not_authenticated: "Run `gh auth login` to authenticate." };
    const lines = resolveCoaching(snap, messages);
    expect(lines).toEqual([{ id: "gh", text: "Run `gh auth login` to authenticate." }]);
  });

  it("skips ok checks and falls back to the raw key when a message is missing", () => {
    const lines = resolveCoaching(snap, {});
    expect(lines).toEqual([{ id: "gh", text: "diagnostics_hint_gh_not_authenticated" }]);
  });
});

describe("buildAgentPrompt", () => {
  it("includes the coaching text and a clear success instruction", () => {
    const p = buildAgentPrompt([{ id: "gh", text: "Run gh auth login." }]);
    expect(p).toContain("Run gh auth login.");
    expect(p.toLowerCase()).toContain("healthy");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/onboarding-harness/apply.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`ci/onboarding-harness/apply.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncusDriver } from "./incus";
import type { DiagnosticsSnapshot } from "../../src/types";

export interface CoachingLine {
  id: string;
  text: string;
}

/** Pure: resolve every non-ok check's hintKey to the user-visible EN string
 *  (falling back to the raw key). This is exactly the coaching a new user reads. */
export function resolveCoaching(
  snapshot: DiagnosticsSnapshot,
  messages: Record<string, string>,
): CoachingLine[] {
  return snapshot.checks
    .filter((c) => c.state !== "ok")
    .map((c) => ({ id: c.id, text: messages[c.hintKey] ?? c.hintKey }));
}

/** Pure: the proxy-user prompt — only what a real user sees, plus the goal. */
export function buildAgentPrompt(lines: CoachingLine[]): string {
  const coaching = lines.map((l) => `- (${l.id}) ${l.text}`).join("\n");
  return [
    "You are a new user setting up Shepherd on this machine.",
    "Shepherd's onboarding screen shows these issues and advice:",
    "",
    coaching,
    "",
    "Follow this advice to get the machine to a healthy state. Use the shell.",
    "Do not invent steps beyond what the advice implies. Stop when done.",
  ].join("\n");
}

/** Load the EN catalog once (the user-visible coaching source of truth). */
export function loadEnMessages(): Record<string, string> {
  const p = join(import.meta.dir, "..", "..", "ui", "messages", "en.json");
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
}

/** Run the proxy-user agent inside the instance to act on the coaching. Returns
 *  the agent's exit code (0 ⇒ it believes it finished). Auth is provided by a
 *  ~/.claude credential mounted into the instance by run.ts. */
export async function applyAgent(
  driver: IncusDriver,
  name: string,
  snapshot: DiagnosticsSnapshot,
): Promise<number> {
  const lines = resolveCoaching(snapshot, loadEnMessages());
  if (lines.length === 0) return 0;
  const prompt = buildAgentPrompt(lines);
  const r = await driver.exec(name, [
    "sh",
    "-c",
    `claude -p ${shellQuote(prompt)} --permission-mode dontAsk --allowedTools Bash`,
  ]);
  return r.code;
}

/** Minimal single-quote shell escape for embedding the prompt safely. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/onboarding-harness/apply.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add ci/onboarding-harness/apply.ts test/onboarding-harness/apply.test.ts
git commit -m "feat(onboarding-harness): agent apply path + coaching resolution"
```

---

### Task 9: Orchestrator + CLI + manual integration run

**Files:**
- Create: `ci/onboarding-harness/run.ts`
- Create: `ci/onboarding-harness/README.md`
- Modify: `package.json` (add `onboarding:test` script)

- [ ] **Step 1: Write the orchestrator**

`ci/onboarding-harness/run.ts`:

```ts
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { IncusDriver } from "./incus";
import { SCENARIOS } from "./scenarios";
import { seedInstance } from "./seed";
import { bootShepherd, probeDiagnostics } from "./probe";
import { applyAgent } from "./apply";
import { assertDetection } from "./assert";
import { buildGapReport } from "./report";
import type { Scenario, ScenarioResult } from "./types";

/** `git archive` the current HEAD into a tarball the seed engine pushes. */
function buildTarball(): string {
  const dir = mkdtempSync(join(tmpdir(), "shep-onb-"));
  const tar = join(dir, "shepherd.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", tar, "HEAD"]);
  return tar;
}

async function runScenario(
  driver: IncusDriver,
  scenario: Scenario,
  tarball: string,
): Promise<ScenarioResult> {
  const base = { scenarioId: scenario.id, image: scenario.image };
  try {
    await seedInstance(driver, scenario, tarball);
    await bootShepherd(driver, scenario.id);
    const before = await probeDiagnostics(driver, scenario.id);
    const detection = assertDetection(before, scenario.id, scenario.expect);

    // Phase 1 has no verbatim path yet. A scenario that disabled the agent
    // (claude-missing — the agent IS claude in-instance) is detection-only and
    // is NOT counted as an advice gap. Everything else uses the agent proxy-user.
    if (scenario.agentIncompatible) {
      console.log(`[${scenario.id}] agent-incompatible — detection-only in Phase 1`);
      return { ...base, detection, appliedVia: "skipped", reachedGreen: false, detectionOnly: true };
    }
    if (scenario.coaching === "structured") {
      console.log(`[${scenario.id}] structured coaching not yet available — using agent path`);
    }
    await applyAgent(driver, scenario.id, before);

    const after = await probeDiagnostics(driver, scenario.id);
    return { ...base, detection, appliedVia: "agent", reachedGreen: after.overall === "ok" };
  } catch (err) {
    return {
      ...base,
      detection: { scenarioId: scenario.id, detected: false, misses: [] },
      appliedVia: "skipped",
      reachedGreen: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await driver.delete(scenario.id);
  }
}

// FIXED absolute path under the host-global Shepherd state dir (~/.shepherd) — NOT
// $TMPDIR. A systemd-user timer service and an interactive shell can see different
// $TMPDIR (PrivateTmp, per-session dirs), which would defeat the lock; $HOME is
// stable and identical for both (same user), so the lock is genuinely host-wide.
const LOCK_PATH = join(homedir(), ".shepherd", "onboarding-harness.lock");

/** Acquire a host-wide exclusive lock so concurrent runs never share the Incus
 *  host. `wx` fails if the lock already exists. Returns a release fn. */
function acquireHostLock(): () => void {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  let fd: number;
  try {
    fd = openSync(LOCK_PATH, "wx");
  } catch {
    console.error(`another onboarding-harness run holds ${LOCK_PATH}; aborting`);
    process.exit(3);
  }
  return () => {
    closeSync(fd);
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* already gone */
    }
  };
}

async function main() {
  // Maintenance: reap ALL harness instances across runs (manual recovery only).
  if (process.argv.includes("--reap-orphans")) {
    await new IncusDriver(undefined, "shep-onb-").sweep();
    console.log("reaped all shep-onb-* instances");
    return;
  }

  const only = process.argv.includes("--scenario")
    ? process.argv[process.argv.indexOf("--scenario") + 1]
    : null;
  const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  if (scenarios.length === 0) {
    console.error(`no scenario matched ${only}`);
    process.exit(2);
  }

  const release = acquireHostLock();
  // Per-run prefix isolates this run's instances; `sweep()` then only ever
  // touches our own, so overlapping runs can't destroy each other (point 5).
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const driver = new IncusDriver(undefined, `shep-onb-${runId}-`);
  const tarball = buildTarball();

  const results: ScenarioResult[] = [];
  try {
    for (const s of scenarios) {
      console.log(`\n=== ${s.id} (${s.image}) ===`);
      results.push(await runScenario(driver, s, tarball));
    }
  } finally {
    await driver.sweep(); // teardown — own-prefix instances only
    release();
  }

  const report = buildGapReport(results);
  const out = join(process.cwd(), "onboarding-gap-report.md");
  writeFileSync(out, report);
  console.log(`\n${report}\nReport written to ${out}`);

  // Non-zero exit if any APPLY-ABLE scenario failed to reach green (detection-only
  // scenarios are excluded). Consumed by the Phase 2 gate.
  const applicable = results.filter((r) => !r.detectionOnly);
  process.exit(applicable.every((r) => r.reachedGreen) ? 0 : 1);
}

void main();
```

- [ ] **Step 2: Add the npm script**

In `package.json` `scripts`:

```json
"onboarding:test": "bun run ci/onboarding-harness/run.ts",
```

- [ ] **Step 3: Write the README (auth + prereqs + usage)**

`ci/onboarding-harness/README.md` — document: requires the self-hosted Incus host; create the `shep-onb` Incus profile with resource caps + (for tailscale/systemd scenarios) `security.nesting=true` and a TUN device; mount `~/.claude` credentials for the agent path; run with `bun run onboarding:test [--scenario <id>]`; report lands at `onboarding-gap-report.md`. **Run isolation:** each run takes a host-wide lock at the fixed absolute path `~/.shepherd/onboarding-harness.lock` (NOT `$TMPDIR` — a systemd-user service and an interactive run can see different `$TMPDIR`, so the lock must live under the stable host-global `~/.shepherd` dir to actually serialize them) and uses a per-run instance prefix `shep-onb-<runId>-`, swept (own-prefix only) on teardown — so a second run cannot launch while one holds the lock, and crashed-run leftovers are cleared with `bun run onboarding:test --reap-orphans` (the only command that touches other runs' instances).

- [ ] **Step 4: Verify type-check, lint, and the unit suite**

Run: `bunx tsc --noEmit && bun run lint && bun test ./test/onboarding-harness`
Expected: PASS (all harness unit tests green; no type/lint errors).

- [ ] **Step 5: Manual integration run (on the Incus host)**

Run: `bun run onboarding:test --scenario gh-unauthed`
Expected: launches `shep-onb-gh-unauthed`, boots Shepherd, prints a snapshot with `gh: error`, runs the agent, re-probes, deletes the instance, writes `onboarding-gap-report.md`. Confirm `incus list` shows no leaked `shep-onb-*` instances afterward.
Then iterate the `seed.ts` per-scenario fixtures (herdr-too-old, tailscale-not-serving) against real probe behavior until each scenario's detection matches `expect`.

- [ ] **Step 6: Commit**

```bash
git add ci/onboarding-harness/run.ts ci/onboarding-harness/README.md package.json
git commit -m "feat(onboarding-harness): orchestrator, CLI, and run docs"
```

---

## Phase 2 — deterministic regression tier + ops wiring

### Task 10: Harness-side remediation catalog (no `src/` change)

**Files:**
- Create: `ci/onboarding-harness/remediations.ts`
- Test: `test/onboarding-harness/remediations.test.ts`

Per plan review (point 3), structured remediations live **in the harness**, keyed by the `hintKey` Shepherd emits — NOT as a field on the shipped `DiagnosticCheck` payload. This keeps the exact-keys payload-purity contract (`test/diagnostics.test.ts:52`) intact and avoids a hidden shipped field. `src/diagnostics.ts` and `src/types.ts` are **not touched**. The verbatim path therefore guards *detection + scenario-reachability deterministically*; advice-text correctness remains the agent path's job (Task 8).

- [ ] **Step 1: Write the failing test**

`test/onboarding-harness/remediations.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { REMEDIATIONS, remediationsFor } from "../../ci/onboarding-harness/remediations";
import type { DiagnosticsSnapshot } from "../../src/types";

describe("remediations catalog", () => {
  it("maps known fixable hintKeys to a single shell command", () => {
    expect(REMEDIATIONS.diagnostics_hint_bun_missing).toContain("bun.sh/install");
  });

  it("collects verbatim commands for non-ok checks that have one (skips prose-only and ok)", () => {
    const snap: DiagnosticsSnapshot = {
      checks: [
        { id: "bun", state: "error", hintKey: "diagnostics_hint_bun_missing" },
        { id: "gh", state: "error", hintKey: "diagnostics_hint_gh_not_authenticated" }, // prose-only → skipped
        { id: "git", state: "ok", hintKey: "diagnostics_hint_git_ok" }, // ok → skipped
      ],
      generatedAt: 1,
      overall: "error",
    };
    expect(remediationsFor(snap)).toEqual([REMEDIATIONS.diagnostics_hint_bun_missing]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/onboarding-harness/remediations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the catalog**

`ci/onboarding-harness/remediations.ts`:

```ts
import type { DiagnosticsSnapshot } from "../../src/types";

/** hintKey → verbatim shell remediation, keyed by the advice identifier Shepherd
 *  emits. Lives in the HARNESS (not the diagnostics payload) so the shipped
 *  DiagnosticCheck contract is unchanged. Only keys whose canonical fix is a
 *  single non-interactive command appear; prose-only coaching (interactive
 *  `gh auth login`, tailscale serve setup) is intentionally absent and stays on
 *  the agent path. */
export const REMEDIATIONS: Record<string, string> = {
  diagnostics_hint_bun_missing: "curl -fsSL https://bun.sh/install | bash",
  diagnostics_hint_node_missing: "curl -fsSL https://fnm.vercel.app/install | bash && fnm install --lts",
  diagnostics_hint_herdr_missing: "curl -fsSL https://herdr.dev/install.sh | bash",
  diagnostics_hint_claude_missing: "curl -fsSL https://claude.ai/install.sh | bash",
};

/** Verbatim commands for every non-ok check whose emitted hintKey has a known fix. */
export function remediationsFor(snapshot: DiagnosticsSnapshot): string[] {
  return snapshot.checks
    .filter((c) => c.state !== "ok" && REMEDIATIONS[c.hintKey])
    .map((c) => REMEDIATIONS[c.hintKey]!);
}
```

> **Implementer:** confirm each install URL against the project's actual install docs before committing — use the exact command Shepherd's onboarding docs prescribe. Drop any key whose canonical fix is not a single non-interactive command.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/onboarding-harness/remediations.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add ci/onboarding-harness/remediations.ts test/onboarding-harness/remediations.test.ts
git commit -m "feat(onboarding-harness): harness-side remediation catalog"
```

---

### Task 11: Verbatim apply path

**Files:**
- Modify: `ci/onboarding-harness/apply.ts` (add `applyVerbatim`, sourced from `remediations.ts`)
- Modify: `ci/onboarding-harness/run.ts` (verbatim-first dispatch; replaces the Phase-1 block)
- Test: `test/onboarding-harness/apply.test.ts` (add the verbatim case)

- [ ] **Step 1: Write the failing test**

Add to `test/onboarding-harness/apply.test.ts`:

```ts
import { applyVerbatim } from "../../ci/onboarding-harness/apply";
import { IncusDriver } from "../../ci/onboarding-harness/incus";

describe("applyVerbatim", () => {
  it("runs each harness-catalog remediation for non-ok checks inside the instance", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    };
    const d = new IncusDriver(run, "shep-onb-");
    const snap = {
      checks: [{ id: "bun", state: "error" as const, hintKey: "diagnostics_hint_bun_missing" }],
      generatedAt: 1,
      overall: "error" as const,
    };
    const ok = await applyVerbatim(d, "bun-missing", snap);
    expect(ok).toBe(true);
    expect(calls[0].join(" ")).toContain("bun.sh/install");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/onboarding-harness/apply.test.ts`
Expected: FAIL — `applyVerbatim` is not exported.

- [ ] **Step 3: Implement `applyVerbatim` (sourcing the harness catalog)**

Add the import at the top of `ci/onboarding-harness/apply.ts`:

```ts
import { remediationsFor } from "./remediations";
```

Append to `ci/onboarding-harness/apply.ts`:

```ts
/** Run each harness-catalog remediation (keyed by Shepherd's emitted hintKeys)
 *  verbatim inside the instance. Returns false if any command exits non-zero. */
export async function applyVerbatim(
  driver: IncusDriver,
  name: string,
  snapshot: DiagnosticsSnapshot,
): Promise<boolean> {
  for (const cmd of remediationsFor(snapshot)) {
    const r = await driver.exec(name, ["sh", "-c", cmd]);
    if (r.code !== 0) return false;
  }
  return true;
}
```

- [ ] **Step 4: Verbatim-first dispatch in `run.ts`**

Add the imports to `run.ts`:

```ts
import { applyVerbatim } from "./apply";
import { remediationsFor } from "./remediations";
```

In `runScenario`, **replace** the Phase-1 `agentIncompatible`/agent block (the one added in Task 9) with verbatim-first dispatch. Verbatim takes precedence, so `claude-missing` (which now has a catalog remediation) is reinstalled and reaches green instead of staying detection-only:

```ts
const verbatim = remediationsFor(before);
let appliedVia: ScenarioResult["appliedVia"];
let detectionOnly = false;
if (verbatim.length > 0) {
  await applyVerbatim(driver, scenario.id, before);
  appliedVia = "verbatim";
} else if (scenario.agentIncompatible) {
  // No structured fix AND the agent can't run here (no claude) → detection-only.
  appliedVia = "skipped";
  detectionOnly = true;
} else {
  await applyAgent(driver, scenario.id, before);
  appliedVia = "agent";
}
const after = detectionOnly ? before : await probeDiagnostics(driver, scenario.id);
return {
  ...base,
  detection,
  appliedVia,
  reachedGreen: !detectionOnly && after.overall === "ok",
  detectionOnly: detectionOnly || undefined,
};
```

- [ ] **Step 5: Run tests + type-check**

Run: `bun test ./test/onboarding-harness && bunx tsc --noEmit && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ci/onboarding-harness/apply.ts ci/onboarding-harness/run.ts test/onboarding-harness/apply.test.ts
git commit -m "feat(onboarding-harness): deterministic verbatim apply path"
```

---

### Task 12: Release gate + nightly wiring (Incus host)

**Files:**
- Create: `scripts/onboarding-gate.sh`
- Create: `ci/onboarding-harness/shepherd-onboarding.service`
- Create: `ci/onboarding-harness/shepherd-onboarding.timer`
- Modify: `ci/onboarding-harness/README.md` (install instructions for the units)

The gate runs the **deterministic verbatim subset** (the `structured` scenarios) so the release check is reproducible and LLM-free; agent-path scenarios are reported by the nightly run but do not gate.

- [ ] **Step 1: Write the gate script**

`scripts/onboarding-gate.sh`:

```bash
#!/usr/bin/env bash
# Release gate: run the deterministic (structured) onboarding scenarios and fail
# the release if any does not reach a healthy state.
#
# SAFE DEGRADE (point 6): this gate depends on a single self-hosted Incus host.
# If that host is unavailable, we must NOT hard-block an otherwise-good release on
# unrelated infra — we log a loud, explicit bypass and exit 0. A red SCENARIO
# (Incus present, a scenario failed) still fails the gate; only an absent/broken
# Incus host bypasses.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v incus >/dev/null 2>&1 || ! incus list >/dev/null 2>&1; then
  echo "::onboarding-gate:: BYPASSED — Incus host unavailable; not blocking the release on infra." >&2
  exit 0
fi

STRUCTURED_IDS=$(bun -e '
  import("./ci/onboarding-harness/scenarios.ts").then(({ SCENARIOS }) =>
    console.log(SCENARIOS.filter((s) => s.coaching === "structured").map((s) => s.id).join(" ")));
')

fail=0
for id in $STRUCTURED_IDS; do
  echo "::onboarding-gate:: $id"
  bun run onboarding:test --scenario "$id" || fail=1
done
exit "$fail"
```

Make it executable: `chmod +x scripts/onboarding-gate.sh`

- [ ] **Step 2: Write the systemd units (nightly)**

`ci/onboarding-harness/shepherd-onboarding.service`:

```ini
[Unit]
Description=Shepherd onboarding regression harness (nightly)
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=%h/Work/shepherd
ExecStart=/usr/bin/env bun run onboarding:test
```

`ci/onboarding-harness/shepherd-onboarding.timer`:

```ini
[Unit]
Description=Nightly Shepherd onboarding harness run

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Document install + wire the pre-release gate**

In `ci/onboarding-harness/README.md`, add: copy the units to `~/.config/systemd/user/`, `systemctl --user enable --now shepherd-onboarding.timer`; and add to the OSS-release checklist that `scripts/onboarding-gate.sh` must exit 0 before tagging. (No GitHub Actions wiring — this is self-hosted-Incus-only, never per-PR, per the design.)

- [ ] **Step 4: Verify the gate script parses + selects scenarios**

Run: `bash -n scripts/onboarding-gate.sh && bun -e 'import("./ci/onboarding-harness/scenarios.ts").then(({SCENARIOS})=>console.log(SCENARIOS.filter(s=>s.coaching==="structured").map(s=>s.id)))'`
Expected: the script has no syntax errors; the command prints the list of structured scenario ids.

- [ ] **Step 5: Commit**

```bash
git add scripts/onboarding-gate.sh ci/onboarding-harness/shepherd-onboarding.service ci/onboarding-harness/shepherd-onboarding.timer ci/onboarding-harness/README.md
git commit -m "feat(onboarding-harness): release gate + nightly timer"
```

---

## Self-review

**Spec coverage:**
- Incus driver (system containers + VM opt-in, snapshot/sweep) → Task 2. ✓
- Scenario catalog (7 checks × states, distro spread) → Task 3. ✓
- Seed engine (bootable baseline + messy seed) → Task 6. ✓
- Probe via `GET /api/diagnostics?refresh=1` → Task 7. ✓
- Detection assertion (gap source #1) → Task 4. ✓
- Apply: agent path (P1) → Task 8; verbatim path (P2) → Task 11. ✓
- Gap report (incl. DETECTION-ONLY class, green over applicable) → Task 5; wired in orchestrator → Task 9. ✓
- Detect→apply→re-probe-green success signal → Task 9 `runScenario`. ✓
- Structured remediations **harness-side** (no `src/` change; payload-purity contract intact) → Task 10. ✓
- Manual + nightly + pre-release gate on Incus host → Task 9 (manual) + Task 12 (nightly/gate). ✓
- Guaranteed teardown + run isolation → Task 2 note + Task 9 host-lock + per-run prefix + `finally` sweep + `--reap-orphans`. ✓
- Bootstrap-paradox boundary (baseline always has bun; cold-bun-absent deferred) → encoded in Task 6 baseline + scenario catalog scope; cold-bun-absent NOT in Phase 1 catalog (matches spec). ✓

**Plan-review points (this revision):**
- (1) Spec + detailed plan committed (`0589f426`, `04c21a98`) and tracked. ✓
- (2) Brokenness scope = the 7 diagnostics checks for v1 — user-signed-off; other failure modes (corrupted/locked git, port-in-use, partial herdr, no network/DNS, full disk, broken worktrees, target-repo readiness) explicitly deferred. ✓
- (3) Remediations harness-side, not a shipped `DiagnosticCheck` field → Task 10. ✓
- (4) `claude` presence-only: no `claude-unauthed` scenario; `claude-missing` is detection-only in P1 (agent needs claude), verbatim-reinstalled in P2 → Tasks 3/5/9/11. ✓
- (5) Per-run prefix + host lock + own-prefix sweep + `--reap-orphans` → Tasks 2/9. ✓
- (6) Release gate bypasses (exit 0, logged) when Incus host unavailable → Task 12. ✓
- (7) Probe auth: baseline boots with `SHEPHERD_TOKEN` unset so plain `curl` passes `checkAuth` → Task 7. ✓

**Plan-review points (round 2):**
- (1, re-raised) The gate reviews a frozen *main* worktree (`ef27e9bf`, #637) lacking this feature branch's commits, and `.shepherd-plan.md` is `.gitignore`d (read live). Committing to the branch can't make `docs/` visible to the gate, so the full plan + spec are now embedded **inline** in `.shepherd-plan.md` (executable detail, not a pointer). The `docs/` copies remain committed on the branch for the eventual PR. ✓
- (2) Host lock moved off `$TMPDIR` to the fixed absolute `~/.shepherd/onboarding-harness.lock` so a systemd-user timer and an interactive run (which can see different `$TMPDIR` under PrivateTmp) share one lock and truly serialize → Task 9 `acquireHostLock`. ✓

**Placeholder scan:** No TBD/TODO left as work; two explicit *implementer-confirm* notes (per-scenario fixtures in Task 6; install-URL verification in Task 10) are deliberate real-world verifications, each with concrete instructions, not deferred design.

**Type consistency:** `IncusRunner`/`IncusExec`, `Scenario`/`ExpectedCheck` (incl. `agentIncompatible?`), `DetectionResult`, `ScenarioResult` (incl. `detectionOnly?`) defined in Task 1 and used unchanged throughout. `assertDetection(snapshot, scenarioId, expected)` signature matches its call in Task 9. `applyAgent`/`applyVerbatim`/`resolveCoaching`/`buildAgentPrompt` (apply.ts) and `REMEDIATIONS`/`remediationsFor` (remediations.ts) names consistent across Tasks 8/10/11. No `src/` types touched.

## Unresolved questions

None — all scope/approach decisions resolved during brainstorming. Two real-world values to confirm during execution (not design gaps): exact install-command URLs for the `REMEDIATIONS` map (Task 10), and the per-scenario fixture setup for `herdr-too-old` / `tailscale-not-serving` (Task 6), both validated against real Incus behavior in Task 9.
