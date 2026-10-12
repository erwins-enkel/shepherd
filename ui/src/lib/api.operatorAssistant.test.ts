import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ensureOperatorAssistant,
  getOperatorAssistant,
  operatorAssistantUnavailableReason,
  resetOperatorAssistant,
} from "./api";

vi.mock("#lib/auth.svelte.js", () => ({
  auth: { unauthenticated: false, checked: false },
}));

const row = { id: "oa-1", desig: "TASK-90", operatorAssistant: true };

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Operator Assistant API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads availability, reason and the live row", async () => {
    const body = { available: false, reason: "herdr_unreachable", session: null };
    const fetchMock = stubFetch(200, body);
    await expect(getOperatorAssistant()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/operator-assistant");
  });

  it("rejects a failed read", async () => {
    stubFetch(500, { error: "boom" });
    await expect(getOperatorAssistant()).rejects.toThrow("boom");
  });

  it.each([
    [ensureOperatorAssistant, "/api/operator-assistant"],
    [resetOperatorAssistant, "/api/operator-assistant/reset"],
  ] as const)("POSTs %o and returns the row", async (call, url) => {
    const fetchMock = stubFetch(200, { session: row });
    await expect(call()).resolves.toEqual({ session: row });
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: "POST" }));
  });

  it.each(["claude_missing", "herdr_unreachable"] as const)(
    "surfaces the 503 reason %s",
    async (reason) => {
      stubFetch(503, { error: "unavailable", reason });
      const err = await ensureOperatorAssistant().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(operatorAssistantUnavailableReason(err)).toBe(reason);
    },
  );

  it("reads no reason from other failures", async () => {
    stubFetch(500, { error: "spawn failed" });
    const err = await resetOperatorAssistant().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("spawn failed");
    expect(operatorAssistantUnavailableReason(err)).toBeNull();
    expect(operatorAssistantUnavailableReason(new Error("x"))).toBeNull();
    expect(operatorAssistantUnavailableReason(new ApiError(503, "x", "other"))).toBeNull();
  });
});
