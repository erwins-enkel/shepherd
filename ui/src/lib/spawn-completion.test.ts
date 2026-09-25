import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { raceSpawnCompletion } from "./spawn-completion";
import type { SpawnProgress } from "./types";

const ID = "spawn-abc12345";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function frame(over: Partial<SpawnProgress> = {}): SpawnProgress {
  return { spawnId: ID, phase: "agent", startedAt: 0, completed: [], ...over };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("raceSpawnCompletion", () => {
  test("the completion frame wins while the HTTP answer is still pending", async () => {
    let progress: SpawnProgress | null = frame();
    const race = raceSpawnCompletion(new Promise<never>(() => {}), ID, () => progress);
    await vi.advanceTimersByTimeAsync(1_000);
    progress = frame({ sessionId: "sess-1" });
    await vi.advanceTimersByTimeAsync(250);
    await expect(race).resolves.toEqual({ id: "sess-1" });
  });

  test("a frame already present when the race starts wins immediately", async () => {
    const progress = frame({ sessionId: "sess-1" });
    await expect(
      raceSpawnCompletion(new Promise<never>(() => {}), ID, () => progress),
    ).resolves.toEqual({ id: "sess-1" });
  });

  test("the HTTP answer wins when it arrives first", async () => {
    await expect(
      raceSpawnCompletion(Promise.resolve({ id: "sess-http" }), ID, () => null),
    ).resolves.toEqual({ id: "sess-http" });
  });

  test("an HTTP failure before any completion frame rejects", async () => {
    await expect(
      raceSpawnCompletion(Promise.reject(new Error("boom")), ID, () => frame()),
    ).rejects.toThrow("boom");
  });

  test("a late HTTP failure after the frame won is swallowed", async () => {
    const http = deferred<unknown>();
    const race = raceSpawnCompletion(http.promise, ID, () => frame({ sessionId: "sess-1" }));
    await expect(race).resolves.toEqual({ id: "sess-1" });
    http.reject(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
  });

  test("another spawn's completion frame is ignored, and polling stops once settled", async () => {
    const read = vi.fn(() => frame({ spawnId: "spawn-other999", sessionId: "sess-other" }));
    const http = deferred<{ id: string }>();
    const race = raceSpawnCompletion(http.promise, ID, read);
    await vi.advanceTimersByTimeAsync(500);
    http.resolve({ id: "sess-mine" });
    await expect(race).resolves.toEqual({ id: "sess-mine" });
    const calls = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read.mock.calls.length).toBe(calls);
  });
});
