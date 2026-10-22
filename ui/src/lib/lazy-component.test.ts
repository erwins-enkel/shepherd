import { describe, expect, it, vi } from "vitest";
import { lazy, prefetchWhenIdle } from "./lazy-component";

describe("lazy", () => {
  it("calls the loader once and reuses its promise", async () => {
    const loader = vi.fn(() => Promise.resolve({ default: "X" }));
    const load = lazy(loader);
    const a = load();
    const b = load();
    expect(a).toBe(b);
    expect(await a).toEqual({ default: "X" });
    await load();
    expect(loader).toHaveBeenCalledOnce();
  });

  it("forgets a rejected load so the next call retries", async () => {
    const loader = vi
      .fn<() => Promise<{ default: string }>>()
      .mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module"))
      .mockResolvedValueOnce({ default: "X" });
    const load = lazy(loader);
    await expect(load()).rejects.toThrow();
    expect(await load()).toEqual({ default: "X" });
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("prefetchWhenIdle", () => {
  it("runs every loader once the scheduler fires and swallows failures", async () => {
    let fire: () => void = () => {};
    const schedule = vi.fn((cb: () => void) => (fire = cb));
    const ok = vi.fn(() => Promise.resolve({ default: 1 }));
    const bad = vi.fn(() => Promise.reject(new Error("offline")));
    prefetchWhenIdle([ok, bad], schedule);
    expect(ok).not.toHaveBeenCalled();
    fire();
    expect(ok).toHaveBeenCalledOnce();
    expect(bad).toHaveBeenCalledOnce();
    // A rejection must not surface as an unhandled rejection.
    await Promise.resolve();
  });
});
