import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import RestartShepherdDialog from "./RestartShepherdDialog.svelte";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RestartShepherdDialog", () => {
  it("stops polling /api/health once unmounted, so it never reloads the page", async () => {
    vi.useFakeTimers();
    let healthCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/restart")) {
        return new Response(JSON.stringify({ started: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/health")) {
        healthCalls++;
        return new Response("ok", { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });

    const { unmount } = await render(RestartShepherdDialog, {
      autoStart: true,
      shepherdOnly: true,
    });
    for (let i = 0; i < 20 && healthCalls === 0; i++) await vi.advanceTimersByTimeAsync(0);
    expect(healthCalls).toBeGreaterThan(0);

    await unmount();
    const atUnmount = healthCalls;
    // well past DOWN_WINDOW_MS (30s): an unguarded loop would keep polling and reload
    for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(700);
    expect(healthCalls).toBe(atUnmount);
  });
});
