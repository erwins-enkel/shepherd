import { m } from "#lib/paraglide/messages.js";
import {
  getRepoBootstrap,
  overrideRepoBootstrap,
  putRepoBootstrap,
  type RepoBootstrapView,
} from "#lib/api.js";
import { SvelteMap } from "svelte/reactivity";
import { toasts } from "#lib/toasts.svelte.js";

/**
 * Per-repo project-bootstrap state (#3105) for the automation settings. Loaded on demand per
 * repo; every mutation replaces the view with the server's answer (the server owns the exit
 * predicate, so the client never derives `done` itself). A failed write keeps the old view and
 * says so in a toast. Keyed by `SvelteMap`, not a plain object: `repoPath` arrives off the
 * event stream, so it must never become a property name.
 */
class RepoBootstrapStore {
  #views = new SvelteMap<string, RepoBootstrapView>();
  #busy = new SvelteMap<string, boolean>();

  viewFor(repoPath: string): RepoBootstrapView | null {
    return this.#views.get(repoPath) ?? null;
  }

  busyFor(repoPath: string): boolean {
    return this.#busy.get(repoPath) ?? false;
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
    if (this.#views.has(repoPath)) void this.load(repoPath);
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
    if (this.#busy.get(repoPath)) return;
    this.#busy.set(repoPath, true);
    try {
      this.#set(repoPath, await op());
    } catch {
      toasts.info(m.automation_bootstrap_failed(), { alert: true });
    } finally {
      this.#busy.set(repoPath, false);
    }
  }

  #set(repoPath: string, view: RepoBootstrapView) {
    this.#views.set(repoPath, view);
  }
}

export const repoBootstrap = new RepoBootstrapStore();
