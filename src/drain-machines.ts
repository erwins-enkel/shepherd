/**
 * The drain's view of the connected machines (`DrainMachinePort`, src/drain.ts), built from the
 * same services the create route uses: the shared machine choice (`remote-instances/decide.ts`),
 * the dispatcher that sends a task to a machine (#2763) and the session mirror (#2762). Wired in
 * index.ts.
 *
 * A project is the same project on every machine when its forge slug matches — for a fork the
 * clone origin, as the create route reads it (`repoRemoteSlug` in server.ts).
 */
import type { DrainMachinePort } from "./drain";
import { REMOTE_WORK_WINDOW_MS, drainDispatchKey, remoteWorkOf } from "./drain-remote";
import { payloadHash } from "./dispatch";
import type { GitForge } from "./forge/types";
import { type DecideDeps, decide } from "./remote-instances/decide";
import type { RemoteDispatcher } from "./remote-instances/dispatch";
import { instanceIdentity } from "./remote-instances/identity";
import { placementActive } from "./remote-instances/placement";
import type { RemoteInstanceService } from "./remote-instances/service";
import { type RemoteSessionMirror, hostNames } from "./remote-instances/sessions";
import type { SessionStore } from "./store";

export interface DrainMachineDeps {
  store: Pick<
    SessionStore,
    "getSetting" | "setSetting" | "deleteSetting" | "listDrainRemoteDispatches"
  >;
  decide: DecideDeps;
  instances: Pick<RemoteInstanceService, "list">;
  sessions: Pick<RemoteSessionMirror, "list">;
  dispatcher: Pick<RemoteDispatcher, "submit">;
  resolveForge: (repoPath: string) => GitForge | null;
  now?: () => number;
}

/** A repo's identity across machines, or undefined when it has no forge to match it by. */
function projectOf(forge: GitForge | null): string | undefined {
  return forge?.originSlug ?? forge?.slug ?? undefined;
}

export function drainMachinePort(deps: DrainMachineDeps): DrainMachinePort {
  const now = deps.now ?? Date.now;
  const project = (repoPath: string) => projectOf(deps.resolveForge(repoPath));
  return {
    active: () => placementActive(deps.instances.list()),
    selfId: () => instanceIdentity(deps.store).instanceId,
    decide: (repoPath, requirements, override) =>
      decide(deps.decide, { requirements, project: project(repoPath), override }),
    async submit({ repoPath, issue, placement, body }) {
      const slug = project(repoPath);
      if (!slug) return { kind: "refused", code: "remote_project_missing", reason: null };
      return deps.dispatcher.submit({
        clientKey: drainDispatchKey(issue),
        instanceId: placement.target.instanceId,
        project: slug,
        body,
        payloadHash: payloadHash(body),
      });
    },
    work(repoPath) {
      const slug = project(repoPath);
      if (!slug) return new Map();
      const at = now();
      const machines = deps.instances.list();
      const names = hostNames(machines);
      const hosts = new Map(
        machines.map((m) => [
          m.instanceId,
          {
            instanceId: m.instanceId,
            name: names.get(m.instanceId) ?? m.name,
            platform: m.info?.platform ?? "unknown",
          },
        ]),
      );
      return remoteWorkOf(
        deps.store.listDrainRemoteDispatches(slug, at - REMOTE_WORK_WINDOW_MS),
        deps.sessions.list(),
        (id) => hosts.get(id) ?? null,
        at,
      );
    },
  };
}
