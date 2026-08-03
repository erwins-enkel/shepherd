// Shared shapes for the New Task keymap registry.
//
// ONE SOURCE: the registry in ./newTask.ts is the only list of the dialog's
// shortcuts. Four consumers read it and nothing else — the keydown dispatcher,
// the hold-to-reveal keycaps, the full key sheet (`?`), and the
// `aria-keyshortcuts` attribute on each control. Never maintain a second list
// in markup; add a row here and every consumer picks it up.
// See docs/design/keymap-10a/README.md.

/** Grouping in the key sheet, and the rough region of the dialog a shortcut acts on. */
export type KeymapZone = "global" | "prompt" | "context" | "options";

/** A key combination, matched either physically or by character.
 *
 *  `code` (KeyboardEvent.code — the physical key) is the default and the right
 *  choice for every modifier chord, which is the rule the dialog's pre-existing
 *  Alt tier already followed. On macOS, Option+letter produces a special
 *  character in `key` (⌥R → "®") and Option+digit likewise (⌥1 → "¡"), so
 *  matching on `key` would silently miss; `code` stays "KeyR"/"Digit1" on every
 *  layout.
 *
 *  `key` (KeyboardEvent.key — the produced character) is for unmodified
 *  *characters*, where the physical key differs per layout. `?` is the case
 *  that forces this: it is Shift+Slash on a US layout but Shift+Minus on a
 *  German one, so `code: "Slash"` would leave German keyboards — the majority
 *  here — unable to open the key sheet. Set exactly one of `code` / `key`.
 *  A single-character `key` match ignores `shift` (the character already implies
 *  it); a named one ("Enter") still checks it, so ⇧⌘↵ ≠ ⌘↵. Named keys are also
 *  why `key` is right for Enter/Escape: the numeric keypad's Enter reports
 *  code "NumpadEnter", which a code match would silently miss.
 *
 *  `mod` is the platform's PRIMARY modifier: Command on macOS, Control
 *  elsewhere. Keeping it abstract here is what lets one registry row render as
 *  `⌘G` for a Mac and `Strg+G` for a German Windows box. */
export interface Chord {
  code?: string;
  key?: string;
  mod?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** Everything a shortcut needs to know about, and do to, the open dialog.
 *
 *  NewTask.svelte builds this object; the registry only declares. That split is
 *  what keeps the registry a plain data module — unit-testable with a stub ctx,
 *  no component mounting, no Svelte runtime. */
export interface NewTaskKeymapCtx {
  /** Resolved once per dialog, never per keycap — it decides both which
   *  physical modifier arms the reveal and how every label is spelled. */
  isMac: boolean;

  // ── state the `enabled` predicates read ──
  canSubmit: boolean;
  /** The desktop layout is mounted (see NewTask's `mobile`). Most anchors only
   *  exist there, so most rows go dim-but-visible on the mobile layout. */
  desktop: boolean;
  /** Mode is forced by a relaunch/edit-held seed — the mode segment is locked. */
  modeLocked: boolean;
  /** The side list's tab switch will actually flip (mounted + Issues allowed).
   *
   *  These three are deliberately "will the action do something", not "is the
   *  panel around". The side list mounts only with a repo on the desktop rail,
   *  and its filter and rows exist only on the Issues tab — so a flag that meant
   *  merely "mounted" would light ⌘F and ↑↓ on the Commands tab, where they
   *  advertise a key that no-ops. PromptSources answers each one from its own
   *  render conditions; NewTask forwards the answer. */
  sourcesTabReady: boolean;
  /** The issue-filter popover is mounted, so ⌘F has something to open. */
  issueFilterReady: boolean;
  /** At least one FOCUSABLE issue row exists, so ↑↓ lands somewhere. Not the
   *  same as "the list is non-empty": epic-parent rows aren't focusable. */
  issueListReady: boolean;
  /** MicButton decided the browser can dictate (it hides itself otherwise). */
  micAvailable: boolean;
  /** An upload is in flight — the attach button is disabled. */
  uploading: boolean;

  // ── the actions `run` invokes ──
  submit(): void;
  close(): void;
  openSheet(): void;
  focusPrompt(): void;
  /** Focus the prompt and type the token, which opens the matching inline menu. */
  insertToken(token: "#" | "/"): void;
  attach(): void;
  dictate(): void;
  openRepoPicker(): void;
  cycleRepo(dir: 1 | -1): void;
  focusBranch(): void;
  openIssueFilter(): void;
  toggleSourcesTab(): void;
  focusIssueList(): void;
  setMode(mode: "code" | "research" | "epic"): void;
  focusEngine(): void;
  focusModel(): void;
  togglePlanGate(): void;
  toggleAutopilot(): void;
}

/** One shortcut. */
export interface KeymapEntry {
  /** Stable id. Doubles as the DOM hook (`data-keymap="<id>"`) so a test can
   *  assert every rendered keycap maps to exactly one row. */
  id: string;
  zone: KeymapZone;
  /** The key combinations this row DESCRIBES. Rendering reads these; whether we
   *  intercept them is decided by `run`, not by this list. That split lets a row
   *  advertise `⌘V` on a keycap while leaving the browser's own paste completely
   *  alone — intercepting ⌘V would break pasting plain text into the prompt. */
  chords: Chord[];
  /** ARIA key names for rows whose keys are real keys but NOT dispatchable
   *  chords — `↑↓` is the case: giving it chords would make `matchKeymap` hijack
   *  the arrow keys dialog-wide, but the row still has to name itself to a
   *  screen reader. Values are WAI-ARIA key names, joined with a space. */
  ariaKeys?: string[];
  /** Verbatim key label for rows whose keys aren't a chord at all ("#", "/",
   *  "↑↓", "↵", "⌘ halten"). Takes precedence over rendering `chords`. Receives
   *  the platform so the hold row can say "⌘ halten" or "Strg halten". */
  literal?: (isMac: boolean) => string;
  /** Resolves to the localized description. A function, not a string, because
   *  Paraglide messages must be called at render time to honor a locale switch. */
  label: () => string;
  /** Where the KEYCAP sits — this governs the cap only, never the ARIA. `null`
   *  = no cap, because the spec's inventory gives the row none (`?`, `↵`,
   *  "hold ⌘"). Such a row can still be announced on a control: `↵` carries no
   *  cap on an issue row (↑↓ already caps it) yet is named in that row's
   *  `aria-keyshortcuts`, since a11y coverage is per-control and every control
   *  must carry its keys. Every non-null anchor MUST be rendered by a
   *  component; the registry test pins that contract from the DOM side. */
  anchor: string | null;
  enabled(ctx: NewTaskKeymapCtx): boolean;
  /** The action, AND the switch that decides interception: only rows with a
   *  `run` are dispatched from the keydown handler. Rows without one are
   *  documentation — the key still works, it is just somebody else's to handle
   *  (the browser for `⌘V`, a11yDialog for `ESC`, the focused list for `↑↓`). */
  run?(ctx: NewTaskKeymapCtx): void;
}
