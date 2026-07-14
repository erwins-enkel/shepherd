import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ApiError,
  createSession,
  isPreviewBlocked,
  relaunchSession,
  restoreSession,
  uploadScratchpadFile,
} from "./api";
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

// The re-wrap sites (upload / relaunch / restore) rebuild an ApiError to attach a `code`. Each must
// first re-throw a PreviewBlockedError untouched — re-wrapping it as a plain ApiError silently
// strips the class, and every isPreviewBlocked() caller then misclassifies the 403 as a real failure.
describe("re-wrap sites preserve PreviewBlockedError", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it.each([
    ["restoreSession", () => restoreSession("s1")],
    ["relaunchSession", () => relaunchSession("s1", {} as never)],
    ["uploadScratchpadFile", () => uploadScratchpadFile("s1", new File(["x"], "x.txt"))],
  ])("%s keeps the preview-origin 403 a PreviewBlockedError", async (_label, call) => {
    globalThis.fetch = mockFetch(403, { error: "forbidden: origin not allowed" });
    const err = await call().then(
      () => null,
      (e) => e as Error,
    );
    expect(isPreviewBlocked(err)).toBe(true);
  });
});

// `serverAuthored` gates whether a caller may show `message` to a human, so its definition has to
// hold at every construction site: a body-less response must NOT masquerade as a server message.
describe("ApiError.serverAuthored provenance", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const restoreErr = async (status: number, body: unknown) => {
    globalThis.fetch = mockFetch(status, body);
    return (await restoreSession("s1").then(
      () => null,
      (e) => e,
    )) as ApiError;
  };

  it("is true for a real server message", async () => {
    const err = await restoreErr(400, { error: "no active workspace" });
    expect(err.serverAuthored).toBe(true);
    expect(err.message).toBe("no active workspace");
  });

  it("is false for a body-less response — the fallback is a plumbing string", async () => {
    const err = await restoreErr(502, null);
    expect(err.serverAuthored).toBe(false);
    expect(err.message).toBe("restore failed: 502");
  });

  // An empty message is no message: honouring it would render a blank toast.
  it("is false for an empty server message, and falls back", async () => {
    const err = await restoreErr(500, { error: "" });
    expect(err.serverAuthored).toBe(false);
    expect(err.message).toBe("restore failed: 500");
  });
});
