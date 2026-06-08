import { expect, test } from "bun:test";
import { effectiveAutopilot } from "../src/effective-autopilot";

test("explicit override true wins over repo default false", () => {
  expect(effectiveAutopilot({ autopilotEnabled: true }, false)).toBe(true);
});

test("explicit override false wins over repo default true", () => {
  expect(effectiveAutopilot({ autopilotEnabled: false }, true)).toBe(false);
});

test("null override inherits repo default true", () => {
  expect(effectiveAutopilot({ autopilotEnabled: null }, true)).toBe(true);
});

test("null override inherits repo default false", () => {
  expect(effectiveAutopilot({ autopilotEnabled: null }, false)).toBe(false);
});
