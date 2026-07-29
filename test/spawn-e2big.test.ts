import { test, expect, describe } from "bun:test";
import { execFileSync } from "node:child_process";
import { buildWrappedArgv, posixShellJoin } from "../src/herdr";
import {
  hostArgvBudget,
  hostArgvElementLimit,
  spawnFootprintBytes,
  OversizedArgvError,
  oversizedFromArgv,
} from "../src/argv-limit";
import { buildTransientAgentArgv } from "../src/transient-agent-argv";
import { planReviewPrompt } from "../src/plan-gate";
import { clampBlock, fitAssembledPrompt, planUsefulFloor } from "../src/prompt-fit";
import { spawnBudget } from "../src/spawn-budget";

/**
 * The ONLY seam here that fails on `main`.
 *
 * Everything else in this change can be asserted against fakes, which means everything else could
 * in principle be self-consistently wrong. This one hands the argv to the REAL kernel and lets it
 * decide, so it cannot be satisfied by agreeing with our own arithmetic:
 *
 *  - `throws E2BIG today` reproduces issue #1944 exactly — a ~129 KB plan riding as the trailing
 *    argv positional, through both driver shapes.
 *  - `succeeds after the ladder` proves the fix actually clears the kernel's bar, not ours.
 *
 * Linux-gated: `MAX_ARG_STRLEN` is a Linux concept (`PAGE_SIZE * 32`); darwin caps only the whole
 * argv, so there is nothing to reproduce there.
 */
const onLinux = process.platform === "linux";

/** A plan shaped like the real schema — the sections the reviewer checks for are in the back half. */
function realisticPlan(totalBytes: number): string {
  const head = "# Plan — fix the thing\n\n## Goal\n\nStop the failure.\n\n## Approach\n\n";
  const tail =
    "\n## Out of scope\n\n- document spill\n\n## Testing seams\n\n- the real-spawn seam\n\n" +
    "## Risks\n\n- a clamped plan is partial\n\n## Success criteria\n\n1. gates green\n";
  const filler = "The ladder measures every byte of the argv herdr.start will spawn.\n";
  const need = Math.max(0, totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail));
  return head + filler.repeat(Math.ceil(need / filler.length)).slice(0, need) + tail;
}

/** The REAL plan-gate prompt, so the reported 129 KB figure is meaningful: the plan alone fits, and
 *  it is the several-KB instruction block wrapped around it that pushes the argv past the limit. */
const promptFor = (plan: string) => planReviewPrompt("do the thing", plan);

const argvFor = (prompt: string) =>
  buildTransientAgentArgv("reviewer", {
    provider: "claude",
    model: null,
    prompt,
    sessionId: "11111111-2222-3333-4444-555555555555",
  }).argv;

/** Both shapes the budget is calibrated against, each wrapped by the env shim `herdr.start` applies. */
const DRIVER_SHAPES = [
  {
    name: "the joined command line as ONE argv element (what spawnBudget prices)",
    // No transport spends the argv this way since #1967 — the ≥0.7.5 drivers type `sh '<script>'`
    // and the script's `exec` spreads the tokens. `spawnBudget` still measures the joined line, so
    // this is the deliberately conservative upper bound: a prompt that clears it clears every real
    // shape, and the ladder can never under-clamp.
    elements: (prompt: string) => [posixShellJoin(buildWrappedArgv(argvFor(prompt)))],
  },
  {
    name: "<=0.7.4 agent start (argv spread; the prompt is its own element)",
    elements: (prompt: string) => buildWrappedArgv(argvFor(prompt)),
  },
] as const;

/** Hand `elements` to the real kernel via /bin/true. Returns the thrown error, or null on success. */
function realSpawn(elements: string[]): NodeJS.ErrnoException | null {
  try {
    execFileSync("/bin/true", elements, { stdio: "ignore" });
    return null;
  } catch (err) {
    return err as NodeJS.ErrnoException;
  }
}

describe.skipIf(!onLinux)("#1944 real spawn against the kernel", () => {
  const plan = realisticPlan(129_000);

  for (const shape of DRIVER_SHAPES) {
    test(`REPRODUCES the bug today: ${shape.name}`, () => {
      // This is the assertion that fails on a fixed branch only if the fix were to change what the
      // UNCLAMPED prompt looks like. It documents the defect: on `main` this is what every plan
      // gate and review spawn did with a 129 KB plan, ten times per session.
      const err = realSpawn(shape.elements(promptFor(plan)));
      expect(err?.code).toBe("E2BIG");

      // ...and the raw error names neither the cause nor the cure, which is why #1944 read as an
      // unexplained flake. `oversizedFromArgv` is what makes it legible.
      expect(String(err)).not.toContain("argument limit");
      expect(oversizedFromArgv(err, shape.elements(promptFor(plan)))).toBeInstanceOf(
        OversizedArgvError,
      );
    });

    test(`SUCCEEDS after the ladder: ${shape.name}`, () => {
      const fitted = fitAssembledPrompt({
        ...spawnBudget((p) => ({ wrapped: argvFor(p) })),
        specs: [
          {
            id: "plan",
            kind: "text",
            text: plan,
            mode: "head-tail",
            minUseful: planUsefulFloor(Buffer.byteLength(plan, "utf8")),
          },
        ],
        compose: (v) => promptFor(v.plan as string),
      });
      expect(fitted.ok).toBe(true);
      if (!fitted.ok) return;

      // The kernel accepts it — the whole point.
      expect(realSpawn(shape.elements(fitted.prompt))).toBeNull();

      // And it is still a reviewable plan, not a stub: both ends survive.
      expect(fitted.prompt).toContain("# Plan — fix the thing");
      expect(fitted.prompt).toContain("## Out of scope");
      expect(fitted.prompt).toContain("## Success criteria");
      expect(Buffer.byteLength(fitted.prompt, "utf8")).toBeGreaterThan(
        planUsefulFloor(Buffer.byteLength(plan, "utf8")),
      );
    });
  }

  test("the budget is calibrated against the kernel, not merely against itself", () => {
    // The kernel compares MAX_ARG_STRLEN against the string INCLUDING its NUL terminator, so an
    // element of exactly `limit` bytes already fails — which is precisely why the ladder targets
    // `limit - 1`. This walks that boundary against the real kernel rather than trusting the
    // arithmetic: one byte of drift in the unsafe direction and this test goes red.
    const limit = hostArgvElementLimit();
    expect(hostArgvBudget()).toBe(limit - 1);
    expect(realSpawn(["x".repeat(hostArgvBudget())])).toBeNull();
    expect(realSpawn(["x".repeat(limit)])?.code).toBe("E2BIG");
  });

  test("a plan just UNDER the budget is spawned byte-identically — no clamp, no marker", () => {
    // The fix must be inert below the threshold; this is the regression guard for that.
    const small = realisticPlan(4_000);
    const before = argvFor(promptFor(small));
    const fitted = fitAssembledPrompt({
      ...spawnBudget((p) => ({ wrapped: argvFor(p) })),
      specs: [{ id: "plan", kind: "text", text: small, mode: "head-tail" }],
      compose: (v) => promptFor(v.plan as string),
    });
    expect(fitted.ok).toBe(true);
    if (!fitted.ok) return;

    expect(fitted.clamps).toEqual([]);
    expect(argvFor(fitted.prompt)).toEqual(before);
    expect(fitted.prompt).not.toContain("bytes elided");
    for (const shape of DRIVER_SHAPES) expect(realSpawn(shape.elements(fitted.prompt))).toBeNull();
  });

  test("spawnFootprintBytes predicts the kernel's verdict exactly at the boundary", () => {
    // The joined-line shape is the one the budget prices, so its footprint is what the ladder
    // compares against MAX_ARG_STRLEN. Build a prompt whose joined line lands exactly on the limit
    // and confirm both our measurement and the kernel agree.
    const limit = hostArgvElementLimit();
    const probe = spawnBudget((p) => ({ wrapped: argvFor(p) }));
    let prompt = "y".repeat(limit);
    // Shrink to the largest prompt whose joined line lands exactly on the budget.
    while (probe.measure(prompt) > hostArgvBudget()) prompt = prompt.slice(0, -1);

    const line = posixShellJoin(buildWrappedArgv(argvFor(prompt)));
    expect(Buffer.byteLength(line, "utf8")).toBe(probe.measure(prompt));
    expect(realSpawn([line])).toBeNull();
    expect(realSpawn([`${line}z`])?.code).toBe("E2BIG");
  });

  test("clampBlock output survives a real exec at the ceiling", () => {
    // Guards the UTF-8 boundary logic against the kernel: a clamp that split a character would
    // still exec, but a clamp that overshot the budget would not.
    const unicodePlan = "🐑 plan\n".repeat(30_000);
    const clamped = clampBlock(unicodePlan, 40_000, "head-tail");
    expect(clamped).not.toContain("�");
    expect(realSpawn([posixShellJoin(buildWrappedArgv(argvFor(promptFor(clamped))))])).toBeNull();
  });
});

describe.skipIf(onLinux)("#1944 off Linux", () => {
  test("nothing is clamped — there is no per-element cap to clamp for", () => {
    const plan = realisticPlan(200_000);
    const fitted = fitAssembledPrompt({
      ...spawnBudget((p) => ({ wrapped: argvFor(p) })),
      specs: [{ id: "plan", kind: "text", text: plan, mode: "head-tail" }],
      compose: (v) => promptFor(v.plan as string),
    });
    expect(fitted.ok).toBe(true);
    if (!fitted.ok) return;
    expect(fitted.clamps).toEqual([]);
    expect(fitted.prompt).toBe(promptFor(plan));
    expect(spawnFootprintBytes(argvFor(fitted.prompt))).toBeGreaterThan(131_072);
  });
});
