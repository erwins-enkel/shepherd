import { describe, it, expect, vi } from "vitest";
import { transcribeAudio } from "./api";

function captureFetch(status: number, body: unknown): { forms: FormData[] } {
  const forms: FormData[] = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: FormData }) => {
    if (init?.body instanceof FormData) forms.push(init.body);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { forms };
}

const clip = new Blob(["riff"], { type: "audio/wav" });

describe("transcribeAudio", () => {
  it("appends mode=partial for interim preview requests", async () => {
    const { forms } = captureFetch(200, { text: "hello" });
    await expect(transcribeAudio(clip, "en", { mode: "partial" })).resolves.toBe("hello");
    expect(forms[0]!.get("mode")).toBe("partial");
    expect(forms[0]!.get("lang")).toBe("en");
  });

  it("sends NO mode field for the final clip — the plugin treats absent mode as final", async () => {
    const { forms } = captureFetch(200, { text: "final text" });
    await expect(transcribeAudio(clip, "de")).resolves.toBe("final text");
    expect(forms[0]!.get("mode")).toBeNull();
    expect(forms[0]!.get("lang")).toBe("de");
  });

  it("omits lang when not supplied", async () => {
    const { forms } = captureFetch(200, { text: "x" });
    await transcribeAudio(clip);
    expect(forms[0]!.get("lang")).toBeNull();
    expect(forms[0]!.get("mode")).toBeNull();
  });

  it("throws on a non-ok response (e.g. a 429 shed)", async () => {
    captureFetch(429, { error: "busy" });
    await expect(transcribeAudio(clip, "en", { mode: "partial" })).rejects.toThrow();
  });
});
