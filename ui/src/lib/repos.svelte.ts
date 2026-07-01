import type { RepoEntry } from "./types";
import { listRepos } from "./api";

// Client cache of the repo index. Loaded once on app start. Repos are keyed by NAME
// (the dir listRepos enumerates under repoRoot) — the map below resolves EITHER path
// form (raw `join(repoRoot, name)` or realpath, see RepoEntry.realPath) to that name,
// since session.repoPath is realpath-resolved while listRepos/backlog use the raw form.
class ReposStore {
  entries = $state<RepoEntry[]>([]);
  loaded = $state(false);
  error = $state<string | null>(null);

  async load() {
    try {
      this.entries = (await listRepos()).repos;
    } catch (e) {
      this.error = e instanceof Error ? e.message : "failed to load repos";
    } finally {
      this.loaded = true;
    }
  }

  /** path/realPath → name, so a caller holding either form resolves to the same entry. */
  pathIndex = $derived(
    new Map<string, string>(
      this.entries.flatMap((e) => [[e.path, e.name] as const, [e.realPath, e.name] as const]),
    ),
  );

  /** Resolved repo name for a path in either form, or null when unknown. */
  nameFor(repoPath: string): string | null {
    return this.pathIndex.get(repoPath) ?? null;
  }

  /** Sorted, unique repo names — the allowlist picker's candidate set. */
  knownNames = $derived([...new Set(this.entries.map((e) => e.name))].sort());
}

export const repos = new ReposStore();
