import { describe, it, expect } from "vitest";
import {
  scanPromptPins,
  resolvePinnedPrompt,
  supportsPromptPins,
  type PromptPin,
} from "./promptPins";

/** Turn a literal scrollback dump into the LineReader the scanner consumes. */
const reader = (lines: string[]) => (i: number) => lines[i] ?? null;

/** Verbatim shape captured from Claude Code v2.1.205 in a real PTY (see
 *  promptPins.browser.test.ts, which replays the raw bytes): the echo sits at column 0
 *  behind `❯ `, the rendered row is padded out with REAL trailing spaces, hard-wrapped
 *  continuations carry a 2-space hanging indent, and a blank line separates the prompt
 *  from the `●` answer. */
const TRANSCRIPT = [
  "╭─── Claude Code v2.1.205 ──────────────────╮", // 0
  "╰───────────────────────────────────────────╯", // 1
  "", // 2
  "❯ What is 2+2? Answer with just the number.     ", // 3  (padded, as rendered)
  "", // 4
  "● 4", // 5
  "", // 6
  "✻ Crunched for 2s", // 7
  "", // 8
  "❯ Please explain in one short sentence why the sky appears blue, and also", // 9
  "  mention Rayleigh scattering explicitly.", // 10
  "", // 11
  "● The sky appears blue because air molecules scatter shorter wavelengths", // 12
  "  far more than longer ones (Rayleigh scattering).", // 13
];

/** The agent's live input box as it sits at the bottom of the screen rows: a `❯` row
 *  framed between two full-width rules. Its separator is U+00A0, not a plain space —
 *  captured, not assumed. The scanner accepts BOTH separators on purpose, so what
 *  rejects this row is the structural rule-frame guard, not the NBSP. */
const INPUT_BOX = (typed: string) => [
  "────────────────────",
  `❯\u00a0${typed}`,
  "────────────────────",
];

describe("supportsPromptPins", () => {
  it("claude's echo is verified", () => expect(supportsPromptPins("claude")).toBe(true));

  it("codex has no verified echo → stays dark rather than guessing", () => {
    expect(supportsPromptPins("codex")).toBe(false);
  });

  it("unknown / absent provider → stays dark", () => {
    expect(supportsPromptPins(null)).toBe(false);
    expect(supportsPromptPins(undefined)).toBe(false);
  });
});

describe("scanPromptPins", () => {
  it("finds each prompt echo at its absolute buffer line", () => {
    const pins = scanPromptPins("claude", TRANSCRIPT.length, reader(TRANSCRIPT));
    expect(pins.map((p) => p.line)).toEqual([3, 9]);
  });

  it("folds the hanging-indent continuations into the prompt text", () => {
    const pins = scanPromptPins("claude", TRANSCRIPT.length, reader(TRANSCRIPT));
    expect(pins[1]!.text).toBe(
      "Please explain in one short sentence why the sky appears blue, and also mention Rayleigh scattering explicitly.",
    );
  });

  it("strips the real trailing spaces the agent pads its rendered rows with", () => {
    const pins = scanPromptPins("claude", TRANSCRIPT.length, reader(TRANSCRIPT));
    expect(pins[0]!.text).toBe("What is 2+2? Answer with just the number.");
  });

  it("stops folding at the blank line, so the ● answer never bleeds into the prompt", () => {
    const pins = scanPromptPins("claude", TRANSCRIPT.length, reader(TRANSCRIPT));
    expect(pins[1]!.text).not.toContain("sky appears blue because");
  });

  it("ignores the empty live input box: `❯` with nothing after it is not a prompt", () => {
    const lines = INPUT_BOX("");
    expect(scanPromptPins("claude", lines.length, reader(lines))).toEqual([]);
  });

  it("ignores a HALF-TYPED input box — a `❯` row framed by a rule is never a prompt", () => {
    const lines = [...TRANSCRIPT, ...INPUT_BOX("what I am still typing")];
    const pins = scanPromptPins("claude", lines.length, reader(lines));
    expect(pins.map((p) => p.text)).not.toContain("what I am still typing");
    expect(pins.map((p) => p.line)).toEqual([3, 9]);
  });

  it("the rule-frame guard — not the NBSP — is what rejects the input box", () => {
    // Same row, plain-space separator: still rejected, because it sits under a rule.
    // This is the regression the guard exists for, should the agent drop the NBSP.
    const boxed = ["────────────────────", "❯ typed but not submitted", "────────────────────"];
    expect(scanPromptPins("claude", boxed.length, reader(boxed))).toEqual([]);

    // And the separator itself is not the discriminator: an NBSP echo with no rule
    // above it IS a prompt.
    const unboxed = ["", "❯\u00a0a submitted prompt"];
    expect(scanPromptPins("claude", unboxed.length, reader(unboxed))).toEqual([
      { line: 1, text: "a submitted prompt" },
    ]);
  });

  it("scans the live screen rows too — the newest prompt has not scrolled off yet", () => {
    // A session under one screenful has baseY === 0: scanning committed scrollback
    // alone would find nothing at all, and the newest prompt is the one worth pinning.
    const pins = scanPromptPins("claude", TRANSCRIPT.length, reader(TRANSCRIPT));
    expect(pins).toHaveLength(2);
  });

  it("a provider with no verified echo yields nothing", () => {
    expect(scanPromptPins("codex", TRANSCRIPT.length, reader(TRANSCRIPT))).toEqual([]);
    expect(scanPromptPins(null, TRANSCRIPT.length, reader(TRANSCRIPT))).toEqual([]);
  });

  it("a `❯` that is not at column 0 is decoration, not a prompt", () => {
    expect(scanPromptPins("claude", 1, reader(["  ❯ indented"]))).toEqual([]);
  });

  it("caps runaway folding so one prompt can't swallow the transcript", () => {
    const lines = ["❯ head", ...Array.from({ length: 50 }, (_, i) => `  cont${i}`)];
    const pins = scanPromptPins("claude", lines.length, reader(lines));
    expect(pins[0]!.text.split(" ")).toHaveLength(5); // head + 4 continuations
  });
});

describe("resolvePinnedPrompt — xterm owns the scrollback", () => {
  const ROWS = 10;
  const pins: PromptPin[] = [
    { line: 3, text: "first" },
    { line: 20, text: "second" },
  ];
  /** `viewportY` is the TOP visible line; the screen spans `viewportY + ROWS - 1`. */
  const at = (viewportY: number, rows = ROWS) =>
    resolvePinnedPrompt(pins, { viewportY, rows, agentOwnsScroll: false, scrolledUp: true });

  it("the newest echo on screen governs, even though it sits BELOW viewportY", () => {
    expect(at(15).pin?.text).toBe("second"); // screen 15..24; the echo at 20 is visible
  });

  it("scrolled back until the newer echo falls off the bottom → the earlier prompt", () => {
    expect(at(5).pin?.text).toBe("first"); // screen 5..14: only the 1st echo is at/above
  });

  it("parked on the very first echo → that prompt governs", () => {
    expect(at(0).pin?.text).toBe("first"); // screen 0..9; the echo at 3 is visible
  });

  it("scrolled above every echo (the banner) → nothing to pin, but not uncertain", () => {
    expect(at(0, 2)).toEqual({ pin: null, uncertain: false }); // screen 0..1, echo at 3
  });

  it("no prompts asked yet → nothing to pin", () => {
    expect(
      resolvePinnedPrompt([], {
        viewportY: 40,
        rows: ROWS,
        agentOwnsScroll: false,
        scrolledUp: false,
      }),
    ).toEqual({ pin: null, uncertain: false });
  });

  // Both regressions come from anchoring on the TOP visible row, where viewportY ===
  // baseY at the bottom and every on-screen echo is skipped.
  it("regression: a session under one screenful (baseY === 0) still pins its prompt", () => {
    const short: PromptPin[] = [
      { line: 3, text: "first" },
      { line: 9, text: "second" },
    ];
    const r = resolvePinnedPrompt(short, {
      viewportY: 0, // nothing has scrolled
      rows: 30,
      agentOwnsScroll: false,
      scrolledUp: false,
    });
    expect(r.pin?.text).toBe("second"); // NOT null / "No prompt yet"
  });

  it("regression: parked at the bottom of a long session pins the NEWEST prompt", () => {
    const long: PromptPin[] = [
      { line: 14, text: "first" }, // scrolled into the trimmed scrollback
      { line: 44, text: "second" }, // still among the screen rows, below viewportY
    ];
    const r = resolvePinnedPrompt(long, {
      viewportY: 27, // === baseY: parked at the latest output
      rows: 30,
      agentOwnsScroll: false,
      scrolledUp: false,
    });
    expect(r.pin?.text).toBe("second"); // NOT the previous prompt
  });
});

describe("resolvePinnedPrompt — agent owns the scroll", () => {
  const pins: PromptPin[] = [
    { line: 3, text: "first" },
    { line: 9, text: "second" },
  ];

  it("at the bottom, the newest prompt is right either way", () => {
    const r = resolvePinnedPrompt(pins, {
      viewportY: 9,
      rows: 10,
      agentOwnsScroll: true,
      scrolledUp: false,
    });
    expect(r).toEqual({ pin: pins[1], uncertain: false });
  });

  it("scrolled up, xterm's viewportY is stale → say unknown rather than name the newest", () => {
    // The agent repainted old output in place; viewportY still reports the bottom.
    const r = resolvePinnedPrompt(pins, {
      viewportY: 9,
      rows: 10,
      agentOwnsScroll: true,
      scrolledUp: true,
    });
    expect(r).toEqual({ pin: null, uncertain: true });
  });
});
