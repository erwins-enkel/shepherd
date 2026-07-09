// Integration guard for the one assumption promptPins.ts rests on: that Claude Code
// renders each submitted prompt as a `❯ <text>` line. The fixture is a VERBATIM
// capture of a real `claude` process's PTY output (v2.1.205, 100x30,
// TERM=xterm-256color), with both prompts delivered exactly as Shepherd delivers a
// steer — bracketed paste + CR. Replaying it through a real xterm parser means this
// test fails the day that echo shape changes, instead of the bar silently going blank.
//
// The capture is deliberately shaped to exercise what mocks got wrong:
//   • it scrolls, so the 1st prompt's echo lands in the trimmed scrollback
//     (line < baseY) while the 2nd stays on the screen rows (line >= baseY);
//   • it ends with UNSUBMITTED text left sitting in the live input box, so the
//     rule-frame guard is exercised against a row that ECHO really does match.
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
/** Typed into the live input box during the capture and never submitted. */
const DRAFT = "this question is still being typed";

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
    const b = term.buffer.normal;
    const rows = Array.from({ length: b.baseY + term.rows }, (_, i) =>
      (b.getLine(i)?.translateToString(true) ?? "").trimEnd(),
    );

    // Anti-vacuity: the captured box really does hold unsubmitted text, and that row
    // really does match ECHO — so only the rule-frame guard can be rejecting it.
    const box = rows.findIndex((r) => r.includes(DRAFT));
    expect(box).toBeGreaterThan(-1);
    expect(rows[box]).toMatch(/^❯[ \u00a0]\S/);
    expect(rows[box - 1]).toMatch(/^─{3,}$/);

    const pins = pinsOf(term);
    expect(pins).toHaveLength(2);
    expect(pins.map((p) => p.text)).not.toContain(DRAFT);
  });

  it("resolves the reader's position to the prompt that produced what they see", async () => {
    term = await replay();
    const pins = pinsOf(term);
    const [first, second] = pins as [(typeof pins)[0], (typeof pins)[0]];
    const rows = term.rows;
    const resolve = (viewportY: number, scrolledUp: boolean) =>
      resolvePinnedPrompt(pins, { viewportY, rows, agentOwnsScroll: false, scrolledUp }).pin?.text;

    // Parked at the latest output (viewportY === baseY): the newest echo sits BELOW
    // viewportY among the screen rows, which a top anchor would skip.
    expect(resolve(term.buffer.normal.baseY, false)).toBe(PROMPT_2);

    // Scrolled back into the tail of the 1st answer. The 2nd echo (line 44) is still
    // on screen from here, but the reader is reading the 1st — a bottom anchor would
    // mislabel this whole band as PROMPT_2.
    expect(resolve(second.line - 5, true)).toBe(PROMPT_1);

    // Scrolled so the 2nd echo is the top row → it takes over.
    expect(resolve(second.line, true)).toBe(PROMPT_2);

    // Parked on the 1st echo itself.
    expect(resolve(first.line, true)).toBe(PROMPT_1);

    // Scrolled to the very top: the banner, above every prompt.
    expect(resolve(0, true)).toBeUndefined();
  });

  it("the captured agent never seized the scroll, so xterm's viewportY is authoritative", async () => {
    term = await replay();
    expect(term.buffer.active.type).toBe("normal");
    expect(term.modes.mouseTrackingMode).toBe("none");
  });

  // Why Viewport.svelte hides the bar outright on the alternate screen rather than
  // trusting resolvePinnedPrompt's agent-owns-scroll guard. Sessions spawned under the
  // fullscreen renderer (CLAUDE_CODE_NO_FLICKER=1) live on the alt screen for their
  // whole life; a normal one enters it whenever the agent shells out to a TUI.
  it("on the alternate screen the pins' coordinates no longer describe what is on screen", async () => {
    term = await replay();
    const pins = pinsOf(term);
    expect(pins).toHaveLength(2);

    await new Promise<void>((r) => term!.write("\x1b[?1049h", r)); // enter alt screen

    expect(term.buffer.active.type).toBe("alternate");
    // The alt buffer has its own coordinate space, pinned at the top…
    expect(term.buffer.active.viewportY).toBe(0);
    // …while the pins still index the normal buffer, which is untouched.
    expect(pinsOf(term).map((p) => p.text)).toEqual([PROMPT_1, PROMPT_2]);

    // Resolving against the alt viewportY silently names the prompt that happens to
    // lie in the normal buffer's first screenful — and the agent-owns-scroll guard
    // does NOT catch it, because entering the alt screen resets `scrolledUp` to false.
    const misresolved = resolvePinnedPrompt(pins, {
      viewportY: term.buffer.active.viewportY,
      rows: term.rows,
      agentOwnsScroll: true,
      scrolledUp: false,
    });
    expect(misresolved.uncertain).toBe(false);
    expect(misresolved.pin?.text).toBe(PROMPT_1); // a confident falsehood; hence the gate
  });
});
