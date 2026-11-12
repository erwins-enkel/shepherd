import type { Steer } from "./types";

// The Settings steer editor's working copy of the saved list, and how it follows a store list
// that changes underneath it (another client's save, a settings source's live update — #3967).

export function cloneSteer(s: Steer): Steer {
  return {
    ...s,
    repos: s.repos ? [...s.repos] : undefined,
    agentProviders: s.agentProviders ? [...s.agentProviders] : undefined,
  };
}

/** Trim and normalise an empty repo selection back to "all repos" before persisting. */
export function cleanSteer(s: Steer): Steer {
  return {
    ...s,
    label: s.label.trim(),
    text: s.text.trim(),
    repos: s.repos && s.repos.length ? s.repos : undefined,
  };
}

/** Order-sensitive signature of the persisted shape, so the editor can tell "there are unsaved
 *  changes" from "nothing to do". Tuples (not the objects) so key order can't produce a false
 *  difference; the fields mirror what the server round-trips, so a cleaned payload and the
 *  store's copy of it compare equal. */
export function steersSig(list: readonly Steer[]): string {
  return JSON.stringify(
    list.map((s) => [
      s.id,
      s.label,
      s.text,
      s.emoji ?? "",
      s.inSteerBar,
      s.onIssues,
      s.repos ?? null,
      s.agentProviders ?? null,
    ]),
  );
}

const idsOf = (list: readonly Steer[], keep: (id: string) => boolean): string =>
  list
    .filter((s) => keep(s.id))
    .map((s) => s.id)
    .join("\n");

/** Fold a store list that moved from `before` to `after` into the editor's `draft`. A row the
 *  editor has not touched since `before` follows the store (changed or removed there); a row
 *  edited or added here stays as typed, so the next save sends it. Rows added there appear.
 *  The store's order wins unless the editor reordered. Without this, closing the editor would
 *  save its stale copy over the newer list. */
export function followSteers(
  draft: readonly Steer[],
  before: readonly Steer[],
  after: readonly Steer[],
): Steer[] {
  const was = new Map(before.map((s) => [s.id, steersSig([s])]));
  const now = new Map(after.map((s) => [s.id, s]));
  const kept = draft.flatMap((s) => {
    const base = was.get(s.id);
    if (base === undefined || base !== steersSig([cleanSteer(s)])) return [s];
    const theirs = now.get(s.id);
    if (!theirs) return [];
    return steersSig([theirs]) === base ? [s] : [cloneSteer(theirs)];
  });
  const keptById = new Map(kept.map((s) => [s.id, s]));
  const draftIds = new Set(draft.map((s) => s.id));
  const reordered = idsOf(draft, (id) => was.has(id)) !== idsOf(before, (id) => draftIds.has(id));
  if (reordered) {
    return [...kept, ...after.filter((s) => !keptById.has(s.id) && !was.has(s.id)).map(cloneSteer)];
  }
  // Rows removed here (in `before`, gone from the draft) stay removed.
  const inStoreOrder = after.flatMap((s) => {
    const mine = keptById.get(s.id);
    if (mine) return [mine];
    return was.has(s.id) ? [] : [cloneSteer(s)];
  });
  return [...inStoreOrder, ...kept.filter((s) => !now.has(s.id))];
}
