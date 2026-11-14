import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { config } from "../src/config";
import {
  MAX_HOST_FILE_BYTES,
  announced,
  deniedHostPath,
  hostEnv,
  parseAllowList,
  readHostFile,
  resolveHostFile,
  type HostEnv,
} from "../src/host-file";
import { scopeAllows } from "../src/token-scopes";

let home: string;
let transcript: string;
const prevHome = process.env.HOME;
const prevAgentTmp = process.env.SHEPHERD_AGENT_TMPDIR;

const assistant = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const writeCall = (file_path: string) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path } }] },
  });
const toolResult = (text: string) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: text }] },
  });
const userSays = (text: string) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text }] } });

function put(rel: string, body: string | Buffer, mode = 0o644): string {
  const p = join(home, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  chmodSync(p, mode);
  return p;
}

function setTranscript(lines: string[]): void {
  writeFileSync(transcript, lines.join("\n") + "\n");
}

beforeEach(() => {
  home = mkdtempSync(join(config.repoRoot, "shepherd-hostfile-"));
  process.env.HOME = home;
  // Inside a Shepherd session the run's temp root sits under the real agent tmp dir, which the
  // guard denies; disable that root so the test home is in scope (its own test covers it).
  process.env.SHEPHERD_AGENT_TMPDIR = "";
  transcript = join(home, "work", "t.jsonl");
  mkdirSync(join(home, "work"), { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env.HOME = prevHome;
  if (prevAgentTmp === undefined) delete process.env.SHEPHERD_AGENT_TMPDIR;
  else process.env.SHEPHERD_AGENT_TMPDIR = prevAgentTmp;
});

const resolve = (p: string, provider: "claude" | "codex" = "claude") =>
  resolveHostFile(p, { transcriptPath: transcript, provider });

// ── denylist + scope ──────────────────────────────────────────────────────────

test("deniedHostPath: scope and denylist", () => {
  const env: HostEnv = {
    home: "/h",
    scopeRoots: ["/h", "/tmp"],
    deniedRoots: ["/h/.config/gh", "/h/.cache/shepherd"],
  };
  const allowed = ["/h/notes/report.md", "/h/.local/state/tool/reports/r.md", "/tmp/out.txt"];
  const denied = [
    "/etc/passwd",
    "/h/.env",
    "/h/app/.env.local",
    "/h/app/prod.env",
    "/h/.ssh/config",
    "/h/.aws/credentials",
    "/h/.config/gh/hosts.yml",
    "/h/.cache/shepherd/tmp/x.md",
    "/h/.shepherd/shepherd.log",
    "/h/.claude/settings.json",
    "/h/.codex/auth.json",
    "/h/.local/share/keyrings/login.keyring",
    "/tmp/shepherd-spawn-abc/run.sh",
    "/h/certs/server.pem",
    "/h/keys/id_ed25519.pub",
    "/h/x/credentials.json",
    "/h/x/token.json",
  ];
  for (const p of allowed) expect(deniedHostPath(p, env)).toBe(false);
  for (const p of denied) expect(deniedHostPath(p, env)).toBe(true);
});

test("hostEnv scopes $HOME and tmp, denies Shepherd state", async () => {
  const env = await hostEnv();
  expect(env.scopeRoots).toContain(home);
  expect(env.scopeRoots).toContain("/tmp");
  expect(env.deniedRoots).toContain(join(home, ".config/shepherd"));
  process.env.SHEPHERD_AGENT_TMPDIR = join(home, "agent-tmp");
  expect((await hostEnv()).deniedRoots).toContain(join(home, "agent-tmp"));
});

// ── allow-list ────────────────────────────────────────────────────────────────

test("announced: delimited raw, ~/, encoded and file:// forms; not a longer path", () => {
  const p = "/h/r/my report.md";
  const allowOf = (text: string) => ({ texts: [text], writes: new Set<string>() });
  for (const t of [
    "saved to /h/r/my report.md.",
    "[r](/h/r/my%20report.md)",
    "see <file:///h/r/my%20report.md>",
    "`~/r/my report.md`",
    "[r](~/r/my%20report.md#L3)",
  ])
    expect(announced(allowOf(t), p, "/h")).toBe(true);
  for (const t of ["/h/r/my report.md.bak", "/x/h/r/my report.md", "~/h/r/my report.md"])
    expect(announced(allowOf(t), p, "/h")).toBe(false);
});

test("parseAllowList: assistant text + Write targets only", () => {
  const allow = parseAllowList(
    [assistant("a /h/a.md"), writeCall("/h/w.md"), toolResult("/h/t.md"), userSays("/h/u.md")].join(
      "\n",
    ),
    "claude",
  );
  expect(allow.writes).toEqual(new Set(["/h/w.md"]));
  expect(allow.texts.join(" ")).toContain("/h/a.md");
  expect(allow.texts.join(" ")).not.toContain("/h/t.md");
  expect(allow.texts.join(" ")).not.toContain("/h/u.md");
});

// ── resolve + read ────────────────────────────────────────────────────────────

test("an announced text file resolves and reads; ~/ form too", async () => {
  const p = put(".local/state/tool/reports/r.md", "# Report\n");
  setTranscript([assistant(`Report: [r](${p})`)]);
  const hit = await resolve(p);
  expect(hit?.path).toBe(p);
  expect(await readHostFile(hit!)).toBe("# Report\n");
  expect((await resolve("~/.local/state/tool/reports/r.md"))?.path).toBe(p);
});

test("a Write target resolves without a chat mention", async () => {
  const p = put("notes/w.txt", "w");
  setTranscript([writeCall(p)]);
  expect(await resolve(p)).not.toBeNull();
});

test("Codex: announced in assistant output_text", async () => {
  const p = put("notes/c.md", "c");
  setTranscript([
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `wrote ${p}` }],
      },
    }),
  ]);
  expect(await resolve(p, "codex")).not.toBeNull();
});

test("refuses unannounced, tool-result-only, user-only and suffix mentions", async () => {
  const a = put("n/a.md", "a");
  const b = put("n/b.md", "b");
  const c = put("n/c.md", "c");
  const d = put("n/d.md", "d");
  setTranscript([toolResult(b), userSays(c), assistant(`${d}.bak`)]);
  for (const p of [a, b, c, d]) expect(await resolve(p)).toBeNull();
});

test("refuses denied, out-of-scope, symlinked-to-denied, owner-only, big, binary, dirs", async () => {
  const env = put(".env", "SECRET=1");
  const key = put(".ssh/id_x", "k");
  const link = join(home, "n", "link.md");
  mkdirSync(join(home, "n"), { recursive: true });
  symlinkSync(key, link);
  const outside = "/etc/hostname";
  const outLink = join(home, "n", "out.md");
  symlinkSync(outside, outLink);
  const priv = put("n/priv.md", "p", 0o600);
  const big = put("n/big.log", "x".repeat(MAX_HOST_FILE_BYTES + 1));
  const bin = put("n/bin.txt", Buffer.from([0x61, 0x00, 0x62]));
  const bad = put("n/bad.txt", Buffer.from([0xff, 0xfe, 0x41]));
  const dir = join(home, "n", "dir");
  mkdirSync(dir);
  const all = [env, key, link, outside, outLink, priv, big, bin, bad, dir];
  setTranscript([assistant(all.map((p) => `- ${p}`).join("\n"))]);
  for (const p of all) expect(await resolve(p)).toBeNull();
});

test("no transcript → nothing resolves", async () => {
  const p = put("n/a.md", "a");
  expect(await resolveHostFile(p, { transcriptPath: null, provider: "claude" })).toBeNull();
  expect(await resolveHostFile(p, { transcriptPath: transcript, provider: "claude" })).toBeNull();
});

test("allow-list re-parses when the transcript grows", async () => {
  const p = put("n/late.md", "l");
  setTranscript([assistant("nothing yet")]);
  expect(await resolve(p)).toBeNull();
  appendFileSync(transcript, assistant(`now ${p}`) + "\n");
  expect(await resolve(p)).not.toBeNull();
});

test("read refuses a file swapped after resolve", async () => {
  const p = put("n/s.md", "one");
  setTranscript([assistant(p)]);
  const hit = await resolve(p);
  rmSync(p);
  put("n/s.md", "two");
  expect(await readHostFile(hit!)).toBeNull();
});

test("files/host is full-scope only", () => {
  for (const scope of ["read", "submit"])
    expect(scopeAllows(scope, "GET", "/api/sessions/x/files/host")).toBe(false);
  expect(scopeAllows("full", "GET", "/api/sessions/x/files/host")).toBe(true);
});
