/**
 * Where a drain spawn runs: this machine, or another connected one that meets its requirements.
 * The pure half. The drain asks the shared machine choice (`remote-instances/decide.ts`, #2772)
 * only when `placementQuery` says to, and turns its answer into a route with `routeOf`.
 *
 * A spawn's requirements come from its labels, not from a model: `requires-macos` needs Xcode.
 * An epic child also inherits its epic's labels. A spawn without requirements and without a named
 * machine runs here exactly as before, and so does every spawn while no other machine is registered.
 *
 * A spawn that belongs elsewhere but cannot go there now holds the drain with a reason instead of
 * starting here: the machine is out of reach, the named machine is unfit, no machine fits, or the
 * child is stacked on a predecessor's branch (stacks stay on one machine).
 */
import type { HoldReason } from "./drain-core";
import type { Capability } from "./remote-instances/capabilities";
import type { Placement, PlacementDecision } from "./remote-instances/placement";
import { withImplied } from "./requirements-classify-core";

/** Labels that call for capabilities, matched case-insensitively. */
const LABEL_REQUIREMENTS: Readonly<Record<string, readonly Capability[]>> = {
  "requires-macos": ["xcode"],
};

/** The requirements `labels` call for, with what they imply; sorted, deduplicated. */
export function requirementsFromLabels(labels: readonly string[]): Capability[] {
  return withImplied(labels.flatMap((label) => LABEL_REQUIREMENTS[label.toLowerCase()] ?? []));
}

export interface RouteInput {
  requirements: readonly Capability[];
  /** The epic's named machine; null = automatic (always null in label mode). */
  machine: string | null;
  /** This Shepherd's instance ID. */
  selfId: string;
  /** Some registered machine could take a task (`placementActive`). */
  active: boolean;
}

/** null = the spawn runs here without asking the machine choice (today's behaviour); otherwise the
 *  override to ask it with. */
export function placementQuery(input: RouteInput): { override: string | null } | null {
  if (input.machine === null) {
    return input.active && input.requirements.length > 0 ? { override: null } : null;
  }
  if (input.machine === input.selfId && input.requirements.length === 0) return null;
  return { override: input.machine };
}

export type ChildRoute =
  | { kind: "here" }
  | { kind: "remote"; placement: Placement }
  | { kind: "hold"; reason: HoldReason };

/** The route the machine choice's `decision` gives a spawn. `machine` names the machine asked for
 *  (null = automatic), so an unknown one is still named in the hold. */
export function routeOf(
  decision: PlacementDecision,
  ctx: { selfId: string; stacked: boolean; machine: string | null },
): ChildRoute {
  if (!decision.ok) {
    const { refusal } = decision;
    if (refusal.code === "no_suitable_machine") {
      return { kind: "hold", reason: { code: refusal.code, detail: refusal.missing.join(", ") } };
    }
    const name = refusal.host?.name ?? ctx.machine ?? "";
    const code = refusal.code === "remote_target_unavailable" ? "machine_offline" : "machine_unfit";
    return { kind: "hold", reason: { code, detail: name } };
  }
  const { placement, wait } = decision;
  if (placement.target.instanceId === ctx.selfId) return { kind: "here" };
  const detail = placement.target.name;
  if (wait) return { kind: "hold", reason: { code: "machine_offline", detail } };
  if (ctx.stacked) return { kind: "hold", reason: { code: "machine_stacked", detail } };
  return { kind: "remote", placement };
}
