import { describe, it, expect, vi } from "vitest";
import { parseOsc52, handleOsc52, OSC52_MAX_BYTES, type Osc52Sink } from "./osc52";

// Build a base64 payload from a UTF-8 source string, matching what a well-behaved
// OSC 52 emitter (like Claude Code) would send as Pd.
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

describe("parseOsc52", () => {
  it("byte-exact round-trip of a realistic long login URL", () => {
    const url =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=abc123&code_challenge_method=S256&state=xyz";
    const result = parseOsc52("c;" + b64(url));
    expect(result).not.toBeNull();
    expect(result!.text).toBe(url);
  });

  it("empty Pc still parses (Pc is ignored)", () => {
    expect(parseOsc52(";" + b64("hello"))).toEqual({ text: "hello" });
  });

  it("refuses a read/query request (Pd === '?')", () => {
    expect(parseOsc52("c;?")).toBeNull();
  });

  it("returns null when there is no semicolon at all", () => {
    expect(parseOsc52("garbage")).toBeNull();
  });

  it("returns null for malformed base64", () => {
    expect(parseOsc52("c;!!!not base64!!!")).toBeNull();
  });

  it("returns null when the decoded payload exceeds OSC52_MAX_BYTES", () => {
    const huge = "x".repeat(OSC52_MAX_BYTES + 10);
    expect(parseOsc52("c;" + b64(huge))).toBeNull();
  });

  it("round-trips a UTF-8 payload with multibyte characters byte-exact", () => {
    const text = "café — 日本語";
    expect(parseOsc52("c;" + b64(text))).toEqual({ text });
  });
});

describe("handleOsc52", () => {
  function mockSink(writeText: Osc52Sink["writeText"]) {
    return {
      writeText,
      onCopied: vi.fn(),
      onPending: vi.fn(),
    } satisfies Osc52Sink;
  }

  it("resolved write fires onCopied, not onPending", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const sink = mockSink(writeText);

    handleOsc52("c;" + b64("hello"), sink);
    await vi.waitFor(() => expect(sink.onCopied).toHaveBeenCalledTimes(1));

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(sink.onPending).not.toHaveBeenCalled();
  });

  it("rejected write fires onPending with the byte-exact text, not onCopied", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    const sink = mockSink(writeText);

    handleOsc52("c;" + b64("secret text"), sink);
    await vi.waitFor(() => expect(sink.onPending).toHaveBeenCalledTimes(1));

    expect(sink.onPending).toHaveBeenCalledWith("secret text");
    expect(sink.onCopied).not.toHaveBeenCalled();
  });

  it("writeText returning undefined (no async clipboard API) fires onPending", () => {
    const writeText = vi.fn().mockReturnValue(undefined);
    const sink = mockSink(writeText);

    handleOsc52("c;" + b64("no api"), sink);

    expect(sink.onPending).toHaveBeenCalledWith("no api");
    expect(sink.onCopied).not.toHaveBeenCalled();
  });

  it("writeText returning null (no async clipboard API) fires onPending", () => {
    const writeText = vi.fn().mockReturnValue(null);
    const sink = mockSink(writeText);

    handleOsc52("c;" + b64("also no api"), sink);

    expect(sink.onPending).toHaveBeenCalledWith("also no api");
    expect(sink.onCopied).not.toHaveBeenCalled();
  });

  it("writeText throwing synchronously fires onPending", () => {
    const writeText = vi.fn(() => {
      throw new Error("insecure context");
    });
    const sink = mockSink(writeText);

    handleOsc52("c;" + b64("thrown text"), sink);

    expect(sink.onPending).toHaveBeenCalledWith("thrown text");
    expect(sink.onCopied).not.toHaveBeenCalled();
  });

  it("a `?` read request fires neither callback", () => {
    const writeText = vi.fn();
    const sink = mockSink(writeText);

    handleOsc52("c;?", sink);

    expect(writeText).not.toHaveBeenCalled();
    expect(sink.onCopied).not.toHaveBeenCalled();
    expect(sink.onPending).not.toHaveBeenCalled();
  });

  it("malformed data (no semicolon) fires neither callback", () => {
    const writeText = vi.fn();
    const sink = mockSink(writeText);

    handleOsc52("garbage", sink);

    expect(writeText).not.toHaveBeenCalled();
    expect(sink.onCopied).not.toHaveBeenCalled();
    expect(sink.onPending).not.toHaveBeenCalled();
  });
});
