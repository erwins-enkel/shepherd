import { test, expect } from "bun:test";
import { SessionService } from "../src/service";
import { ReviewService } from "../src/review";
import { SessionStore } from "../src/store";

function deps(store: SessionStore) {
  return {
    store,
    worktree: {} as any,
    // reply() now liveness-checks the pane before sending; list the session's agent live.
    herdr: { send: async () => {}, list: () => [{ terminalId: "t1" }] } as any,
    namer: (p: string) => p,
  };
}

test("reply records a 'reply' signal for the session's repo", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "n",
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    branch: "b",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t1",
  });
  const svc = new SessionService(deps(store) as any);
  expect(await svc.reply(s.id, "use uv not pip")).toBe(true);
  const sigs = store.listSignals("/r");
  expect(sigs.length).toBe(1);
  expect(sigs[0]!.kind).toBe("reply");
  expect(sigs[0]!.payload).toBe("use uv not pip");
  expect(sigs[0]!.sessionId).toBe(s.id);
});

test("reply to a missing session records nothing", async () => {
  const store = new SessionStore(":memory:");
  const svc = new SessionService(deps(store) as any);
  expect(await svc.reply("nope", "x")).toBe(false);
  expect(store.listSignals("/r").length).toBe(0);
});

test("critic changes_requested records a 'critic' signal", async () => {
  const store = new SessionStore(":memory:");
  const session = store.create({
    name: "n",
    prompt: "p",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "b",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t1",
  });
  // The signal now fires only when the PR is confirmed open (moot-run guard).
  // Supply a minimal forge that confirms open and accepts the review post.
  const fakeForge = {
    prStatus: async () => ({ state: "open" }),
    postReview: async () => ({ url: "u" }),
  } as any;
  const svc = new ReviewService({
    store,
    herdr: {
      start: async () => ({ terminalId: "rev1" }),
      stop: async () => {},
      list: () => [{ cwd: "/rev-wt", terminalId: "rev1", agentStatus: "idle" }],
    } as any,
    worktree: {
      createDetached: async () => ({ worktreePath: "/rev-wt" }),
      remove: () => {},
      gitCommonDir: () => "/fake-git-common",
    } as any,
    detectBackend: () => null,
    resolveForge: () => fakeForge,
    onChange: () => {},
    now: () => 1,
    readVerdict: () => ({
      status: "parsed",
      repaired: false,
      value: { decision: "request-changes", summary: "2 issues", body: "## findings" },
    }),
  });
  await svc.consider(session, {
    state: "open",
    checks: "success",
    headSha: "abc",
    number: 7,
  } as any);
  await svc.tick();
  const sigs = store.listSignals("/repo");
  expect(sigs.length).toBe(1);
  expect(sigs[0]!.kind).toBe("critic");
  expect(sigs[0]!.payload).toContain("2 issues");
});
