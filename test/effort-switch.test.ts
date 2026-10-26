import { describe, expect, test } from "bun:test";
import {
  countMatches,
  effortSwitchSteps,
  inForceEffort,
  effortForProvider,
  phaseEffort,
} from "../src/effort-switch";
import { createKeyedSerializer } from "../src/herdr";

describe("effortSwitchSteps", () => {
  test("claude: opens the picker, clamps left, walks right, applies session-only", () => {
    const steps = effortSwitchSteps("claude", "high")!;
    expect(steps.map((s) => [s.kind, s.text])).toEqual([
      ["paste", "/effort"],
      ["keys", "\x1b[D".repeat(5) + "\x1b[C".repeat(2) + "s"],
    ]);
    expect(
      steps[0]!.confirm.test("  ←/→ to adjust · Enter to confirm · s for this session only"),
    ).toBe(true);
    const done = "Set effort level to high (this session only): Comprehensive";
    expect(countMatches(done, steps[1]!.confirm)).toBe(1);
    expect(countMatches("Set effort level to xhigh (this session only)", steps[1]!.confirm)).toBe(
      0,
    );
    // the persistent typed form is never a confirmation
    expect(countMatches("Set effort level to high (saved as your default", steps[1]!.confirm)).toBe(
      0,
    );
  });

  test("claude: low needs no right steps; max is the last picker level", () => {
    expect(effortSwitchSteps("claude", "low")![1]!.text).toBe("\x1b[D".repeat(5) + "s");
    expect(effortSwitchSteps("claude", "max")![1]!.text).toBe(
      "\x1b[D".repeat(5) + "\x1b[C".repeat(4) + "s",
    );
  });

  test("claude: ultra and unknown tiers are unreachable", () => {
    expect(effortSwitchSteps("claude", "ultra")).toBeNull();
    expect(effortSwitchSteps("claude", "bogus")).toBeNull();
  });

  test("codex: one /model --reasoning paste confirmed by the session-only line", () => {
    const steps = effortSwitchSteps("codex", "medium")!;
    expect(steps.map((s) => [s.kind, s.text])).toEqual([["paste", "/model --reasoning=medium"]]);
    const line = "• Model changed to gpt-6.1-sol medium for this session only";
    expect(countMatches(line, steps[0]!.confirm)).toBe(1);
    expect(countMatches(line.replace("medium", "xhigh"), steps[0]!.confirm)).toBe(0);
  });

  test("countMatches counts every occurrence (baseline vs. after)", () => {
    const re = effortSwitchSteps("codex", "low")![0]!.confirm;
    const line = "Model changed to m low for this session only";
    expect(countMatches(`${line}\n${line}`, re)).toBe(2);
    expect(countMatches("", re)).toBe(0);
  });
});

describe("phaseEffort / inForceEffort / effortForProvider", () => {
  test("phaseEffort picks execution only while executing with one set", () => {
    expect(phaseEffort({ planPhase: "planning", effort: "xhigh", executionEffort: "medium" })).toBe(
      "xhigh",
    );
    expect(
      phaseEffort({ planPhase: "executing", effort: "xhigh", executionEffort: "medium" }),
    ).toBe("medium");
    expect(phaseEffort({ planPhase: "executing", effort: "xhigh", executionEffort: null })).toBe(
      "xhigh",
    );
    expect(phaseEffort({ planPhase: null, effort: null, executionEffort: "low" })).toBeNull();
  });

  test("inForceEffort falls back to effort only when activeEffort is absent", () => {
    expect(inForceEffort({ effort: "high", activeEffort: "low" })).toBe("low");
    expect(inForceEffort({ effort: "high", activeEffort: null })).toBeNull();
    expect(inForceEffort({ effort: "high" })).toBe("high");
  });

  test("effortForProvider clamps to the provider's tiers", () => {
    expect(effortForProvider("claude", "medium")).toBe("medium");
    expect(effortForProvider("claude", "ultra")).toBeNull();
    expect(effortForProvider("codex", "ultra")).toBe("ultra");
    expect(effortForProvider("claude", "default")).toBeNull();
    expect(effortForProvider("claude", 3)).toBeNull();
  });
});

describe("createKeyedSerializer", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("same key is FIFO; another key is not blocked; entries drain", async () => {
    const serialize = createKeyedSerializer();
    const order: string[] = [];
    let releaseA!: () => void;
    const a1 = serialize("a", async () => {
      await new Promise<void>((r) => (releaseA = r));
      order.push("a1");
    });
    const a2 = serialize("a", async () => {
      order.push("a2");
    });
    const b1 = serialize("b", async () => {
      order.push("b1");
    });
    await b1;
    expect(order).toEqual(["b1"]); // b ran while a1 was still held
    releaseA();
    await Promise.all([a1, a2]);
    expect(order).toEqual(["b1", "a1", "a2"]);
    await tick();
    expect(serialize.inFlightKeys()).toBe(0);
  });

  test("a rejected call does not wedge its key", async () => {
    const serialize = createKeyedSerializer();
    await expect(serialize("k", () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await serialize("k", async () => 1)).toBe(1);
  });
});
