import { getContext, setContext } from "svelte";
import { m } from "#lib/paraglide/messages.js";
import type { PendingRepoConfig } from "#lib/api.js";

const KEY = Symbol("repo-settings-pending-config");
type Proposal = () => PendingRepoConfig | null;
export function providePendingConfig(proposal: Proposal): void {
  setContext(KEY, proposal);
}
export function usePendingConfig(): Proposal {
  return getContext<Proposal | undefined>(KEY) ?? (() => null);
}

/** Summary rows name several rules without becoming the navigation target of each rule. */
export function rowPendingChanges(
  field: string,
  proposal: PendingRepoConfig | null,
): [string, unknown][] {
  const fields =
    field === "autonomyLevel" || field === "autonomyChain"
      ? [
          "criticEnabled",
          "autoAddressEnabled",
          "autopilotEnabled",
          "autoDrainEnabled",
          "autoMergeEnabled",
          "planGateEnabled",
        ]
      : field.split(/\s+/);
  return Object.entries(proposal?.changes ?? {}).filter(([key]) => fields.includes(key));
}
export function proposedValue(value: unknown): string {
  if (value === true) return m.reposettings_pending_on();
  if (value === false) return m.reposettings_pending_off();
  if (value === null) return m.reposettings_pending_none();
  return String(value);
}

/** Compound rows need names for their constituent rules; single rows already supply a label. */
export function proposedRuleName(key: string, rowName: string): string {
  switch (key) {
    case "criticEnabled":
      return m.automation_critic_name();
    case "autoAddressEnabled":
      return m.automation_autoaddress_name();
    case "autopilotEnabled":
      return m.automation_autopilot_name();
    case "autoDrainEnabled":
      return m.automation_autodrain_name();
    case "autoMergeEnabled":
      return m.automation_automerge_name();
    case "planGateEnabled":
      return m.automation_plan_gate_name();
    case "draftMode":
      return m.reposettings_merge_mode_draft();
    default:
      return rowName;
  }
}
