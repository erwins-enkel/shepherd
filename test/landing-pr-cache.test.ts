/** LandingPrStatusCache (src/landing-pr-cache.ts): one landing-PR read per repo+branch per TTL,
 *  shared by GET /api/epics/completed and the drain's landing-gate fallback (#2756, #2858). */
import { describe, expect, test } from "bun:test";
import { LANDING_PR_TTL_MS, LandingPrStatusCache } from "../src/landing-pr-cache";
import type { PrStatus } from "../src/forge/types";

function setup() {
  let now = 0;
  let calls = 0;
  let fail = false;
  const forge = {
    prStatus: async (): Promise<PrStatus> => {
      calls++;
      if (fail) throw new Error("gh down");
      return { state: "open", checks: "success", deployConfigured: false } as PrStatus;
    },
  };
  const cache = new LandingPrStatusCache(() => now);
  return {
    cache,
    forge,
    calls: () => calls,
    setNow: (ms: number) => (now = ms),
    setFail: (f: boolean) => (fail = f),
  };
}

describe("LandingPrStatusCache", () => {
  test("callers share one read per repo+branch within the TTL, then read again", async () => {
    const h = setup();
    await h.cache.read(h.forge, "/r", "epic/1");
    await h.cache.read(h.forge, "/r", "epic/1");
    await h.cache.read(h.forge, "/r", "epic/2");
    expect(h.calls()).toBe(2);
    h.setNow(LANDING_PR_TTL_MS);
    await h.cache.read(h.forge, "/r", "epic/1");
    expect(h.calls()).toBe(3);
  });

  test("a failed read is evicted, so the next caller retries", async () => {
    const h = setup();
    h.setFail(true);
    await expect(h.cache.read(h.forge, "/r", "epic/1")).rejects.toThrow("gh down");
    h.setFail(false);
    await h.cache.read(h.forge, "/r", "epic/1");
    expect(h.calls()).toBe(2);
  });
});
