import { m } from "#lib/paraglide/messages.js";
import {
  getRepoBootstrap,
  overrideRepoBootstrap,
  putRepoBootstrap,
  type RepoBootstrapView,
} from "#lib/api.js";
import { toasts } from "#lib/toasts.svelte.js";

/**
 * Per-repo project-bootstrap state (#3105) for the automation settings. Loaded on demand per
 * repo; every mutation replaces the view with the server's answer (the server owns the exit
 * predicate, so the client never derives `done` itself). A failed write keeps the old view and
 * says so in a toast.
 */
class RepoBootstrapStore {
  views = $state<Record<string, RepoBootstrapView>>({});
  busy = $state<Record<string, boolean>>({});

  viewFor(repoPath: string): RepoBootstrapView | null {
    return this.views[repoPath] ?? null;
  }

  async load(repoPath: string): Promise<void> {
    try {
      this.#set(repoPath, await getRepoBootstrap(repoPath));
    } catch {
      /* unknown state renders nothing; the next open retries */
    }
  }

  /** The server says `repoPath`'s bootstrap changed (#3112): re-read it when a view shows it. */
  refresh(repoPath: string): void {
    if (this.views[repoPath]) void this.load(repoPath);
  }

  setActive(repoPath: string, on: boolean): Promise<void> {
    return this.#write(repoPath, () =>
      putRepoBootstrap(repoPath, { state: on ? "active" : "off" }),
    );
  }

  setOverride(repoPath: string, on: boolean): Promise<void> {
    return this.#write(repoPath, () => overrideRepoBootstrap(repoPath, on));
  }

  async #write(repoPath: string, op: () => Promise<RepoBootstrapView>): Promise<void> {
    if (this.busy[repoPath]) return;
    this.busy = { ...this.busy, [repoPath]: true };
    try {
      this.#set(repoPath, await op());
    } catch {
      toasts.info(m.automation_bootstrap_failed(), { alert: true });
    } finally {
      this.busy = { ...this.busy, [repoPath]: false };
    }
  }

  #set(repoPath: string, view: RepoBootstrapView) {
    this.views = { ...this.views, [repoPath]: view };
  }
}

export const repoBootstrap = new RepoBootstrapStore();
