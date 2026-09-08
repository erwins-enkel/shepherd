import { afterEach, expect, it, vi } from "vitest";
import { requestPrReview } from "./api";
import { auth } from "./auth.svelte";

afterEach(() => {
  vi.unstubAllGlobals();
  auth.unauthenticated = false;
});

it("sends the displayed PR number and only the chosen login", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, refreshPending: true })));
  vi.stubGlobal("fetch", fetch);
  expect(await requestPrReview("s1", 42, "alice")).toEqual({ ok: true, refreshPending: true });
  expect(fetch).toHaveBeenCalledWith("/api/sessions/s1/git/request-review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prNumber: 42, reviewer: "alice" }),
  });
});

it("passes stable rejection codes through without retrying", async () => {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ code: "review_request_forbidden" }), { status: 403 }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(requestPrReview("s1", 42, "alice")).rejects.toThrow("review_request_forbidden");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("returns to login when authentication expires before submission", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("unauthorized", { status: 401 })),
  );
  await expect(requestPrReview("s1", 42, "alice")).rejects.toThrow("review_request_failed");
  expect(auth.unauthenticated).toBe(true);
});
