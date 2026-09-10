/** Resolve the open amend-task dialog's target against the live herd (#2225).
 *
 *  The dialog is addressed by session ID, but the row can leave `store.sessions` underneath it —
 *  archive, decommission, clear-merged. Two things then have to happen, and conflating them is
 *  what made this a bug: the dialog must UNMOUNT (no target), and the held id must be CLEARED.
 *
 *  Keeping the id after its row is gone is not inert. The page's "is any overlay open?" test
 *  gates every global shortcut, so an id that outlives its row wedges the command bar and the
 *  settings chord until a reload; and because `restore` brings a session back under the SAME id,
 *  a stale id would silently re-open the dialog later. Hence `stale` — the caller drops the id on
 *  it, and tests `target` (what is mounted) for the overlay gate.
 */
export function amendTargetState<T extends { id: string }>(
  id: string | null,
  sessions: readonly T[],
): { target: T | null; stale: boolean } {
  if (!id) return { target: null, stale: false };
  const target = sessions.find((s) => s.id === id) ?? null;
  return { target, stale: target === null };
}
