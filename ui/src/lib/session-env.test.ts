import { describe, expect, test } from "vitest";
import { modelsMixed, providersMixed, sessionEnvironment } from "./session-env";
import { runtimeModelLabel } from "./model-label";
import { m } from "$lib/paraglide/messages";
import type { Session, SessionActivity } from "./types";

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
    expect(env.modelObserved).toBe(true);
    expect(env.effortObserved).toBe(true);
  });

  test("the persisted identity wins over the configured one", () => {
    const env = sessionEnvironment({
      model: "opus",
      effort: "low",
      runtimeModel: "gpt-6-astra",
      runtimeEffort: "high",
    });
    expect(env.segments).toEqual(["GPT-6 Astra", "High"]);
    expect(env.modelObserved).toBe(true);
    expect(env.effortObserved).toBe(true);
  });

  test("the configured values stand when nothing was observed", () => {
    const env = sessionEnvironment({
      model: "claude-opus-5",
      effort: "high",
      runtimeModel: null,
      runtimeEffort: null,
    });
    expect(env.segments).toEqual(["Opus 5", "High"]);
    expect(env.modelObserved).toBe(false);
    expect(env.effortObserved).toBe(false);
  });

  test("precedence is per field: an observed model pairs with a configured effort", () => {
    const env = sessionEnvironment({
      model: "opus",
      effort: "max",
      runtimeModel: "claude-opus-5",
      runtimeEffort: null,
    });
    expect(env.segments).toEqual(["Opus 5", "Max"]);
    expect(env.modelObserved).toBe(true);
    expect(env.effortObserved).toBe(false);
  });
});

describe("never two identical default labels", () => {
  test("a wholly unknown environment prints ONE default segment, not two", () => {
    const env = sessionEnvironment(empty);
    expect(env.segments).toHaveLength(1);
    expect(env.effort).toBeNull();
    expect(env.modelObserved).toBe(false);
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

// The finding that prompted this shape: one flag for both fields let the tooltip claim the runtime
// log named an effort it never mentions. Claude transcripts report a model and NOTHING else, so
// "observed model + configured effort" is the ordinary case, not an edge one.
describe("tooltip provenance is per segment", () => {
  test("a mixed identity does not claim the configured effort was observed", () => {
    const env = sessionEnvironment({
      model: null,
      effort: "high",
      runtimeModel: "claude-opus-5",
      runtimeEffort: null,
    });
    expect(env.modelObserved).toBe(true);
    expect(env.effortObserved).toBe(false);
    expect(env.tooltip).toBe(
      `${m.session_env_model_observed({ model: "Opus 5" })} ${m.session_env_effort_configured({ effort: "High" })}`,
    );
  });

  test("a fully observed identity says so for both segments", () => {
    const env = sessionEnvironment({
      model: null,
      effort: null,
      runtimeModel: "gpt-6-astra",
      runtimeEffort: "high",
    });
    expect(env.tooltip).toBe(
      `${m.session_env_model_observed({ model: "GPT-6 Astra" })} ${m.session_env_effort_observed({ effort: "High" })}`,
    );
  });

  test("an unknown effort renders no segment and makes no claim about one", () => {
    const env = sessionEnvironment(empty);
    // Exact equality is the assertion: the whole tooltip IS the model sentence, so there is no
    // effort claim anywhere in it.
    expect(env.tooltip).toBe(m.session_env_model_configured({ model: m.newtask_model_default() }));
  });

  test("every reachable input describes each rendered segment exactly once", () => {
    const models = [null, "opus", "gpt-6-astra"];
    const efforts = [null, "high", "ultra"];
    for (const model of models)
      for (const effort of efforts)
        for (const runtimeModel of models)
          for (const runtimeEffort of efforts) {
            const env = sessionEnvironment({ model, effort, runtimeModel, runtimeEffort });
            // One sentence per segment: the tooltip must never describe an absent effort, and never
            // omit a rendered one.
            const claimsEffort =
              env.tooltip.includes(m.session_env_effort_observed({ effort: env.effort ?? "x" })) ||
              env.tooltip.includes(m.session_env_effort_configured({ effort: env.effort ?? "x" }));
            expect(claimsEffort).toBe(env.effort !== null);
          }
  });
});

// The rail prints each row's model only when the rows actually differ; `modelsMixed` is that
// decision. Both rules it encodes are load-bearing and easy to "simplify" wrongly, so each gets a
// test naming what would break.
describe("modelsMixed", () => {
  type EnvFields = Pick<Session, "model" | "effort" | "runtimeModel" | "runtimeEffort">;
  const row = (id: string, fields: Partial<EnvFields>) => ({ id, ...empty, ...fields });

  test("one model down the whole list is not a mix", () => {
    expect(
      modelsMixed(
        [row("a", { runtimeModel: "claude-opus-5" }), row("b", { runtimeModel: "claude-opus-5" })],
        {},
      ),
    ).toBe(false);
  });

  test("two different models are", () => {
    expect(
      modelsMixed(
        [row("a", { runtimeModel: "claude-opus-5" }), row("b", { runtimeModel: "gpt-6-astra" })],
        {},
      ),
    ).toBe(true);
  });

  test("an unknown model is not a second model", () => {
    // The rule that makes the feature work: unknowns render the localized "default", which says
    // only that we never learned what ran. Counting it would call nearly every list mixed and
    // leave the label permanently on — exactly what this gate exists to stop.
    expect(modelsMixed([row("a", { runtimeModel: "claude-opus-5" }), row("b", {})], {})).toBe(
      false,
    );
  });

  test("a list that knows nothing is not a mix", () => {
    expect(modelsMixed([row("a", {}), row("b", {})], {})).toBe(false);
  });

  test("an empty list is not a mix", () => {
    expect(modelsMixed([], {})).toBe(false);
  });

  test("the live activity signal decides, same as the rendered row", () => {
    // Both sessions are CONFIGURED alike; only the observed models differ. Comparing the configured
    // field instead of the resolved label would miss this and hide a genuine mix.
    expect(
      modelsMixed([row("a", { model: "opus" }), row("b", { model: "opus" })], {
        a: signal({ runtimeModel: "claude-opus-5" }),
        b: signal({ runtimeModel: "gpt-6-astra" }),
      }),
    ).toBe(true);
  });

  test("the same model reached by different routes is one model", () => {
    // Observed on one row, configured (pinned) on the other: same label, so no mix.
    expect(
      modelsMixed(
        [row("a", { runtimeModel: "claude-opus-5" }), row("b", { model: "claude-opus-5" })],
        {},
      ),
    ).toBe(false);
  });

  test("a floating alias beside its resolved name counts as a mix", () => {
    // Stated assumption, pinned: `opus` and `Opus 5` look like two models on screen, and the client
    // cannot know which concrete model the alias resolved to. Folding them together is a guess.
    expect(
      modelsMixed([row("a", { model: "opus" }), row("b", { runtimeModel: "claude-opus-5" })], {}),
    ).toBe(true);
  });
});

// The CLI chip gets the same treatment as the model segment, with one difference worth pinning: a
// provider is never unknown, so there is no skip rule — only a default that has to agree with the
// badge's own.
describe("providersMixed", () => {
  test("one CLI across the rail is not a mix", () => {
    expect(providersMixed([{ agentProvider: "claude" }, { agentProvider: "claude" }])).toBe(false);
  });

  test("two CLIs are", () => {
    expect(providersMixed([{ agentProvider: "claude" }, { agentProvider: "codex" }])).toBe(true);
  });

  test("a pre-field row counts as Claude, not as a second CLI", () => {
    // CliBadge renders a null provider as Claude. Counting it as its own value here would light the
    // chips up across an all-Claude herd — exactly the noise this gate removes.
    expect(providersMixed([{ agentProvider: "claude" }, { agentProvider: undefined }])).toBe(false);
    expect(providersMixed([{ agentProvider: undefined }, { agentProvider: "codex" }])).toBe(true);
  });

  test("an empty list is not a mix", () => {
    expect(providersMixed([])).toBe(false);
  });
});
