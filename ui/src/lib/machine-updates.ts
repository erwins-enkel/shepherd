import { m } from "#lib/paraglide/messages.js";
import type { TooltipExplanation } from "#lib/tooltips/content.js";
import type { MachineUpdate, UpdateStatus } from "#lib/types.js";

// Self-updates across machines: which connected machines are behind, and what the top-bar update
// badge says about them. The update window and the badge read the same answer from here.

/** Where one machine's update stands in the update window. `skipped` = the operator left a
 *  machine whose dirty tree blocks it for later. */
export type MachinePhase = "idle" | "updating" | "done" | "failed" | "dirty" | "skipped";

/** A machine that answered its last probe — compatible or not — can be told to update. */
export function machineReachable(machine: MachineUpdate): boolean {
  return machine.status === "connected" || machine.status === "incompatible";
}

/** Connected machines whose own checkout is behind and that can be updated now. */
export function machinesBehind(machines: readonly MachineUpdate[]): MachineUpdate[] {
  return machines.filter((mc) => machineReachable(mc) && (mc.update?.behind ?? 0) > 0);
}

export const commitsLabel = (count: number): string =>
  count === 1 ? m.topbar_update_commits_one() : m.topbar_update_commits_other({ count });

export interface UpdateBadge {
  /** Commits while only this Shepherd is behind (as the badge always counted), machines once
   *  another one is. */
  count: number;
  machines: boolean;
  /** Short accessible name. */
  label: string;
  /** Which machine needs how much — only when other machines are involved. */
  explanation: TooltipExplanation | null;
}

/** What the top-bar update badge shows, or null when nothing is behind. */
export function updateBadge(
  local: UpdateStatus | null,
  machines: readonly MachineUpdate[],
): UpdateBadge | null {
  const localBehind = local?.behind ?? 0;
  const others = machinesBehind(machines);
  if (others.length === 0) {
    if (localBehind <= 0) return null;
    const label = `${localBehind} ${
      localBehind === 1 ? m.updatemodal_commits_one() : m.updatemodal_commits_other()
    }`;
    return { count: localBehind, machines: false, label, explanation: null };
  }
  const rows = [
    ...(localBehind > 0
      ? [{ text: m.updatemodal_this_machine(), aside: commitsLabel(localBehind) }]
      : []),
    ...others.map((mc) => ({ text: mc.name, aside: commitsLabel(mc.update?.behind ?? 0) })),
  ];
  const count = rows.length;
  const label =
    count === 1
      ? m.topbar_update_machines_title_one()
      : m.topbar_update_machines_title_other({ count });
  return {
    count,
    machines: true,
    label,
    explanation: {
      title: label,
      summary: m.topbar_update_machines_summary(),
      sections: [
        { label: m.topbar_update_machines_due(), text: "", rows },
        { label: m.topbar_update_machines_next(), text: m.topbar_update_machines_next_text() },
      ],
    },
  };
}
