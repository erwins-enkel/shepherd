import { afterEach, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

// A macrotask delay, not an instant resolve: on a regression the refresh loop would otherwise
// spin on microtasks alone and hang the page instead of failing the assertion.
vi.mock("./api", () => ({
  getSteerLog: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve([]), 5))),
}));

import { getSteerLog } from "./api";
import SteerLogEffectHarness from "./SteerLogEffectHarness.test.svelte";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

// Regression (#3170): refresh() read `steerLogs.map` before its await, so a caller's $effect
// subscribed to the whole map and every response re-ran it — ~100 requests/s against the server.
it("a refresh from an effect fetches once, not again on its own write", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const harness = mount(SteerLogEffectHarness, { target, props: { sessionId: "s1" } });
  cleanup = () => {
    void unmount(harness);
    target.remove();
  };
  flushSync();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(vi.mocked(getSteerLog)).toHaveBeenCalledTimes(1);
});
