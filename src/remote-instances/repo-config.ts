/** On-demand repository settings. Only local endpoints are called on peers: no mirroring. */
import {
  isRepoRuleKey,
  REPO_RULE_FIELDS,
  repoRulesFromConfig,
  parseRepoRules,
} from "../repo-config-file";
import type { RepoConfigView } from "../repo-config-service";
import { repoConfigDefaults } from "../store";
import { isRecord, requestRemote, type FetchLike, type RemoteTarget } from "./client";

export interface RepoMachine {
  instanceId: string;
  name: string;
  membership: "present" | "absent" | "unknown";
  reachable: boolean;
  reason: string | null;
  config: RepoConfigView | null;
}
export interface RepoPeer {
  instanceId: string;
  name: string;
  membership: RepoMachine["membership"];
  target: RemoteTarget | null;
}
export function compareRepoConfigs(machines: readonly RepoMachine[]) {
  const owners = machines.filter((m) => m.membership !== "absent");
  const available = owners.filter((m) => m.config !== null);
  const applicable = available.every((m) => m.config!.repoConfigCommit === null);
  const unavailableInstanceIds = owners.filter((m) => !m.config).map((m) => m.instanceId);
  const differing = applicable
    ? REPO_RULE_FIELDS.filter((key) => new Set(available.map((m) => m.config![key])).size > 1)
    : [];
  return {
    applicable,
    complete: applicable && unavailableInstanceIds.length === 0 && available.length >= 2,
    unavailableInstanceIds,
    fields: differing.length
      ? available.map((m) => ({
          instanceId: m.instanceId,
          fields: Object.fromEntries(differing.map((key) => [key, m.config![key]])),
        }))
      : [],
    multipleAutoDrain:
      applicable && available.filter((m) => m.config!.autoDrainEnabled).length >= 2
        ? available.filter((m) => m.config!.autoDrainEnabled).map((m) => m.instanceId)
        : [],
  };
}

/** Validate the peer DTO before using it as a source of comparison or shared rules. */
function configView(value: unknown): RepoConfigView | null {
  if (
    !isRecord(value) ||
    !isRecord(value.fieldSources) ||
    !(value.repoConfigCommit === null || typeof value.repoConfigCommit === "string")
  )
    return null;
  const defaults = repoConfigDefaults();
  for (const [key, fallback] of Object.entries(defaults)) {
    if (!(key in value)) return null;
    const v = value[key];
    if (
      fallback !== null &&
      (Array.isArray(fallback) ? !Array.isArray(v) : typeof v !== typeof fallback)
    )
      return null;
  }
  return parseRepoRules(JSON.stringify(value)) ? (value as unknown as RepoConfigView) : null;
}

export class RepoConfigCoordinator {
  constructor(
    private deps: {
      self: { instanceId: string; name: string };
      peers: (slug: string) => RepoPeer[];
      refreshLocal: (slug: string) => Promise<void>;
      local: (slug: string) => RepoConfigView | null | Promise<RepoConfigView | null>;
      fetch?: FetchLike;
    },
  ) {}

  async forward(
    peer: RepoPeer,
    method: string,
    leaf: "machine" | "project" | "refresh" | "roles",
    slug: string,
    body?: string,
  ): Promise<Response> {
    if (!peer.target)
      return Response.json(
        {
          error: "machine is not reachable",
          code: "machine_unreachable",
          instanceId: peer.instanceId,
          reason: "disconnected",
        },
        { status: 502 },
      );
    const query = new URLSearchParams({
      remoteSlug: slug,
      instanceId: peer.instanceId,
      host: "local",
    });
    const result = await requestRemote(
      peer.target,
      `/api/repo-config/${leaf}?${query}`,
      { method, headers: { "content-type": "application/json", accept: "application/json" }, body },
      { fetch: this.deps.fetch, timeoutMs: method === "GET" ? 5_000 : 65_000 },
    );
    if (!result.ok)
      return Response.json(
        {
          error: "machine request failed",
          code: "machine_unreachable",
          instanceId: peer.instanceId,
          reason: result.failure.reason,
        },
        { status: 502 },
      );
    const res = result.response;
    if (!res.headers.get("content-type")?.includes("application/json")) {
      await res.body?.cancel();
      return Response.json(
        { error: "invalid machine response", reason: "bad_response" },
        { status: 502 },
      );
    }
    // Bound JSON reading as well: requestRemote's timer ends at response headers.
    let value: unknown;
    const reader = res.body?.getReader();
    const readJson = async () => {
      if (!reader) throw new Error("empty response");
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode()) as unknown;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      value = await Promise.race([
        readJson(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("timeout"));
            void reader?.cancel().catch(() => {});
          }, 5_000);
        }),
      ]);
    } catch {
      return Response.json(
        { error: "invalid machine response", reason: "bad_response" },
        { status: 502 },
      );
    } finally {
      clearTimeout(timer);
    }
    if (!isRecord(value))
      return Response.json(
        { error: "invalid machine response", reason: "bad_response" },
        { status: 502 },
      );
    if (
      res.ok &&
      ((leaf === "machine" && !configView(value)) || (leaf === "refresh" && value.ok !== true))
    )
      return Response.json(
        { error: "invalid machine response", reason: "bad_response" },
        { status: 502 },
      );
    return Response.json(value, { status: res.status });
  }

  async read(slug: string) {
    const local = await this.deps.local(slug);
    const machines: RepoMachine[] = [
      {
        ...this.deps.self,
        membership: local ? "present" : "absent",
        reachable: true,
        reason: null,
        config: local,
      },
    ];
    const remote = await Promise.all(
      this.deps.peers(slug).map(async (peer): Promise<RepoMachine> => {
        const res = await this.forward(peer, "GET", "machine", slug);
        const body: unknown = await res.json();
        if (res.status === 404 && isRecord(body) && body.code === "repo_not_found")
          return {
            instanceId: peer.instanceId,
            name: peer.name,
            membership: "absent",
            reachable: true,
            reason: null,
            config: null,
          };
        const view = res.ok ? configView(body) : null;
        return {
          instanceId: peer.instanceId,
          name: peer.name,
          membership: view ? "present" : peer.membership === "present" ? "present" : "unknown",
          reachable: !!view,
          reason: view
            ? null
            : res.status === 404
              ? "api_missing"
              : isRecord(body) && typeof body.reason === "string"
                ? body.reason
                : "bad_response",
          config: view,
        };
      }),
    );
    machines.push(...remote);
    const reference = machines.find((m) => m.config);
    const selected = reference?.config?.leitrechner ?? null;
    const lead = machines.find((m) => m.instanceId === selected);
    return {
      remoteSlug: slug,
      complete: machines.every((m) => m.reachable),
      referenceInstanceId: reference?.instanceId ?? null,
      rules: reference?.config ? repoRulesFromConfig(reference.config) : null,
      repoConfigCommit: reference?.config?.repoConfigCommit ?? null,
      pendingRepoConfig: reference?.config?.pendingRepoConfig ?? null,
      leitrechner: selected
        ? { instanceId: selected, name: lead?.name ?? null, reachable: lead?.reachable ?? false }
        : null,
      machines,
      differences: compareRepoConfigs(machines),
    };
  }

  async notify(slug: string, writerInstanceId = this.deps.self.instanceId) {
    const local = [];
    if (writerInstanceId !== this.deps.self.instanceId && (await this.deps.local(slug))) {
      try {
        await this.deps.refreshLocal(slug);
        local.push({ ...this.deps.self, ok: true });
      } catch {
        local.push({ ...this.deps.self, ok: false, reason: "fetch_failed" });
      }
    }
    const remote = await Promise.all(
      this.deps
        .peers(slug)
        .filter((peer) => peer.membership !== "absent")
        .map(async (peer) => {
          const res = await this.forward(peer, "POST", "refresh", slug, "{}");
          const body = (await res.json()) as Record<string, unknown>;
          return {
            instanceId: peer.instanceId,
            name: peer.name,
            ok: res.ok,
            ...(res.ok
              ? {}
              : { reason: typeof body.reason === "string" ? body.reason : "refresh_failed" }),
          };
        }),
    );
    return [...local, ...remote];
  }
}

/** Shared request-body boundary; machine values must never become committed rule keys. */
export function isRulePatch(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).every(isRepoRuleKey) &&
    parseRepoRules(JSON.stringify(value)) !== null
  );
}
