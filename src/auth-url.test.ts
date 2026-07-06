import { describe, it, expect } from "bun:test";
import { detectAuthUrl, detectPendingAuthUrl, detectLoginAuthUrl } from "./auth-url";

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

// Attachment / system records — carry no `message`, so they are NOT meaningful records and must
// not count toward the freshness gate's since-set distance.
const attachment = () => JSON.stringify({ type: "attachment" });
const system = () => JSON.stringify({ type: "system", content: "hook ran" });

describe("detectPendingAuthUrl (freshness-gated)", () => {
  it("returns the URL for the real captured check-sentry tail shape (0 meaningful records after)", () => {
    // Mirrors the captured transcript tail: the authorize URL lands in a `tool_result` (raw MCP
    // payload) AND the assistant relay, with only attachment/system records trailing — sinceSet=0.
    const jsonl = [
      opInputString("check sentry"),
      toolUse(),
      toolResult(`MCP server sentry requires authorization. Visit: ${AUTH_URL}`),
      attachment(),
      assistantText(
        `The Sentry MCP server needs authorization.\n1. Open this URL:\n\n${AUTH_URL}\n\n2. Paste the callback URL here.`,
      ),
      attachment(),
      system(),
      system(),
    ].join("\n");
    expect(detectPendingAuthUrl(jsonl)).toBe(AUTH_URL);
  });

  it("surfaces a URL that is the last meaningful record", () => {
    const jsonl = [opInputString("go"), assistantText(`Authorize: ${AUTH_URL}`)].join("\n");
    expect(detectPendingAuthUrl(jsonl)).toBe(AUTH_URL);
  });

  it("suppresses a stale URL buried under more than K meaningful records (truncation phantom)", () => {
    // A stale URL whose clearing operator message scrolled out of the MAX_TAIL_BYTES window,
    // followed by many autonomous tool turns — must NOT re-surface as a phantom banner.
    const trailing = Array.from({ length: 30 }, () => toolUse());
    const jsonl = [assistantText(`old prompt: ${AUTH_URL}`), ...trailing].join("\n");
    expect(detectPendingAuthUrl(jsonl)).toBeNull();
  });

  it("still surfaces a URL with a handful of trailing assistant messages (generous K)", () => {
    const trailing = Array.from({ length: 5 }, () => assistantText("still waiting on you"));
    const jsonl = [assistantText(`Authorize: ${AUTH_URL}`), ...trailing].join("\n");
    expect(detectPendingAuthUrl(jsonl)).toBe(AUTH_URL);
  });

  it("returns null once the operator has responded (explicit clear)", () => {
    const jsonl = [
      assistantText(`Authorize: ${AUTH_URL}`),
      opInputString("http://localhost:3118/callback?code=xyz"),
    ].join("\n");
    expect(detectPendingAuthUrl(jsonl)).toBeNull();
  });
});

// Byte-faithful capture of a real `herdr.read(term,"visible")` of the Claude Code `/login`
// (account re-login) panel — the pane hard-wrapped the flush-left URL at 63 cols, breaking it
// mid-token with NO inserted spaces. This authorize URL is PTY-only (it never lands in the JSONL
// transcript), so this fixture is the sole validation that the wrap-join reconstructs a REAL
// hard-wrap. `client_id` is the public Claude Code OAuth client id; the single-use PKCE
// `code_challenge`/`state` are long-expired nonces.
const LOGIN_URL_LINES = [
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c25",
  "0a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=ht",
  "tps%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=o",
  "rg%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessio",
  "ns%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_chall",
  "enge=7fZ4v-QWXM2nnE_04d3um7K5-KOOVAHtRcFmvlTBIfE&code_challenge_m",
  "ethod=S256&state=t6_LEFskFrRPiy_pnzr_f9uKwJSArorv7PaSt4DuoKY",
];
const LOGIN_URL = LOGIN_URL_LINES.join("");
const LOGIN_PANEL = [
  "❯ /login",
  "",
  "─".repeat(62),
  "  Login",
  "",
  "  Browser didn't open? Use the url below to sign in (c to copy)",
  "",
  ...LOGIN_URL_LINES,
  "",
  "",
  "  Paste code here if prompted >",
  "",
  "  Esc to cancel",
].join("\n");

describe("detectLoginAuthUrl", () => {
  it("reconstructs the wrapped URL from a byte-faithful /login panel capture", () => {
    expect(detectLoginAuthUrl(LOGIN_PANEL)).toBe(LOGIN_URL);
    // Sanity: the reconstruction really is a valid authorize URL.
    expect(new URL(LOGIN_URL).pathname).toBe("/cai/oauth/authorize");
  });

  it("returns a single-line (unwrapped) authorize URL as-is", () => {
    expect(detectLoginAuthUrl(`  Login\n\n${LOGIN_URL}\n\n  Esc to cancel`)).toBe(LOGIN_URL);
  });

  it("reconstructs a URL wrapped inside a box-drawing border", () => {
    const bordered = [
      "│  Login" + " ".repeat(10) + "│",
      "│" + " ".repeat(20) + "│",
      ...LOGIN_URL_LINES.map((l) => "│ " + l + " │"),
      "│" + " ".repeat(20) + "│",
    ].join("\n");
    expect(detectLoginAuthUrl(bordered)).toBe(LOGIN_URL);
  });

  it("stops before appending a following text line with NO intervening blank line (plain)", () => {
    // `Paste code here…` directly follows the last URL chunk with no blank line. Its leading
    // `Paste` must NOT be appended (evaluate-STOP-before-APPEND) — else a broken-but-structurally
    // -valid authorize URL passes both isAuthUrl and the stability gate.
    const noBlank = [...LOGIN_URL_LINES, "  Paste code here if prompted >"].join("\n");
    expect(detectLoginAuthUrl(noBlank)).toBe(LOGIN_URL);
  });

  it("stops before appending a following text line with NO blank line (box-bordered)", () => {
    const noBlank = [
      ...LOGIN_URL_LINES.map((l) => "│ " + l + " │"),
      "│ Paste code here if prompted > │",
    ].join("\n");
    expect(detectLoginAuthUrl(noBlank)).toBe(LOGIN_URL);
  });

  it("anchors past a non-URL prefix on the URL's first line", () => {
    const prefixed = ["url> " + LOGIN_URL_LINES[0], ...LOGIN_URL_LINES.slice(1)].join("\n");
    expect(detectLoginAuthUrl(prefixed)).toBe(LOGIN_URL);
  });

  it("returns null when the visible buffer has no URL", () => {
    expect(
      detectLoginAuthUrl("  Login\n\n  Paste code here if prompted >\n\n  Esc to cancel"),
    ).toBeNull();
  });

  it("returns null for a wrapped NON-auth URL (isAuthUrl gate)", () => {
    const nonAuth = [
      "https://example.com/very/long/path/that/wraps/here/aaaaaaaaa",
      "bbbbbbbbbbbb/cccccc/dddddd",
    ].join("\n");
    expect(detectLoginAuthUrl(nonAuth)).toBeNull();
  });

  it("skips a leading non-auth URL and finds the auth URL later in the buffer", () => {
    const buf = ["visit https://example.com/docs for help", "", ...LOGIN_URL_LINES].join("\n");
    expect(detectLoginAuthUrl(buf)).toBe(LOGIN_URL);
  });
});
