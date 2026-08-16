// Derives the "where does this task wait for a human?" timeline shown under the Guards
// toggles in New Task. Pure: message KEYS and a marker kind per step, never rendered
// prose — the browser tests assert structure without depending on translations.
//
// Every branch here mirrors a server-side predicate. When one of those moves, this moves:
//   step 1 (grill)    — service.ts composeSystemPrompt(): a dialog-spawned session always
//                       gets the INTERACTIVE plan-gate directive (input.auto is false), so
//                       the agent asks live even under autopilot.
//   step 2 (review)   — plan-gate.ts applyChangesRequested(): escalates at the round cap.
//   step 3 (release)  — plan-gate.ts applyApproved(): autopilot (or drain) releases, else
//                       the operator's explicit Go.
//   step 4 (to PR)    — autopilot.ts eligible(): autopilot drives the routine stops.
//   step 5 (critic)   — review.ts runAutoAddress(): returns without steering when
//                       auto-address is off, and holds at the cap when it is on.
//   step 6 (merge)    — full-auto.ts isFullAuto() for the configuration, plus
//                       automerge-core.ts readyExceptManualSteps()/hasBlockingManualSteps()
//                       for the runtime conditions.
//
// INVARIANTS:
//   • No step after the repo divider is ever "auto". Nothing past the PR is unconditionally
//     hands-off — see the two predicates above.
//   • No step of a Codex task is ever "auto". Autopilot stands down entirely on a
//     non-isolated Codex session (autopilot.ts eligible(), and the codexNonIsolated guard in
//     plan-gate.ts applyApproved()), and worktree.ts create() only decides isolation at spawn
//     time — so every autopilot-driven promise is a condition there, never a claim.

import type { AgentProvider } from "./types";

export type GuardStepKind =
  /** Waits for the operator, always. */
  | "human"
  /** Runs without the operator, always. */
  | "auto"
  /** Runs without the operator only while the stated condition holds. */
  | "conditional";

export type GuardStep = {
  /** Stable identity for tests and keyed rendering. */
  id: string;
  kind: GuardStepKind;
  /** Message key for the step text. */
  key: string;
  /** Governed by repo-wide automation → renders the affordance opening the automation panel. */
  repoScoped: boolean;
};

/** Repo-wide automation flags, or null while the repo config is still loading. */
export type GuardRepoConfig = {
  critic: boolean;
  autoAddress: boolean;
  autoMerge: boolean;
  draftMode: boolean;
};

export type GuardTimelineInput = {
  planGate: boolean;
  autopilot: boolean;
  provider: AgentProvider;
  baseBranch: string;
  /** null → the post-PR steps are omitted rather than guessed from defaults. */
  repo: GuardRepoConfig | null;
};

export type GuardTimeline = {
  headerKey: string;
  steps: GuardStep[];
};

/** Mirrors isEpicIntegrationBranch() in src/epic-branch.ts — epic children are squash-merged
 *  by the drain's retire path, never carried by the merge train. Kept in step by
 *  guard-timeline.test.ts, which pins the same inputs; there is no cross-package gate. */
const EPIC_INTEGRATION_BRANCH = /^epic\/\d+(-[a-z0-9-]+)?$/;

/** True when autopilot is on AND actually applies. For Codex it only applies with an isolated
 *  worktree, which is not known until spawn — so a Codex task never gets an unconditional
 *  autopilot promise, in the header or in a step. */
function autopilotIsCertain(input: GuardTimelineInput): boolean {
  return input.autopilot && input.provider !== "codex";
}

function headerKey(input: GuardTimelineInput): string {
  const suffix = autopilotIsCertain(input) ? "auto" : input.autopilot ? "auto_codex" : "manual";
  return input.planGate ? `guardtl_head_plan_${suffix}` : `guardtl_head_nogate_${suffix}`;
}

/** An autopilot-driven step: the operator's when autopilot is off, Shepherd's when it is on and
 *  certain, and conditional on the worktree isolation when the task runs on Codex. */
function autopilotStep(
  input: GuardTimelineInput,
  id: string,
  keys: { human: string; auto: string; autoCodex: string },
): GuardStep {
  if (!input.autopilot) return { id, kind: "human", key: keys.human, repoScoped: false };
  return autopilotIsCertain(input)
    ? { id, kind: "auto", key: keys.auto, repoScoped: false }
    : { id, kind: "conditional", key: keys.autoCodex, repoScoped: false };
}

/** The critic leg: off means nobody reviews for you; on splits by whether findings are
 *  steered back automatically (runAutoAddress) or land on the operator straight away. */
function criticStep(repo: GuardRepoConfig): GuardStep {
  if (!repo.critic) {
    return { id: "critic", kind: "human", key: "guardtl_step_critic_off", repoScoped: true };
  }
  return {
    id: "critic",
    kind: "conditional",
    key: repo.autoAddress ? "guardtl_step_critic_auto" : "guardtl_step_critic_manual",
    repoScoped: true,
  };
}

/** The merge leg. The rejection reasons follow isFullAuto()'s own order, minus its Codex
 *  isolation stage: whether Shepherd gets an isolated worktree is decided at spawn time by
 *  worktree.ts create(), so the dialog cannot know it. Rather than promise or deny a merge
 *  train, a Codex session that clears every configuration gate carries the isolation as one
 *  more condition. */
function mergeStep(input: GuardTimelineInput, repo: GuardRepoConfig): GuardStep {
  const step = (kind: GuardStepKind, key: string): GuardStep => ({
    id: "merge",
    kind,
    key,
    repoScoped: true,
  });
  if (EPIC_INTEGRATION_BRANCH.test(input.baseBranch)) {
    return step("human", "guardtl_step_merge_you_epic");
  }
  if (!input.autopilot) return step("human", "guardtl_step_merge_you_autopilot");
  if (repo.draftMode) return step("human", "guardtl_step_merge_you_draft");
  if (!repo.autoMerge) return step("human", "guardtl_step_merge_you_automerge");
  return step(
    "conditional",
    input.provider === "codex" ? "guardtl_step_merge_train_codex" : "guardtl_step_merge_train",
  );
}

export function buildGuardTimeline(input: GuardTimelineInput): GuardTimeline {
  const steps: GuardStep[] = [];

  if (input.planGate) {
    steps.push({ id: "grill", kind: "human", key: "guardtl_step_grill", repoScoped: false });
    steps.push({
      id: "review",
      kind: "conditional",
      key: "guardtl_step_review",
      repoScoped: false,
    });
    steps.push(
      autopilotStep(input, "release", {
        human: "guardtl_step_release_you",
        auto: "guardtl_step_release_auto",
        autoCodex: "guardtl_step_release_auto_codex",
      }),
    );
  }

  steps.push(
    autopilotStep(input, "to-pr", {
      human: "guardtl_step_topr_you",
      auto: "guardtl_step_topr_auto",
      autoCodex: "guardtl_step_topr_auto_codex",
    }),
  );

  if (input.repo) {
    steps.push(criticStep(input.repo));
    steps.push(mergeStep(input, input.repo));
  }

  return { headerKey: headerKey(input), steps };
}
