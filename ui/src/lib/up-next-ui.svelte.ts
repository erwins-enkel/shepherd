import { SvelteMap, SvelteSet } from "svelte/reactivity";
import type { UpNextItem, UpNextPr, UpNextSnapshot } from "./types";

/** Row identity across repos: issue numbers repeat, so key by repoPath#number. */
export const upNextKey = (it: Pick<UpNextItem, "repoPath" | "number">) =>
  `${it.repoPath}#${it.number}`;

/** A PR row's identity — prefixed, so one selection and one preview key hold both kinds. */
export const upNextPrKey = (pr: Pick<UpNextPr, "repoPath" | "number">) =>
  `pr:${pr.repoPath}#${pr.number}`;
export const isPrKey = (key: string | null): boolean => key?.startsWith("pr:") ?? false;

/** The live item for a key, or null once a refresh dropped it (started, closed, filtered). */
export function findUpNextItem(snap: UpNextSnapshot | null, key: string | null): UpNextItem | null {
  if (!snap || key === null) return null;
  for (const s of snap.sections) {
    const hit = s.items.find((it) => upNextKey(it) === key);
    if (hit) return hit;
  }
  return null;
}

/** The live PR row for a key, or null once a refresh dropped it (merged, fixed, filtered). */
export function findUpNextPr(snap: UpNextSnapshot | null, key: string | null): UpNextPr | null {
  if (!snap || key === null) return null;
  return snap.pullRequests?.find((pr) => upNextPrKey(pr) === key) ?? null;
}

/** How long a merged or fixed PR stays hidden while the server's next snapshot catches up. */
export const ACTED_HIDE_MS = 120_000;

/** Up Next state shared by its two surfaces — the rail panel (list) and the main-area preview:
 *  the ticked rows, the row open in the preview, and the panel's row order the preview's ‹ ›
 *  step through. A module singleton so both read one selection, and a pick survives the
 *  panel's remount on a lens switch. */
class UpNextUi {
  readonly selected = new SvelteSet<string>();
  previewKey = $state<string | null>(null);
  order = $state<string[]>([]);
  /** PR keys in on-screen order — the PR preview steps through PRs only. */
  prOrder = $state<string[]>([]);
  /** PR key → when it was merged or handed to a fix session (client clock). */
  readonly acted = new SvelteMap<string, number>();
  /** Dependabot PRs already asked to rebase — never asked twice. */
  readonly rebaseRequested = new SvelteSet<string>();
  /** Dependabot PR key → the head its merge failed at; a new head clears the rebase offer. */
  readonly mergeFailed = new SvelteMap<string, string>();

  toggle(key: string) {
    if (this.selected.has(key)) this.selected.delete(key);
    else this.selected.add(key);
  }

  markActed(key: string, at = Date.now()) {
    this.acted.set(key, at);
    this.selected.delete(key);
  }

  /** Whether a row was just acted on: hidden until the snapshot drops it, or ACTED_HIDE_MS. */
  hidesActed(key: string, now: number): boolean {
    const at = this.acted.get(key);
    return at !== undefined && now - at < ACTED_HIDE_MS;
  }

  /** Whether this PR's merge failed at its current head — its button then offers a rebase. */
  mergeFailedAt(pr: Pick<UpNextPr, "repoPath" | "number" | "headSha">): boolean {
    return pr.headSha !== undefined && this.mergeFailed.get(upNextPrKey(pr)) === pr.headSha;
  }

  /** Test seam: module state otherwise leaks between mounts. */
  reset() {
    this.selected.clear();
    this.previewKey = null;
    this.order = [];
    this.prOrder = [];
    this.acted.clear();
    this.rebaseRequested.clear();
    this.mergeFailed.clear();
  }
}
export const upNextUi = new UpNextUi();
