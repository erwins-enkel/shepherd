import type { Session, GitState, Epic } from "$lib/types";
import {
  partitionSessions,
  shownSessions,
  flattenByStage,
  type HerdFilter,
} from "./herd-partition";
import { groupSessionsByEpic } from "./epic-grouping";

/** Pure ordering/cycling logic for the herd's keyboard navigation (j/k, g, 1-9).
 *  Sibling of herd-partition.ts: the page-level shortcut handler computes the
 *  rail's visible order here instead of duplicating Herd.svelte's template walk. */

/** Session ids in the exact order the herd rail renders them. Mirrors Herd.svelte's
 *  template: epic groups render at the TOP (in `groupSessionsByEpic` order, each
 *  group's sessions already lifecycle-flattened, a collapsed group contributing
 *  nothing), then the lifecycle sections render over the non-epic `rest` in
 *  `STAGE_ORDER`. Reuses the SAME `groupSessionsByEpic` + `flattenByStage` the
 *  template does, so the rail can never drift from the render.
 *
 *  The trailing epic args default empty: with no epics, `grouped.groups` is empty
 *  and `grouped.rest === shown`, so the output equals the pre-epic behavior
 *  (`flattenByStage(partitionSessions(shownSessions(...)))`) — existing callers and
 *  tests that pass no grouping args see identical order. */
export function railOrder(
  sessions: Session[],
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean = () => false,
  now: number = Date.now(),
  filter: HerdFilter = "all",
  workingBlocked: Record<string, boolean> = {},
  epics: Record<string, Epic> = {},
  activeEpicKeys: Set<string> = new Set(),
  collapsedKeys: Set<string> = new Set(),
): string[] {
  const shown = shownSessions(sessions, filter, isReviewing, workingBlocked);
  const grouped = groupSessionsByEpic(shown, epics, activeEpicKeys, git, isReviewing, now);
  const groupIds = grouped.groups.flatMap((g) =>
    collapsedKeys.has(g.key) ? [] : g.sessions.map((s) => s.id),
  );
  const restIds = flattenByStage(partitionSessions(grouped.rest, git, isReviewing, now)).map(
    (s) => s.id,
  );
  return [...groupIds, ...restIds];
}

/** The id one step (+1 down / -1 up) from `currentId` in `order`, wrapping at
 *  both ends. With nothing selected (or a selection not in the list) a downward
 *  step lands on the first row, an upward step on the last. Null when empty. */
export function cycleId(order: string[], currentId: string | null, step: 1 | -1): string | null {
  if (order.length === 0) return null;
  const idx = currentId ? order.indexOf(currentId) : -1;
  if (idx === -1) return step > 0 ? order[0] : order[order.length - 1];
  return order[(idx + step + order.length) % order.length];
}

/** The Nth (1-based) id in rail order, or null when out of range. */
export function nthId(order: string[], n: number): string | null {
  return Number.isInteger(n) && n >= 1 && n <= order.length ? order[n - 1] : null;
}

/** Maps a physical `KeyboardEvent.code` to the keynav key vocabulary string used
 *  by the page-level shortcut handler (lowercase `e.key`-style), or null if the
 *  code is not part of the Alt+key session-switch combo set.
 *
 *  Single source of truth for Alt+key combos — consumed by BOTH the window
 *  shortcut handler in +page.svelte (to act on the combo) and xterm's
 *  `attachCustomKeyEventHandler` in Viewport.svelte (to suppress the key from
 *  reaching the PTY). Matching on physical `e.code`, not `e.key`, because macOS
 *  Option+J produces "∆" and other layouts vary.
 *
 *  Numpad1–9 are deliberately NOT mapped (asymmetric with the plain-key tier,
 *  which keys off `e.key` and so accepts numpad digits): Alt+numpad-digit is
 *  the Windows OS alt-code input method for typing special characters into the
 *  terminal, and `e.code` reports Numpad1–9 regardless of NumLock — mapping
 *  them would both shadow alt-code entry and ghost-match when the key isn't a
 *  digit at all. */
export function altComboKey(code: string): string | null {
  if (code === "KeyJ") return "j";
  if (code === "KeyK") return "k";
  if (code === "KeyG") return "g";
  if (code === "ArrowDown") return "arrowdown";
  if (code === "ArrowUp") return "arrowup";
  const digitMatch = /^Digit([1-9])$/.exec(code);
  if (digitMatch) return digitMatch[1];
  return null;
}

/** Next blocked session after `currentId` in `blockedIds` (oldest-first, the
 *  NEEDS-YOU set), wrapping around; cycles among several, skips the current one.
 *  Null when none are blocked or the only blocked session is already selected. */
export function nextNeedsYou(blockedIds: string[], currentId: string | null): string | null {
  if (blockedIds.length === 0) return null;
  const idx = currentId ? blockedIds.indexOf(currentId) : -1;
  const start = idx === -1 ? 0 : idx + 1;
  for (let i = 0; i < blockedIds.length; i++) {
    const id = blockedIds[(start + i) % blockedIds.length];
    if (id !== currentId) return id;
  }
  return null;
}

/** Resolve the next needs-you jump target plus the epic group key (if any) that must be
 *  expanded so the target row is visible. `groupOf` maps sessionId → its epic group key.
 *  Keeps the `g`-handler and the NEEDS-YOU jump button DRY: both resolve the target AND
 *  the collapsed-group-to-expand through one tested helper so they can't drift. */
export function nextNeedsYouTarget(
  blockedIds: string[],
  currentId: string | null,
  groupOf: Map<string, string>,
  collapsed: ReadonlySet<string>,
): { id: string | null; expand: string | null } {
  const id = nextNeedsYou(blockedIds, currentId);
  if (id === null) return { id: null, expand: null };
  const key = groupOf.get(id);
  return { id, expand: key != null && collapsed.has(key) ? key : null };
}
