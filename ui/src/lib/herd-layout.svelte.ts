// The herd rail's grouping (#4228): by lifecycle Stage (default) or by Repo, plus which repo
// sections are collapsed. One singleton so Herd (render) and the page's keyboard nav / jump
// reveal read the same state and can't drift. Both prefs persist; all localStorage access is
// try/caught like EPICS_BAND_KEY in Herd.svelte (private mode / SSR keep it in memory).
import { SvelteSet } from "svelte/reactivity";

export type HerdLayout = "stage" | "repo";

const LAYOUT_KEY = "shepherd:herd-layout";
const COLLAPSED_KEY = "shepherd:herd-repo-collapsed";

function readLayout(): HerdLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "repo" ? "repo" : "stage";
  } catch {
    return "stage";
  }
}

function readCollapsed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the choice stays in-memory only */
  }
}

class HerdLayoutStore {
  layout = $state<HerdLayout>("stage");
  /** Repo section keys (see herd-repo-groups.ts) whose rows are folded. */
  collapsed = new SvelteSet<string>();

  constructor() {
    this.load();
  }

  /** (Re)read both prefs from storage. */
  load() {
    this.layout = readLayout();
    this.collapsed.clear();
    for (const key of readCollapsed()) this.collapsed.add(key);
  }

  setLayout(layout: HerdLayout) {
    this.layout = layout;
    write(LAYOUT_KEY, layout);
  }

  toggleRepo(key: string) {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    this.#persistCollapsed();
  }

  expandRepo(key: string) {
    if (!this.collapsed.delete(key)) return;
    this.#persistCollapsed();
  }

  #persistCollapsed() {
    write(COLLAPSED_KEY, JSON.stringify([...this.collapsed]));
  }
}

export const herdLayout = new HerdLayoutStore();
