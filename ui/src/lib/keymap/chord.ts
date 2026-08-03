// Chord matching and labelling.
//
// Two renderings of the same Chord, deliberately kept apart:
//   • chordLabel()      — what a human reads on a keycap ("⌘G" / "Strg+G")
//   • ariaKeyshortcuts() — what a screen reader consumes ("Meta+G" / "Control+G")
// The ARIA form is specified by WAI-ARIA and is NOT localizable; the visible
// form is, hence the message keys for the modifier names.

import { m } from "$lib/paraglide/messages";
import type { Chord } from "./types";

/** True when this event is the chord. Matches on `code` (physical key) by
 *  default, or on `key` (produced character) for layout-dependent characters —
 *  see the note in types.ts for why each is wrong for the other's case.
 *
 *  Both platform modifiers are checked: the non-primary one must be UP. Without
 *  that, ⌃G on a Mac would also fire the ⌘G row (Control is not the primary
 *  modifier there, so it would otherwise go unexamined). */
export function chordMatches(chord: Chord, e: KeyboardEvent, isMac: boolean): boolean {
  if (chord.key !== undefined) {
    if (e.key !== chord.key) return false;
  } else if (e.code !== chord.code) {
    return false;
  }
  const primary = isMac ? e.metaKey : e.ctrlKey;
  const secondary = isMac ? e.ctrlKey : e.metaKey;
  if (secondary) return false;
  if (primary !== !!chord.mod) return false;
  if (e.altKey !== !!chord.alt) return false;
  // Shift is checked EXCEPT for single-character `key` chords, where the shift
  // state is already baked into the character ("?" is only ever reachable with
  // it, on some layouts). Named keys ("Enter", "ArrowUp") are multi-character
  // and stay checked, so ⇧⌘↵ can never be mistaken for ⌘↵.
  const shiftIsImplicit = chord.key !== undefined && chord.key.length === 1;
  if (!shiftIsImplicit && e.shiftKey !== !!chord.shift) return false;
  return true;
}

/** The key name alone, without modifiers. Unicode glyphs match the rest of
 *  Shepherd's iconography (see the spec's Assets section — no image assets). */
function keyLabel(chord: Chord): string {
  const name = keyName(chord);
  if (name === "Enter") return "↵";
  if (name === "Escape") return "ESC";
  if (name === "ArrowUp") return "↑";
  if (name === "ArrowDown") return "↓";
  return name;
}

/** The chord's key as a name, whichever way it was declared. */
function keyName(chord: Chord): string {
  if (chord.key !== undefined) return chord.key;
  const code = chord.code ?? "";
  if (code === "BracketLeft") return "[";
  if (code === "BracketRight") return "]";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

/** Human-readable chord for a keycap or the key sheet.
 *
 *  macOS composes glyphs with no separator (⌘⇧A) the way the system menus do;
 *  everywhere else the modifier names are words and need a separator
 *  (Strg+Umschalt+A). The spec accounts for the extra width — the PC keycap
 *  drops to 9px with wider padding, handled in Keycap.svelte. */
export function chordLabel(chord: Chord, isMac: boolean): string {
  const parts: string[] = [];
  // Order matches the platform conventions: ⌃⌥⇧⌘ on macOS collapses to ⌥⇧⌘
  // here (we never use Control as a secondary), Ctrl+Alt+Shift on PC.
  if (isMac) {
    if (chord.alt) parts.push("⌥");
    if (chord.shift) parts.push("⇧");
    if (chord.mod) parts.push("⌘");
    return parts.join("") + keyLabel(chord);
  }
  if (chord.mod) parts.push(m.keymap_mod_ctrl());
  if (chord.alt) parts.push(m.keymap_mod_alt());
  if (chord.shift) parts.push(m.keymap_mod_shift());
  parts.push(keyLabel(chord));
  return parts.join("+");
}

/** The primary modifier's own glyph/word — for the footer hint and the "hold"
 *  row, which name the modifier without naming a key. */
export function modLabel(isMac: boolean): string {
  return isMac ? "⌘" : m.keymap_mod_ctrl();
}

/** ARIA key name for a chord. WAI-ARIA wants the KeyboardEvent.key value, so
 *  arrows and Enter/Escape keep their spec names rather than glyphs. */
function ariaKeyName(chord: Chord): string {
  return keyName(chord);
}

/** `aria-keyshortcuts` value for a set of chords — the semantic source of truth
 *  for assistive tech (the keycaps themselves are aria-hidden decoration).
 *  Space-separated per the ARIA spec when a control has several. */
export function ariaKeyshortcuts(chords: Chord[], isMac: boolean): string | undefined {
  if (chords.length === 0) return undefined;
  return chords
    .map((c) => {
      const parts: string[] = [];
      if (c.mod) parts.push(isMac ? "Meta" : "Control");
      if (c.alt) parts.push("Alt");
      if (c.shift) parts.push("Shift");
      parts.push(ariaKeyName(c));
      return parts.join("+");
    })
    .join(" ");
}
