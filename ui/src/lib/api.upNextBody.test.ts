import { afterEach, expect, it, vi } from "vitest";
import { getUpNextBody } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("loads one full up-next body with encoded identity and reports read errors", async () => {
  const body = "Full ü😀 body ".repeat(400);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ body })))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "issue unavailable" }), { status: 404 }),
    );
  vi.stubGlobal("fetch", fetcher);
  expect(await getUpNextBody("/repo/with # space", 42)).toEqual({ body });
  expect(fetcher.mock.calls[0]![0]).toBe(
    "/api/up-next/body?repo=%2Frepo%2Fwith%20%23%20space&number=42",
  );
  await expect(getUpNextBody("/repo", 42)).rejects.toThrow("up next body failed: 404");
});
