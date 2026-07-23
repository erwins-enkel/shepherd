import { test, expect } from "bun:test";
import { GithubForge } from "../../src/forge/github";

// A recording fake `gh` runner. Returns canned stdout keyed by the subcommand
// (`<arg0> <arg1>`), and records every call for argument assertions.
function fakeRunner(responses: Record<string, string>) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    const key = `${args[0]} ${args[1] ?? ""}`.trim();
    return key in responses ? responses[key]! : "";
  };
  return { run, calls };
}

const UPSTREAM = "dannymcc/may";
const FORK = "kai-osthoff/may";
const FORK_OWNER = "kai-osthoff";
const BRANCH = "shepherd/fix-thing";

// ── originSlug: preserve the clone's origin identity in fork mode ──────────────

test("fork mode originSlug is the fork while slug remains upstream", () => {
  const forge = new GithubForge(UPSTREAM, {}, async () => "", FORK);
  expect(forge.slug).toBe(UPSTREAM);
  expect(forge.originSlug).toBe(FORK);
});

test("non-fork originSlug is the repository slug", () => {
  const forge = new GithubForge("o/r", {}, async () => "");
  expect(forge.originSlug).toBe("o/r");
});

/** Build a single gh `pr list` JSON entry (shape captured from a real cross-repo PR). */
function prEntry(owner: string, extra: Record<string, unknown> = {}) {
  return {
    number: 42,
    url: `https://github.com/${UPSTREAM}/pull/42`,
    title: "feat: thing",
    state: "OPEN",
    createdAt: "2026-01-01T00:00:00Z",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [],
    headRefOid: "abc123",
    reviews: [],
    reviewRequests: [],
    headRepositoryOwner: { login: owner },
    ...extra,
  };
}

// ── openPr: PR targets upstream, head qualified with the fork owner ──────────────

test("fork mode openPr: --repo upstream, --base, --head <forkOwner>:<branch>", async () => {
  const { run, calls } = fakeRunner({ "pr list": JSON.stringify([prEntry(FORK_OWNER)]) });
  const forge = new GithubForge(UPSTREAM, {}, run, FORK);
  await forge.openPr({ head: BRANCH, base: "main", title: "t", body: "b" });

  const create = calls.find((c) => c[0] === "pr" && c[1] === "create")!;
  expect(create).toBeDefined();
  const repoIdx = create.indexOf("--repo");
  expect(create[repoIdx + 1]).toBe(UPSTREAM);
  const headIdx = create.indexOf("--head");
  expect(create[headIdx + 1]).toBe(`${FORK_OWNER}:${BRANCH}`);
  const baseIdx = create.indexOf("--base");
  expect(create[baseIdx + 1]).toBe("main");
});

test("non-fork openPr: bare --head, --repo origin", async () => {
  const { run, calls } = fakeRunner({ "pr list": JSON.stringify([]) });
  const forge = new GithubForge("o/r", {}, run);
  await forge.openPr({ head: BRANCH, base: "main", title: "t", body: "b" });

  const create = calls.find((c) => c[0] === "pr" && c[1] === "create")!;
  expect(create[create.indexOf("--repo") + 1]).toBe("o/r");
  expect(create[create.indexOf("--head") + 1]).toBe(BRANCH); // no owner: qualifier
});

// ── prStatus: bare --head (gh rejects owner:branch) + headRepositoryOwner filter ──

test("fork mode prStatus: resolves the cross-repo PR (not state:none) via bare --head", async () => {
  const { run, calls } = fakeRunner({ "pr list": JSON.stringify([prEntry(FORK_OWNER)]) });
  const forge = new GithubForge(UPSTREAM, {}, run, FORK);
  const status = await forge.prStatus(BRANCH);

  expect(status.state).toBe("open");
  expect(status.number).toBe(42);

  const list = calls.find((c) => c[0] === "pr" && c[1] === "list")!;
  // gh `pr list --head` does NOT accept `<owner>:<branch>` — must be the bare branch.
  expect(list[list.indexOf("--head") + 1]).toBe(BRANCH);
  expect(list[list.indexOf("--json") + 1]).toContain("headRepositoryOwner");
});

test("fork mode prStatus: picks OUR fork when a same-named branch exists on another fork", async () => {
  const { run } = fakeRunner({
    // Another fork's PR for the same branch name comes first; ours second.
    "pr list": JSON.stringify([
      prEntry("someone-else", { number: 99, url: "x" }),
      prEntry(FORK_OWNER, { number: 42 }),
    ]),
  });
  const forge = new GithubForge(UPSTREAM, {}, run, FORK);
  const status = await forge.prStatus(BRANCH);
  expect(status.number).toBe(42); // filtered by headRepositoryOwner.login === forkOwner
});

test("fork mode prStatus: no PR from our fork → state:none", async () => {
  const { run } = fakeRunner({ "pr list": JSON.stringify([prEntry("someone-else")]) });
  const forge = new GithubForge(UPSTREAM, {}, run, FORK);
  const status = await forge.prStatus(BRANCH);
  expect(status.state).toBe("none");
});

// ── canPush: probe the fork (write target), not the read-only upstream ───────────

test("fork mode canPush: probes the FORK slug, returns true on WRITE", async () => {
  const { run, calls } = fakeRunner({
    "repo view": JSON.stringify({ viewerPermission: "WRITE" }),
  });
  const forge = new GithubForge(UPSTREAM, {}, run, FORK);
  expect(await forge.canPush()).toBe(true);

  const view = calls.find((c) => c[0] === "repo" && c[1] === "view")!;
  expect(view[2]).toBe(FORK); // forkSlug, NOT the upstream slug
});

test("non-fork canPush: probes the origin slug", async () => {
  const { run, calls } = fakeRunner({
    "repo view": JSON.stringify({ viewerPermission: "READ" }),
  });
  const forge = new GithubForge("o/r", {}, run);
  expect(await forge.canPush()).toBe(false);
  const view = calls.find((c) => c[0] === "repo" && c[1] === "view")!;
  expect(view[2]).toBe("o/r");
});

// ── isFork + syncFork: keep the fork current with upstream ────────────────────────

test("fork mode: isFork true; syncFork runs `gh repo sync <fork> --source <upstream>`", async () => {
  const { run, calls } = fakeRunner({ "repo sync": "" });
  const forge = new GithubForge(UPSTREAM, {}, run, FORK);
  expect(forge.isFork).toBe(true);
  await forge.syncFork();

  const sync = calls.find((c) => c[0] === "repo" && c[1] === "sync")!;
  expect(sync).toBeDefined();
  expect(sync.slice(0, 3)).toEqual(["repo", "sync", FORK]); // destination = the fork
  expect(sync[sync.indexOf("--source") + 1]).toBe(UPSTREAM); // source = upstream
});

test("non-fork: isFork false; syncFork throws and never shells out", async () => {
  const { run, calls } = fakeRunner({});
  const forge = new GithubForge("o/r", {}, run);
  expect(forge.isFork).toBe(false);
  await expect(forge.syncFork()).rejects.toThrow();
  expect(calls.find((c) => c[0] === "repo" && c[1] === "sync")).toBeUndefined();
});
