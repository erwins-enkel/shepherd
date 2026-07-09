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
 *  promptPins.browser.test.ts, which replays the raw bytes): the echo sits at column
 *  0 behind `❯ `, the rendered row is padded out with REAL trailing spaces,
 *  hard-wrapped continuations carry a 2-space hanging indent, a blank line separates
 *  the prompt from the `●` answer, and the live input box is a `❯` row framed between
 *  two full-width rules. */
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

/** The agent's live input box, as it sits at the bottom of the screen rows. */
const INPUT_BOX = (typed: string) => ["────────────────────", `❯ ${typed}`, "────────────────────"];

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

  it("ignores the empty live input box: `❯ ` with nothing after it is not a prompt", () => {
    const lines = INPUT_BOX("");
    expect(scanPromptPins("claude", lines.length, reader(lines))).toEqual([]);
  });

  it("ignores a HALF-TYPED input box — a `❯` row framed by a rule is never a prompt", () => {
    const lines = [...TRANSCRIPT, ...INPUT_BOX("what I am still typing")];
    const pins = scanPromptPins("claude", lines.length, reader(lines));
    expect(pins.map((p) => p.text)).not.toContain("what I am still typing");
    expect(pins.map((p) => p.line)).toEqual([3, 9]);
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
  const pins: PromptPin[] = [
    { line: 3, text: "first" },
    { line: 9, text: "second" },
  ];
  const at = (viewportY: number) =>
    resolvePinnedPrompt(pins, { viewportY, agentOwnsScroll: false, scrolledUp: viewportY < 9 });

  it("parked below the newest echo → that prompt governs", () => {
    expect(at(12).pin?.text).toBe("second");
  });

  it("scrolled back between the two echoes → the earlier prompt governs", () => {
    expect(at(8).pin?.text).toBe("first");
  });

  it("the echo line itself governs its own output", () => {
    expect(at(9).pin?.text).toBe("second");
    expect(at(3).pin?.text).toBe("first");
  });

  it("scrolled above every echo (the banner) → nothing to pin, but not uncertain", () => {
    expect(at(1)).toEqual({ pin: null, uncertain: false });
  });

  it("no prompts asked yet → nothing to pin", () => {
    expect(
      resolvePinnedPrompt([], { viewportY: 40, agentOwnsScroll: false, scrolledUp: false }),
    ).toEqual({ pin: null, uncertain: false });
  });
});

describe("resolvePinnedPrompt — agent owns the scroll", () => {
  const pins: PromptPin[] = [
    { line: 3, text: "first" },
    { line: 9, text: "second" },
  ];

  it("at the bottom, the newest prompt is right either way", () => {
    const r = resolvePinnedPrompt(pins, { viewportY: 9, agentOwnsScroll: true, scrolledUp: false });
    expect(r).toEqual({ pin: pins[1], uncertain: false });
  });

  it("scrolled up, xterm's viewportY is stale → say unknown rather than name the newest", () => {
    // The agent repainted old output in place; viewportY still reports the bottom.
    const r = resolvePinnedPrompt(pins, { viewportY: 9, agentOwnsScroll: true, scrolledUp: true });
    expect(r).toEqual({ pin: null, uncertain: true });
  });
});
