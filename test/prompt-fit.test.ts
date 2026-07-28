import { test, expect, describe } from "bun:test";
import {
  MIN_CLAMP_KEEP,
  PLAN_MIN_USEFUL_BYTES,
  clampBlock,
  clampList,
  describeClamps,
  elisionMarker,
  fitAssembledPrompt,
  headBytes,
  planUsefulFloor,
  tailBytes,
  type ClampSpec,
} from "../src/prompt-fit";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** A plan shaped like the real schema: the sections the reviewer is told to check for live in the
 *  BACK half, which is precisely why tail-truncation was the wrong policy. */
function makePlan(totalBytes: number): string {
  const head = "# Goal\n\nStop the failure with a terminal guarantee.\n\n## Approach\n\n";
  const tail =
    "\n## Out of scope\n\n- document spill\n\n## Testing seams\n\n- the real-spawn seam\n\n" +
    "## Risks\n\n- a clamped plan is partial\n\n## Success criteria\n\n1. gates green\n";
  const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n";
  const need = Math.max(0, totalBytes - bytes(head) - bytes(tail));
  return head + filler.repeat(Math.ceil(need / bytes(filler))).slice(0, need) + tail;
}

describe("byte-safe slicing", () => {
  test("never splits a multi-byte character", () => {
    const s = "🐑".repeat(10); // 4 bytes each
    for (let n = 0; n <= 40; n++) {
      const h = headBytes(s, n);
      const t = tailBytes(s, n);
      expect(h).not.toContain("�");
      expect(t).not.toContain("�");
      expect(bytes(h)).toBeLessThanOrEqual(n);
      expect(bytes(t)).toBeLessThanOrEqual(n);
    }
  });

  test("returns the whole string when the budget covers it", () => {
    expect(headBytes("abc", 99)).toBe("abc");
    expect(tailBytes("abc", 99)).toBe("abc");
  });

  test("head takes the front, tail takes the back", () => {
    expect(headBytes("abcdef", 3)).toBe("abc");
    expect(tailBytes("abcdef", 3)).toBe("def");
  });
});

describe("clampBlock", () => {
  test("head-tail retains BOTH the opening sections and the tail sections", () => {
    // The whole point of finding 1: `planReviewPrompt` orders the reviewer to flag a missing
    // `Out of Scope` boundary or missing testing seams as BLOCKING. Tail-truncation deletes exactly
    // those, so the reviewer invents findings about material it never saw, the agent "fixes" them
    // by ADDING the sections, and the next clamp cuts deeper.
    const plan = makePlan(129_000);
    const out = clampBlock(plan, 20_000, "head-tail");

    expect(out).toContain("# Goal");
    expect(out).toContain("## Out of scope");
    expect(out).toContain("## Testing seams");
    expect(out).toContain("## Success criteria");
    expect(bytes(out)).toBeLessThan(bytes(plan));
  });

  test("the marker sits BETWEEN the two slices", () => {
    const plan = makePlan(50_000);
    const out = clampBlock(plan, 10_000, "head-tail");
    const marker = out.match(/\[… \d+ bytes elided …\]/)?.[0];
    expect(marker).toBeTruthy();
    const i = out.indexOf(marker!);
    expect(out.slice(0, i)).toContain("# Goal");
    expect(out.slice(i)).toContain("## Success criteria");
  });

  test("head-only mode keeps the front and appends the marker", () => {
    const out = clampBlock(makePlan(50_000), 5_000, "head");
    expect(out).toContain("# Goal");
    expect(out).not.toContain("## Success criteria");
    expect(out.trimEnd().endsWith("…]")).toBe(true);
  });

  test("PER-SLICE floor: head-tail degrades to head-only below 2 × MIN_CLAMP_KEEP", () => {
    const plan = makePlan(50_000);
    const out = clampBlock(plan, 2 * MIN_CLAMP_KEEP - 1, "head-tail");
    // One marker, at the end — not a two-slice split with sub-floor stubs.
    expect(out.match(/bytes elided/g)).toHaveLength(1);
    expect(out.trimEnd().endsWith("…]")).toBe(true);

    const split = clampBlock(plan, 2 * MIN_CLAMP_KEEP, "head-tail");
    expect(split.trimEnd().endsWith("…]")).toBe(false); // tail slice follows the marker
  });

  test("the marker names the real number of bytes removed", () => {
    const plan = makePlan(10_000);
    const out = clampBlock(plan, 4_000, "head-tail");
    const n = Number(out.match(/\[… (\d+) bytes elided …\]/)![1]);
    expect(n).toBe(bytes(plan) - 4_000);
  });

  test("a keep at or above the original returns the text UNTOUCHED (no marker)", () => {
    const plan = makePlan(1_000);
    expect(clampBlock(plan, bytes(plan), "head-tail")).toBe(plan);
    expect(clampBlock(plan, 99_999, "head")).toBe(plan);
  });

  test("closes a fence the head slice left open", () => {
    const text = "intro\n\n```ts\n" + "const x = 1;\n".repeat(500) + "```\n\ndone\n";
    const out = clampBlock(text, 300, "head");
    const fences = out.split("\n").filter((l) => l.trimStart().startsWith("```")).length;
    expect(fences % 2).toBe(0);
  });

  test("opens a fence the tail slice starts inside of", () => {
    const text = "intro\n\n```ts\n" + "const x = 1;\n".repeat(500) + "```\n\ndone\n";
    const out = clampBlock(text, 2 * MIN_CLAMP_KEEP + 200, "head-tail");
    const fences = out.split("\n").filter((l) => l.trimStart().startsWith("```")).length;
    expect(fences % 2).toBe(0);
  });

  test("never emits a replacement character on a multi-byte boundary", () => {
    const text = "🐑".repeat(20_000);
    for (const keep of [1_000, 1_001, 1_002, 1_003, 2 * MIN_CLAMP_KEEP + 1]) {
      expect(clampBlock(text, keep, "head-tail")).not.toContain("�");
    }
  });
});

describe("clampList", () => {
  test("drops WHOLE tail entries and names how many went", () => {
    const items = Array.from({ length: 50 }, (_, i) => `src/file-${i}.ts`);
    const out = clampList(items, 10, "files");
    expect(out).toHaveLength(11);
    expect(out.slice(0, 10)).toEqual(items.slice(0, 10));
    expect(out[10]).toBe("[… 40 further files omitted …]");
  });

  test("never emits a partial entry", () => {
    const items = ["aaaa", "bbbb", "cccc"];
    for (const keep of [0, 1, 2]) {
      for (const entry of clampList(items, keep).slice(0, keep)) {
        expect(items).toContain(entry);
      }
    }
  });

  test("a keep at or above the length returns the list untouched", () => {
    const items = ["a", "b"];
    expect(clampList(items, 2)).toBe(items);
    expect(clampList(items, 9)).toBe(items);
  });
});

describe("planUsefulFloor", () => {
  test("is the greater of the absolute floor and a quarter of the plan", () => {
    expect(planUsefulFloor(1_000)).toBe(PLAN_MIN_USEFUL_BYTES);
    expect(planUsefulFloor(129_000)).toBe(32_250);
  });
});

// ── the ladder ────────────────────────────────────────────────────────────────

/** Measure a prompt the way the real sites do — in joined-argv bytes, which quoting inflates. */
const measure = (p: string) => bytes(p) + 2;

function fit(over: Partial<Parameters<typeof fitAssembledPrompt>[0]> & { budget: number }) {
  return fitAssembledPrompt({
    specs: [],
    compose: (v) => String(v.plan ?? ""),
    measure,
    ...over,
  });
}

describe("fitAssembledPrompt", () => {
  test("UNDER budget: byte-identical prompt, ZERO clamps", () => {
    const plan = makePlan(1_000);
    const r = fit({
      budget: 1_000_000,
      specs: [{ id: "plan", kind: "text", text: plan, mode: "head-tail" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prompt).toBe(plan);
    expect(r.clamps).toEqual([]);
  });

  test("AT budget: still unclamped (the budget is inclusive)", () => {
    const plan = makePlan(2_000);
    const r = fit({
      budget: measure(plan),
      specs: [{ id: "plan", kind: "text", text: plan, mode: "head-tail" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clamps).toEqual([]);
  });

  test("ONE byte over: clamps, and the postcondition holds", () => {
    const plan = makePlan(60_000);
    const budget = measure(plan) - 1;
    const r = fit({ budget, specs: [{ id: "plan", kind: "text", text: plan, mode: "head-tail" }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(measure(r.prompt)).toBeLessThanOrEqual(budget);
    expect(r.clamps).toHaveLength(1);
    expect(r.clamps[0]!.id).toBe("plan");
    expect(r.clamps[0]!.toBytes).toBeLessThan(r.clamps[0]!.fromBytes);
  });

  test("MARKER-NET: a clamp NEVER increases the measured prompt", () => {
    // The footgun a naive `shrink by min(overage, absorbable)` walks into: for a small overage the
    // inserted marker can cost more than the bytes it replaces.
    const plan = makePlan(60_000);
    const before = measure(plan);
    for (let over = 1; over <= 60; over += 7) {
      const r = fit({
        budget: before - over,
        specs: [{ id: "plan", kind: "text", text: plan, mode: "head-tail" }],
      });
      if (r.ok) expect(measure(r.prompt)).toBeLessThanOrEqual(before);
    }
  });

  test("MARKER-NET: a block whose slack is under its own marker is SKIPPED, not grown", () => {
    // Retained budget is pinned to the floor, so the only possible clamp costs more than it saves.
    const tiny = "x".repeat(MIN_CLAMP_KEEP + 4);
    const before = measure(tiny);
    const r = fit({
      budget: before - 1,
      specs: [{ id: "plan", kind: "text", text: tiny, mode: "head" }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Refused rather than shipped LARGER, and the reason is size, not unreviewability.
    expect(r.reason).toBe("over-budget");
    expect(r.measured).toBeLessThanOrEqual(before);
  });

  test("clamps in the caller's fixed order and stops as soon as it fits", () => {
    const a = makePlan(40_000);
    const b = makePlan(40_000);
    const compose = (v: Record<string, unknown>) => `${v.first}\n${v.second}`;
    const specs: ClampSpec[] = [
      { id: "first", kind: "text", text: a, mode: "head" },
      { id: "second", kind: "text", text: b, mode: "head" },
    ];
    const r = fitAssembledPrompt({
      budget: measure(compose({ first: a, second: b })) - 5_000,
      specs,
      compose,
      measure,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clamps.map((c) => c.id)).toEqual(["first"]); // second never touched
  });

  test("USEFULNESS FLOOR: refuses rather than reviewing a gutted plan", () => {
    const plan = makePlan(129_000);
    const floor = planUsefulFloor(bytes(plan));
    // A budget that only a sub-floor plan could satisfy.
    const r = fit({
      budget: floor / 2,
      specs: [{ id: "plan", kind: "text", text: plan, mode: "head-tail", minUseful: floor }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("plan-unreviewable");
    expect(r.detail).toContain("plan");
  });

  test("THE FLOOR IS LOAD-BEARING: without it, the same shape ships a gutted plan", () => {
    // This is the defect finding 1 named. MIN_CLAMP_KEEP alone only guarantees TERMINATION, so the
    // plan is ground to a few hundred bytes and the review runs anyway, writing a confident verdict
    // on a stub. The assertion below is what we must NOT ship.
    const plan = makePlan(129_000);
    const budget = planUsefulFloor(bytes(plan)) / 2;

    const unfloored = fit({
      budget,
      specs: [{ id: "plan", kind: "text", text: plan, mode: "head-tail" }],
    });
    expect(unfloored.ok).toBe(true);
    if (!unfloored.ok) return;
    expect(unfloored.clamps[0]!.toBytes).toBeLessThan(planUsefulFloor(bytes(plan)));

    // Squeeze harder and MIN_CLAMP_KEEP is all that is left standing — a 256-byte "plan".
    const starved = fit({
      budget: 600,
      specs: [{ id: "plan", kind: "text", text: plan, mode: "head-tail" }],
    });
    expect(starved.ok).toBe(true);
    if (!starved.ok) return;
    expect(starved.clamps[0]!.toBytes).toBeLessThan(PLAN_MIN_USEFUL_BYTES);

    // With the floor wired — which is how every real call site configures it — it refuses instead.
    const floored = fit({
      budget,
      specs: [
        {
          id: "plan",
          kind: "text",
          text: plan,
          mode: "head-tail",
          minUseful: planUsefulFloor(bytes(plan)),
        },
      ],
    });
    expect(floored.ok).toBe(false);
    if (floored.ok) return;
    expect(floored.reason).toBe("plan-unreviewable");
  });

  test("a plan that fits ABOVE its usefulness floor is clamped, not refused", () => {
    const plan = makePlan(129_000);
    const floor = planUsefulFloor(bytes(plan));
    const r = fit({
      budget: measure(plan) - 10_000,
      specs: [{ id: "plan", kind: "text", text: plan, mode: "head-tail", minUseful: floor }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clamps[0]!.toBytes).toBeGreaterThanOrEqual(floor);
    // ...and it still carries both ends.
    expect(r.prompt).toContain("# Goal");
    expect(r.prompt).toContain("## Success criteria");
  });

  test("a list spec drops whole entries and reports the count", () => {
    const files = Array.from({ length: 4_000 }, (_, i) => `src/very/long/path/file-${i}.ts`);
    const compose = (v: Record<string, unknown>) => (v.files as string[]).join("\n");
    const r = fitAssembledPrompt({
      budget: 5_000,
      specs: [{ id: "files", kind: "list", items: files, noun: "files" }],
      compose,
      measure,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prompt).toMatch(/\[… \d+ further files omitted …\]/);
    expect(r.clamps[0]!.droppedItems).toBeGreaterThan(0);
    expect(measure(r.prompt)).toBeLessThanOrEqual(5_000);
  });

  test("terminates on a pathological budget of zero", () => {
    const r = fit({
      budget: 0,
      specs: [{ id: "plan", kind: "text", text: makePlan(50_000), mode: "head-tail" }],
    });
    expect(r.ok).toBe(false);
  });

  test("no specs at all → straight refusal, no infinite loop", () => {
    const r = fit({ budget: 10, specs: [], compose: () => "x".repeat(500) });
    expect(r.ok).toBe(false);
  });

  test("describeClamps names each block and its byte counts", () => {
    expect(describeClamps([{ id: "plan", fromBytes: 129_000, toBytes: 40_000 }])).toBe(
      "plan (129000→40000 bytes)",
    );
    expect(
      describeClamps([{ id: "files", fromBytes: 900, toBytes: 100, droppedItems: 12 }]),
    ).toContain("−12 entries");
  });

  test("elisionMarker is a FACT, not an instruction (finding 3)", () => {
    const m = elisionMarker(1234).toLowerCase();
    for (const imperative of ["do not", "don't", "must", "ignore", "report", "treat"]) {
      expect(m).not.toContain(imperative);
    }
    expect(m).toContain("1234");
  });
});
