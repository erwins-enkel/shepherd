/** Pure helpers for the detail-panel automation pill + panel.
 *  No Svelte / no i18n / no store imports so they unit-test in isolation
 *  (mirrors git-rail-drain.ts and pr-badge.ts). */

/** Every automation key. `autoAddress` depends on `critic`. `criticAllPrs` is the
 *  session-LESS repo-wide critic (independent of `critic`). */
export type AutomationKey =
  | "critic"
  | "criticAllPrs"
  | "smellLens"
  | "autoAddress"
  | "planGate"
  | "learnings"
  | "autopilot"
  | "autoDrain"
  | "autoMerge"
  | "buildQueue"
  | "draftMode";

/** On/off state for each automation, as read from repoConfig in the component. */
export interface AutomationFlags {
  critic: boolean;
  criticAllPrs: boolean;
  /** Fowler code-smell lens on the session critic (#1824). No-op unless the critic is on. */
  smellLens: boolean;
  autoAddress: boolean;
  planGate: boolean;
  learnings: boolean;
  autopilot: boolean;
  autoDrain: boolean;
  autoMerge: boolean;
  buildQueue: boolean;
  draftMode: boolean;
}

/** A themed group of automation rows shown in the panel. */
export interface AutomationGroup {
  id: "review" | "behavior" | "queue";
  items: AutomationKey[];
}

/** Panel layout: theme groups in display order. */
export const AUTOMATION_GROUPS: readonly AutomationGroup[] = [
  { id: "review", items: ["critic", "criticAllPrs", "smellLens", "autoAddress", "planGate"] },
  { id: "behavior", items: ["learnings", "autopilot"] },
  { id: "queue", items: ["autoDrain", "autoMerge", "buildQueue", "draftMode"] },
];

/** The pill denominator: total automations, derived from the group layout so it
 *  stays in sync with the count when an automation is added or removed. */
export const AUTOMATION_TOTAL = AUTOMATION_GROUPS.flatMap((g) => g.items).length;

/** Number of automations currently ON. Auto-address and the smell lens only count
 *  while the critic is on (each is a no-op otherwise), matching the panel's disabled-row behavior. */
export function automationCount(flags: AutomationFlags): number {
  return [
    flags.critic,
    flags.criticAllPrs,
    flags.smellLens && flags.critic,
    flags.autoAddress && flags.critic,
    flags.planGate,
    flags.learnings,
    flags.autopilot,
    flags.autoDrain,
    flags.autoMerge,
    flags.buildQueue,
    flags.draftMode,
  ].filter(Boolean).length;
}
