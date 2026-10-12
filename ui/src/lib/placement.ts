import { m } from "#lib/paraglide/messages.js";
import { getLocale } from "#lib/i18n.js";
import { capabilityLabel, capabilityReasonLabel, platformLabel } from "#lib/machines.js";
import type { Placement, PlacementRefusal, SessionHost } from "#lib/types.js";

// The automatic machine choice (#2772) in words. The server decides and reports a language-neutral
// record (`Placement`) or why it would refuse (`PlacementRefusal`); this module is the one place
// those become sentences, so the New Task preview, the session status bar and a mirrored session's
// detail cannot drift apart.

/** Capabilities a task can name in New Task: the vocabulary except platforms not released for
 *  tasks (Windows). Mirrors CAPABILITIES in src/remote-instances/capabilities.ts. */
export const REQUIREMENT_OPTIONS: readonly string[] = [
  "platform:linux",
  "platform:macos",
  "xcode",
  "sdk:macos",
  "sdk:ios",
  "ios-simulator",
  "android-sdk",
  "agent:claude",
  "agent:codex",
  "sandbox:trusted",
  "sandbox:standard",
  "sandbox:autonomous",
];

/** "macOS and Xcode" / "macOS und Xcode", in the UI's language. */
export function capabilityList(ids: readonly string[]): string {
  const labels = ids.map(capabilityLabel);
  try {
    return new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(labels);
  } catch {
    return labels.join(", ");
  }
}

/** Why the task runs where it runs: "Needs macOS and Xcode", "No special requirements – preferred:
 *  Linux", "Chosen manually", … */
export function placementReason(p: Placement): string {
  const list = capabilityList(p.requirements);
  const platform = platformLabel(p.preferred ?? p.target.platform);
  switch (p.basis) {
    case "manual":
      return m.placement_basis_manual();
    case "requirements":
      return m.placement_basis_requirements({ list });
    case "preference":
      return p.requirements.length > 0
        ? m.placement_basis_preference({ list, platform })
        : m.placement_basis_preference_none({ platform });
    case "only_candidate":
      return m.placement_basis_only();
    default:
      return p.requirements.length > 0 ? m.placement_basis_requirements({ list }) : "";
  }
}

const hostNames = (hosts: readonly SessionHost[] | undefined) =>
  (hosts ?? []).map((h) => h.name).join(", ");

/** What a named machine lacks: "Xcode (not installed)". */
function missingOnMachine(missing: PlacementRefusal["missing"]): string {
  return (missing ?? [])
    .map((x) =>
      typeof x === "string"
        ? capabilityLabel(x)
        : `${capabilityLabel(x.capability)} (${capabilityReasonLabel(x.reason)})`,
    )
    .join(", ");
}

function noSuitableMachine(r: PlacementRefusal): string {
  const ids = (r.missing ?? []).filter((x): x is string => typeof x === "string");
  const list = capabilityList(ids);
  const head =
    ids.length === 0
      ? m.placement_refusal_none_any()
      : r.together && ids.length > 1
        ? m.placement_refusal_none_together({ list })
        : m.placement_refusal_none({ list });
  const elsewhere = hostNames(r.elsewhere);
  return elsewhere ? `${head} ${m.placement_refusal_elsewhere({ machines: elsewhere })}` : head;
}

/** Why the task would not start — the preview's warning and the dialog's error after a refused
 *  create. A code a newer server might add reads as the server's own sentence. */
export function placementRefusalText(r: PlacementRefusal): string {
  const machine = r.host?.name ?? "";
  switch (r.code) {
    case "no_suitable_machine":
      return noSuitableMachine(r);
    case "preferred_machine_offline": {
      const text = m.placement_refusal_offline({ machine });
      const others = hostNames(r.alternatives);
      return others ? `${text} ${m.placement_refusal_alternatives({ machines: others })}` : text;
    }
    case "missing_capabilities": {
      // Without a host: this machine's own fresh check at acceptance refused it.
      const list = missingOnMachine(r.missing);
      return r.host
        ? m.placement_refusal_missing({ machine, list })
        : m.placement_refusal_missing_here({ list });
    }
    case "remote_target_unavailable":
      return m.placement_refusal_unavailable({ machine });
    case "remote_target_unreleased":
      return m.placement_refusal_unreleased({ machine });
    case "remote_project_missing":
      return m.placement_refusal_project_missing({ machine });
    case "remote_target_unknown":
      return m.placement_refusal_unknown();
    case "remote_project_unknown":
      return m.newtask_runon_project_unknown();
    default:
      return r.error;
  }
}
