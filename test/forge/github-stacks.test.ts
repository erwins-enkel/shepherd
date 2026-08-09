// Stacked-PR API surface (#2068): read a PR's stack, create one, append to one, dissolve one.
// Everything drives the injected GhRunner seam, so no network and no real stacks. The read fails
// open (an error is "unstacked", today's behaviour everywhere); the three writes do NOT — a
// swallowed write failure would leave a caller believing a stack exists when it does not.
import { test, expect } from "bun:test";
import { GithubForge } from "../../src/forge/github";
import { GiteaForge } from "../../src/forge/gitea";
import { LocalForge } from "../../src/forge/local";
import { SessionStore } from "../../src/store";
import type { ForgeConfig, GitForge } from "../../src/forge/types";

const READ = "repos/o/r/stacks?pull_request=7";
const CREATE = "repos/o/r/stacks";
const TRUNK = "epic/2063-stack-epic-children-onto-the-integration";

/** Build a forge whose runner replies from `routes` (first matching substring wins) and records
 *  every call. Mirrors test/forge/github-stacked-merge.test.ts. */
function harness(routes: [match: string, reply: () => string][]) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    for (const [match, reply] of routes) if (joined.includes(match)) return reply();
    return "";
  };
  return { forge: new GithubForge("o/r", {}, run), calls };
}

/** What the runner sees after `--jq` narrowing: gh applies the filter, so the fake replies with
 *  the PROJECTION, not the raw stack resource. */
const projection = (prNumbers: number[], baseRef: string = TRUNK) => ({
  number: 42,
  baseRef,
  prNumbers,
});

const boom = () => {
  throw new Error("HTTP 503: upstream unavailable");
};

test("stackForPr: maps the stack, deriving the PR's position from the membership order", async () => {
  const { forge, calls } = harness([[READ, () => JSON.stringify([projection([5, 7, 9])])]]);

  expect(await forge.stackForPr(7)).toEqual({
    number: 42,
    baseRef: TRUNK,
    prNumbers: [5, 7, 9], // bottom → top, verbatim from the host
    position: 2,
    size: 3,
  });
  // The stack RESOURCE is read, keyed on the PR — the PR's own `.stack` object carries no
  // membership list, which is the whole point of this call.
  expect(calls[0]?.[1]).toBe(READ);
});

test("stackForPr: an unstacked PR reports null", async () => {
  const { forge } = harness([[READ, () => "[]"]]);

  expect(await forge.stackForPr(7)).toBeNull();
});

test("stackForPr: a failed read FAILS OPEN to null rather than rejecting", async () => {
  const { forge } = harness([[READ, boom]]);

  expect(await forge.stackForPr(7)).toBeNull();
});

test("stackForPr: an unparseable body reports null", async () => {
  const { forge } = harness([[READ, () => "<html>502 Bad Gateway</html>"]]);

  expect(await forge.stackForPr(7)).toBeNull();
});

test("stackForPr: a stack with no readable trunk reports null, never an empty baseRef", async () => {
  const { forge } = harness([[READ, () => JSON.stringify([projection([5, 7], "")])]]);

  // baseRef is the load-bearing field; a caller must not receive "" to compare or interpolate.
  expect(await forge.stackForPr(7)).toBeNull();
});

test("stackForPr: a stack the PR is not a member of is not reported as its stack", async () => {
  // Would only happen if the host dropped or ignored the `pull_request=` filter — in which case
  // answering with somebody else's stack is worse than answering with nothing.
  const { forge } = harness([[READ, () => JSON.stringify([projection([5, 9])])]]);

  expect(await forge.stackForPr(7)).toBeNull();
});

test("createStack: POSTs the pull requests bottom→top and returns the created stack", async () => {
  const { forge, calls } = harness([[CREATE, () => JSON.stringify(projection([5, 7, 9]))]]);

  expect(await forge.createStack([5, 7, 9])).toEqual({
    number: 42,
    baseRef: TRUNK,
    prNumbers: [5, 7, 9],
    size: 3,
  });
  const post = calls[0] ?? [];
  expect(post.slice(0, 4)).toEqual(["api", "--method", "POST", CREATE]);
  expect(post.filter((_, i) => post[i - 1] === "-F")).toEqual([
    "pull_requests[]=5",
    "pull_requests[]=7",
    "pull_requests[]=9",
  ]);
});

test("createStack: a host rejection PROPAGATES — writes never fail open", async () => {
  const { forge } = harness([[CREATE, boom]]);

  await expect(forge.createStack([5, 7])).rejects.toThrow("503");
});

test("createStack: an unreadable response is an error, not a stack nobody can address", async () => {
  const { forge } = harness([[CREATE, () => ""]]);

  await expect(forge.createStack([5, 7])).rejects.toThrow("no stack");
});

test("addToStack: appends one PR to an existing stack", async () => {
  const { forge, calls } = harness([]);

  await forge.addToStack(42, 9);

  expect(calls[0]).toEqual([
    "api",
    "--method",
    "POST",
    "repos/o/r/stacks/42/add",
    "-F",
    "pull_requests[]=9",
  ]);
});

test("addToStack: a host rejection propagates", async () => {
  const { forge } = harness([["stacks/42/add", boom]]);

  await expect(forge.addToStack(42, 9)).rejects.toThrow("503");
});

test("unstack: dissolves the stack, with no fields to send", async () => {
  const { forge, calls } = harness([]);

  await forge.unstack(42);

  expect(calls[0]).toEqual(["api", "--method", "POST", "repos/o/r/stacks/42/unstack"]);
});

test("unstack: a host rejection propagates", async () => {
  const { forge } = harness([["stacks/42/unstack", boom]]);

  await expect(forge.unstack(42)).rejects.toThrow("503");
});

test("no stack method ever shells out to `gh stack` (it opens a TUI under a PTY)", async () => {
  const { forge, calls } = harness([[READ, () => JSON.stringify([projection([5, 7])])]]);

  await forge.stackForPr(7);
  await forge.addToStack(42, 9);
  await forge.unstack(42);
  await forge.createStack([5, 7]).catch(() => {});

  expect(calls.length).toBe(4);
  expect(calls.every((c) => c[0] === "api")).toBe(true);
});

test("Gitea and Local omit the stack surface, so callers branch on capability not on kind", async () => {
  const cfg: ForgeConfig = { type: "gitea", baseUrl: "https://git.example.com", token: "s" };
  const forges: GitForge[] = [
    new GiteaForge("team/proj", cfg),
    new LocalForge("/nonexistent", new SessionStore(":memory:")),
  ];

  for (const forge of forges) {
    expect(forge.stackForPr).toBeUndefined();
    expect(forge.createStack).toBeUndefined();
    expect(forge.addToStack).toBeUndefined();
    expect(forge.unstack).toBeUndefined();
  }
});
