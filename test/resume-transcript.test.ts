import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RestoreError, SessionService, type ServiceDeps } from "../src/service";
import { SessionStore } from "../src/store";
import { jsonlPathFor } from "../src/usage";
import { EventHub } from "../src/events";
import { makeApp } from "../src/server";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "shepherd-transcript-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(
  provider: "claude" | "codex" = "claude",
  live = false,
  capacity?: () => Promise<boolean>,
  overrides: Partial<ServiceDeps> = {},
) {
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "transcript",
    prompt: "go",
    repoPath: scratch,
    baseBranch: "main",
    branch: "shepherd/transcript",
    worktreePath: join(scratch, "wt"),
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "old",
    claudeSessionId: "claude-id",
    agentProvider: provider,
    providerSessionId: "codex-id",
    codexLaunchId: "launch-id",
  });
  store.update(s.id, { status: "done" });
  store.setSpawnIdentity(s.id, "old", join(scratch, "account"));
  let starts = 0;
  let stops = 0;
  let argv: string[] = [];
  const sent: string[] = [];
  let terminalId = "old";
  const events = new EventHub();
  const service = new SessionService({
    store,
    events,
    capacity,
    runSpawnHooks:
      provider === "claude" ? async () => ({ credentialDir: join(scratch, "account") }) : undefined,
    namer: () => "transcript",
    worktree: {} as never,
    herdr: {
      list: () => (live ? [{ terminalId, cwd: s.worktreePath, name: s.name }] : []),
      paneForegroundProcs: async () => ["claude"],
      send: async (_target: string, text: string) => {
        sent.push(text);
      },
      stop: async () => {
        stops++;
      },
      start: async (_name: string, _cwd: string, args: string[]) => {
        starts++;
        argv = args;
        return { terminalId: "new" };
      },
    } as never,
    ...overrides,
  });
  const session = store.get(s.id)!;
  const path = jsonlPathFor(session.worktreePath, session.claudeSessionId, session.spawnAccountDir);
  return {
    service,
    store,
    events,
    session,
    path,
    starts: () => starts,
    stops: () => stops,
    argv: () => argv,
    sent,
    setTerminalId: (id: string) => {
      terminalId = id;
    },
  };
}

test("Claude transcript present in its owning account resumes by exact id", async () => {
  const f = fixture();
  mkdirSync(dirname(f.path), { recursive: true });
  writeFileSync(f.path, '{"type":"user"}\n');
  expect(f.service.hasConversation(f.session)).toBe(true);
  expect(f.service.resumeRefusalCode(f.session.id)).toBeNull();
  const resumed = await f.service.resume(f.session.id, { force: true });
  expect(resumed?.herdrAgentId).toBe("new");
  expect(f.starts()).toBe(1);
  expect(f.argv().slice(f.argv().indexOf("--resume"), f.argv().indexOf("--resume") + 2)).toEqual([
    "--resume",
    "claude-id",
  ]);
});

test("missing transcript: manual API returns stable code and never spawns or tears down", async () => {
  const f = fixture("claude", true);
  // Sidecars cannot substitute for a JSONL conversation.
  mkdirSync(join(dirname(f.path), "claude-id", "tool-results"), { recursive: true });
  expect(f.service.hasConversation(f.session)).toBe(true);
  expect(f.service.canRespawnConversation(f.session)).toBe(false);
  const app = makeApp({
    store: f.store,
    service: f.service,
    events: f.events,
    usageLimits: { limits: () => ({}) as never, projections: () => [] },
  });
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${f.session.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    }),
  );
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "transcript-missing", code: "transcript-missing" });
  expect(f.starts()).toBe(0);
  expect(f.stops()).toBe(0);
  expect(f.store.get(f.session.id)?.status).toBe("done");
});

test("dead Claude: automatic, forced, revive and planner delivery refuse missing transcripts", async () => {
  const f = fixture();
  expect(await f.service.resume(f.session.id, { automatic: true })).toBeNull();
  expect(await f.service.resume(f.session.id, { force: true })).toBeNull();
  expect(await f.service.resumeAndReply(f.session.id, "implement", { automatic: true })).toBe(
    false,
  );
  expect(await f.service.reDriveAccount(f.session.id)).toBe("refused");
  expect(await f.service.reviveAll([f.session.id])).toEqual({ revived: 0, failed: 1 });
  expect(f.starts()).toBe(0);
  expect(f.stops()).toBe(0);
});

test("dead Claude without JSONL receives a typed manual refusal without spawning", async () => {
  const f = fixture();
  const app = makeApp({
    store: f.store,
    service: f.service,
    events: f.events,
    usageLimits: { limits: () => ({}) as never, projections: () => [] },
  });
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${f.session.id}/resume`, { method: "POST" }),
  );
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "transcript-missing", code: "transcript-missing" });
  expect(f.starts()).toBe(0);
});

test("live Claude without JSONL is adopted and receives automatic delivery without API refusal", async () => {
  const f = fixture("claude", true);
  expect(f.service.hasConversation(f.session)).toBe(true);
  expect(f.service.canRespawnConversation(f.session)).toBe(false);
  const app = makeApp({
    store: f.store,
    service: f.service,
    events: f.events,
    usageLimits: { limits: () => ({}) as never, projections: () => [] },
  });
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${f.session.id}/resume`, { method: "POST" }),
  );
  expect(res.status).toBe(200);
  // A restarted herdr may assign a new terminal id; default-account adoption must still work.
  f.store.setSpawnIdentity(f.session.id, "old", null);
  f.setTerminalId("restored-live");
  expect((await f.service.resume(f.session.id))?.herdrAgentId).toBe("restored-live");
  expect(await f.service.resumeAndReply(f.session.id, "implement", { automatic: true })).toBe(true);
  expect(f.sent.join("")).toContain("implement");
  expect(f.starts()).toBe(0);
  expect(f.stops()).toBe(0);
});

test("missing transcript prevents archived restore and account redrive before teardown", async () => {
  const f = fixture("claude", true);
  f.setTerminalId("restored-husk");
  expect(await f.service.resume(f.session.id)).toBeNull(); // account mismatch needs --resume
  expect(await f.service.reDriveAccount(f.session.id)).toBe("refused");
  f.store.update(f.session.id, { status: "archived" });
  try {
    await f.service.restore(f.session.id);
    throw new Error("restore should refuse");
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreError);
    expect((error as RestoreError).code).toBe("cannot_restore");
  }
  expect(f.starts()).toBe(0);
  expect(f.stops()).toBe(0);
});

test("respawn rechecks transcript availability after trim using the filesystem seam", async () => {
  let checks = 0;
  const f = fixture("claude", true, undefined, { transcriptExists: () => ++checks === 1 });
  expect(await f.service.resume(f.session.id, { force: true })).toBeNull();
  expect(checks).toBe(2);
  expect(f.starts()).toBe(0);
  expect(f.stops()).toBe(0);
});

test("Codex exact-id resume does not require a Claude transcript", async () => {
  const f = fixture("codex", false, undefined, {
    transcriptExists: () => {
      throw new Error("Codex must not check Claude JSONL");
    },
  });
  expect(f.service.canRespawnConversation(f.session)).toBe(true);
  expect(f.service.hasConversation(f.session)).toBe(true);
  expect(f.service.resumeRefusalCode(f.session.id)).toBeNull();
  expect(await f.service.resume(f.session.id)).not.toBeNull();
  expect(f.starts()).toBe(1);
  expect(f.argv()).toContain("codex-id");
});

test("transcript removed during resume preparation refuses before tearing down a live pane", async () => {
  const f = fixture("claude", true, async () => {
    rmSync(f.path);
    return true;
  });
  mkdirSync(dirname(f.path), { recursive: true });
  writeFileSync(f.path, '{"type":"user"}\n');
  expect(await f.service.resume(f.session.id, { force: true, automatic: true })).toBeNull();
  expect(f.service.resumeRefusalCode(f.session.id)).toBe("transcript-missing");
  expect(f.starts()).toBe(0);
  expect(f.stops()).toBe(0);
});

test("Claude respawn accepts its owning account transcript under an unexpected encoding", async () => {
  const f = fixture();
  mkdirSync(join(scratch, "account/projects/unexpected-encoding"), { recursive: true });
  writeFileSync(join(scratch, "account/projects/unexpected-encoding/claude-id.jsonl"), "{}\n");
  expect(f.service.canRespawnConversation(f.session)).toBe(true);
  expect(f.service.resumeRefusalCode(f.session.id)).toBeNull();
  expect(await f.service.resume(f.session.id)).not.toBeNull();
  expect(f.starts()).toBe(1);
});
