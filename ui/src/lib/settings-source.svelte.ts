import type { SettingsSource } from "./types";
import { ApiError, getSettingsSource, putSettingsSource } from "./api";
import { repos } from "./repos.svelte";
import { steers } from "./steers.svelte";
import { projectIcons } from "./projectIcons.svelte";
import { steerRepoNames, type SteerRepoNames } from "./steer-scope";
import { m } from "#lib/paraglide/messages.js";

// The connected machine whose steers and repo emojis this Shepherd uses live (#3967). The server
// reads and writes through to it; this store only knows WHICH machine, whether it is reachable
// (else steers and emojis are its last known state, read-only) and its checkouts, which its
// repo-bound steers name. Loaded on app start, pushed over the WS (`settings-source:update`).
class SettingsSourceStore {
  source = $state<SettingsSource | null>(null);
  loaded = $state(false);

  /** A source is set but out of reach: steers and emojis are its last known state, read-only. */
  readOnly = $derived(this.source !== null && !this.source.reachable);

  async load() {
    // The first load rides along with the app's own steers + emojis load: nothing to re-read.
    const first = !this.loaded;
    try {
      const next = await getSettingsSource();
      if (first) this.source = next;
      else this.#adopt(next);
    } catch {
      // keep what we had: no source known ⇒ this Shepherd's own steers, as before
    } finally {
      this.loaded = true;
    }
  }

  /** Adopt the source pushed over the WS. */
  apply(next: SettingsSource | null) {
    this.#adopt(next);
    this.loaded = true;
  }

  /** Pick a machine as the source, or `null` for this Shepherd's own. Throws on failure. */
  async set(instanceId: string | null) {
    this.#adopt(await putSettingsSource(instanceId), true);
  }

  /** On reconnect: the source may have changed, and with one set its steers and emojis may have
   *  changed while no events reached us. */
  async resync() {
    const had = this.source !== null;
    try {
      this.source = await getSettingsSource();
    } catch {
      // keep what we had
    } finally {
      this.loaded = true;
    }
    if (had || this.source) this.#reloadSettings();
  }

  #adopt(next: SettingsSource | null, force = false) {
    const prev = this.source;
    this.source = next;
    const switched = (prev?.instanceId ?? null) !== (next?.instanceId ?? null);
    const reconnected = !!prev && !!next && !switched && !prev.reachable && next.reachable;
    // Steers and emojis now come from somewhere else (or fresh again): re-read both.
    if (force || switched || reconnected) this.#reloadSettings();
  }

  #reloadSettings() {
    void steers.refresh();
    void projectIcons.load();
  }
}

export const settingsSource = new SettingsSourceStore();

/** The names a steer's repo allowlist may use for the checkout at `repoPath`: its local name
 *  without a settings source; with one, the source machine's names for it (by its own path for
 *  a mirrored session, else by forge slug). Feed it to `steerAppliesToRepo`. */
export function steerRepoNamesFor(repoPath: string): SteerRepoNames {
  const source = settingsSource.source;
  if (!source) return repos.nameFor(repoPath);
  return steerRepoNames(
    { path: repoPath, localName: repos.nameFor(repoPath), slug: repos.slugFor(repoPath) },
    source.repos,
  );
}

/** Words for a failed steers / emoji read or write: the settings-source refusals by code,
 *  anything else by its own message. */
export function settingsSourceErrorText(e: unknown): string {
  const code = e instanceof ApiError ? e.code : undefined;
  if (code === "settings_source_unreachable") return m.settings_source_err_unreachable();
  if (code === "settings_source_failed") return m.settings_source_err_failed();
  if (code === "settings_source_no_repo") return m.settings_source_err_no_repo();
  return e instanceof Error ? e.message : String(e);
}
