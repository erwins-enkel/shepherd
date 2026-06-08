import { expect, test } from "bun:test";
import { effectiveAutopilot } from "../src/effective-autopilot";

const cfg = (autopilotEnabled: boolean) => () => ({ autopilotEnabled });

test("explicit override true wins over repo default false", () => {
  expect(effectiveAutopilot({ autopilotEnabled: true, repoPath: "/r" }, cfg(false))).toBe(true);
});

test("explicit override false wins over repo default true", () => {
  expect(effectiveAutopilot({ autopilotEnabled: false, repoPath: "/r" }, cfg(true))).toBe(false);
});

test("null override inherits repo default true", () => {
  expect(effectiveAutopilot({ autopilotEnabled: null, repoPath: "/r" }, cfg(true))).toBe(true);
});

test("null override inherits repo default false", () => {
  expect(effectiveAutopilot({ autopilotEnabled: null, repoPath: "/r" }, cfg(false))).toBe(false);
});

test("getRepoConfig is consulted only on a null override (override short-circuits)", () => {
  let consulted = false;
  effectiveAutopilot({ autopilotEnabled: true, repoPath: "/r" }, () => {
    consulted = true;
    return { autopilotEnabled: false };
  });
  expect(consulted).toBe(false);
});
