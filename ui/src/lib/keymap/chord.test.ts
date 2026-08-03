import { describe, expect, it } from "vitest";
import { ariaKeyshortcuts, chordLabel, chordMatches, modLabel } from "./chord";
import type { Chord } from "./types";

function ev(init: Partial<KeyboardEvent> & { code?: string; key?: string }): KeyboardEvent {
  return {
    code: "",
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("chordMatches", () => {
  const modG: Chord = { code: "KeyG", mod: true };

  it("maps the primary modifier to Meta on macOS and Control elsewhere", () => {
    expect(chordMatches(modG, ev({ code: "KeyG", metaKey: true }), true)).toBe(true);
    expect(chordMatches(modG, ev({ code: "KeyG", ctrlKey: true }), false)).toBe(true);
    // ...and never the other way round.
    expect(chordMatches(modG, ev({ code: "KeyG", ctrlKey: true }), true)).toBe(false);
    expect(chordMatches(modG, ev({ code: "KeyG", metaKey: true }), false)).toBe(false);
  });

  it("rejects the chord when the NON-primary modifier is also down", () => {
    // ⌃⌘G on a Mac is not ⌘G — without this check Control would go unexamined.
    expect(chordMatches(modG, ev({ code: "KeyG", metaKey: true, ctrlKey: true }), true)).toBe(
      false,
    );
  });

  it("requires an exact modifier set, not a superset", () => {
    expect(chordMatches(modG, ev({ code: "KeyG", metaKey: true, shiftKey: true }), true)).toBe(
      false,
    );
    expect(chordMatches(modG, ev({ code: "KeyG", metaKey: true, altKey: true }), true)).toBe(false);
    expect(chordMatches(modG, ev({ code: "KeyG" }), true)).toBe(false);
  });

  it("matches the Option tier on physical code, so macOS dead keys still hit", () => {
    // ⌥R produces key "®" on macOS; code stays KeyR.
    const altR: Chord = { code: "KeyR", alt: true };
    expect(chordMatches(altR, ev({ code: "KeyR", key: "®", altKey: true }), true)).toBe(true);
    // ⌥1 produces "¡".
    const alt1: Chord = { code: "Digit1", alt: true };
    expect(chordMatches(alt1, ev({ code: "Digit1", key: "¡", altKey: true }), true)).toBe(true);
  });

  it("matches `?` by character, so non-US layouts can open the key sheet", () => {
    const question: Chord = { key: "?" };
    // US: Shift+Slash. German: Shift+Minus. Both produce key "?".
    expect(chordMatches(question, ev({ code: "Slash", key: "?", shiftKey: true }), true)).toBe(
      true,
    );
    expect(chordMatches(question, ev({ code: "Minus", key: "?", shiftKey: true }), true)).toBe(
      true,
    );
    // A `key` chord still refuses the real modifiers.
    expect(chordMatches(question, ev({ code: "Slash", key: "?", metaKey: true }), true)).toBe(
      false,
    );
  });
});

describe("chordLabel", () => {
  it("composes glyphs without a separator on macOS", () => {
    expect(chordLabel({ key: "Enter", mod: true }, true)).toBe("⌘↵");
    expect(chordLabel({ code: "KeyA", alt: true }, true)).toBe("⌥A");
    expect(chordLabel({ code: "KeyA", mod: true, shift: true }, true)).toBe("⇧⌘A");
    expect(chordLabel({ key: "Escape" }, true)).toBe("ESC");
    expect(chordLabel({ code: "Digit1", alt: true }, true)).toBe("⌥1");
  });

  it("uses localized modifier words joined with + off macOS", () => {
    expect(chordLabel({ key: "Enter", mod: true }, false)).toBe("Ctrl+↵");
    expect(chordLabel({ code: "KeyA", alt: true }, false)).toBe("Alt+A");
    expect(chordLabel({ code: "KeyA", mod: true, shift: true }, false)).toBe("Ctrl+Shift+A");
  });

  it("renders a character chord as the character itself", () => {
    expect(chordLabel({ key: "?" }, true)).toBe("?");
    expect(chordLabel({ key: "?" }, false)).toBe("?");
  });
});

describe("modLabel", () => {
  it("names the primary modifier per platform", () => {
    expect(modLabel(true)).toBe("⌘");
    expect(modLabel(false)).toBe("Ctrl");
  });
});

describe("ariaKeyshortcuts", () => {
  it("emits the WAI-ARIA spelling, which is never localized", () => {
    expect(ariaKeyshortcuts([{ code: "KeyG", mod: true }], true)).toBe("Meta+G");
    expect(ariaKeyshortcuts([{ code: "KeyG", mod: true }], false)).toBe("Control+G");
    expect(ariaKeyshortcuts([{ code: "KeyA", alt: true }], true)).toBe("Alt+A");
    expect(ariaKeyshortcuts([{ key: "Enter", mod: true }], true)).toBe("Meta+Enter");
    expect(ariaKeyshortcuts([{ key: "ArrowUp" }], true)).toBe("ArrowUp");
  });

  it("space-separates several chords and omits the attribute when there are none", () => {
    expect(
      ariaKeyshortcuts(
        [
          { code: "BracketLeft", alt: true },
          { code: "BracketRight", alt: true },
        ],
        true,
      ),
    ).toBe("Alt+[ Alt+]");
    expect(ariaKeyshortcuts([], true)).toBeUndefined();
  });
});
