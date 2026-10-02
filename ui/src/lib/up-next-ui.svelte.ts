import { SvelteSet } from "svelte/reactivity";
import type { UpNextItem, UpNextSnapshot } from "./types";

/** Row identity across repos: issue numbers repeat, so key by repoPath#number. */
export const upNextKey = (it: Pick<UpNextItem, "repoPath" | "number">) =>
  `${it.repoPath}#${it.number}`;

/** The live item for a key, or null once a refresh dropped it (started, closed, filtered). */
export function findUpNextItem(snap: UpNextSnapshot | null, key: string | null): UpNextItem | null {
  if (!snap || key === null) return null;
  for (const s of snap.sections) {
    const hit = s.items.find((it) => upNextKey(it) === key);
    if (hit) return hit;
  }
  return null;
}

/** Up Next state shared by its two surfaces — the rail panel (list) and the main-area preview:
 *  the ticked rows, the row open in the preview, and the panel's row order the preview's ‹ ›
 *  step through. A module singleton so both read one selection, and a pick survives the
 *  panel's remount on a lens switch. */
class UpNextUi {
  readonly selected = new SvelteSet<string>();
  previewKey = $state<string | null>(null);
  order = $state<string[]>([]);

  toggle(key: string) {
    if (this.selected.has(key)) this.selected.delete(key);
    else this.selected.add(key);
  }

  /** Test seam: module state otherwise leaks between mounts. */
  reset() {
    this.selected.clear();
    this.previewKey = null;
    this.order = [];
  }
}
export const upNextUi = new UpNextUi();
