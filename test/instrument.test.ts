import { test, expect } from "bun:test";
import { timed, timedAsync, execFileSync, startLoopLagSampler } from "../src/instrument";

// ── helpers ───────────────────────────────────────────────────────────────────

function withProfile(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const prev = process.env.SHEPHERD_PROFILE_LOOP;
    process.env.SHEPHERD_PROFILE_LOOP = "1";
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.SHEPHERD_PROFILE_LOOP;
      else process.env.SHEPHERD_PROFILE_LOOP = prev;
    }
  };
}

function withoutProfile(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const prev = process.env.SHEPHERD_PROFILE_LOOP;
    delete process.env.SHEPHERD_PROFILE_LOOP;
    try {
      await fn();
    } finally {
      if (prev !== undefined) process.env.SHEPHERD_PROFILE_LOOP = prev;
    }
  };
}

// ── timed — return value ──────────────────────────────────────────────────────

test(
  "timed returns wrapped value (profile on)",
  withProfile(() => {
    const result = timed("test", () => 42);
    expect(result).toBe(42);
  }),
);

test(
  "timed returns wrapped value (profile off)",
  withoutProfile(() => {
    const result = timed("test", () => 42);
    expect(result).toBe(42);
  }),
);

// ── timed — error re-throw ────────────────────────────────────────────────────

test(
  "timed re-throws errors (profile on)",
  withProfile(() => {
    const boom = new Error("boom");
    expect(() =>
      timed("test", () => {
        throw boom;
      }),
    ).toThrow(boom);
  }),
);

test(
  "timed re-throws errors (profile off)",
  withoutProfile(() => {
    const boom = new Error("boom");
    expect(() =>
      timed("test", () => {
        throw boom;
      }),
    ).toThrow(boom);
  }),
);

// ── timedAsync — return value ─────────────────────────────────────────────────

test(
  "timedAsync returns wrapped value (profile on)",
  withProfile(async () => {
    const result = await timedAsync("test", async () => "hello");
    expect(result).toBe("hello");
  }),
);

test(
  "timedAsync returns wrapped value (profile off)",
  withoutProfile(async () => {
    const result = await timedAsync("test", async () => "hello");
    expect(result).toBe("hello");
  }),
);

// ── timedAsync — error re-throw ───────────────────────────────────────────────

test(
  "timedAsync re-throws errors (profile on)",
  withProfile(async () => {
    const boom = new Error("async-boom");
    await expect(
      timedAsync("test", async () => {
        throw boom;
      }),
    ).rejects.toThrow(boom);
  }),
);

test(
  "timedAsync re-throws errors (profile off)",
  withoutProfile(async () => {
    const boom = new Error("async-boom");
    await expect(
      timedAsync("test", async () => {
        throw boom;
      }),
    ).rejects.toThrow(boom);
  }),
);

// ── threshold: fast fn should not log ────────────────────────────────────────

test(
  "timed does not log for fast function (profile on)",
  withProfile(() => {
    const logs: unknown[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => logs.push(args);
    try {
      timed("fast", () => 1);
    } finally {
      console.warn = orig;
    }
    expect(logs).toHaveLength(0);
  }),
);

test(
  "timedAsync does not log for fast async function (profile on)",
  withProfile(async () => {
    const logs: unknown[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => logs.push(args);
    try {
      await timedAsync("fast-async", async () => 1);
    } finally {
      console.warn = orig;
    }
    expect(logs).toHaveLength(0);
  }),
);

// ── threshold: slow fn should log ────────────────────────────────────────────

test(
  "timed logs when fn exceeds 250ms threshold (profile on)",
  withProfile(async () => {
    const logs: string[] = [];
    const orig = console.warn;
    console.warn = (msg: unknown) => logs.push(String(msg));
    try {
      // Simulate slow fn by overriding Date.now temporarily
      let callCount = 0;
      const origNow = Date.now;
      Date.now = () => {
        // first call = start, second call = after fn = start + 300ms
        return callCount++ === 0 ? origNow() : origNow() + 300;
      };
      try {
        timed("slow-op", () => "done");
      } finally {
        Date.now = origNow;
      }
    } finally {
      console.warn = orig;
    }
    expect(logs.some((l) => l.includes("[profile]") && l.includes("slow-op"))).toBe(true);
  }),
);

test(
  "timed does not log when profiling is off (even if slow)",
  withoutProfile(async () => {
    const logs: string[] = [];
    const orig = console.warn;
    console.warn = (msg: unknown) => logs.push(String(msg));
    let callCount = 0;
    const origNow = Date.now;
    Date.now = () => (callCount++ === 0 ? origNow() : origNow() + 300);
    try {
      timed("slow-off", () => "done");
    } finally {
      Date.now = origNow;
      console.warn = orig;
    }
    expect(logs.filter((l) => l.includes("[profile]"))).toHaveLength(0);
  }),
);

// ── startLoopLagSampler ───────────────────────────────────────────────────────

test(
  "startLoopLagSampler returns a callable stop fn when profiling is off (no timer started)",
  withoutProfile(() => {
    const logs: unknown[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => logs.push(args);
    let stop: (() => void) | undefined;
    try {
      stop = startLoopLagSampler();
    } finally {
      console.warn = orig;
    }
    // Must be callable
    expect(typeof stop).toBe("function");
    expect(() => stop!()).not.toThrow();
    // No timer means no logging
    expect(logs).toHaveLength(0);
  }),
);

test(
  "startLoopLagSampler returns a callable stop fn when profiling is on",
  withProfile(() => {
    const stop = startLoopLagSampler();
    expect(typeof stop).toBe("function");
    // Clean up immediately so the interval doesn't outlive this test
    stop();
  }),
);

test(
  "startLoopLagSampler stop fn clears the interval — no further logging after stop",
  withProfile(
    () =>
      new Promise<void>((resolve, reject) => {
        const logs: string[] = [];
        const orig = console.warn;
        console.warn = (msg: unknown) => logs.push(String(msg));

        const stop = startLoopLagSampler();
        // Stop immediately — the interval must not fire after this
        stop();
        console.warn = orig;

        const countAfterStop = logs.length;
        // Wait long enough for one interval period (50ms) to pass
        setTimeout(() => {
          try {
            expect(logs.length).toBe(countAfterStop);
            resolve();
          } catch (e) {
            reject(e);
          }
        }, 120);
      }),
  ),
);

// (d) Asserting a specific >[profile] loop-lag< log line requires the interval
// callback to observe a fabricated >150ms lag, which needs Date.now to return
// different values for the *closure-captured* `last` assignment inside the
// setInterval callback vs. the later `now` read. That sequence is non-trivial
// to control from outside without adding a production seam (injecting a clock).
// Skipped in favour of the behavioural coverage above.

// ── execFileSync passthrough ──────────────────────────────────────────────────

test(
  "execFileSync passes through correctly (profile off)",
  withoutProfile(() => {
    const result = execFileSync("echo", ["hi"], { encoding: "utf8" });
    expect(result.trim()).toBe("hi");
  }),
);

test(
  "execFileSync passes through correctly (profile on)",
  withProfile(() => {
    const result = execFileSync("echo", ["hi"], { encoding: "utf8" });
    expect(result.trim()).toBe("hi");
  }),
);

test(
  "execFileSync re-throws on error (profile off)",
  withoutProfile(() => {
    expect(() => execFileSync("false", [], { stdio: "pipe" })).toThrow();
  }),
);

test(
  "execFileSync re-throws on error (profile on)",
  withProfile(() => {
    expect(() => execFileSync("false", [], { stdio: "pipe" })).toThrow();
  }),
);
