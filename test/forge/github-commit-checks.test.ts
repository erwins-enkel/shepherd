import { afterEach, expect, test } from "bun:test";
import { GithubForge } from "../../src/forge/github";
import { graphRateLimit } from "../../src/forge/rate-limit";

afterEach(() => {
  graphRateLimit.note({ remaining: 1000, resetAt: Date.now() + 60_000 });
});

test("#2854 commit checks batch unique heads in one aliased rollup-only query", async () => {
  const calls: string[][] = [];
  const states = ["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED", null];
  const forge = new GithubForge("o/r", {}, async (args) => {
    calls.push(args);
    return JSON.stringify({
      data: {
        repository: Object.fromEntries([
          ...states.map((state, i) => [`c${i}`, { statusCheckRollup: state ? { state } : null }]),
          ["c6", null],
        ]),
      },
    });
  });
  const result = await forge.listCommitChecks([
    "s0",
    "s1",
    "s2",
    "s3",
    "s4",
    "s5",
    "missing",
    "s0",
  ]);
  expect(result).toEqual(
    new Map([
      ["s0", "success"],
      ["s1", "failure"],
      ["s2", "failure"],
      ["s3", "pending"],
      ["s4", "pending"],
      ["s5", "none"],
    ]),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.slice(0, 2)).toEqual(["api", "graphql"]);
  const query = calls[0]!.find((arg) => arg.startsWith("query="))!;
  expect(query.match(/object\(oid:/g)).toHaveLength(7);
  expect(query).toContain("statusCheckRollup{state}");
  expect(query).not.toContain("contexts");
  expect(query).not.toContain("first:");
});

test("#2854 no candidate heads makes no commit-check request", async () => {
  let calls = 0;
  const forge = new GithubForge("o/r", {}, async () => {
    calls++;
    return "";
  });
  expect(await forge.listCommitChecks([])).toEqual(new Map());
  expect(calls).toBe(0);
});

test("#2854 commit checks use candidate-only REST reads during GraphQL backoff", async () => {
  graphRateLimit.noteLimitError(60);
  const calls: string[][] = [];
  const forge = new GithubForge("o/r", {}, async (args) => {
    calls.push(args);
    if (args.some((arg) => arg.endsWith("/status")))
      return JSON.stringify({ total_count: 0, statuses: [] });
    return JSON.stringify({
      total_count: 1,
      check_runs: [{ status: "completed", conclusion: "success" }],
    });
  });
  expect(await forge.listCommitChecks(["waiting"])).toEqual(new Map([["waiting", "success"]]));
  expect(calls).toHaveLength(2);
  expect(
    calls.every((args) => args.some((arg) => arg.startsWith("repos/o/r/commits/waiting/"))),
  ).toBe(true);
});

test("#2854 failed commit-check reads cannot clear a candidate's CI gate", async () => {
  const forge = new GithubForge("o/r", {}, async () => {
    throw new Error("network down");
  });
  await expect(forge.listCommitChecks(["waiting"])).rejects.toThrow("network down");
});
