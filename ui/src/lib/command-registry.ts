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

import { m } from "#lib/paraglide/messages.js";
import { assistantChordHint } from "#lib/components/herd-keynav.js";

export type Command = {
  /** Stable identifier — used as the listbox row key and in tests. */
  id: string;
  /** Localized display label. */
  label: () => string;
  /** Optional localized synonyms, space-joined — searched alongside the label. */
  keywords?: () => string;
  /** Present ⇒ the verb is DESTRUCTIVE and two-step: the first activation arms the row (which
   *  then renders this string) and only a second one runs it. */
  confirmLabel?: () => string;
  /** The armed state spoken by the command bar's polite live region. Names the target, which the
   *  short visible `confirmLabel` drops — a screen-reader user would otherwise lose the
   *  designation the replaced row label carried. Only meaningful alongside `confirmLabel`. */
  confirmAria?: () => string;
  /** Present ⇒ the verb has a global keyboard chord; returns its platform label (⌘J / Ctrl+J),
   *  shown as the row's trailing hint. */
  shortcut?: (mac: boolean) => string;
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
  /** Opens Settings on the Schedules section (every repo's scheduled prompts, #3475). */
  onSchedules: () => void;
  onRetry: () => void;
  onNextNeedsYou: () => void;
  /** Opens the epic-diagnosis entry (repo + arbitrary parent #) — reaches the fully
   *  unrecognized would-be epic that has no on-screen EpicPanel/Diagnose button (#1657). */
  onDiagnoseEpic: () => void;
  /** Opens the Operator Assistant panel (#1446) and hands its terminal the keyboard. */
  onOperatorAssistant: () => void;
  /** Decommission the current session (the page closes over the selected id). */
  onDecommission: () => void;
  /** Designation of the session Decommission would target, or null when the verb is unavailable:
   *  no selection, or a lens where the selected session isn't on screen (Done has its own
   *  selection space; the panel-only lenses render no session list at all). A destructive verb
   *  must never name a target the operator can't see. */
  decommissionDesig: string | null;
  /** Shelve / unshelve the current session (the page closes over the selected id). */
  onToggleShelve: () => void;
  /** Whether the session the shelve verb targets is shelved now — picks Shelve vs Unshelve. Same
   *  target and visibility rule as `decommissionDesig`. */
  selectedShelved: boolean;
  /** store.sessions.length > 0 — Broadcast needs at least one session. */
  hasSessions: boolean;
  /** haltedCount > 0 && usageBelow — mirrors SteerBar's retry chip visibility. */
  retryReady: boolean;
  /** Sessions waiting on the operator other than the one on screen — gates the jump. */
  otherNeedsYouCount: number;
};

/** The verbs available right now, in display order. Filters out any whose availability
 *  predicate is false, so the caller can render the result directly. */
export function buildCommands(ctx: CommandCtx): Command[] {
  // Narrowed before the label closures so `desig` is a plain string inside them.
  const desig = ctx.decommissionDesig;
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
      available: true,
      cmd: {
        id: "schedules",
        label: () => m.commandbar_cmd_schedules(),
        keywords: () => m.commandbar_cmd_schedules_kw(),
        run: ctx.onSchedules,
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
      // Always offered: an assistant that can't run says why inside the panel it opens.
      available: true,
      cmd: {
        id: "operator-assistant",
        label: () => m.commandbar_cmd_operator_assistant(),
        keywords: () => m.commandbar_cmd_operator_assistant_kw(),
        shortcut: assistantChordHint,
        run: ctx.onOperatorAssistant,
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
    {
      available: desig !== null,
      cmd: ctx.selectedShelved
        ? {
            id: "unshelve",
            label: () => m.commandbar_cmd_unshelve({ desig: desig ?? "" }),
            keywords: () => m.commandbar_cmd_shelve_kw(),
            run: ctx.onToggleShelve,
          }
        : {
            id: "shelve",
            label: () => m.commandbar_cmd_shelve({ desig: desig ?? "" }),
            keywords: () => m.commandbar_cmd_shelve_kw(),
            run: ctx.onToggleShelve,
          },
    },
    {
      // Last: the only destructive verb. `desig` is non-null exactly when this is available, so
      // the `?? ""` fallback in the closures is unreachable.
      available: desig !== null,
      cmd: {
        id: "decommission",
        label: () => m.commandbar_cmd_decommission({ desig: desig ?? "" }),
        keywords: () => m.commandbar_cmd_decommission_kw(),
        confirmLabel: () => m.commandbar_cmd_decommission_confirm(),
        confirmAria: () => m.commandbar_cmd_decommission_confirm_aria({ desig: desig ?? "" }),
        run: ctx.onDecommission,
      },
    },
  ];
  return all.filter((c) => c.available).map((c) => c.cmd);
}
