/** Pure helpers for the detail-panel automation pill + panel.
 *  No Svelte / no i18n / no store imports so they unit-test in isolation
 *  (mirrors git-rail-drain.ts and pr-badge.ts). */

/** Every automation key. `autoAddress` depends on `critic`. */
export type AutomationKey =
  | "critic"
  | "autoAddress"
  | "learnings"
  | "autopilot"
  | "autoDrain"
  | "autoMerge"
  | "buildQueue";

/** On/off state for each automation, as read from repoConfig in the component.
 *  `planGate` is carried for the pre-execution plan-gate toggle but is NOT yet part
 *  of AUTOMATION_GROUPS / the pill count — its row lands with the plan-gate UI task. */
export interface AutomationFlags {
  critic: boolean;
  autoAddress: boolean;
  learnings: boolean;
  autopilot: boolean;
  autoDrain: boolean;
  autoMerge: boolean;
  buildQueue: boolean;
  planGate: boolean;
}

/** A themed group of automation rows shown in the panel. */
export interface AutomationGroup {
  id: "review" | "behavior" | "queue";
  items: AutomationKey[];
}

/** Panel layout: theme groups in display order. */
export const AUTOMATION_GROUPS: readonly AutomationGroup[] = [
  { id: "review", items: ["critic", "autoAddress"] },
  { id: "behavior", items: ["learnings", "autopilot"] },
  { id: "queue", items: ["autoDrain", "autoMerge", "buildQueue"] },
];

/** The pill denominator: total automations, derived from the group layout so it
 *  stays in sync with the count when an automation is added or removed. */
export const AUTOMATION_TOTAL = AUTOMATION_GROUPS.flatMap((g) => g.items).length;

/** Number of automations currently ON. Auto-address only counts while the critic
 *  is on (it's a no-op otherwise), matching the panel's disabled-row behavior. */
export function automationCount(flags: AutomationFlags): number {
  return [
    flags.critic,
    flags.autoAddress && flags.critic,
    flags.learnings,
    flags.autopilot,
    flags.autoDrain,
    flags.autoMerge,
    flags.buildQueue,
  ].filter(Boolean).length;
}
