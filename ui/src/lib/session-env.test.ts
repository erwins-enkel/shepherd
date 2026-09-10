import { describe, expect, test } from "vitest";
import { sessionEnvironment } from "./session-env";
import { runtimeModelLabel } from "./model-label";
import type { SessionActivity } from "./types";

const empty = { model: null, effort: null, runtimeModel: null, runtimeEffort: null };

function signal(identity: Partial<SessionActivity>): SessionActivity {
  return { lastActivityTs: 1, summary: null, recentTs: [], recentErrTs: [], ...identity };
}

describe("precedence: observed → configured → default", () => {
  test("the live activity signal wins over everything", () => {
    const env = sessionEnvironment(
      { model: "opus", effort: "low", runtimeModel: "gpt-5.6-sol", runtimeEffort: "medium" },
      signal({ runtimeModel: "gpt-6-astra", runtimeEffort: "high" }),
    );
    expect(env.segments).toEqual(["GPT-6 Astra", "High"]);
    expect(env.observed).toBe(true);
  });

  test("the persisted identity wins over the configured one", () => {
    const env = sessionEnvironment({
      model: "opus",
      effort: "low",
      runtimeModel: "gpt-6-astra",
      runtimeEffort: "high",
    });
    expect(env.segments).toEqual(["GPT-6 Astra", "High"]);
    expect(env.observed).toBe(true);
  });

  test("the configured values stand when nothing was observed", () => {
    const env = sessionEnvironment({
      model: "claude-opus-5",
      effort: "high",
      runtimeModel: null,
      runtimeEffort: null,
    });
    expect(env.segments).toEqual(["Opus 5", "High"]);
    expect(env.observed).toBe(false);
  });

  test("precedence is per field: an observed model pairs with a configured effort", () => {
    const env = sessionEnvironment({
      model: "opus",
      effort: "max",
      runtimeModel: "claude-opus-5",
      runtimeEffort: null,
    });
    expect(env.segments).toEqual(["Opus 5", "Max"]);
    expect(env.observed).toBe(true);
  });
});

describe("never two identical default labels", () => {
  test("a wholly unknown environment prints ONE default segment, not two", () => {
    const env = sessionEnvironment(empty);
    expect(env.segments).toHaveLength(1);
    expect(env.effort).toBeNull();
    expect(env.observed).toBe(false);
  });

  test("a known model with an unknown effort drops the effort segment", () => {
    const env = sessionEnvironment({ ...empty, runtimeModel: "gpt-6-astra" });
    expect(env.segments).toEqual(["GPT-6 Astra"]);
  });

  test("a known effort with an unknown model keeps both — they cannot collide", () => {
    const env = sessionEnvironment({ ...empty, runtimeEffort: "ultra" });
    expect(env.segments).toHaveLength(2);
    expect(env.segments[0]).not.toBe(env.segments[1]);
  });

  test("no reachable input ever yields two equal segments", () => {
    const models = [null, "opus", "gpt-6-astra"];
    const efforts = [null, "high", "ultra"];
    for (const model of models)
      for (const effort of efforts)
        for (const runtimeModel of models)
          for (const runtimeEffort of efforts) {
            const { segments } = sessionEnvironment({ model, effort, runtimeModel, runtimeEffort });
            if (segments.length === 2) expect(segments[0]).not.toBe(segments[1]);
          }
  });
});

describe("labeling follows the source", () => {
  // The Codex model behind the report that prompted this work. Pinning it here keeps the card's
  // headline case honest if runtimeModelLabel's regex is ever touched.
  test("a concrete Codex runtime id renders as a friendly name", () => {
    expect(runtimeModelLabel("gpt-6-astra")).toBe("GPT-6 Astra");
  });

  test("a configured alias keeps its record label, not the runtime one", () => {
    // "opus" is a FLOATING alias: it must render bare, never as a resolved model name, or an
    // archived session would claim it ran today's Opus.
    expect(sessionEnvironment({ ...empty, model: "opus" }).model).toBe("opus");
  });
});
