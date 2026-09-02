import { nextNeedsYou, type RailLocation } from "./herd-keynav";

/** Dependencies for the jump handlers. Every value that can change after the factory
 *  runs is a LIVE GETTER (`locate`, `selectedId`, `blockedIds`, `isDesktop`) — the
 *  handlers re-read them on every jump, never capturing a snapshot at creation time.
 *  The collapsed sets are live references used only for `has` checks; the actual
 *  mutation goes through `expandEpic`/`expandStage` so the page can keep its epic
 *  touched-key bookkeeping (expandEpicGroup) in ONE place. */
export type JumpDeps = {
  /** Fresh rail locations — read AFTER a path's effects ran, so a target the active
   *  repo/status filter hid becomes locatable once the effects reset those filters. */
  locate: () => ReadonlyMap<string, RailLocation>;
  selectedId: () => string | null;
  /** NEEDS-YOU walk source (oldest-first), for selectNextNeedsYou's target choice. */
  blockedIds: () => string[];
  /** Desktop layout gate: the lifecycle-stage collapse is desktop-only state, so
   *  mobile jumps must never mutate it (the phone accordion is Herd-internal). */
  isDesktop: () => boolean;
  collapsedEpics: ReadonlySet<string>;
  collapsedStages: ReadonlySet<string>;
  expandEpic: (key: string) => void;
  expandStage: (key: string) => void;
  tick: () => Promise<void>;
  /** The page's selectUnit — default select for direct jumps. */
  select: (id: string, focusTerm?: boolean, toDetail?: boolean) => void;
  /** The page's keyNavSelect — used by selectNextNeedsYou. Passes scroll=false: the
   *  reveal step below owns the scroll for every jump, and keyNavSelect's own
   *  `block: "nearest"` would otherwise land the row at a rail edge and leave it there
   *  (the reveal would then judge it already-visible and never centre it). */
  keyNavSelect: (id: string, focusTerm: boolean, scroll?: boolean) => void;
  /** Scroll the now-selected row into view and flash it, so the rail can never appear
   *  to disagree with the session the terminal is showing. The DOM half of the jump. */
  revealRow: (id: string) => void;
};

/** Page-specific side effects each handler runs BEFORE locating the target (see the
 *  handler table in createJumpHandlers). Injected so the module stays page-agnostic
 *  and the effects can be spied on in tests. */
export type JumpEffects = {
  /** jumpToSession: leave the backlog + clear the lens/status filters. */
  resetLensAndFilters: () => void;
  /** jumpToSession: collapse the repo filter onto the target's repo. */
  followRepo: (id: string) => void;
  /** jumpFromHerdrUpdate: close the update modal + clear its run state. */
  beforeHerdrUpdateJump: () => void;
};

/** Reveal-before-select core — the single authority for getting a jump target's row
 *  on screen. Fixed order: the caller's effects already ran →
 *  (1) resolve the target's CURRENT location, (2) expand the right collapsed set
 *  (epic → always; stage → desktop only; experiment groups never collapse), (3) if
 *  something expanded, await a tick so the row mounts, (4) select, (5) await a tick and
 *  reveal. Selection is a callback so each handler picks its own select function and
 *  options.
 *
 *  The trailing tick is unconditional, unlike the one in step 3: every handler's effects
 *  mutate page state (lens, status/repo filters, the backlog overlay) BEFORE selecting,
 *  and revealRow queries the DOM for the row — so the re-render those mutations queued
 *  must be flushed first, or a jump out of a filtered view would silently reveal
 *  nothing. */
export async function revealAndSelect(
  id: string,
  deps: JumpDeps,
  select: (id: string) => void,
): Promise<void> {
  const loc = deps.locate().get(id);
  let expanded = false;
  if (loc?.kind === "epic" && deps.collapsedEpics.has(loc.key)) {
    deps.expandEpic(loc.key);
    expanded = true;
  } else if (loc?.kind === "stage" && deps.isDesktop() && deps.collapsedStages.has(loc.key)) {
    deps.expandStage(loc.key);
    expanded = true;
  }
  // Only an actual expansion needs THIS tick (the row must mount before it can be
  // selected); an already-visible target selects synchronously, like a rail click.
  if (expanded) await deps.tick();
  select(id);
  await deps.tick();
  deps.revealRow(id);
}

/** Every global (outside-the-rail) session jump the page performs, built on ONE
 *  reveal-before-select core — so all of them scroll to and flash their target, and none
 *  can leave the rail showing a different session than the terminal. Rail-internal
 *  selection (a click, j/k) deliberately does NOT come through here: the operator's own
 *  pointer or cursor walk already told them where they landed.
 *
 *  Per-handler effects and select variants (every one then ticks and reveals):
 *
 *  | handler               | effects before locate      | select                          |
 *  | --------------------- | -------------------------- | ------------------------------- |
 *  | jumpToSession         | resetLensAndFilters,       | select(id)                      |
 *  |                       | followRepo(id)             |                                 |
 *  | selectFromDeepLink    | —                          | select(id)                      |
 *  | jumpFromHerdrUpdate   | beforeHerdrUpdateJump      | select(id)                      |
 *  | navigateFromViewport  | —                          | select(id)                      |
 *  | retargetForRepoFilter | — (follows a just-set repo | select(id, false, false)        |
 *  |                       | filter; no reset)          |                                 |
 *  | selectNextNeedsYou    | — (target via nextNeedsYou)| keyNavSelect(id, focusTerm, no  |
 *  |                       |                            | scroll — the reveal owns it)    |
 */
export function createJumpHandlers(deps: JumpDeps, effects: JumpEffects) {
  return {
    jumpToSession: async (id: string): Promise<void> => {
      effects.resetLensAndFilters();
      effects.followRepo(id);
      await revealAndSelect(id, deps, (i) => deps.select(i));
    },
    selectFromDeepLink: async (id: string): Promise<void> => {
      await revealAndSelect(id, deps, (i) => deps.select(i));
    },
    jumpFromHerdrUpdate: async (id: string): Promise<void> => {
      effects.beforeHerdrUpdateJump();
      await revealAndSelect(id, deps, (i) => deps.select(i));
    },
    navigateFromViewport: async (id: string): Promise<void> => {
      await revealAndSelect(id, deps, (i) => deps.select(i));
    },
    retargetForRepoFilter: async (id: string): Promise<void> => {
      // toDetail=false: filtering the list must not fling a phone user into a terminal.
      await revealAndSelect(id, deps, (i) => deps.select(i, false, false));
    },
    selectNextNeedsYou: async (focusTerm = true): Promise<void> => {
      const id = nextNeedsYou(deps.blockedIds(), deps.selectedId());
      if (id === null) return;
      await revealAndSelect(id, deps, (i) => deps.keyNavSelect(i, focusTerm, false));
    },
  };
}
