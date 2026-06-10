import { test, expect } from "bun:test";
import { classifyBlocked, hasActiveSpinner } from "../src/blocked";

test("classifies a numbered permission menu", () => {
  const tail = [
    "│ Do you want to proceed?",
    "│ ❯ 1. Yes",
    "│   2. Yes, and don't ask again",
    "│   3. No, and tell Claude what to do differently",
  ].join("\n");
  const r = classifyBlocked(tail);
  expect(r.shape).toBe("menu");
  expect(r.options).toEqual([
    { label: "Yes", send: "1" },
    { label: "Yes, and don't ask again", send: "2" },
    { label: "No, and tell Claude what to do differently", send: "3" },
  ]);
  expect(r.tail.at(-1)).toContain("No, and tell Claude");
});

test("classifies a (y/n) prompt", () => {
  const r = classifyBlocked("Overwrite existing file? (y/n)");
  expect(r.shape).toBe("yes-no");
  expect(r.options).toEqual([
    { label: "Yes", send: "y" },
    { label: "No", send: "n" },
  ]);
});

test("falls back to awaiting-input when no shape matches", () => {
  const r = classifyBlocked("What should I name the component?\n>");
  expect(r.shape).toBe("awaiting-input");
  expect(r.options).toEqual([]);
  expect(r.tail.length).toBeGreaterThan(0);
});

test("ignores stray numbered prose, keeps the last 1..n run", () => {
  const tail = ["I considered 3 options earlier.", "❯ 1. Apply the patch", "  2. Skip it"].join(
    "\n",
  );
  const r = classifyBlocked(tail);
  expect(r.shape).toBe("menu");
  expect(r.options.map((o) => o.send)).toEqual(["1", "2"]);
});

test("keeps only the last 15 non-empty lines in tail", () => {
  const tail = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n\n");
  const r = classifyBlocked(tail);
  expect(r.tail.length).toBe(15);
  expect(r.tail[0]).toBe("line 15");
});

test("hasActiveSpinner detects real spinner variants", () => {
  expect(hasActiveSpinner("✶ Bunning… (1m 13s · ↑ 1.3k tokens)")).toBe(true);
  expect(
    hasActiveSpinner("* Adding i18n + final review… (1h 29m 49s · ↓ 2.4k tokens · thinking)"),
  ).toBe(true);
  expect(hasActiveSpinner("⎿  Running… (4s)")).toBe(true);
  expect(hasActiveSpinner("some output\nPress esc to interrupt\n❯")).toBe(true);
});

test("hasActiveSpinner detects a spinner with input-box/status lines after it", () => {
  const tail = [
    "· Churning… (2m 5s · ↓ 1.1k tokens · thought for 8s)",
    "╭──────────────────────────────────╮",
    "│ ❯                                │",
    "╰──────────────────────────────────╯",
    "⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");
  expect(hasActiveSpinner(tail)).toBe(true);
});

test("hasActiveSpinner rejects idle/blocked buffers", () => {
  expect(hasActiveSpinner("… +5 lines (ctrl+o to expand)")).toBe(false);
  expect(hasActiveSpinner("Opus 4.8 (1M context)")).toBe(false);
  expect(hasActiveSpinner("❯ 1. Yes\n  2. No")).toBe(false);
  expect(hasActiveSpinner("Enter to select · ↑/↓ to navigate · Esc to cancel")).toBe(false);
  expect(hasActiveSpinner("❯\n⏵⏵ bypass permissions on (shift+tab to cycle)")).toBe(false);
});

test("hasActiveSpinner ignores a spinner outside the 15-line tail window", () => {
  const filler = Array.from({ length: 16 }, (_, i) => `filler line ${i}`).join("\n");
  expect(hasActiveSpinner(`✶ Bunning… (1m 13s · ↑ 1.3k tokens)\n${filler}`)).toBe(false);
});

test("strips ANSI escape codes before classifying a menu", () => {
  const tail = ["\x1b[1m❯ 1. Yes\x1b[0m", "\x1b[2m  2. No\x1b[0m"].join("\n");
  const r = classifyBlocked(tail);
  expect(r.shape).toBe("menu");
  expect(r.options).toEqual([
    { label: "Yes", send: "1" },
    { label: "No", send: "2" },
  ]);
  // tail itself should be free of escape codes
  expect(r.tail.join("\n")).not.toContain("\x1b");
});
