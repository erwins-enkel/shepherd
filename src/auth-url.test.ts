import { describe, it, expect } from "bun:test";
import { detectAuthUrl } from "./auth-url";

// Real-shape fixtures (synthetic client_id / code_challenge). Mirrors the Step-0 capture:
// the authorize URL lands in an assistant `text` block AND/OR a `tool_result` block inside a
// `role:"user"` message. `code_challenge` is a PKCE hash placeholder here.
const AUTH_URL =
  "https://mcp.notion.com/authorize?response_type=code&client_id=abc123&code_challenge=HOkFuV4sAW3&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback&resource=https%3A%2F%2Fmcp.notion.com%2Fmcp";

const assistantText = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
const toolResult = (content: string) =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content }] },
  });
const opInputString = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: text } });
const opInputText = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const toolUse = () =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name: "notion" }] },
  });

describe("detectAuthUrl", () => {
  it("detects the URL in an assistant text block", () => {
    const jsonl = [
      opInputString("read this notion page for me"),
      assistantText(
        `I need you to authorize the Notion connection.\n1. Open this URL in your browser:\n\n${AUTH_URL}\n\n2. Copy the callback URL back here.`,
      ),
    ].join("\n");
    expect(detectAuthUrl(jsonl)).toBe(AUTH_URL);
  });

  it("detects the URL in a tool_result (role:user) — the assistant-only scan would miss it", () => {
    const jsonl = [
      opInputString("read this notion page"),
      toolUse(),
      toolResult(`Authorization required. Visit ${AUTH_URL} to authorize.`),
    ].join("\n");
    expect(detectAuthUrl(jsonl)).toBe(AUTH_URL);
  });

  it("detects a Vercel-style /oauth/authorize URL", () => {
    const vercel =
      "https://vercel.com/oauth/authorize?response_type=code&client_id=cl_Wbdt&code_challenge=x&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcallback";
    expect(detectAuthUrl(assistantText(`Open ${vercel} then paste the callback.`))).toBe(vercel);
  });

  it("returns null for a plain non-auth URL", () => {
    expect(
      detectAuthUrl(assistantText("See the docs at https://example.com/guide/setup for details.")),
    ).toBeNull();
  });

  it("does not match the localhost callback URL the operator pastes back", () => {
    const callback = "http://localhost:3118/callback?code=xyz789&state=abc";
    expect(detectAuthUrl(opInputString(`Here is the callback: ${callback}`))).toBeNull();
    expect(detectAuthUrl(toolResult(`redirected to ${callback}`))).toBeNull();
  });

  it("clears a resolved URL once the operator has responded (no stale resurface)", () => {
    const jsonl = [
      assistantText(`Open ${AUTH_URL}`),
      opInputString("http://localhost:3118/callback?code=done"), // operator pasted the callback
      toolUse(),
      assistantText("Thanks, I read the page. Anything else?"),
    ].join("\n");
    expect(detectAuthUrl(jsonl)).toBeNull();
  });

  it("clears when the operator answers via a typed text turn", () => {
    const jsonl = [
      toolResult(`authorize at ${AUTH_URL}`),
      opInputText("skip it, read the page directly instead"),
    ].join("\n");
    expect(detectAuthUrl(jsonl)).toBeNull();
  });

  it("surfaces the current URL while still blocked (URL is the newest relevant content)", () => {
    const jsonl = [
      opInputString("original request"),
      toolUse(),
      toolResult(`auth required: ${AUTH_URL}`),
      assistantText(`Please open ${AUTH_URL} and paste the callback.`),
    ].join("\n");
    expect(detectAuthUrl(jsonl)).toBe(AUTH_URL);
  });

  it("round-trips a long URL byte-exactly and skips malformed lines", () => {
    const jsonl = ["not json", "", "{broken", assistantText(`link: ${AUTH_URL}`)].join("\n");
    expect(detectAuthUrl(jsonl)).toBe(AUTH_URL);
  });

  it("returns null for an empty transcript", () => {
    expect(detectAuthUrl("")).toBeNull();
  });
});
