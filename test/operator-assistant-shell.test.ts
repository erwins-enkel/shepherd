import { expect, test } from "bun:test";
import { assistantShellNeedsApproval } from "../src/operator-assistant-shell";

test("read diagnostics never mistake write flags or an executable path for a free read", () => {
  expect(assistantShellNeedsApproval(["df", "-h"], "read")).toBe(false);
  expect(assistantShellNeedsApproval(["systemctl", "--user", "status", "herdr"], "read")).toBe(
    false,
  );
  expect(assistantShellNeedsApproval(["systemctl", "restart", "herdr"], "read")).toBe(true);
  expect(
    assistantShellNeedsApproval(["find", "/", "-exec", "sh", "-c", "echo bad", ";"], "read"),
  ).toBe(true);
  expect(assistantShellNeedsApproval(["/tmp/df"], "read")).toBe(true);
  expect(assistantShellNeedsApproval(["df"], "ask")).toBe(true);
});

test("the shell gate refuses off and denied commands before starting any subprocess", async () => {
  const { SessionStore } = await import("../src/store");
  const { DEFAULT_ASSISTANT_PERMISSIONS } = await import("../src/operator-assistant-permissions");
  const { applyAssistantShell } = await import("../src/operator-assistant-shell");
  const store = new SessionStore(":memory:");
  const source = store.create({
    name: "hud",
    prompt: "",
    repoPath: "/missing",
    worktreePath: "/missing",
    baseBranch: "",
    branch: null,
    isolated: false,
    herdrSession: "test",
    herdrAgentId: "test",
    claudeSessionId: "test",
    model: null,
    operatorAssistant: true,
    agentProvider: "codex",
  });
  let shell: "off" | "ask" = "off";
  const deps = {
    store,
    operatorActions: { permissions: () => ({ ...DEFAULT_ASSISTANT_PERMISSIONS, shell }) },
    actionRequests: {
      request: () => ({ status: "denied" as const }),
      wait: async () => "denied" as const,
    },
  } as unknown as import("../src/agent-control").AgentControlDeps;
  expect(
    await applyAssistantShell(deps, source.id, { argv: ["touch", "/tmp/should-never-run"] }),
  ).toMatchObject({ ok: false, status: 403 });
  shell = "ask";
  expect(
    await applyAssistantShell(deps, source.id, { argv: ["touch", "/tmp/should-never-run"] }),
  ).toMatchObject({ ok: false, status: 403 });
});
