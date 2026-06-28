import { test, expect } from "vitest";
import { checksCleared } from "./checks-cleared";

test("success always clears (noCi irrelevant)", () => {
  expect(checksCleared("success", false)).toBe(true);
  expect(checksCleared("success", true)).toBe(true);
});

test("none clears only when noCi", () => {
  expect(checksCleared("none", true)).toBe(true);
  expect(checksCleared("none", false)).toBe(false);
  expect(checksCleared("none", undefined)).toBe(false);
});

test("pending / failure never clear", () => {
  expect(checksCleared("pending", true)).toBe(false);
  expect(checksCleared("failure", true)).toBe(false);
});
