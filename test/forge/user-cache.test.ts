import { test, expect } from "bun:test";
import { makeUserCache } from "../../src/forge/user-cache";

/** A probe recording its call count, answering from a scripted queue (last entry repeats). */
function probeOf(script: Array<string | null | Error>) {
  const state = { calls: 0 };
  const probe = async (): Promise<string | null> => {
    const step = script[Math.min(state.calls, script.length - 1)]!;
    state.calls++;
    if (step instanceof Error) throw step;
    return step;
  };
  return { probe, state };
}

test("makeUserCache: a resolved login is cached for the process lifetime", async () => {
  const { probe, state } = probeOf(["octocat"]);
  const user = makeUserCache(probe);

  expect(await user()).toBe("octocat");
  expect(await user()).toBe("octocat");
  expect(state.calls).toBe(1);
});

test("makeUserCache: a failure is NOT remembered past the negative TTL (#2140)", async () => {
  let clock = 1_000;
  const { probe, state } = probeOf([new Error("HTTP 403"), "octocat"]);
  const user = makeUserCache(probe, { negativeTtlMs: 30_000, now: () => clock });

  expect(await user()).toBeNull();
  expect(state.calls).toBe(1);

  // Inside the window: answered from the negative cache, no fresh probe.
  clock += 29_999;
  expect(await user()).toBeNull();
  expect(state.calls).toBe(1);

  // Window elapsed: re-probed, and the late success sticks for good.
  clock += 1;
  expect(await user()).toBe("octocat");
  expect(state.calls).toBe(2);
  expect(await user()).toBe("octocat");
  expect(state.calls).toBe(2);
});

test("makeUserCache: an answer without a login counts as a failure, not a cached null", async () => {
  let clock = 0;
  const { probe, state } = probeOf([null, "", "octocat"]);
  const user = makeUserCache(probe, { negativeTtlMs: 10, now: () => clock });

  expect(await user()).toBeNull(); // probe resolved null
  clock += 10;
  expect(await user()).toBeNull(); // probe resolved "" — equally unusable
  clock += 10;
  expect(await user()).toBe("octocat");
  expect(state.calls).toBe(3);
});
