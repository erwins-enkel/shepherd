import { test, expect, beforeEach, afterEach } from "bun:test";
import { firstRun } from "../src/first-run";

// firstRun is a shared module singleton — reset it before every test so runs don't leak
// pending state or registered callbacks into each other.
beforeEach(() => {
  firstRun.pending = false;
  firstRun.onResolve(() => {});
});

// Also clear state AFTER each test so the last test here (which registers a throwing
// callback) can't leave it parked on the singleton for later test files — otherwise a
// cross-file resolve() would fire it and print caught-warning noise.
afterEach(() => {
  firstRun.pending = false;
  firstRun.onResolve(() => {});
});

test("resolve() while pending flips pending to false and runs the registered callback once", async () => {
  firstRun.pending = true;
  let calls = 0;
  firstRun.onResolve(() => {
    calls++;
  });
  firstRun.resolve();
  expect(firstRun.pending).toBe(false);
  expect(calls).toBe(0); // scheduled via queueMicrotask, not run synchronously
  await Promise.resolve();
  expect(calls).toBe(1);
});

test("resolve() called twice runs the callback at most once", async () => {
  firstRun.pending = true;
  let calls = 0;
  firstRun.onResolve(() => {
    calls++;
  });
  firstRun.resolve();
  firstRun.resolve();
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toBe(1);
});

test("resolve() while already resolved (pending=false) is a no-op — callback never runs", async () => {
  firstRun.pending = false;
  let calls = 0;
  firstRun.onResolve(() => {
    calls++;
  });
  firstRun.resolve();
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toBe(0);
});

test("a throwing callback is caught inside resolve() and does not propagate or crash the process", async () => {
  // console.warn "[first-run] startBackground failed: boom" is expected here — resolve() must
  // catch and warn, never let the callback's throw escape.
  firstRun.pending = true;
  firstRun.onResolve(() => {
    throw new Error("boom");
  });
  expect(() => firstRun.resolve()).not.toThrow();
  // give the microtask a tick to run (and throw internally, if uncaught) before asserting
  // that execution continued normally past resolve() — a real regression would surface as
  // an unhandled rejection/exception failing the test run, not as a synchronous throw here.
  await Promise.resolve();
  expect(firstRun.pending).toBe(false);
});
