import { describe, it, expect, vi, afterEach } from "vitest";
import { createSession, isPreviewBlocked } from "./api";
import type { CreateInput } from "./types";

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("preview-origin blocked detection", () => {
  // Each test reassigns globalThis.fetch; restore the real one so the mock
  // doesn't leak into other suites that share the global.
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("maps a 403 origin-block body to a PreviewBlockedError", async () => {
    globalThis.fetch = mockFetch(403, { error: "forbidden: origin not allowed" });
    const err = await createSession({ repo: "r", prompt: "p" } as unknown as CreateInput).then(
      () => null,
      (e) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(isPreviewBlocked(err)).toBe(true);
    // Remapped to a (translated) sentence — not the raw server string.
    expect(err!.message.length).toBeGreaterThan(0);
    expect(err!.message).not.toBe("forbidden: origin not allowed");
  });

  it("leaves a non-origin 403 as a plain error", async () => {
    globalThis.fetch = mockFetch(403, { error: "nope" });
    const err = await createSession({ repo: "r", prompt: "p" } as unknown as CreateInput).then(
      () => null,
      (e) => e as Error,
    );
    expect(isPreviewBlocked(err)).toBe(false);
    expect(err!.message).toBe("nope");
  });

  // A host-not-allowlisted 403 (real HUD on an un-allowed host, #1645 Fix 3) is NOT a preview
  // block — it becomes a plain Error carrying the translated SHEPHERD_ALLOWED_HOSTS hint, so the
  // UI stops misdirecting the operator to "the live preview".
  it("maps a 403 host-block body to a plain (non-preview) error with hint copy", async () => {
    globalThis.fetch = mockFetch(403, { error: "forbidden: origin host not allowed" });
    const err = await createSession({ repo: "r", prompt: "p" } as unknown as CreateInput).then(
      () => null,
      (e) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(isPreviewBlocked(err)).toBe(false);
    // Remapped to a translated sentence — not the raw server string.
    expect(err!.message.length).toBeGreaterThan(0);
    expect(err!.message).not.toBe("forbidden: origin host not allowed");
  });
});
