// Declarative registry for the command bar's Commands group (#1338 — command bar v2).
//
// Each verb is a small record: a stable `id`, an i18n `label` (+ optional `keywords`
// synonyms), and a `run()` callback. New actions register by adding an entry here rather
// than editing CommandBar.svelte. Availability predicates gate a verb on live app state
// (mirroring the existing UI gates) so an unavailable command simply isn't offered.
//
// The `run()` closures + availability flags come from the page (`+page.svelte`), which
// owns every overlay/view-state signal; `buildCommands` turns that context into the list
// of currently-runnable commands and CommandBar just renders/filters what it's handed.

import { m } from "$lib/paraglide/messages";

export type Command = {
  /** Stable identifier — used as the listbox row key and in tests. */
  id: string;
  /** Localized display label. */
  label: () => string;
  /** Optional localized synonyms, space-joined — searched alongside the label. */
  keywords?: () => string;
  /** Perform the verb (mutates page state, e.g. opens an overlay). */
  run: () => void;
};

/** Live app state + action callbacks the registry needs. Booleans mirror the same gates
 *  the corresponding on-screen affordances use, so the command bar can't offer a verb the
 *  UI itself would hide. */
export type CommandCtx = {
  onNewTask: () => void;
  onBroadcast: () => void;
  onSettings: () => void;
  onUsage: () => void;
  onRetry: () => void;
  onNextNeedsYou: () => void;
  /** Opens the learnings drawer. */
  onLearnings: () => void;
  /** Opens the epic-diagnosis entry (repo + arbitrary parent #) — reaches the fully
   *  unrecognized would-be epic that has no on-screen EpicPanel/Diagnose button (#1657). */
  onDiagnoseEpic: () => void;
  /** store.sessions.length > 0 — Broadcast needs at least one session. */
  hasSessions: boolean;
  /** haltedCount > 0 && usageBelow — mirrors SteerBar's retry chip visibility. */
  retryReady: boolean;
  /** Sessions waiting on the operator other than the one on screen — gates the jump. */
  otherNeedsYouCount: number;
  /** learningsPresent gate (learnings > 0 || learningsCurate > 0) — mirrors the mobile
   *  sheet and desktop badge, so command-bar availability is uniform with those surfaces. */
  hasLearnings: boolean;
};

/** The verbs available right now, in display order. Filters out any whose availability
 *  predicate is false, so the caller can render the result directly. */
export function buildCommands(ctx: CommandCtx): Command[] {
  const all: { available: boolean; cmd: Command }[] = [
    {
      available: true,
      cmd: {
        id: "new-task",
        label: () => m.commandbar_cmd_new_task(),
        keywords: () => m.commandbar_cmd_new_task_kw(),
        run: ctx.onNewTask,
      },
    },
    {
      available: ctx.hasSessions,
      cmd: {
        id: "broadcast",
        label: () => m.commandbar_cmd_broadcast(),
        run: ctx.onBroadcast,
      },
    },
    {
      available: true,
      cmd: {
        id: "settings",
        label: () => m.commandbar_cmd_settings(),
        run: ctx.onSettings,
      },
    },
    {
      available: true,
      cmd: {
        id: "usage",
        label: () => m.commandbar_cmd_usage(),
        keywords: () => m.commandbar_cmd_usage_kw(),
        run: ctx.onUsage,
      },
    },
    {
      available: ctx.hasLearnings,
      cmd: {
        id: "learnings",
        label: () => m.commandbar_cmd_learnings(),
        keywords: () => m.commandbar_cmd_learnings_kw(),
        run: ctx.onLearnings,
      },
    },
    {
      available: ctx.retryReady,
      cmd: {
        id: "retry",
        label: () => m.commandbar_cmd_retry(),
        run: ctx.onRetry,
      },
    },
    {
      // Always available: it targets an ARBITRARY parent number the operator types, so it
      // can't be gated on live state the way the other verbs are.
      available: true,
      cmd: {
        id: "diagnose-epic",
        label: () => m.commandbar_cmd_diagnose_epic(),
        keywords: () => m.commandbar_cmd_diagnose_epic_kw(),
        run: ctx.onDiagnoseEpic,
      },
    },
    {
      available: ctx.otherNeedsYouCount > 0,
      cmd: {
        id: "next-needs-you",
        label: () => m.commandbar_cmd_next_needs_you(),
        keywords: () => m.commandbar_cmd_next_needs_you_kw(),
        run: ctx.onNextNeedsYou,
      },
    },
  ];
  return all.filter((c) => c.available).map((c) => c.cmd);
}
