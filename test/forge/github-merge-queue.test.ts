// Merge-queue read for the merge train (#3223). Drives the injected GhRunner seam — no network.
import { test, expect } from "bun:test";
import { GithubForge } from "../../src/forge/github";

function forgeReplying(reply: () => string) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    return reply();
  };
  return { forge: new GithubForge("o/r", {}, run), calls };
}

test("mergeQueueEntries: lists every queued PR number, whatever the entry state", async () => {
  const { forge, calls } = forgeReplying(() =>
    JSON.stringify({
      data: {
        repository: {
          mergeQueue: {
            entries: {
              nodes: [{ pullRequest: { number: 639 } }, { pullRequest: { number: 642 } }],
            },
          },
        },
      },
    }),
  );
  expect(await forge.mergeQueueEntries("main")).toEqual([639, 642]);
  const args = calls[0]!;
  expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
  expect(args).toContain("branch=main");
  expect(args[args.indexOf("branch=main") - 1]).toBe("-f");
});

test("mergeQueueEntries: a queue-less branch reads as null", async () => {
  const { forge } = forgeReplying(() =>
    JSON.stringify({ data: { repository: { mergeQueue: null } } }),
  );
  expect(await forge.mergeQueueEntries("main")).toBeNull();
});

test("mergeQueueEntries: an empty queue is [] (queue exists), not null", async () => {
  const { forge } = forgeReplying(() =>
    JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes: [] } } } } }),
  );
  expect(await forge.mergeQueueEntries("main")).toEqual([]);
});

test("mergeQueueEntries: no repository in the answer throws instead of reading as no queue", async () => {
  const { forge } = forgeReplying(() => JSON.stringify({ data: { repository: null } }));
  await expect(forge.mergeQueueEntries("main")).rejects.toThrow();
});

test("mergeQueueEntries: an unsafe ref throws without calling gh", async () => {
  const { forge, calls } = forgeReplying(() => "");
  await expect(forge.mergeQueueEntries("../x")).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
