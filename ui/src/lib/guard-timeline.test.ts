import { describe, expect, it } from "vitest";
import {
  buildGuardTimeline,
  type GuardRepoConfig,
  type GuardStep,
  type GuardTimelineInput,
} from "./guard-timeline";

const REPO: GuardRepoConfig = {
  critic: true,
  autoAddress: true,
  autoMerge: true,
  draftMode: false,
};

function input(over: Partial<GuardTimelineInput> = {}): GuardTimelineInput {
  return {
    planGate: true,
    autopilot: false,
    provider: "claude",
    baseBranch: "main",
    repo: REPO,
    ...over,
  };
}

function step(over: Partial<GuardTimelineInput>, id: string): GuardStep {
  const found = buildGuardTimeline(input(over)).steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step "${id}" for ${JSON.stringify(over)}`);
  return found;
}

/** Every combination the derivation can be handed, for the invariants below. */
function allInputs(): GuardTimelineInput[] {
  const out: GuardTimelineInput[] = [];
  for (const planGate of [true, false])
    for (const autopilot of [true, false])
      for (const provider of ["claude", "codex"] as const)
        for (const baseBranch of ["main", "epic/42-thing"])
          for (const critic of [true, false])
            for (const autoAddress of [true, false])
              for (const autoMerge of [true, false])
                for (const draftMode of [true, false])
                  out.push({
                    planGate,
                    autopilot,
                    provider,
                    baseBranch,
                    repo: { critic, autoAddress, autoMerge, draftMode },
                  });
  return out;
}

describe("buildGuardTimeline — header", () => {
  it("names the combination, never promising a merge", () => {
    expect(buildGuardTimeline(input({ planGate: true, autopilot: false })).headerKey).toBe(
      "guardtl_head_plan_manual",
    );
    expect(buildGuardTimeline(input({ planGate: true, autopilot: true })).headerKey).toBe(
      "guardtl_head_plan_auto",
    );
    expect(buildGuardTimeline(input({ planGate: false, autopilot: false })).headerKey).toBe(
      "guardtl_head_nogate_manual",
    );
    expect(buildGuardTimeline(input({ planGate: false, autopilot: true })).headerKey).toBe(
      "guardtl_head_nogate_auto",
    );
  });
});

describe("buildGuardTimeline — planning phase", () => {
  it("drops the three planning steps when the gate is off", () => {
    const ids = buildGuardTimeline(input({ planGate: false })).steps.map((s) => s.id);
    expect(ids).toEqual(["to-pr", "critic", "merge"]);
  });

  // The point of the whole feature: composeSystemPrompt() picks the interactive plan-gate
  // directive off input.auto, not autopilot, so a dialog-spawned task always grills you.
  it("grills the operator in BOTH autopilot states", () => {
    expect(step({ autopilot: false }, "grill").kind).toBe("human");
    expect(step({ autopilot: true }, "grill").kind).toBe("human");
  });

  it("keeps the plan review conditional — it escalates at the round cap", () => {
    expect(step({ autopilot: false }, "review").kind).toBe("conditional");
    expect(step({ autopilot: true }, "review").kind).toBe("conditional");
  });

  it("hands the release to the operator only when autopilot is off", () => {
    expect(step({ autopilot: false }, "release")).toMatchObject({
      kind: "human",
      key: "guardtl_step_release_you",
    });
    expect(step({ autopilot: true }, "release")).toMatchObject({
      kind: "auto",
      key: "guardtl_step_release_auto",
    });
  });
});

describe("buildGuardTimeline — path to the PR", () => {
  it("follows autopilot", () => {
    expect(step({ autopilot: false }, "to-pr")).toMatchObject({
      kind: "human",
      key: "guardtl_step_topr_you",
    });
    expect(step({ autopilot: true }, "to-pr")).toMatchObject({
      kind: "auto",
      key: "guardtl_step_topr_auto",
    });
  });
});

describe("buildGuardTimeline — critic leg (review.ts runAutoAddress)", () => {
  it("distinguishes off / on-without-auto-address / on-with-auto-address", () => {
    const off = step({ repo: { ...REPO, critic: false } }, "critic");
    const manual = step({ repo: { ...REPO, critic: true, autoAddress: false } }, "critic");
    const auto = step({ repo: { ...REPO, critic: true, autoAddress: true } }, "critic");

    expect(off).toMatchObject({ kind: "human", key: "guardtl_step_critic_off" });
    expect(manual).toMatchObject({ kind: "conditional", key: "guardtl_step_critic_manual" });
    expect(auto).toMatchObject({ kind: "conditional", key: "guardtl_step_critic_auto" });
    expect(new Set([off.key, manual.key, auto.key]).size).toBe(3);
  });

  it("ignores auto-address when the critic is off — nothing produces findings to steer", () => {
    expect(step({ repo: { ...REPO, critic: false, autoAddress: true } }, "critic").key).toBe(
      "guardtl_step_critic_off",
    );
  });
});

describe("buildGuardTimeline — merge leg (full-auto.ts isFullAuto)", () => {
  it("rejects in isFullAuto's own order: epic base, then autopilot, then draft, then auto-merge", () => {
    // Epic base outranks everything, even a fully hands-off configuration.
    expect(
      step({ baseBranch: "epic/42-thing", autopilot: true, repo: REPO }, "merge"),
    ).toMatchObject({ kind: "human", key: "guardtl_step_merge_you_epic" });
    expect(
      step({ autopilot: false, repo: { ...REPO, draftMode: true, autoMerge: false } }, "merge"),
    ).toMatchObject({ kind: "human", key: "guardtl_step_merge_you_autopilot" });
    expect(
      step({ autopilot: true, repo: { ...REPO, draftMode: true, autoMerge: false } }, "merge"),
    ).toMatchObject({ kind: "human", key: "guardtl_step_merge_you_draft" });
    expect(
      step({ autopilot: true, repo: { ...REPO, draftMode: false, autoMerge: false } }, "merge"),
    ).toMatchObject({ kind: "human", key: "guardtl_step_merge_you_automerge" });
  });

  // isFullAuto() forces the merge half off in draftMode regardless of any auto-merge override.
  it("blames draft mode even with auto-merge on", () => {
    expect(step({ autopilot: true, repo: { ...REPO, draftMode: true } }, "merge").key).toBe(
      "guardtl_step_merge_you_draft",
    );
  });

  it("stays conditional when every configuration gate clears", () => {
    expect(step({ autopilot: true, repo: REPO }, "merge")).toMatchObject({
      kind: "conditional",
      key: "guardtl_step_merge_train",
    });
  });

  it("matches src/epic-branch.ts on the same inputs", () => {
    const epic = ["epic/1", "epic/42", "epic/42-some-slug"];
    const notEpic = ["main", "epic/", "epic/abc", "epics/42", "feature/epic/42", "epic/42_Bad"];
    for (const b of epic) {
      expect(step({ baseBranch: b, autopilot: true }, "merge").key).toBe(
        "guardtl_step_merge_you_epic",
      );
    }
    for (const b of notEpic) {
      expect(step({ baseBranch: b, autopilot: true }, "merge").key).not.toBe(
        "guardtl_step_merge_you_epic",
      );
    }
  });
});

// worktree.ts create() decides isolation at spawn time, so the dialog can neither promise nor
// deny the train for Codex — it carries the isolation as one more condition.
describe("buildGuardTimeline — Codex isolation", () => {
  it("adds the isolation condition when the configuration clears", () => {
    expect(step({ provider: "codex", autopilot: true, repo: REPO }, "merge")).toMatchObject({
      kind: "conditional",
      key: "guardtl_step_merge_train_codex",
    });
  });

  it("leaves Claude without it under the same inputs", () => {
    expect(step({ provider: "claude", autopilot: true, repo: REPO }, "merge").key).toBe(
      "guardtl_step_merge_train",
    );
  });

  it("keeps the autopilot reason for Codex when autopilot is off", () => {
    expect(step({ provider: "codex", autopilot: false, repo: REPO }, "merge")).toMatchObject({
      kind: "human",
      key: "guardtl_step_merge_you_autopilot",
    });
  });
});

describe("buildGuardTimeline — unloaded repo config", () => {
  it("omits the post-PR steps rather than guessing defaults", () => {
    const ids = buildGuardTimeline(input({ repo: null })).steps.map((s) => s.id);
    expect(ids).toEqual(["grill", "review", "release", "to-pr"]);
    expect(buildGuardTimeline(input({ repo: null })).steps.some((s) => s.repoScoped)).toBe(false);
  });
});

describe("buildGuardTimeline — invariants across every input", () => {
  it("never marks a post-PR step as unconditionally automatic", () => {
    for (const i of allInputs()) {
      for (const s of buildGuardTimeline(i).steps) {
        if (s.repoScoped) expect(s.kind).not.toBe("auto");
      }
    }
  });

  it("keeps the plan review conditional wherever it appears", () => {
    for (const i of allInputs()) {
      const review = buildGuardTimeline(i).steps.find((s) => s.id === "review");
      if (review) expect(review.kind).toBe("conditional");
    }
  });

  it("marks exactly the critic and merge steps as repo-scoped", () => {
    for (const i of allInputs()) {
      const scoped = buildGuardTimeline(i)
        .steps.filter((s) => s.repoScoped)
        .map((s) => s.id);
      expect(scoped).toEqual(["critic", "merge"]);
    }
  });

  it("emits unique step ids and a non-empty key for each", () => {
    for (const i of allInputs()) {
      const { steps } = buildGuardTimeline(i);
      expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
      for (const s of steps) expect(s.key).toMatch(/^guardtl_/);
    }
  });
});
