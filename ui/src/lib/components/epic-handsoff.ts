// Pure recommendation logic for the "run this epic hands-off" first-run explainer
// (EpicHandsOffIntro.svelte). Kept DOM- and i18n-free so the recommendation is
// unit-testable and has a single source of truth shared by the explainer and the
// reviews store's applyHandsOffDefaults().
//
// Plan gate is deliberately NOT in the applied patch: it is recommended ON (the
// seeded default), auto-approves/auto-iterates for drain-spawned epic sessions, and
// is hands-off-safe — so one-click Apply must never flip it. See the hands-off-epics
// guide + src/plan-gate.ts (applyApproved / applyChangesRequested).

/** The repo + epic flags the checklist reads, resolved from repoConfig.flags() + epic.run.mode. */
export type HandsOffFlags = {
  autopilot: boolean;
  autoMerge: boolean;
  draftMode: boolean;
  critic: boolean;
  autoAddress: boolean;
  /** Plan gate — recommended ON (informational; not changed by Apply). */
  planGate: boolean;
  /** epic.run.mode === "auto". */
  epicModeAuto: boolean;
};

export type HandsOffItemKey =
  "autopilot" | "automerge" | "critic" | "autoaddress" | "plangate" | "epicmode";

export type HandsOffCheckItem = {
  key: HandsOffItemKey;
  /** True when the current value already matches the hands-off recommendation. */
  ok: boolean;
};

/** The exact repo-config patch one-click Apply writes. Excludes planGateEnabled (see file
 *  header) and epic mode (per-epic, set via updateEpic — not a repo-config field). */
export type HandsOffPatch = {
  autopilotEnabled: true;
  autoMergeEnabled: true;
  draftMode: false;
  criticEnabled: true;
  autoAddressEnabled: true;
};

export function handsOffPatch(): HandsOffPatch {
  return {
    autopilotEnabled: true,
    autoMergeEnabled: true,
    draftMode: false,
    criticEnabled: true,
    autoAddressEnabled: true,
  };
}

/** Per-setting current-vs-recommended state driving the explainer checklist. Plan gate is
 *  recommended ON (informational — one-click Apply never touches it; see file header). */
export function handsOffDelta(current: HandsOffFlags): HandsOffCheckItem[] {
  return [
    { key: "autopilot", ok: current.autopilot },
    // Full-auto merge is only effective with Draft off (mutually exclusive).
    { key: "automerge", ok: current.autoMerge && !current.draftMode },
    { key: "critic", ok: current.critic },
    { key: "autoaddress", ok: current.autoAddress },
    { key: "plangate", ok: current.planGate },
    { key: "epicmode", ok: current.epicModeAuto },
  ];
}
