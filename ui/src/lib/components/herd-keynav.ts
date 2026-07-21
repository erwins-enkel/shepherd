import type { Session, GitState, Epic } from "$lib/types";
import {
  partitionSessions,
  shownSessions,
  flattenByStage,
  GROUP_KEY_BY_STAGE,
  type HerdFilter,
} from "./herd-partition";
import { groupSessionsByEpic } from "./epic-grouping";
import { groupSessionsByExperiment, type ExperimentGroup } from "./experiment-grouping";

/** Pure ordering/cycling logic for the herd's keyboard navigation (j/k, g, 1-9).
 *  Sibling of herd-partition.ts: the page-level shortcut handler computes the
 *  rail's visible order here instead of duplicating Herd.svelte's template walk. */

/** An experiment group's members in the exact order HerdExperimentGroups renders them
 *  (variants first, then the comparison run). Shared by railOrder and railLocationsOf. */
function experimentMembers(g: ExperimentGroup): Session[] {
  return g.comparison ? [...g.variants, g.comparison] : g.variants;
}

/** Session ids in the exact order the herd rail renders them. Mirrors Herd.svelte's
 *  grouping pipeline: comparison experiments are pulled out FIRST, then epic groups form
 *  over the experiment `rest`, then the lifecycle sections render over the true rest in
 *  `STAGE_ORDER`. The template order is epic groups → experiment groups → lifecycle, with
 *  a collapsed epic group contributing nothing and a collapsed lifecycle stage
 *  (`collapsedStageKeys`, desktop group collapse) dropping ONLY its rest rows — epic and
 *  experiment members stay reachable because their groups render regardless of stage.
 *  Reuses the SAME grouping helpers + `flattenByStage` the template does, so the rail can
 *  never drift from the render.
 *
 *  The trailing epic/collapse args default empty: with no epics and no experiments,
 *  `grouped.groups` is empty and `grouped.rest === shown`, so the output equals the
 *  pre-epic behavior (`flattenByStage(partitionSessions(shownSessions(...)))`) — existing
 *  callers and tests that pass no grouping args see identical order. */
export function railOrder(
  sessions: Session[],
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean,
  isReworkRunning: (session: Session) => boolean,
  now: number = Date.now(),
  filter: HerdFilter = "all",
  workingBlocked: Record<string, boolean> = {},
  epics: Record<string, Epic> = {},
  activeEpicKeys: Set<string> = new Set(),
  collapsedKeys: Set<string> = new Set(),
  collapsedStageKeys: ReadonlySet<string> = new Set(),
): string[] {
  const shown = shownSessions(sessions, filter, isReviewing, workingBlocked, git, now);
  const experimentGrouped = groupSessionsByExperiment(shown);
  const grouped = groupSessionsByEpic(
    experimentGrouped.rest,
    epics,
    activeEpicKeys,
    git,
    isReviewing,
    isReworkRunning,
    now,
  );
  const groupIds = grouped.groups.flatMap((g) =>
    collapsedKeys.has(g.key) ? [] : g.sessions.map((s) => s.id),
  );
  const experimentIds = experimentGrouped.groups.flatMap((g) =>
    experimentMembers(g).map((s) => s.id),
  );
  const restIds = flattenByStage(
    partitionSessions(grouped.rest, git, isReviewing, isReworkRunning, now),
    collapsedStageKeys,
  ).map((s) => s.id);
  return [...groupIds, ...experimentIds, ...restIds];
}

/** Where a session renders in the herd rail: inside an experiment group (never
 *  collapsible), inside an epic group (collapsed via the epic set), or in a lifecycle
 *  section of the rest (collapsed via the desktop stage set, keyed by
 *  GROUP_KEY_BY_STAGE). Sessions not in the input list have no location. */
export type RailLocation =
  { kind: "experiment" } | { kind: "epic"; key: string } | { kind: "stage"; key: string };

/** Classify every session by where it renders, in ONE pass of the exact grouping
 *  pipeline the template (and railOrder) uses: experiments first, epics over the
 *  experiment rest, lifecycle partition over the true rest. Single authority for
 *  "which collapsed group hides this row" — jump handlers expand based on this, so an
 *  experiment member (even one carrying epic metadata) can never open an epic or
 *  lifecycle group it doesn't render in. */
export function railLocationsOf(
  sessions: Session[],
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean,
  isReworkRunning: (session: Session) => boolean,
  now: number,
  epics: Record<string, Epic> = {},
  activeEpicKeys: Set<string> = new Set(),
): Map<string, RailLocation> {
  const experimentGrouped = groupSessionsByExperiment(sessions);
  const grouped = groupSessionsByEpic(
    experimentGrouped.rest,
    epics,
    activeEpicKeys,
    git,
    isReviewing,
    isReworkRunning,
    now,
  );
  const partition = partitionSessions(grouped.rest, git, isReviewing, isReworkRunning, now);
  // Entries array (not .set in a loop) so callers get a plain non-reactive lookup,
  // matching the page's previous epicGroupOf pattern.
  const entries: [string, RailLocation][] = [
    ...experimentGrouped.groups.flatMap((g) =>
      experimentMembers(g).map((s): [string, RailLocation] => [s.id, { kind: "experiment" }]),
    ),
    ...grouped.groups.flatMap((g) =>
      g.sessions.map((s): [string, RailLocation] => [s.id, { kind: "epic", key: g.key }]),
    ),
    ...(Object.keys(GROUP_KEY_BY_STAGE) as (keyof typeof GROUP_KEY_BY_STAGE)[]).flatMap((stage) =>
      partition[stage].map((s): [string, RailLocation] => [
        s.id,
        { kind: "stage", key: GROUP_KEY_BY_STAGE[stage] },
      ]),
    ),
  ];
  return new Map(entries);
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
 *  The combo set: `j`/`k` (+ `arrowdown`/`arrowup`) cycle prev/next, `1`–`9` select
 *  the Nth row, and the session-switch aliases `tab` (Alt+Tab / Alt+Shift+Tab) +
 *  `]`/`[` (Alt+] / Alt+[). This map is
 *  direction-AGNOSTIC: it returns `"tab"` for both Alt+Tab and Alt+Shift+Tab
 *  (Shift is not encoded here). The window handler resolves Tab's direction from
 *  `e.shiftKey` (Tab = next, Shift+Tab = prev); Viewport only needs non-null to
 *  suppress, so returning `"tab"` for both keeps BOTH out of the PTY.
 *
 *  Single source of truth for Alt+key combos — consumed by BOTH the window
 *  shortcut handler in +page.svelte (to act on the combo) and xterm's
 *  `attachCustomKeyEventHandler` in Viewport.svelte (to suppress the key from
 *  reaching the PTY). Matching on physical `e.code`, not `e.key`, because macOS
 *  Option+J produces "∆", Option+] a "'", Option+[ a "”", and other layouts vary.
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
  if (code === "ArrowDown") return "arrowdown";
  if (code === "ArrowUp") return "arrowup";
  if (code === "Tab") return "tab";
  if (code === "BracketRight") return "]";
  if (code === "BracketLeft") return "[";
  const digitMatch = /^Digit([1-9])$/.exec(code);
  if (digitMatch) return digitMatch[1];
  return null;
}

/** Command-bar quick-jump: maps an `Alt`+digit KeyboardEvent to the 0-based index of the
 *  result row to activate, or null when the event is not a bare `Alt`+`Digit` combo.
 *
 *  `Digit1`–`Digit9` → 0–8 and `Digit0` → 9 (the tenth row), so the on-screen hints read
 *  1…9,0. Strict single-Alt — Ctrl/Meta/Shift must all be absent — so it never collides with
 *  the Cmd/Ctrl+K open chord or any Shift-modified combo. Matches on physical `e.code`, not
 *  `e.key`, because macOS Option+1 emits "¡" (and other layouts vary).
 *
 *  `Numpad0`–`Numpad9` are deliberately NOT accepted — the same reason altComboKey drops them:
 *  `Alt`+Numpad is the Windows alt-code text-input method, and `e.code` reports Numpad*
 *  regardless of NumLock, so accepting them would shadow OS alt-code entry. Cmd/Ctrl+digit was
 *  the originally-requested chord but is impossible in a browser (1–9 switch tabs, 0 resets
 *  zoom, all non-cancellable), so `Alt` is the single-modifier substitute. */
export function jumpDigitIndex(e: KeyboardEvent): number | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const m = /^Digit([0-9])$/.exec(e.code);
  if (!m) return null;
  const d = Number(m[1]);
  return d === 0 ? 9 : d - 1;
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

/** The command-bar chord: Cmd/Ctrl+K with no other modifier held. Shared by
 *  +page's onShortcut (which opens the bar) and Viewport's PTY key handler (which
 *  suppresses the byte) so the trigger and its suppression can't drift — and so the
 *  boolean test lives in ONE tested place instead of inflating both hot handlers'
 *  complexity. */
export function isCommandBarChord(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

/** The open-Settings chord: Cmd/Ctrl+, with no other modifier held. Same shared-predicate
 *  split as `isCommandBarChord` above: TopBar's window listener opens Settings while
 *  Viewport's PTY key handler suppresses the byte, so trigger and suppression can't drift. */
export function isSettingsChord(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === ",";
}

/** Display hint for the settings chord — ⌘, on Mac platforms, Ctrl+, elsewhere.
 *  Pure formatter: callers pass `isMacPlatform()` from $lib/platform. */
export function settingsChordHint(mac: boolean): string {
  return mac ? "⌘," : "Ctrl+,";
}
