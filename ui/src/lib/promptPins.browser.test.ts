// Integration guard for the one assumption promptPins.ts rests on: that Claude Code
// renders each submitted prompt as a `❯ <text>` line. The fixture is a VERBATIM
// capture of a real `claude` process's PTY output (v2.1.205, 100x30,
// TERM=xterm-256color), with both prompts delivered exactly as Shepherd delivers a
// steer — bracketed paste + CR. Replaying it through a real xterm parser means this
// test fails the day that echo shape changes, instead of the bar silently going blank.
//
// The capture is deliberately long enough to scroll: the first prompt's echo ends up
// in the trimmed scrollback (line < baseY) and the second is still on the screen rows
// (line >= baseY), so both halves of the scan range are exercised — that split is what
// the mock-based unit tests got wrong.
import { describe, it, expect, afterEach } from "vitest";
import { Terminal } from "@xterm/xterm";
import { scanPromptPins, resolvePinnedPrompt } from "./promptPins";
import transcript from "./__fixtures__/claude-code-transcript.txt?raw";

let term: Terminal | null = null;

afterEach(() => {
  term?.dispose();
  term = null;
  document.body.innerHTML = "";
});

/** Replay the captured PTY bytes into a real xterm buffer at the captured size. */
async function replay(): Promise<Terminal> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const t = new Terminal({ cols: 100, rows: 30, scrollback: 1000 });
  t.open(el);
  await new Promise<void>((resolve) => t.write(transcript, resolve));
  return t;
}

/** Exactly how Viewport.svelte feeds the scanner. */
const pinsOf = (t: Terminal) => {
  const b = t.buffer.normal;
  return scanPromptPins(
    "claude",
    b.baseY + t.rows,
    (i) => b.getLine(i)?.translateToString(true) ?? null,
  );
};

const PROMPT_1 = "List the integers 1 through 25, one per line, nothing else. No preamble.";
const PROMPT_2 = "Now name one primary color. One word only.";

describe("promptPins against a real Claude Code PTY capture", () => {
  it("finds both submitted prompts, with the agent's row padding stripped", async () => {
    term = await replay();
    expect(pinsOf(term).map((p) => p.text)).toEqual([PROMPT_1, PROMPT_2]);
  });

  it("spans both regions: the 1st echo scrolled off, the 2nd is still on screen", async () => {
    term = await replay();
    const pins = pinsOf(term);
    const { baseY } = term.buffer.normal;
    expect(baseY).toBeGreaterThan(0); // the capture really did scroll
    expect(pins[0]!.line).toBeLessThan(baseY); // trimmed into the scrollback
    expect(pins[1]!.line).toBeGreaterThanOrEqual(baseY); // still on the screen rows
  });

  it("each pin points at the line that really is that prompt's echo", async () => {
    term = await replay();
    const pins = pinsOf(term);
    const lineAt = (i: number) => term!.buffer.normal.getLine(i)!.translateToString(true).trimEnd();
    expect(lineAt(pins[0]!.line)).toBe(`❯ ${PROMPT_1}`);
    expect(lineAt(pins[1]!.line)).toBe(`❯ ${PROMPT_2}`);
  });

  it("never mistakes the live input box — a `❯` row framed by rules — for a prompt", async () => {
    term = await replay();
    // The box is on screen at cursorY; it must not appear as a third pin.
    expect(pinsOf(term)).toHaveLength(2);
  });

  it("resolves the reader's position to the prompt that produced what they see", async () => {
    term = await replay();
    const pins = pinsOf(term);
    const [first, second] = pins as [(typeof pins)[0], (typeof pins)[0]];
    const at = (viewportY: number) =>
      resolvePinnedPrompt(pins, { viewportY, agentOwnsScroll: false, scrolledUp: true }).pin?.text;

    expect(at(second.line + 1)).toBe(PROMPT_2); // reading the 2nd answer
    expect(at(second.line - 1)).toBe(PROMPT_1); // scrolled back into the 1st answer's tail
    expect(at(first.line)).toBe(PROMPT_1); // parked on the 1st echo itself
    expect(at(first.line - 1)).toBeUndefined(); // above every prompt: the banner
  });

  it("the captured agent never seized the scroll, so xterm's viewportY is authoritative", async () => {
    term = await replay();
    expect(term.buffer.active.type).toBe("normal");
    expect(term.modes.mouseTrackingMode).toBe("none");
  });
});
