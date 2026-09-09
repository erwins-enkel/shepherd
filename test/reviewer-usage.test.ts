import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import { CodexRolloutResolver, backfillCodexSpawnUsage } from "../src/codex-activity";
import { readReviewerSpawnUsage } from "../src/reviewer-usage";

for (const kind of ["recap", "doc_agent", "classifier", "review"] as const) {
  test(`${kind} captures Codex usage and persists the existing provider session identity`, async () => {
    const store = new SessionStore(":memory:");
    store.recordReviewerSpawn({
      reviewerSessionId: "spawn",
      taskSessionId: "task",
      kind,
      worktreePath: "/unique-cwd",
      reviewerProvider: "codex",
      model: "gpt-5.6-sol",
      spawnedAt: 1,
    });
    const resolver = new CodexRolloutResolver({
      now: () => 2,
      listMetas: () => [
        {
          path: `${import.meta.dir}/fixtures/codex-activity/rollout-role-exec.jsonl`,
          cwd: "/unique-cwd",
          rolloutId: "native-thread",
          source: "exec",
          mtimeMs: 2,
        },
      ],
    });
    const usage = await readReviewerSpawnUsage(store, "/unique-cwd", "spawn", undefined, resolver);
    expect(usage?.total).toBe(52976);
    expect(store.listReviewerSpawns()[0]?.providerSessionId).toBe("native-thread");
  });
}

test("unresolved Codex helper usage stays unknown", async () => {
  const store = new SessionStore(":memory:");
  store.recordReviewerSpawn({
    reviewerSessionId: "spawn",
    taskSessionId: "task",
    kind: "recap",
    worktreePath: "/unique-cwd",
    reviewerProvider: "codex",
    model: null,
    spawnedAt: 1,
  });
  const resolver = new CodexRolloutResolver({ now: () => 2, listMetas: () => [] });
  expect(
    await readReviewerSpawnUsage(store, "/unique-cwd", "spawn", undefined, resolver),
  ).toBeNull();
  expect(store.listReviewerSpawns()[0]?.providerSessionId).toBeNull();
});

test("delayed Codex usage backfill also persists the role's native thread identity", () => {
  const store = new SessionStore(":memory:");
  store.recordReviewerSpawn({
    reviewerSessionId: "spawn",
    taskSessionId: "task",
    kind: "recap",
    worktreePath: "/unique-cwd",
    reviewerProvider: "codex",
    model: "gpt-5.6-sol",
    spawnedAt: 1,
  });
  store.completeReviewerSpawn("spawn", null, 2);
  expect(
    backfillCodexSpawnUsage(store, () => [
      {
        path: `${import.meta.dir}/fixtures/codex-activity/rollout-role-exec.jsonl`,
        cwd: "/unique-cwd",
        rolloutId: "native-thread",
        source: "exec",
        mtimeMs: 3,
      },
    ]),
  ).toBe(1);
  expect(store.listReviewerSpawns()[0]).toMatchObject({
    providerSessionId: "native-thread",
    totalTokens: 52976,
  });
});
