import type { AutomationFlags } from "./components/git-rail-automation";
import type { RepoConfig } from "#lib/types.js";
import { effectiveMergeMode, mergeModePatch, type MergeMode } from "./merge-mode";

// How much Shepherd does in a repo on its own (#3445): four levels over the five values that
// decide it (Critic, Auto-Address, Autopilot, Auto-Drain and how finished PRs land), and who takes
// each step of the way. Pure; the repo settings' Autonomy section, its rail status, the context
// menus' short status and the first-task confirm read it.

export const AUTONOMY_LEVELS = ["onCall", "review", "backlog", "full"] as const;
/** On call · with review · backlog · full auto — each one adds to the one before. */
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** The five values a level sets. */
export interface AutonomyValues {
  critic: boolean;
  autoAddress: boolean;
  autopilot: boolean;
  autoDrain: boolean;
  merge: MergeMode;
}

const LEVELS: Record<AutonomyLevel, AutonomyValues> = {
  onCall: {
    critic: false,
    autoAddress: false,
    autopilot: false,
    autoDrain: false,
    merge: "manual",
  },
  // what a brand-new repo is seeded with (RepoConfigStore.seedNewRepoDefaults, Critic on by default)
  review: { critic: true, autoAddress: true, autopilot: true, autoDrain: false, merge: "manual" },
  backlog: { critic: true, autoAddress: true, autopilot: true, autoDrain: true, merge: "manual" },
  full: { critic: true, autoAddress: true, autopilot: true, autoDrain: true, merge: "auto" },
};

type AutonomyFlags = Pick<
  AutomationFlags,
  "critic" | "autoAddress" | "autopilot" | "autoDrain" | "autoMerge" | "draftMode"
>;

/** The five values as they take effect, by the rules the settings' rows apply: Auto-Address only
 *  with the Critic on, Auto-Drain only in a GitHub repo, a local-only repo's draft as you merge. */
export function effectiveAutonomy(flags: AutonomyFlags, lightweight: boolean): AutonomyValues {
  return {
    critic: flags.critic,
    autoAddress: flags.autoAddress && flags.critic,
    autopilot: flags.autopilot,
    autoDrain: flags.autoDrain && !lightweight,
    merge: effectiveMergeMode(
      { draftMode: flags.draftMode, autoMergeEnabled: flags.autoMerge },
      lightweight,
    ),
  };
}

/** The level a repo's config holds; "custom" when its five values match none. */
export function autonomyLevelOf(
  flags: AutonomyFlags,
  lightweight: boolean,
): AutonomyLevel | "custom" {
  const v = effectiveAutonomy(flags, lightweight);
  return (
    AUTONOMY_LEVELS.find((id) => {
      const l = LEVELS[id];
      return (
        l.critic === v.critic &&
        l.autoAddress === v.autoAddress &&
        l.autopilot === v.autopilot &&
        l.autoDrain === v.autoDrain &&
        l.merge === v.merge
      );
    }) ?? "custom"
  );
}

/** The one patch that sets a level: exactly its five values, the merge mode as both of its fields.
 *  Draft is always off in it, so the Critic can go off without a sign-off fallback. */
export function autonomyPatch(
  level: AutonomyLevel,
): Pick<
  RepoConfig,
  | "criticEnabled"
  | "autoAddressEnabled"
  | "autopilotEnabled"
  | "autoDrainEnabled"
  | "draftMode"
  | "autoMergeEnabled"
> {
  const l = LEVELS[level];
  return {
    criticEnabled: l.critic,
    autoAddressEnabled: l.autoAddress,
    autopilotEnabled: l.autopilot,
    autoDrainEnabled: l.autoDrain,
    ...mergeModePatch(l.merge),
  };
}

/** Levels that need Auto-Drain, which a local-only repo doesn't have. */
export function levelNeedsForge(level: AutonomyLevel): boolean {
  return LEVELS[level].autoDrain;
}

export const AUTONOMY_STEPS = ["pickup", "plan", "stops", "review", "fix", "merge"] as const;
/** Pick up an issue · check the plan · go on at stops · review · fix the findings · merge. */
export type AutonomyStep = (typeof AUTONOMY_STEPS)[number];

/** Who takes each step, live from the config: the five values plus the plan gate. */
export function autonomyChain(
  flags: AutonomyFlags & Pick<AutomationFlags, "planGate">,
  lightweight: boolean,
): Record<AutonomyStep, "shepherd" | "you"> {
  const v = effectiveAutonomy(flags, lightweight);
  const who = (on: boolean) => (on ? "shepherd" : "you");
  return {
    pickup: who(v.autoDrain),
    plan: who(flags.planGate),
    stops: who(v.autopilot),
    review: who(v.critic),
    fix: who(v.autoAddress),
    merge: who(v.merge === "auto"),
  };
}
