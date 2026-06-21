import { test, expect } from "bun:test";
import { isOperationalArchetype } from "../src/usage-archetype";

test("merge-train name → true", () => {
  expect(isOperationalArchetype({ name: "merge-train", prompt: "x" })).toBe(true);
});

test("/impeccable prompt (leading ws + mixed case) → true", () => {
  expect(isOperationalArchetype({ name: "feat-x", prompt: "  /Impeccable audit the UI  " })).toBe(
    true,
  );
});

test("ordinary task → false", () => {
  expect(isOperationalArchetype({ name: "feat-x", prompt: "add a button" })).toBe(false);
});
