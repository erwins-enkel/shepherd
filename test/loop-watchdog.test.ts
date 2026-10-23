import { expect, test } from "bun:test";
import { withOp } from "../src/loop-watchdog";

// Before startLoopWatchdog the registry is absent; withOp must still run its callback untouched.
test("withOp returns the callback's value", () => {
  expect(withOp("WS open events", () => 42)).toBe(42);
});

test("withOp lets the callback's throw through", () => {
  expect(() =>
    withOp("WS message pty", () => {
      throw new Error("boom");
    }),
  ).toThrow("boom");
});
