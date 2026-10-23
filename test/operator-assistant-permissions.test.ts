import { expect, test } from "bun:test";
import {
  actionGroupOf,
  ASSISTANT_ACTION_GROUPS,
  assistantMode,
  assistantPermissionRules,
  DEFAULT_ASSISTANT_PERMISSIONS,
  normalizeStoredAssistantPermissions,
  OPERATOR_DIAG_TOOL_NAMES,
  parseAssistantPermissionsPatch,
  READ_DIAG_BASH,
  type AssistantPermissions,
} from "../src/operator-assistant-permissions";
import { OPERATOR_DIAG_TOOLS } from "../src/operator-assistant-tools";

const ALL_OFF: AssistantPermissions = {
  shell: "ask",
  steer: "off",
  start: "off",
  sessions: "off",
  approve: "off",
  automation: "off",
};

test("defaults: reads and starting a session run free, every other action group asks", () => {
  expect(DEFAULT_ASSISTANT_PERMISSIONS).toEqual({
    shell: "read",
    steer: "ask",
    start: "allow",
    sessions: "ask",
    approve: "ask",
    automation: "ask",
  });
});

test("patch: a partial object of valid levels parses", () => {
  expect(parseAssistantPermissionsPatch({ steer: "allow", shell: "all" })).toEqual({
    ok: true,
    patch: { steer: "allow", shell: "all" },
  });
});

test("patch: unknown keys, wrong levels and non-objects are refused", () => {
  for (const raw of [
    null,
    "x",
    [],
    {},
    { files: "allow" },
    { steer: "read" },
    { shell: "allow" },
  ]) {
    expect(parseAssistantPermissionsPatch(raw).ok).toBe(false);
  }
});

test("stored value: missing or corrupt fields fall back to their defaults one by one", () => {
  expect(normalizeStoredAssistantPermissions(null)).toEqual(DEFAULT_ASSISTANT_PERMISSIONS);
  expect(normalizeStoredAssistantPermissions("{not json")).toEqual(DEFAULT_ASSISTANT_PERMISSIONS);
  expect(normalizeStoredAssistantPermissions('{"steer":"allow","sessions":"bogus"}')).toEqual({
    ...DEFAULT_ASSISTANT_PERMISSIONS,
    steer: "allow",
  });
  // A set stored before `start` existed gets it at its default, on.
  const before =
    '{"shell":"read","steer":"ask","sessions":"ask","approve":"ask","automation":"ask"}';
  expect(normalizeStoredAssistantPermissions(before).start).toBe("allow");
  expect(normalizeStoredAssistantPermissions('{"start":"off"}').start).toBe("off");
});

test("rules: each shell level maps to exactly one Bash rule set", () => {
  const shell = (level: AssistantPermissions["shell"]) =>
    assistantPermissionRules({ ...ALL_OFF, shell: level });
  expect(shell("off").deny).toContain("Bash");
  expect(shell("ask").ask).toEqual(["Bash"]);
  expect(shell("read").allow).toEqual(READ_DIAG_BASH);
  expect(shell("read").ask).toEqual([]);
  expect(shell("all").allow).toEqual(["Bash"]);
});

test("rules: read diagnostics carry both the bare and the argument form, and no write-flag tool", () => {
  expect(READ_DIAG_BASH).toContain("Bash(ps)");
  expect(READ_DIAG_BASH).toContain("Bash(ps *)");
  expect(READ_DIAG_BASH).toContain("Bash(systemctl --user status *)");
  expect(READ_DIAG_BASH.some((r) => r.includes("journalctl") || r.startsWith("Bash(ss"))).toBe(
    false,
  );
});

test("rules: every tool of a group lands in the bucket of the group's level", () => {
  const rules = assistantPermissionRules({
    shell: "read",
    steer: "allow",
    start: "allow",
    sessions: "ask",
    approve: "off",
    automation: "ask",
  });
  expect(rules.allow).toContain("mcp__shepherd__session_steer");
  expect(rules.allow).toContain("mcp__shepherd__session_start");
  expect(rules.allow).toContain("mcp__shepherd__plan_answer");
  expect(rules.ask).toContain("mcp__shepherd__session_interrupt");
  expect(rules.ask).toContain("mcp__shepherd__herd_retry");
  expect(rules.deny).toEqual(ASSISTANT_ACTION_GROUPS.approve.map((t) => `mcp__shepherd__${t}`));
});

test("actionGroupOf names the group of an action tool and null for a read tool", () => {
  expect(actionGroupOf("pr_merge")).toBe("approve");
  expect(actionGroupOf("held_task")).toBe("automation");
  expect(actionGroupOf("session_start")).toBe("start");
  expect(actionGroupOf("herd_status")).toBe(null);
});

test("mode: acts when anything runs unasked, readonly when no group is on, else asks", () => {
  expect(assistantMode(ALL_OFF)).toBe("readonly");
  expect(assistantMode({ ...ALL_OFF, shell: "read" })).toBe("readonly");
  expect(assistantMode({ ...ALL_OFF, shell: "all" })).toBe("acts");
  // Starting a session runs unasked by default.
  expect(assistantMode(DEFAULT_ASSISTANT_PERMISSIONS)).toBe("acts");
  expect(assistantMode({ ...DEFAULT_ASSISTANT_PERMISSIONS, start: "ask" })).toBe("asks");
  expect(assistantMode({ ...DEFAULT_ASSISTANT_PERMISSIONS, start: "ask", approve: "allow" })).toBe(
    "acts",
  );
});

test("the overlay's read-tool names are exactly the read catalog, so no read tool prompts", () => {
  expect(OPERATOR_DIAG_TOOLS.map((t) => t.name)).toEqual([...OPERATOR_DIAG_TOOL_NAMES]);
});

test("drain_enqueue follows automation off, ask and allow", () => {
  expect(actionGroupOf("drain_enqueue")).toBe("automation");
  for (const [level, bucket] of [
    ["off", "deny"],
    ["ask", "ask"],
    ["allow", "allow"],
  ] as const) {
    const rules = assistantPermissionRules({ ...ALL_OFF, automation: level });
    expect(rules[bucket]).toContain("mcp__shepherd__drain_enqueue");
  }
});
