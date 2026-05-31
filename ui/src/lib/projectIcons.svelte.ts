import type { ProjectIcons } from "./types";
import { getProjectIcons, putProjectIcon } from "./api";

// Client cache of the repoPath→emoji map. Loaded once on app start; each pick
// persists to the server and adopts the returned map. Live updates from other
// clients arrive via the `project-icons:update` WS event (see store.svelte.ts).
class ProjectIconsStore {
  map = $state<ProjectIcons>({});
  loaded = $state(false);
  error = $state<string | null>(null);

  async load() {
    try {
      this.map = await getProjectIcons();
    } catch (e) {
      this.error = e instanceof Error ? e.message : "failed to load project icons";
    } finally {
      this.loaded = true;
    }
  }

  /** Emoji for a repo path, or null when unset (caller falls back to ▣). */
  iconFor(path: string): string | null {
    return this.map[path] ?? null;
  }

  /** Set ("" or null clears) a project's emoji. Persists + adopts the server map. */
  async set(path: string, emoji: string | null) {
    this.error = null;
    try {
      this.map = await putProjectIcon(path, emoji ?? "");
    } catch (e) {
      this.error = e instanceof Error ? e.message : "failed to save project icon";
      throw e;
    }
  }

  /** Adopt a full map pushed over the WS. */
  apply(map: ProjectIcons) {
    this.map = map;
  }
}

export const projectIcons = new ProjectIconsStore();
