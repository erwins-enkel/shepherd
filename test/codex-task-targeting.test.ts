import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexLaunchMarker } from "../src/codex-session-id";
import { SessionService } from "../src/service";
import { SessionStore } from "../src/store";
import type { HerdrAgent } from "../src/herdr";
import type { AgentProvider } from "../src/types";

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "shepherd-targeting-"));
  mkdirSync(join(home, "sessions"));
  process.env.CODEX_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function rollout(nativeId: string, launchId: string) {
  writeFileSync(
    join(home, "sessions", "rollout-" + nativeId + ".jsonl"),
    [
      { type: "session_meta", payload: { id: nativeId, cwd: "/shared", source: "cli" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: codexLaunchMarker(launchId) + "Task" }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
}

function harness(provider: AgentProvider, shell = false) {
  const store = new SessionStore(":memory:");
  const row = (name: string, terminal: string) =>
    store.create({
      name,
      prompt: "task",
      repoPath: "/repo",
      baseBranch: "main",
      branch: null,
      worktreePath: "/shared",
      isolated: false,
      herdrSession: "default",
      herdrAgentId: terminal,
      agentProvider: provider,
      claudeSessionId: provider === "claude" ? name : "",
      codexLaunchId: provider === "codex" ? name : "",
      planPhase: "planning",
      autopilotEnabled: true,
    });
  const target = row("target", "exited");
  const sibling = row("sibling", "sibling-terminal");
  const agent = (terminalId: string, name: string) =>
    ({
      terminalId,
      paneId: terminalId,
      cwd: "/shared",
      name,
      agentStatus: "idle",
    }) as HerdrAgent;
  const agents = [agent(sibling.herdrAgentId, sibling.name), agent("operator", "operator")];
  if (shell) agents.push(agent(target.herdrAgentId, target.name));
  const starts: string[][] = [];
  const sent: { terminal: string; text: string }[] = [];
  const stopped: string[] = [];
  const failSend = { value: false };
  const svc = new SessionService({
    store,
    namer: async () => "task",
    detectBackend: () => null,
    detectEgressBackend: () => null,
    worktree: { remove() {}, gitCommonDir: () => "/git" } as any,
    herdr: {
      list: () => agents,
      start: async (_name: string, _cwd: string, argv: string[]) => {
        starts.push(argv);
        const live = agent("resumed", target.name);
        live.agentStatus = "working";
        agents.push(live);
        return live;
      },
      stop: async (terminal: string) => {
        stopped.push(terminal);
        const i = agents.findIndex((a) => a.terminalId === terminal);
        if (i >= 0) agents.splice(i, 1);
      },
      paneForegroundProcs: async (pane: string) => (pane === "exited" ? ["bash"] : [provider]),
      send: async (terminal: string, text: string) => {
        if (failSend.value) throw new Error("pane disappeared");
        sent.push({ terminal, text });
      },
    } as any,
  });
  store.putPlanGate({
    sessionId: target.id,
    planHash: "hash",
    decision: "approved",
    approved: true,
    summary: "approved",
    body: "",
    findings: [],
    round: 0,
    cap: 5,
    plan: "plan",
    updatedAt: 0,
  });
  return { svc, store, target, sibling, starts, sent, stopped, failSend };
}

for (const provider of ["claude", "codex"] as const) {
  for (const shell of [false, true]) {
    test(`shared-cwd ${provider}: approval revives ${shell ? "shell husk" : "exited planner"} and leaves siblings alone`, async () => {
      rollout("native-sibling", "sibling");
      rollout("native-target", "target"); // target may write its history after the sibling
      rollout("native-operator", "operator");
      const h = harness(provider, shell);
      expect(await h.svc.releasePlanGate(h.target.id)).toBe(true);
      expect(h.starts).toHaveLength(1);
      expect(h.starts[0]).toContain(provider === "codex" ? "native-target" : "target");
      expect(h.starts[0]).not.toContain("--last");
      expect(h.sent.length).toBeGreaterThan(0);
      expect(h.sent.every((s) => s.terminal === "resumed")).toBe(true);
      expect(h.stopped).toEqual(shell ? ["exited"] : []);
      expect(h.store.get(h.target.id)?.planPhase).toBe("executing");
      expect(h.store.get(h.sibling.id)?.herdrAgentId).toBe("sibling-terminal");
    });
  }

  test(`shared-cwd ${provider}: review rework is delivered to the exact exited conversation`, async () => {
    rollout("native-target", "target");
    const h = harness(provider);
    expect(
      await h.svc.resumeAndReply(h.target.id, "Revise the plan: cover concurrent sessions."),
    ).toBe(true);
    expect(h.starts[0]).toContain(provider === "codex" ? "native-target" : "target");
    expect(h.sent.some((s) => s.text.includes("Revise the plan"))).toBe(true);
    expect(h.sent.every((s) => s.terminal === "resumed")).toBe(true);
    expect(h.store.get(h.target.id)?.planPhase).toBe("planning");
  });

  test(`shared-cwd ${provider}: failed approval delivery retains planning phase`, async () => {
    rollout("native-target", "target");
    const h = harness(provider);
    h.failSend.value = true;
    await expect(h.svc.releasePlanGate(h.target.id)).rejects.toThrow("pane disappeared");
    expect(h.store.get(h.target.id)?.planPhase).toBe("planning");
  });
}

for (const ambiguous of [false, true]) {
  test(`Codex ${ambiguous ? "ambiguous" : "missing"} provenance refuses release, rework and forced resume`, async () => {
    if (ambiguous) {
      rollout("first", "target");
      rollout("copied-history", "target");
    }
    rollout("operator", "unrelated");
    const h = harness("codex", true);
    expect(await h.svc.releasePlanGate(h.target.id)).toBe(false);
    expect(await h.svc.resumeAndReply(h.target.id, "rework")).toBe(false);
    expect(await h.svc.resume(h.target.id, { force: true })).toBeNull();
    expect(h.starts).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.stopped).toEqual([]);
    expect(h.store.get(h.target.id)?.planPhase).toBe("planning");
  });
}

test("Codex ignores legacy cwd-derived cached ids and stale pre-replacement snapshots", async () => {
  rollout("native-old", "target");
  const h = harness("codex");
  h.store.update(h.target.id, { codexLaunchId: "", providerSessionId: "legacy-guessed-id" });
  expect(await h.svc.resume(h.target.id, { force: true })).toBeNull();
  h.store.update(h.target.id, { codexLaunchId: "replacement", providerSessionId: "" });
  h.svc.captureCodexSessionId(h.target);
  expect(h.store.get(h.target.id)?.providerSessionId).toBe("");
  rollout("native-new", "replacement");
  expect(await h.svc.resume(h.target.id)).not.toBeNull();
  expect(h.starts[0]).toContain("native-new");
  expect(h.starts[0]).not.toContain("native-old");
});

test("concurrent plan releases send the implementation instruction only once", async () => {
  rollout("native-target", "target");
  const h = harness("codex");
  expect(
    await Promise.all([h.svc.releasePlanGate(h.target.id), h.svc.releasePlanGate(h.target.id)]),
  ).toEqual([true, true]);
  expect(h.starts).toHaveLength(1);
  expect(h.sent).toHaveLength(2); // one bracketed paste and its Enter
});

test("approval withdrawn during delivery is not overwritten by release completion", async () => {
  const h = harness("claude");
  h.svc.resumeAndReply = async () => {
    h.store.putPlanGate({
      ...h.store.getPlanGate(h.target.id)!,
      approved: false,
      decision: "changes_requested",
    });
    return true;
  };
  expect(await h.svc.releasePlanGate(h.target.id)).toBe(false);
  expect(h.store.get(h.target.id)?.planPhase).toBe("planning");
});
