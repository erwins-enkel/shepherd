import type { Steer } from "./types";
import { getSteers, putSteers } from "./api";

/** Backfill surface scopes a pre-scopes payload may omit (e.g. an older backend
 *  during a rolling upgrade), so a steer missing inSteerBar/onIssues defaults to a
 *  bar chip instead of vanishing from every surface. Mirrors the server normalize();
 *  emoji stays optional (server-side migration assigns legacy defaults). */
function normalize(s: Steer & { inSteerBar?: boolean; onIssues?: boolean }): Steer {
  const agentProviders =
    s.agentProviders && s.agentProviders.length === 1 ? s.agentProviders : undefined;
  return {
    ...s,
    inSteerBar: s.inSteerBar ?? true,
    onIssues: s.onIssues ?? false,
    ...(agentProviders ? { agentProviders } : { agentProviders: undefined }),
  };
}

// Client cache of the saved canned steers. Loaded once on app start; every
// mutation persists to the server and adopts the normalized result.
class SteersStore {
  list = $state<Steer[]>([]);
  loaded = $state(false);
  error = $state<string | null>(null);

  async load() {
    try {
      this.list = (await getSteers()).map(normalize);
    } catch (e) {
      this.error = e instanceof Error ? e.message : "failed to load steers";
    } finally {
      this.loaded = true;
    }
  }

  /** Replace the whole list (Settings editor). Persists + adopts the normalized list. */
  async save(next: Steer[]) {
    this.error = null;
    try {
      this.list = (await putSteers(next)).map(normalize);
    } catch (e) {
      this.error = e instanceof Error ? e.message : "failed to save steers";
      throw e;
    }
  }
}

export const steers = new SteersStore();
