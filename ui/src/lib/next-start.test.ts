import { describe, expect, it } from "vitest";
import { nextStart, type NextStartGlobals, type NextStartRepo } from "./next-start";

const globals: NextStartGlobals = {
  defaultAgentProvider: "claude",
  defaultModel: "opus",
  defaultCodexModel: "default",
  defaultEffort: "high",
  defaultClaudeEffort: "inherit",
  defaultCodexEffort: "inherit",
  defaultExecutionEffort: "default",
};
const inherit: NextStartRepo = {
  agentProvider: "inherit",
  defaultModel: "inherit",
  defaultEffort: "inherit",
  defaultExecutionEffort: "inherit",
};

describe("nextStart", () => {
  it("follows every global default when the repo inherits", () => {
    expect(nextStart(inherit, globals)).toEqual({
      cli: "claude",
      cliFrom: "global",
      model: "opus",
      modelFrom: "global",
      effort: "high",
      effortFrom: "global",
      goEffort: null,
      goFrom: "global",
    });
  });

  it("takes the repo's own CLI, model and effort", () => {
    const r = nextStart(
      {
        agentProvider: "codex",
        defaultModel: "default",
        defaultEffort: "ultra",
        defaultExecutionEffort: "inherit",
      },
      globals,
    );
    expect(r).toMatchObject({
      cli: "codex",
      cliFrom: "repo",
      model: "default",
      modelFrom: "repo",
      effort: "ultra",
      effortFrom: "repo",
    });
  });

  it("drops a repo model or effort the CLI cannot run back to the global one", () => {
    const r = nextStart(
      {
        agentProvider: "claude",
        defaultModel: "gpt-6-sol",
        defaultEffort: "ultra",
        defaultExecutionEffort: "inherit",
      },
      globals,
    );
    expect(r).toMatchObject({
      model: "opus",
      modelFrom: "global",
      effort: "high",
      effortFrom: "global",
    });
  });

  it("uses the engine's own default effort before the global one", () => {
    const r = nextStart(
      { ...inherit, agentProvider: "codex" },
      { ...globals, defaultCodexEffort: "low" },
    );
    expect(r).toMatchObject({
      cli: "codex",
      model: "default",
      effort: "low",
      effortFrom: "global",
    });
  });

  it("names the switch at Go from the repo, else from the global setting", () => {
    expect(nextStart({ ...inherit, defaultExecutionEffort: "max" }, globals)).toMatchObject({
      goEffort: "max",
      goFrom: "repo",
    });
    expect(nextStart(inherit, { ...globals, defaultExecutionEffort: "xhigh" })).toMatchObject({
      goEffort: "xhigh",
      goFrom: "global",
    });
    // "default" = same as planning: no switch, even when set on the repo
    expect(
      nextStart(
        { ...inherit, defaultExecutionEffort: "default" },
        { ...globals, defaultExecutionEffort: "max" },
      ),
    ).toMatchObject({ goEffort: null, goFrom: "repo" });
  });

  it("falls back to Claude when the server names no global CLI", () => {
    expect(nextStart(inherit, { ...globals, defaultAgentProvider: undefined }).cli).toBe("claude");
  });
});
