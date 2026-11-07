/**
 * The automatic machine choice (#2772) over the live machine list: this Shepherd's own view plus
 * every registered machine, with load refreshed for the ones that could take the task. The create
 * route, the placement preview and the drain (a backlog or epic child that needs another machine)
 * all decide through `decide`, so a task lands where the same rules send it whoever starts it.
 *
 * The rules themselves are the pure `decidePlacement` in `placement.ts`; this module only gathers
 * what it reads.
 */
import type { SessionStore } from "../store";
import type { Capability } from "./capabilities";
import type { CapabilityService } from "./capability-probe";
import { instanceIdentity } from "./identity";
import type { HostLoadReport } from "./load";
import {
  type MachineView,
  type PlacementDecision,
  PLATFORM_ORDER_SETTING,
  decidePlacement,
  fits,
  localMachine,
  remoteMachineViews,
  storedPlatformOrder,
} from "./placement";
import type { RemoteInstanceService } from "./service";

export interface DecideDeps {
  store: Pick<SessionStore, "getSetting" | "setSetting" | "deleteSetting">;
  capabilities: Pick<CapabilityService, "report" | "refresh">;
  instances: Pick<RemoteInstanceService, "list" | "refreshLoads">;
  /** This Shepherd's platform as its identity reports it. */
  platform: string;
  /** This host's load right now, or null when it cannot be read. */
  load: () => HostLoadReport | null;
}

export interface PlaceInput {
  requirements: Capability[];
  /** Forge slug of the project; undefined = no other machine can match it. */
  project: string | undefined;
  /** null = automatic; else the named machine (this one's own ID included). */
  override: string | null;
}

/** This Shepherd as the choice sees it. Its capability report is refreshed first only when it is
 *  asked about requirements and the last report is missing or stale. */
export async function localMachineView(deps: DecideDeps, refresh: boolean): Promise<MachineView> {
  const last = deps.capabilities.report();
  if (refresh && (!last || last.stale)) await deps.capabilities.refresh();
  return localMachine(
    instanceIdentity(deps.store, deps.platform),
    deps.capabilities.report(),
    deps.load(),
  );
}

/** Where a task with `input` runs, decided over this Shepherd and every registered machine. */
export async function decide(deps: DecideDeps, input: PlaceInput): Promise<PlacementDecision> {
  const self = instanceIdentity(deps.store).instanceId;
  const judgesHere = input.override === null || input.override === self;
  const local = await localMachineView(deps, judgesHere && input.requirements.length > 0);
  const candidates = remoteMachineViews(deps.instances.list(), input.project).filter(
    (m) =>
      m.connected &&
      fits(m, input.requirements) &&
      (input.override === null || m.host.instanceId === input.override),
  );
  await deps.instances.refreshLoads(candidates.map((m) => m.host.instanceId));
  local.load = deps.load();
  return decidePlacement([local, ...remoteMachineViews(deps.instances.list(), input.project)], {
    requirements: input.requirements,
    override: input.override,
    order: storedPlatformOrder(deps.store.getSetting(PLATFORM_ORDER_SETTING)),
    by: { instanceId: local.host.instanceId, name: local.host.name },
    now: Date.now(),
  });
}
