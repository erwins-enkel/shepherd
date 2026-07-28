import { expect, test } from "bun:test";
import { stuckOnPrompt } from "../src/critic-stuck";

/** The real thing: captured verbatim from a wedged PR-critic pane (shepherd.log, PR #836).
 *  Kept multi-line on purpose — the option regex is line-anchored. */
const UPSELL_PANE = [
  "─────────────────────────────────────────",
  "Try the new fullscreen renderer?",
  "· Flicker-free output — fixes the flashing you see during long responses",
  "· Mouse support — click to move your cursor or expand results",
  "· Selected text auto-copies to your clipboard",
  "",
  "❯ 1. Yes, try it",
  "  2. Not now",
  "",
  "Enter to confirm · Esc to cancel",
].join("\n");

/** A critic mid-run, writing findings as a numbered list — shape-identical to a menu. */
const FINDINGS_PANE = [
  "⏺ Review complete. Findings:",
  "1. src/foo.ts: the guard runs after the mutation",
  "2. src/bar.ts: this branch is unreachable",
  "3. test/baz.test.ts: assertion cannot fail",
].join("\n");

test("fires on the captured upsell pane when the buffer is unchanged", () => {
  expect(stuckOnPrompt(UPSELL_PANE, UPSELL_PANE)).toBe("menu");
});

test("does NOT fire on the first read (no previous buffer to compare)", () => {
  expect(stuckOnPrompt(UPSELL_PANE, null)).toBeNull();
});

test("does NOT fire while the buffer is advancing, even on a menu shape", () => {
  expect(stuckOnPrompt(UPSELL_PANE, UPSELL_PANE + "\nstill painting…")).toBeNull();
});

// The load-bearing negative: a critic PRINTING a numbered list looks exactly like a menu to
// classifyBlocked. Motion is the only discriminator, so an advancing buffer must never be killed.
test("does NOT fire on a critic's numbered findings list while output advances", () => {
  expect(stuckOnPrompt(FINDINGS_PANE + "\n4. more", FINDINGS_PANE)).toBeNull();
});

// …but a run that has genuinely stopped dead on that same text IS reported. Documenting the
// residual: the guard is motion, not content, so a critic idling on its final findings render is
// indistinguishable. Acceptable — the verdict file is already written by then, so tick() takes the
// finalize-value path and never consults this detector.
test("an idle pane whose last paint happens to be a numbered list still reports stuck", () => {
  expect(stuckOnPrompt(FINDINGS_PANE, FINDINGS_PANE)).toBe("menu");
});

test("fires on a y/n confirm", () => {
  const pane = "Overwrite the existing file? (y/n)";
  expect(stuckOnPrompt(pane, pane)).toBe("yes-no");
});

test("does NOT fire on ordinary static prose with no prompt", () => {
  const pane = "⏺ Reading src/review.ts…\n  Analyzing the diff.";
  expect(stuckOnPrompt(pane, pane)).toBeNull();
});

test("does NOT fire on an empty or whitespace-only pane", () => {
  expect(stuckOnPrompt("", "")).toBeNull();
  expect(stuckOnPrompt("   \n\n  ", "   \n\n  ")).toBeNull();
});

test("a single numbered option is not a menu", () => {
  const pane = "Choose:\n1. Only one option";
  expect(stuckOnPrompt(pane, pane)).toBeNull();
});

// THE REGRESSION GUARD for the wiring mistake this module's doc-comment warns about: passing the
// ReviewService.readPaneTail() shape (whitespace collapsed to a single line, truncated) instead of
// the raw "visible" buffer. Every other test here feeds raw buffers and would keep passing, so
// without this the detector could be silently dead in production.
test("returns null on a readPaneTail-shaped one-liner — the raw buffer is required", () => {
  const flattened = UPSELL_PANE.replace(/\s+/g, " ").trim();
  expect(flattened).toContain("1. Yes, try it"); // the option text survives…
  expect(stuckOnPrompt(flattened, flattened)).toBeNull(); // …but it can never anchor to a line
});
