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
import {
  REMOTE_WORK_WINDOW_MS,
  dispatchedElsewhereOf,
  drainDispatchKey,
  integratedDispatchesOf,
  remoteWorkOf,
  settleOutcomeOf,
} from "./drain-remote";
import { payloadHash } from "./dispatch";
import type { GitForge } from "./forge/types";
import { type FetchLike, requestRemote } from "./remote-instances/client";
import { type DecideDeps, decide } from "./remote-instances/decide";
import type { RemoteDispatcher } from "./remote-instances/dispatch";
import { instanceIdentity } from "./remote-instances/identity";
import { placementActive } from "./remote-instances/placement";
import type { RemoteInstanceService } from "./remote-instances/service";
import { type RemoteSessionMirror, type SessionHost, hostNames } from "./remote-instances/sessions";
import type { SessionStore } from "./store";

export interface DrainMachineDeps {
  store: Pick<
    SessionStore,
    "getSetting" | "setSetting" | "deleteSetting" | "listDrainRemoteDispatches"
  >;
  decide: DecideDeps;
  instances: Pick<RemoteInstanceService, "list">;
  sessions: Pick<RemoteSessionMirror, "list" | "machines">;
  dispatcher: Pick<RemoteDispatcher, "submit">;
  resolveForge: (repoPath: string) => GitForge | null;
  now?: () => number;
  /** Tests stand in the machine's HTTP. */
  fetch?: FetchLike;
}

/** #3016: how long a settle request may take: the machine reads the PR from its forge first. */
const SETTLE_TIMEOUT_MS = 30_000;

/** A repo's identity across machines, or undefined when it has no forge to match it by. */
function projectOf(forge: GitForge | null): string | undefined {
  return forge?.originSlug ?? forge?.slug ?? undefined;
}

export function drainMachinePort(deps: DrainMachineDeps): DrainMachinePort {
  const now = deps.now ?? Date.now;
  const project = (repoPath: string) => projectOf(deps.resolveForge(repoPath));
  /** The registered machines by instance ID, named as the session mirror names them. */
  const hostsById = (): ReadonlyMap<string, SessionHost> => {
    const machines = deps.instances.list();
    const names = hostNames(machines);
    return new Map(
      machines.map((m) => [
        m.instanceId,
        {
          instanceId: m.instanceId,
          name: names.get(m.instanceId) ?? m.name,
          platform: m.info?.platform ?? "unknown",
        },
      ]),
    );
  };
  /** The machine's address while its link is open; null otherwise. */
  const targetOf = (instanceId: string) =>
    deps.sessions.machines().find((m) => m.host.instanceId === instanceId)?.target ?? null;
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
      const hosts = hostsById();
      return remoteWorkOf(
        deps.store.listDrainRemoteDispatches(slug, at - REMOTE_WORK_WINDOW_MS),
        deps.sessions.list(),
        (id) => hosts.get(id) ?? null,
        at,
      );
    },
    dispatchedElsewhere(repoPath) {
      const slug = project(repoPath);
      if (!slug) return new Map();
      const hosts = hostsById();
      return dispatchedElsewhereOf(
        deps.store.listDrainRemoteDispatches(slug, now() - REMOTE_WORK_WINDOW_MS),
        (id) => hosts.get(id) ?? null,
      );
    },
    integratedDispatches(repoPath, integrationOf) {
      const slug = project(repoPath);
      if (!slug) return [];
      const hosts = hostsById();
      return integratedDispatchesOf(
        deps.store.listDrainRemoteDispatches(slug, now() - REMOTE_WORK_WINDOW_MS),
        (id) => hosts.get(id) ?? null,
        integrationOf,
      );
    },
    machineOnline: (instanceId) => !!targetOf(instanceId),
    mirroredSession: (sessionId) => deps.sessions.list().find((s) => s.id === sessionId),
    async settle(instanceId, sessionId, prNumber) {
      const target = targetOf(instanceId);
      if (!target) return { kind: "failed" };
      const res = await requestRemote(
        target,
        `/api/sessions/${encodeURIComponent(sessionId)}/settle-integrated`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(prNumber != null ? { prNumber } : {}),
        },
        { fetch: deps.fetch, timeoutMs: SETTLE_TIMEOUT_MS },
      );
      if (!res.ok) return { kind: "failed" };
      return settleOutcomeOf(res.response.status, await res.response.json().catch(() => null));
    },
  };
}
