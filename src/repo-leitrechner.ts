import {
  refreshRepoConfigFile,
  invalidateRepoConfigFile,
  repoConfigGitContext,
} from "./repo-config-file";

export interface RepoLeitrechnerStatus {
  instanceId: string | null;
  name: string | null;
  role: "unassigned" | "local" | "remote" | "unknown";
  reachable: boolean | null;
  allowed: boolean;
  pauseReason: "remote_leitrechner" | "leitrechner_unreachable" | "config_refresh_failed" | null;
}

type Deps = {
  config: (repo: string) => { leitrechner?: string | null; repoMode: string };
  self: () => { instanceId: string; name: string };
  remote: (id: string) => { name: string; status: string } | null;
  emit?: (repo: string, status: RepoLeitrechnerStatus) => void;
  fetch?: (repo: string) => Promise<void>;
  context?: (repo: string) => string | null;
  now?: () => number;
};

/** Ownership of new repo-wide jobs only. Session and local epic work never consult this gate. */
export class RepoLeitrechnerService {
  private refreshed = new Map<string, { at: number; ok: boolean }>();
  private inflight = new Map<string, Promise<void>>();
  private published = new Map<string, string>();

  constructor(private deps: Deps) {}

  private key(repo: string): string | null {
    if (this.deps.config(repo).repoMode === "lightweight") return null;
    return this.deps.context ? this.deps.context(repo) : (repoConfigGitContext(repo)?.key ?? null);
  }

  /** Network-free view: an unknown ID intentionally preserves the legacy behavior. */
  status(repo: string): RepoLeitrechnerStatus {
    const key = this.key(repo);
    const owner = this.owner(key ? (this.deps.config(repo).leitrechner ?? null) : null);
    let pauseReason: RepoLeitrechnerStatus["pauseReason"] = null;
    const knownOwner = owner.role === "local" || owner.role === "remote";
    if (knownOwner && key !== null && this.refreshed.get(key)?.ok === false)
      pauseReason = "config_refresh_failed";
    else if (owner.role === "remote")
      pauseReason = owner.reachable ? "remote_leitrechner" : "leitrechner_unreachable";
    return { ...owner, allowed: pauseReason === null, pauseReason };
  }

  private owner(instanceId: string | null): Omit<RepoLeitrechnerStatus, "allowed" | "pauseReason"> {
    if (!instanceId) return { instanceId, name: null, role: "unassigned", reachable: null };
    const self = this.deps.self();
    if (instanceId === self.instanceId)
      return { instanceId, name: self.name, role: "local", reachable: true };
    const remote = this.deps.remote(instanceId);
    if (!remote) return { instanceId, name: null, role: "unknown", reachable: null };
    return {
      instanceId,
      name: remote.name,
      role: "remote",
      reachable: remote.status === "connected",
    };
  }

  /** Every first job after restart fetches, including when a stale local file names this host. */
  async refresh(repo: string): Promise<RepoLeitrechnerStatus> {
    const key = this.key(repo);
    if (key) {
      const previous = this.refreshed.get(key);
      let running = this.inflight.get(key);
      if (!running && (!previous || (this.deps.now ?? Date.now)() - previous.at >= 30_000)) {
        running = (async () => {
          let ok = false;
          try {
            await (this.deps.fetch ?? refreshRepoConfigFile)(repo);
            ok = true;
          } catch {
            // Known ownership fails closed on fetch errors; never disclose Git credentials.
          }
          this.refreshed.set(key, { at: (this.deps.now ?? Date.now)(), ok });
        })();
        this.inflight.set(key, running);
      }
      if (running) {
        await running;
        if (this.inflight.get(key) === running) this.inflight.delete(key);
      }
      if (this.refreshed.get(key)?.ok) invalidateRepoConfigFile(repo);
    }
    return this.publish(repo);
  }

  invalidate(repo: string): void {
    const key = this.key(repo);
    if (key) this.refreshed.delete(key);
    this.publish(repo);
  }

  publish(repo: string): RepoLeitrechnerStatus {
    const status = this.status(repo);
    const signature = JSON.stringify(status);
    if (this.published.get(repo) !== signature) {
      this.published.set(repo, signature);
      this.deps.emit?.(repo, status);
    }
    return status;
  }
}
