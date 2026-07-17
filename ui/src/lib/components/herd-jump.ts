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
  /** The page's keyNavSelect — used by selectNextNeedsYou (scrolls the row into view). */
  keyNavSelect: (id: string, focusTerm: boolean) => void;
};

/** Page-specific side effects each handler runs BEFORE locating the target (see the
 *  handler table in createJumpHandlers). Injected so the module stays page-agnostic
 *  and the effects can be spied on in tests. */
export type JumpEffects = {
  /** jumpToSession: leave the backlog + clear the lens/status filters. */
  resetLensAndFilters: () => void;
  /** jumpToSession: collapse the repo filter onto the target's repo. */
  followRepo: (id: string) => void;
  /** selectRundownItem: leave the panel-only Rundown lens. */
  leaveRundown: () => void;
  /** jumpFromHerdrUpdate: close the update modal + clear its run state. */
  beforeHerdrUpdateJump: () => void;
};

/** Reveal-before-select core — the single authority for expanding a collapsed group so
 *  a jump target's row is visible. Fixed order: the caller's effects already ran →
 *  (1) resolve the target's CURRENT location, (2) expand the right collapsed set
 *  (epic → always; stage → desktop only; experiment groups never collapse), (3) if
 *  something expanded, await a tick so the row mounts, (4) select. Selection is a
 *  callback so each handler picks its own select function and options. */
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
  // Only an actual expansion needs the tick (newly-mounted row before scroll); an
  // already-visible target selects synchronously, exactly like a rail click.
  if (expanded) await deps.tick();
  select(id);
}

/** Every global (outside-the-rail) session jump the page performs, built on ONE
 *  reveal-before-select core. Per-handler effects and select variants:
 *
 *  | handler               | effects before locate      | select                          |
 *  | --------------------- | -------------------------- | ------------------------------- |
 *  | jumpToSession         | resetLensAndFilters,       | select(id)                      |
 *  |                       | followRepo(id)             |                                 |
 *  | selectRundownItem     | leaveRundown               | select(id)                      |
 *  | selectFromDeepLink    | —                          | select(id)                      |
 *  | jumpFromHerdrUpdate   | beforeHerdrUpdateJump      | select(id)                      |
 *  | navigateFromViewport  | —                          | select(id)                      |
 *  | retargetForRepoFilter | — (follows a just-set repo | select(id, false, false)        |
 *  |                       | filter; no reset)          |                                 |
 *  | selectNextNeedsYou    | — (target via nextNeedsYou)| keyNavSelect(id, focusTerm)     |
 */
export function createJumpHandlers(deps: JumpDeps, effects: JumpEffects) {
  return {
    jumpToSession: async (id: string): Promise<void> => {
      effects.resetLensAndFilters();
      effects.followRepo(id);
      await revealAndSelect(id, deps, (i) => deps.select(i));
    },
    selectRundownItem: async (id: string): Promise<void> => {
      effects.leaveRundown();
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
      await revealAndSelect(id, deps, (i) => deps.keyNavSelect(i, focusTerm));
    },
  };
}
