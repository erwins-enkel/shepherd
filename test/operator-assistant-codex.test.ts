import { expect, test } from "bun:test";
import { assistantCodexConfig, buildCodexAssistantArgv } from "../src/operator-assistant-codex";

test("Codex assistant has isolated MCP and read-denying read-only permissions", () => {
  const config = Bun.TOML.parse(
    assistantCodexConfig({
      cwd: "/safe/assistant",
      home: "/safe/runtime",
      endpoint: "http://127.0.0.1:7331/mcp",
      key: "test-only",
      brief: "assistant",
    }),
  ) as any;
  expect(config.features.shell_tool).toBe(false);
  expect(config.approval_policy).toBe("never");
  expect(config.permissions.assistant.extends).toBe(":read-only");
  expect(config.permissions.assistant.filesystem["/safe/runtime"]).toBe("deny");
  expect(Object.keys(config.mcp_servers)).toEqual(["shepherd"]);
});

test("Codex resumes only its proven native identity, without coding bypass flags", () => {
  const argv = buildCodexAssistantArgv({
    home: "/private/runtime",
    resumeId: "native-123",
    launchId: "launch",
    model: "gpt-6-astra",
    effort: "high",
  });
  expect(argv).toContain("resume");
  expect(argv).toContain("native-123");
  expect(argv).toContain("gpt-6-astra");
  expect(argv.join(" ")).not.toContain("dangerously");
});

test("a private assistant home resolves a terminal-started conversation but refuses forks", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { findAssistantCodexSessionId } = await import("../src/operator-assistant-codex");
  const home = mkdtempSync(join(tmpdir(), "assistant-codex-id-"));
  const dir = join(home, "sessions");
  mkdirSync(dir);
  const record = (id: string) =>
    writeFileSync(
      join(dir, `rollout-2026-10-29-${id}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { id, cwd: "/assistant", source: "cli" } }) +
        "\n",
    );
  try {
    record("11111111-1111-1111-1111-111111111111");
    expect(findAssistantCodexSessionId(home, "/assistant")).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
    record("22222222-2222-2222-2222-222222222222");
    expect(findAssistantCodexSessionId(home, "/assistant")).toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("auth publication replaces a symlink without changing its target and preserves refreshes", async () => {
  const {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    rmSync,
    symlinkSync,
    lstatSync,
    statSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { assistantCodexHome, prepareCodexAssistant } =
    await import("../src/operator-assistant-codex");
  const root = mkdtempSync(join(tmpdir(), "assistant-auth-publish-"));
  const sourceHome = join(root, "source");
  const cwd = join(root, "assistant");
  const home = assistantCodexHome(cwd, "test");
  const auth = join(home, "auth.json");
  const target = join(root, "unrelated.json");
  const savedHome = process.env.CODEX_HOME;
  const opts = { cwd, id: "test", endpoint: "http://127.0.0.1:1/mcp", key: "test", brief: "test" };
  try {
    mkdirSync(sourceHome);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    process.env.CODEX_HOME = sourceHome;
    writeFileSync(join(sourceHome, "auth.json"), "source-auth");
    writeFileSync(target, "unrelated", { mode: 0o644 });
    symlinkSync(target, auth);
    prepareCodexAssistant(opts);
    expect(readFileSync(target, "utf8")).toBe("unrelated");
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(readFileSync(auth, "utf8")).toBe("source-auth");
    writeFileSync(auth, "isolated-refresh");
    prepareCodexAssistant(opts);
    expect(readFileSync(auth, "utf8")).toBe("isolated-refresh");
    writeFileSync(join(sourceHome, "auth.json"), "operator-relogin");
    prepareCodexAssistant(opts);
    expect(readFileSync(auth, "utf8")).toBe("operator-relogin");
    expect(lstatSync(auth).isSymbolicLink()).toBe(false);
    expect(statSync(auth).mode & 0o777).toBe(0o600);
  } finally {
    if (savedHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  }
});
