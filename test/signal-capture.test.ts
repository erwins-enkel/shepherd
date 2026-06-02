import { test, expect } from "bun:test";
import { SessionService } from "../src/service";
import { SessionStore } from "../src/store";

function deps(store: SessionStore) {
  return {
    store,
    worktree: {} as any,
    herdr: { send: () => {} } as any,
    namer: (p: string) => p,
  };
}

test("reply records a 'reply' signal for the session's repo", () => {
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
  expect(svc.reply(s.id, "use uv not pip")).toBe(true);
  const sigs = store.listSignals("/r");
  expect(sigs.length).toBe(1);
  expect(sigs[0]!.kind).toBe("reply");
  expect(sigs[0]!.payload).toBe("use uv not pip");
  expect(sigs[0]!.sessionId).toBe(s.id);
});

test("reply to a missing session records nothing", () => {
  const store = new SessionStore(":memory:");
  const svc = new SessionService(deps(store) as any);
  expect(svc.reply("nope", "x")).toBe(false);
  expect(store.listSignals("/r").length).toBe(0);
});
