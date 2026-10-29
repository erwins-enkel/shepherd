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
