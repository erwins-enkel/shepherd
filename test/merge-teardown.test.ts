import { test, expect, mock } from "bun:test";
import { settleMergedSession, type MergeTeardownDeps } from "../src/merge-teardown";

function deps(over: Partial<MergeTeardownDeps> = {}): MergeTeardownDeps {
  return {
    resolveForge: () => ({ closeIssue: mock(async () => {}) }) as any,
    archive: mock(() => 1),
    dropPrCache: mock(() => {}),
    emitArchived: mock(() => {}),
    retainClaim: mock(() => {}),
    ...over,
  };
}

test("auto session with issue: closes issue, archives, does NOT retain claim", async () => {
  const d = deps();
  await settleMergedSession({ id: "s1", auto: true, issueNumber: 9, repoPath: "/r" } as any, d);
  expect((d.archive as any).mock.calls.length).toBe(1);
  expect((d.retainClaim as any).mock.calls.length).toBe(0);
});

test("closeIssue throws → retain claim (issue still open)", async () => {
  const d = deps({
    resolveForge: () =>
      ({
        closeIssue: async () => {
          throw new Error("x");
        },
      }) as any,
  });
  await settleMergedSession({ id: "s1", auto: true, issueNumber: 9, repoPath: "/r" } as any, d);
  expect((d.retainClaim as any).mock.calls).toEqual([["s1"]]);
  expect((d.archive as any).mock.calls.length).toBe(1);
});

test("manual session (no issue): archives, no close, no retain", async () => {
  const close = mock(async () => {});
  const d = deps({ resolveForge: () => ({ closeIssue: close }) as any });
  await settleMergedSession({ id: "s1", auto: false, issueNumber: null, repoPath: "/r" } as any, d);
  expect(close.mock.calls.length).toBe(0);
  expect((d.archive as any).mock.calls.length).toBe(1);
  expect((d.retainClaim as any).mock.calls.length).toBe(0);
});
