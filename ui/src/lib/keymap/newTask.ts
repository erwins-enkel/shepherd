// THE registry for the New Task dialog's shortcuts.
//
// This array is the single source for all four consumers — the keydown
// dispatcher, the hold-to-reveal keycaps, the `?` key sheet and every
// control's `aria-keyshortcuts`. Adding a shortcut means adding a row here and
// rendering <Keycap id="…"> at its anchor; nothing else. If you find yourself
// hard-coding a key label in markup, that's the bug this module exists to
// prevent.
//
// Ordering is the sheet's reading order: zone by zone, and within a zone the
// order the spec's inventory table uses.
// See docs/design/keymap-10a/README.md → "Kürzel-Inventar (kanonisch)".

import { m } from "$lib/paraglide/messages";
import { chordMatches, modLabel } from "./chord";
import type { Chord, KeymapEntry } from "./types";

const KEYMAP_ZONES = ["global", "prompt", "context", "options"] as const;

export function zoneLabel(zone: (typeof KEYMAP_ZONES)[number]): string {
  switch (zone) {
    case "global":
      return m.keymap_zone_global();
    case "prompt":
      return m.keymap_zone_prompt();
    case "context":
      return m.keymap_zone_context();
    case "options":
      return m.keymap_zone_options();
  }
}

const always = () => true;

export const NEW_TASK_KEYMAP: KeymapEntry[] = [
  // ── global ──────────────────────────────────────────────────────────────
  {
    id: "submit",
    zone: "global",
    chords: [{ key: "Enter", mod: true }],
    label: () => m.keymap_submit(),
    anchor: "primary button",
    enabled: (c) => c.canSubmit,
    run: (c) => c.submit(),
  },
  {
    // No `run`: Escape belongs to the shared `use:dialog` action, which every
    // Shepherd modal uses and which already implements the "an inner handler
    // that consumed Escape wins" contract (the key sheet and the inline menus
    // rely on it). Pulling it in here would double-close. The row exists so the
    // ✕ still gets a keycap and `aria-keyshortcuts`.
    id: "close",
    zone: "global",
    chords: [{ key: "Escape" }],
    label: () => m.keymap_close(),
    anchor: "header ✕",
    enabled: always,
  },
  {
    // Documentation-only: the reveal is driven by holding the modifier, which
    // is a state machine (hold.svelte.ts), not a chord to dispatch.
    id: "hold",
    zone: "global",
    chords: [],
    literal: (isMac) => `${modLabel(isMac)} ${m.keymap_hold_verb()}`,
    label: () => m.keymap_hold(),
    anchor: null,
    enabled: always,
  },
  {
    id: "sheet",
    zone: "global",
    chords: [{ key: "?" }],
    literal: () => "?",
    label: () => m.keymap_sheet(),
    anchor: null,
    enabled: always,
    run: (c) => c.openSheet(),
  },

  // ── prompt ──────────────────────────────────────────────────────────────
  {
    id: "focus-prompt",
    zone: "prompt",
    chords: [{ code: "KeyP", mod: true }],
    label: () => m.keymap_focus_prompt(),
    anchor: "PROMPT label row",
    enabled: always,
    run: (c) => c.focusPrompt(),
  },
  {
    // `#` and `/` are ordinary typed characters that open an inline menu, so
    // there is no chord to intercept. They keep a `run` anyway: it is what the
    // ⌘-held keycap flash and any future "activate from the sheet" path invoke,
    // and it is the honest description of what the key does.
    id: "issue-token",
    zone: "prompt",
    chords: [],
    literal: () => "#",
    // A printable character is its own ARIA key name. Needed because `chords` is
    // empty (nothing to intercept), yet the prompt still has to name the key.
    ariaKeys: ["#"],
    label: () => m.keymap_issue_token(),
    anchor: "PROMPT label row",
    enabled: always,
    run: (c) => c.insertToken("#"),
  },
  {
    id: "command-token",
    zone: "prompt",
    chords: [],
    literal: () => "/",
    ariaKeys: ["/"],
    label: () => m.keymap_command_token(),
    anchor: "PROMPT label row",
    enabled: always,
    run: (c) => c.insertToken("/"),
  },
  {
    // The browser's own paste, already handled by a window `paste` listener.
    // Documented so users learn it exists; never intercepted — hijacking ⌘V
    // would break pasting plain text into the prompt.
    id: "paste-image",
    zone: "prompt",
    chords: [{ code: "KeyV", mod: true }],
    label: () => m.keymap_paste_image(),
    anchor: "PROMPT label row",
    enabled: always,
  },
  {
    id: "attach",
    zone: "prompt",
    chords: [{ code: "KeyU", mod: true }],
    label: () => m.keymap_attach(),
    anchor: "↥ button",
    enabled: (c) => !c.uploading,
    run: (c) => c.attach(),
  },
  {
    id: "dictate",
    zone: "prompt",
    chords: [{ code: "KeyD", mod: true }],
    label: () => m.keymap_dictate(),
    anchor: "🎙 button",
    enabled: (c) => c.micAvailable,
    run: (c) => c.dictate(),
  },

  // ── context ─────────────────────────────────────────────────────────────
  {
    id: "repo",
    zone: "context",
    chords: [{ code: "KeyR", alt: true }],
    label: () => m.keymap_repo(),
    anchor: "repo chip",
    enabled: always,
    run: (c) => c.openRepoPicker(),
  },
  {
    id: "branch",
    zone: "context",
    chords: [{ code: "KeyB", alt: true }],
    label: () => m.keymap_branch(),
    anchor: "branch chip",
    enabled: (c) => c.desktop,
    run: (c) => c.focusBranch(),
  },
  {
    // Pre-existing repo cycling, folded into the registry so the sheet is the
    // complete truth. No keycap — the spec's inventory gives it no anchor, and
    // the repo chip already carries ⌥R.
    id: "repo-prev",
    zone: "context",
    chords: [{ code: "BracketLeft", alt: true }],
    label: () => m.keymap_repo_prev(),
    anchor: null,
    enabled: always,
    run: (c) => c.cycleRepo(-1),
  },
  {
    id: "repo-next",
    zone: "context",
    chords: [{ code: "BracketRight", alt: true }],
    label: () => m.keymap_repo_next(),
    anchor: null,
    enabled: always,
    run: (c) => c.cycleRepo(1),
  },
  {
    id: "issue-filter",
    zone: "context",
    chords: [{ code: "KeyF", mod: true }],
    label: () => m.keymap_issue_filter(),
    anchor: "Filter chip",
    enabled: (c) => c.issueFilterReady,
    run: (c) => c.openIssueFilter(),
  },
  {
    id: "sources-tab",
    zone: "context",
    chords: [{ code: "KeyT", alt: true }],
    label: () => m.keymap_sources_tab(),
    anchor: "Issues/Commands switch",
    enabled: (c) => c.sourcesTabReady,
    run: (c) => c.toggleSourcesTab(),
  },
  {
    // ↑↓ are consumed by whichever list has focus (the side list, or the inline
    // `#`/`/` menu). No chord here — `run` moves focus INTO the list, which is
    // what makes the keycap on the first row honest.
    id: "list-nav",
    zone: "context",
    chords: [],
    literal: () => "↑↓",
    ariaKeys: ["ArrowUp", "ArrowDown"],
    label: () => m.keymap_list_nav(),
    anchor: "first issue row",
    enabled: (c) => c.issueListReady,
    run: (c) => c.focusIssueList(),
  },
  {
    id: "list-pick",
    zone: "context",
    chords: [],
    literal: () => "↵",
    ariaKeys: ["Enter"],
    label: () => m.keymap_list_pick(),
    anchor: null,
    enabled: (c) => c.issueListReady,
  },

  // ── options ─────────────────────────────────────────────────────────────
  {
    id: "mode-code",
    zone: "options",
    chords: [{ code: "Digit1", alt: true }],
    label: () => m.keymap_mode_code(),
    anchor: "mode segment · Code",
    enabled: always,
    run: (c) => c.setMode("code"),
  },
  {
    id: "mode-research",
    zone: "options",
    chords: [{ code: "Digit2", alt: true }],
    label: () => m.keymap_mode_research(),
    anchor: "mode segment · Research",
    enabled: always,
    run: (c) => c.setMode("research"),
  },
  {
    id: "mode-epic",
    zone: "options",
    chords: [{ code: "Digit3", alt: true }],
    label: () => m.keymap_mode_epic(),
    anchor: "mode segment · Epic",
    enabled: always,
    run: (c) => c.setMode("epic"),
  },
  {
    id: "engine",
    zone: "options",
    chords: [{ code: "KeyE", mod: true }],
    label: () => m.keymap_engine(),
    anchor: "engine select",
    enabled: (c) => c.desktop,
    run: (c) => c.focusEngine(),
  },
  {
    // ⌥M, not ⌘M: Command+M is macOS "minimize window", a window-level action
    // the page cannot preventDefault. A keycap must not promise what won't
    // happen. See docs/design/keymap-10a/IMPLEMENTATION-PLAN.md, deviation 2.
    id: "model",
    zone: "options",
    chords: [{ code: "KeyM", alt: true }],
    label: () => m.keymap_model(),
    anchor: "model select",
    enabled: (c) => c.desktop,
    run: (c) => c.focusModel(),
  },
  {
    id: "plan-gate",
    zone: "options",
    chords: [{ code: "KeyG", mod: true }],
    label: () => m.keymap_plan_gate(),
    anchor: "plan-gate row",
    enabled: (c) => c.desktop && !c.modeLocked,
    run: (c) => c.togglePlanGate(),
  },
  {
    // ⌥A, not ⌘⇧A: Command+Shift+A is Chrome's tab search — same reasoning as
    // ⌥M above.
    id: "autopilot",
    zone: "options",
    chords: [{ code: "KeyA", alt: true }],
    label: () => m.keymap_autopilot(),
    anchor: "autopilot row",
    enabled: (c) => c.desktop && !c.modeLocked,
    run: (c) => c.toggleAutopilot(),
  },
];

const BY_ID = new Map(NEW_TASK_KEYMAP.map((e) => [e.id, e]));

export function keymapEntry(id: string): KeymapEntry {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error(`unknown keymap entry: ${id}`);
  return entry;
}

/** Find the entry this event triggers, if any.
 *
 *  Only rows with a `run` are candidates — rows that merely DESCRIBE a key
 *  (⌘V, ESC) must fall through to whoever really owns it.
 *
 *  Returns the entry even when it is currently disabled, so the caller can
 *  still swallow the chord — a disabled ⌘G must not fall through to the
 *  browser's "find again". The caller checks `enabled` before running. */
export function matchKeymap(e: KeyboardEvent, isMac: boolean): KeymapEntry | null {
  for (const entry of NEW_TASK_KEYMAP) {
    if (!entry.run) continue;
    for (const chord of entry.chords) {
      if (chordMatches(chord, e, isMac)) return entry;
    }
  }
  return null;
}

/** Entries grouped for the key sheet, in zone order. */
export function keymapByZone(): { zone: (typeof KEYMAP_ZONES)[number]; entries: KeymapEntry[] }[] {
  return KEYMAP_ZONES.map((zone) => ({
    zone,
    entries: NEW_TASK_KEYMAP.filter((e) => e.zone === zone),
  }));
}

/** Every chord in the registry, for the duplicate guard in the unit test. */
export function allChords(): { id: string; chord: Chord }[] {
  return NEW_TASK_KEYMAP.flatMap((e) => e.chords.map((chord) => ({ id: e.id, chord })));
}
