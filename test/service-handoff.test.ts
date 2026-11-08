import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { HandoffGitError, HandoffRefusedError } from "../src/session-handoff";
import type { SessionContinuation } from "../src/types";
import { inlineSpawnFiles } from "./helpers/spawn-files";

// A session move ("Continue with…" on another machine), service level: the source stops, snapshots
// and pushes (prepare), and gets its agent back when the move fails (abort); the target creates a
// session on that very branch with the handoff text in argv only.

function harness(store: SessionStore) {
  const calls = {
    started: [] as { name: string; cwd: string; argv: string[] }[],
    stopped: [] as string[],
    onBranch: [] as { repo: string; branch: string; headCommit: string; name: string }[],
    pushed: [] as { branch: string; targetName: string }[],
    resumed: [] as string[],
  };
  let failPush = false;
  const service = new SessionService({
    transcriptExists: () => true,
    store,
    namer: async () => "moved",
    worktree: {
      ensureBaseRef: async () => {},
      branchExists: () => false,
      create: () => {
        throw new Error("a continuation never creates a fresh branch");
      },
      createOnBranch: async (
        repo: string,
        a: { branch: string; headCommit: string; baseRef: string; name: string },
      ) => {
        calls.onBranch.push({ repo, branch: a.branch, headCommit: a.headCommit, name: a.name });
        return {
          worktreePath: `/wt/${a.name}`,
          branch: a.branch,
          isolated: true,
          baseCommit: "c".repeat(40),
        };
      },
      remove: () => {},
    } as any,
    herdr: {
      start: async (name: string, cwd: string, argv: string[]) => {
        calls.started.push({ name, cwd, argv: inlineSpawnFiles(argv) });
        return { terminalId: `term_${calls.started.length}`, agentStatus: "working" } as any;
      },
      listAsync: async () => [],
      stop: async (id: string) => {
        calls.stopped.push(id);
      },
    } as any,
    handoffGit: async (a) => {
      if (failPush) throw new HandoffGitError("handoff_push_failed", "rejected");
      calls.pushed.push({ branch: a.branch, targetName: a.targetName });
      return { committed: true, headCommit: "d".repeat(40) };
    },
  });
  // The real resume needs a live herdr; the move only cares that it is asked for.
  const realResume = service.resume.bind(service);
  service.resume = async (id, opts) => {
    if (opts?.automatic && service.handoffHeld(id)) return realResume(id, opts);
    calls.resumed.push(id);
    return null;
  };
  return { service, calls, breakPush: () => (failPush = true) };
}

function source(store: SessionStore, over: Partial<Parameters<SessionStore["create"]>[0]> = {}) {
  return store.create({
    name: "orig",
    prompt: "do the thing",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/orig",
    worktreePath: "/wt/orig",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_orig",
    model: "opus",
    ...over,
  });
}

const continuation: SessionContinuation = {
  branch: "shepherd/orig",
  headCommit: "d".repeat(40),
  handoffMode: "resume",
  from: { machine: "moes-tavern", desig: "TASK-07", provider: "codex" },
  amendments: ["Also cover iOS"],
};

test("a continuation create checks out the pushed branch; the row keeps the task, argv gets the handoff", async () => {
  const store = new SessionStore(":memory:");
  const { service, calls } = harness(store);
  const s = await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do the thing",
    model: null,
    images: [],
    continuation,
  });
  expect(calls.onBranch).toEqual([
    { repo: "/repo", branch: "shepherd/orig", headCommit: "d".repeat(40), name: s.name },
  ]);
  expect(s.branch).toBe("shepherd/orig");
  expect(s.baseCommit).toBe("c".repeat(40));
  expect(store.get(s.id)!.prompt).toBe("do the thing");
  const argv = calls.started[0]!.argv.at(-1)!;
  expect(argv).toContain("do the thing");
  expect(argv).toContain("Machine handoff context:");
  expect(argv).toContain("- Source machine: moes-tavern");
  expect(argv).toContain("- Source session: TASK-07");
  expect(argv).toContain("Also cover iOS");
  expect(argv).not.toContain("do not change files yet");
  expect(store.listActiveTaskAmendments(s.id).map((a) => a.text)).toEqual(["Also cover iOS"]);
});

test("a summarize continuation orients first and names files that could not travel", async () => {
  const store = new SessionStore(":memory:");
  const { service, calls } = harness(store);
  await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do the thing",
    model: null,
    images: [],
    continuation: {
      ...continuation,
      handoffMode: "summarize",
      amendments: undefined,
      missingFiles: ["shot.png"],
    },
  });
  const argv = calls.started[0]!.argv.at(-1)!;
  expect(argv).toContain("do not change files yet");
  expect(argv).toContain("could not be carried over: shot.png");
});

test("prepareHandoff stops the agent, pushes, returns the task and holds automatic resumes", async () => {
  const store = new SessionStore(":memory:");
  const { service, calls } = harness(store);
  const s = source(store, {
    planGateEnabled: true,
    planPhase: "executing",
    agentProvider: "codex",
  });
  store.addTaskAmendment(s.id, "Keep the API stable");
  const out = await service.prepareHandoff(s.id, { name: "macbook" });
  expect(calls.stopped).toEqual(["term_orig"]);
  expect(calls.pushed).toEqual([{ branch: "shepherd/orig", targetName: "macbook" }]);
  expect(out).toMatchObject({
    branch: "shepherd/orig",
    headCommit: "d".repeat(40),
    committed: true,
    prompt: "do the thing",
    desig: s.desig,
    agentProvider: "codex",
    // an approved plan is not planned again on the target
    planGateEnabled: false,
    amendments: ["Keep the API stable"],
  });
  expect(service.handoffHeld(s.id)).toBe(true);
  expect(await service.resume(s.id, { automatic: true })).toBeNull();
  expect(calls.resumed).toEqual([]);
  await expect(service.prepareHandoff(s.id, { name: "macbook" })).rejects.toThrow(
    HandoffRefusedError,
  );
  service.releaseHandoff(s.id);
  expect(service.handoffHeld(s.id)).toBe(false);
});

test("prepareHandoff refuses sessions that cannot move, touching nothing", async () => {
  const store = new SessionStore(":memory:");
  const { service, calls } = harness(store);
  const shared = source(store, { isolated: false, branch: null });
  const merging = source(store, { name: "m" });
  store.update(merging.id, { mergingSince: 1 });
  const code = (id: string) =>
    service.prepareHandoff(id, { name: "x" }).then(
      () => null,
      (e: HandoffRefusedError) => e.code,
    );
  expect(await code(shared.id)).toBe("move_no_branch");
  expect(await code(merging.id)).toBe("move_merging");
  expect(await code("missing")).toBe("not_found");
  expect(calls.stopped).toEqual([]);
  expect(service.handoffHeld(shared.id)).toBe(false);
});

test("a failed push releases the hold and resumes the agent", async () => {
  const store = new SessionStore(":memory:");
  const { service, calls, breakPush } = harness(store);
  const s = source(store);
  breakPush();
  await expect(service.prepareHandoff(s.id, { name: "macbook" })).rejects.toThrow(HandoffGitError);
  expect(service.handoffHeld(s.id)).toBe(false);
  expect(calls.resumed).toEqual([s.id]);
});

test("abortHandoff releases the hold and resumes", async () => {
  const store = new SessionStore(":memory:");
  const { service, calls } = harness(store);
  const s = source(store);
  await service.prepareHandoff(s.id, { name: "macbook" });
  await service.abortHandoff(s.id);
  expect(service.handoffHeld(s.id)).toBe(false);
  expect(calls.resumed).toEqual([s.id]);
});
