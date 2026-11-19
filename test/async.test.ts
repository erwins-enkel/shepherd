import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { backoffDelay, sleep, withTimeout } from "../src/async";

const spies: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

/** Spy on setTimeout and record whether each created timer got unref'd. */
function trackUnref(): { unrefs: () => number } {
  const real = globalThis.setTimeout;
  let unrefs = 0;
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    const t = real(fn, ms);
    const orig = t.unref.bind(t);
    t.unref = () => {
      unrefs++;
      return orig();
    };
    return t;
  }) as typeof setTimeout);
  spies.push(spy);
  return { unrefs: () => unrefs };
}

describe("sleep", () => {
  test("resolves after ms", async () => {
    const t0 = performance.now();
    await sleep(20);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(15);
  });

  test("unrefs only when asked", async () => {
    const track = trackUnref();
    await sleep(1);
    expect(track.unrefs()).toBe(0);
    await sleep(1, { unref: true });
    expect(track.unrefs()).toBe(1);
  });
});

describe("withTimeout", () => {
  test("p wins: its value, timer cleared", async () => {
    const clear = spyOn(globalThis, "clearTimeout");
    spies.push(clear);
    expect(await withTimeout(Promise.resolve("p"), 1_000, () => "fallback")).toBe("p");
    expect(clear).toHaveBeenCalled();
  });

  test("timeout wins: onTimeout's value", async () => {
    const never = new Promise<string>(() => {});
    expect(await withTimeout(never, 5, () => null)).toBeNull();
  });

  test("onTimeout throwing rejects", async () => {
    const never = new Promise<string>(() => {});
    const err = new Error("timed out");
    await expect(
      withTimeout(never, 5, () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });

  test("p rejection propagates and clears the timer", async () => {
    const clear = spyOn(globalThis, "clearTimeout");
    spies.push(clear);
    const err = new Error("boom");
    await expect(withTimeout(Promise.reject(err), 1_000, () => "x")).rejects.toBe(err);
    expect(clear).toHaveBeenCalled();
  });

  test("timer is unref'd", async () => {
    const track = trackUnref();
    await withTimeout(Promise.resolve(1), 1_000, () => 0);
    expect(track.unrefs()).toBe(1);
  });

  test("onTimeout not called when p wins", async () => {
    let called = false;
    await withTimeout(Promise.resolve(1), 5, () => {
      called = true;
      return 0;
    });
    await sleep(15);
    expect(called).toBe(false);
  });
});

describe("backoffDelay", () => {
  test("attempt 1 = base, doubles per attempt", () => {
    const o = { baseMs: 100, maxMs: 10_000 };
    expect([1, 2, 3, 4].map((a) => backoffDelay(a, o))).toEqual([100, 200, 400, 800]);
  });

  test("caps at maxMs", () => {
    expect(backoffDelay(10, { baseMs: 100, maxMs: 1_000 })).toBe(1_000);
  });

  test("attempt < 1 clamps to base", () => {
    expect(backoffDelay(0, { baseMs: 100, maxMs: 1_000 })).toBe(100);
    expect(backoffDelay(-3, { baseMs: 100, maxMs: 1_000 })).toBe(100);
  });

  test("uncapped without maxMs", () => {
    expect(backoffDelay(21, { baseMs: 1 })).toBe(2 ** 20);
  });

  test("huge attempt returns maxMs, not NaN", () => {
    expect(backoffDelay(5_000, { baseMs: 30_000, maxMs: 300_000 })).toBe(300_000);
  });
});
