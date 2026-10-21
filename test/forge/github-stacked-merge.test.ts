// Stack-safe merge path (#2059). GitHub's stacked PRs cannot go through the legacy synchronous
// merge — `gh pr merge` refuses — so GithubForge.merge probes for stack membership and routes
// stacked PRs to the async merge API. Everything here drives the injected GhRunner seam, so no
// network and no real PRs; the sleeper is stubbed out so the poll budget costs no wall clock.
import { test, expect } from "bun:test";
import { GithubForge } from "../../src/forge/github";
import {
  MergeEnqueuedError,
  MergePendingError,
  StackedMergeRefusedError,
  StackUntestedError,
} from "../../src/forge/types";

const HEAD_SHA = "f00dcafe0000";
const UUID = "11111111-2222-3333-4444-555555555555";
// The `--jq` suffix keeps this from also matching the merge-async paths, which extend it.
const PROBE = "repos/o/r/pulls/7 --jq";
const PUT_PATH = "repos/o/r/pulls/7/merge-async";
const POLL_PATH = `repos/o/r/pulls/7/merge-async/${UUID}`;
/** The stack's trunk, and the layer directly below pr#7 — deliberately different names, so
 *  "probed the trunk" and "probed the layer below" leave different evidence (#2062). */
const TRUNK = "main";
const PARENT = "b2-fail";
const RULES = "rules/branches/";
/** The trunk-ancestry read (#3192). Defaulted to "contains the trunk tip" in {@link harness}. */
const COMPARE = "/compare/";

const noSleep = async (): Promise<void> => {};

/** A `gh api` rejection: gh prints the HTTP error BODY on stdout and only `gh: HTTP <n>` on
 *  stderr, then exits non-zero. Mirrors what execFileAsync actually produces (verified live). */
function ghHttpError(status: number, body: unknown): Error {
  const err = new Error(`gh: HTTP ${status}`) as Error & { stdout: string; stderr: string };
  err.stdout = JSON.stringify(body);
  err.stderr = `gh: HTTP ${status}`;
  return err;
}

/** Build a forge whose runner replies from `routes` (first matching substring wins) and records
 *  every call. An unmatched call returns "" rather than throwing, so a test only has to describe
 *  the traffic it cares about. The trunk-ancestry compare defaults to `ahead` (tested against the
 *  current trunk, #3192); a test overrides it by routing {@link COMPARE} itself. */
function harness(routes: [match: string, reply: () => string][]) {
  routes = [...routes, [COMPARE, () => "ahead"]];
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    for (const [match, reply] of routes) if (joined.includes(match)) return reply();
    return "";
  };
  const forge = new GithubForge("o/r", {}, run, undefined, noSleep);
  return { forge, calls, joined: () => calls.map((c) => c.join(" ")) };
}

const unstackedProbe = (): string => JSON.stringify({ stack: null, sha: HEAD_SHA });
/** pr#7 as a realistic MIDDLE layer: 2 of 3, sitting on `b2-fail`, stack rooted at `main`.
 *
 *  The top-level `base` is a deliberate TRAP, not a faithful copy of the projection — the probe's
 *  `--jq` does not select it. It is here so that a regression which starts reading the PR's own
 *  base instead of `stack.base.ref` probes `b2-fail`, which the assertions below catch. */
const stackedProbe = (): string =>
  JSON.stringify({
    stack: { id: 9, number: 3, size: 3, position: 2, base: { ref: TRUNK, sha: "0ddba110000" } },
    sha: HEAD_SHA,
    base: PARENT,
  });
/** Same middle layer, but the host reported no trunk on the stack object. */
const trunklessProbe = (): string =>
  JSON.stringify({ stack: { id: 9, number: 3, size: 3, position: 2 }, sha: HEAD_SHA });

/** The `-f` values of the merge-async PUT, which is what #2062 is about. */
const putFields = (calls: string[][]): string[] => {
  const put = calls.find((c) => c.includes(PUT_PATH)) ?? [];
  return put.filter((_, i) => put[i - 1] === "-f");
};

test("merge: unstacked PR takes the legacy `gh pr merge` path, untouched (#2059)", async () => {
  const { forge, calls, joined } = harness([[PROBE, unstackedProbe]]);

  await forge.merge(7, { method: "squash", deleteBranch: true });

  expect(joined().some((c) => c.includes("merge-async"))).toBe(false);
  expect(calls.find((c) => c[0] === "pr")).toEqual([
    "pr",
    "merge",
    "7",
    "--repo",
    "o/r",
    "--squash",
    "--delete-branch",
  ]);
});

test("merge: a failed stack probe falls open to the legacy path (never a regression)", async () => {
  const { forge, joined } = harness([
    [
      PROBE,
      () => {
        throw new Error("HTTP 503: upstream unavailable");
      },
    ],
  ]);

  await forge.merge(7, { method: "squash", deleteBranch: false });

  expect(joined().some((c) => c.startsWith("pr merge 7"))).toBe(true);
  expect(joined().some((c) => c.includes("merge-async"))).toBe(false);
});

test("merge: stacked PR without allowStacked refuses BEFORE mutating anything", async () => {
  const { forge, joined } = harness([[PROBE, stackedProbe]]);

  const err = await forge
    .merge(7, { method: "squash", deleteBranch: true })
    .catch((e: unknown) => e);

  expect(err).toBeInstanceOf(StackedMergeRefusedError);
  expect((err as StackedMergeRefusedError).code).toBe("stacked_refused");
  expect((err as StackedMergeRefusedError).message).toContain("layer 2 of 3");
  // The whole point: nothing was attempted on the host.
  expect(joined().some((c) => c.startsWith("pr merge"))).toBe(false);
  expect(joined().some((c) => c.includes("merge-async"))).toBe(false);
});

test("merge: stacked + allowStacked → merge-async with the sha guard, then polls to merged", async () => {
  let polls = 0;
  const { forge, calls, joined } = harness([
    [PROBE, stackedProbe],
    [POLL_PATH, () => JSON.stringify({ status: ++polls < 2 ? "pending" : "merged", details: {} })],
    [PUT_PATH, () => JSON.stringify({ status: "pending", details: { uuid: UUID } })],
  ]);

  await forge.merge(7, { method: "squash", deleteBranch: true, allowStacked: true });

  expect(calls.find((c) => c.includes(PUT_PATH))).toEqual([
    "api",
    "--method",
    "PUT",
    PUT_PATH,
    "-f",
    "merge_method=squash",
    "-f",
    `sha=${HEAD_SHA}`,
  ]);
  expect(polls).toBe(2); // polled through `pending` to `merged`
  // deleteBranch is deliberately not honoured on the stacked path.
  expect(joined().some((c) => c.includes("--delete-branch"))).toBe(false);
  expect(joined().some((c) => c.startsWith("pr merge"))).toBe(false);
});

test("merge: the merge method reaches merge-async verbatim", async () => {
  const { forge, calls } = harness([
    [PROBE, stackedProbe],
    [POLL_PATH, () => JSON.stringify({ status: "merged" })],
    [PUT_PATH, () => JSON.stringify({ status: "pending", details: { uuid: UUID } })],
  ]);

  await forge.merge(7, { method: "rebase", deleteBranch: false, allowStacked: true });

  expect(calls.find((c) => c.includes(PUT_PATH))).toContain("merge_method=rebase");
});

test("merge: a 409 adopts the in-flight uuid from the error body and polls it (#2059)", async () => {
  let polled = 0;
  const { forge, joined } = harness([
    [PROBE, stackedProbe],
    [
      POLL_PATH,
      () => {
        polled++;
        return JSON.stringify({ status: "merged", details: { sha: "deadbeef" } });
      },
    ],
    [
      PUT_PATH,
      () => {
        // gh exits non-zero, but the body still names the merge request already in flight.
        throw ghHttpError(409, {
          status: "pending",
          details: { uuid: UUID, message: "a merge request is already in progress" },
        });
      },
    ],
  ]);

  await forge.merge(7, { method: "squash", deleteBranch: true, allowStacked: true });

  expect(polled).toBe(1);
  expect(joined().some((c) => c.includes(POLL_PATH))).toBe(true);
});

test("merge: a non-adoptable HTTP failure re-throws the original error", async () => {
  const { forge } = harness([
    [PROBE, stackedProbe],
    [
      PUT_PATH,
      () => {
        throw ghHttpError(422, { message: "Pull request is not mergeable" });
      },
    ],
  ]);

  const err = await forge
    .merge(7, { method: "squash", deleteBranch: true, allowStacked: true })
    .catch((e: unknown) => e);

  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(MergePendingError);
  expect((err as Error).message).toContain("422");
});

test("merge: status `failed` throws carrying the host's reason", async () => {
  const { forge } = harness([
    [PROBE, stackedProbe],
    [
      PUT_PATH,
      () =>
        JSON.stringify({
          status: "failed",
          details: { message: "Pull request head branch was modified." },
        }),
    ],
  ]);

  const err = await forge
    .merge(7, { method: "squash", deleteBranch: true, allowStacked: true })
    .catch((e: unknown) => e);

  expect((err as Error).message).toContain("Pull request head branch was modified.");
});

test("merge: status `enqueued` is terminal for the request and stops polling", async () => {
  let polled = 0;
  const { forge } = harness([
    [PROBE, stackedProbe],
    [
      POLL_PATH,
      () => {
        polled++;
        return JSON.stringify({ status: "enqueued", details: { uuid: UUID } });
      },
    ],
    [PUT_PATH, () => JSON.stringify({ status: "pending", details: { uuid: UUID } })],
  ]);

  const err = await forge
    .merge(7, { method: "squash", deleteBranch: true, allowStacked: true })
    .catch((e: unknown) => e);

  expect(err).toBeInstanceOf(MergeEnqueuedError);
  expect((err as MergeEnqueuedError).code).toBe("merge_enqueued");
  expect(polled).toBe(1); // stopped immediately — NOT polled to completion
});

test("merge: an exhausted poll budget reports pending, not failure", async () => {
  let polled = 0;
  const { forge } = harness([
    [PROBE, stackedProbe],
    [
      POLL_PATH,
      () => {
        polled++;
        return JSON.stringify({ status: "pending", details: { uuid: UUID } });
      },
    ],
    [PUT_PATH, () => JSON.stringify({ status: "pending", details: { uuid: UUID } })],
  ]);

  const err = await forge
    .merge(7, { method: "squash", deleteBranch: true, allowStacked: true })
    .catch((e: unknown) => e);

  expect(err).toBeInstanceOf(MergePendingError);
  expect((err as MergePendingError).code).toBe("merge_pending");
  expect(polled).toBe(15); // the whole budget, then gave up
});

test("merge: a transient poll error is retried, not mistaken for a merge failure", async () => {
  let polled = 0;
  const { forge } = harness([
    [PROBE, stackedProbe],
    [
      POLL_PATH,
      () => {
        if (++polled === 1) throw new Error("HTTP 502: bad gateway");
        return JSON.stringify({ status: "merged" });
      },
    ],
    [PUT_PATH, () => JSON.stringify({ status: "pending", details: { uuid: UUID } })],
  ]);

  await forge.merge(7, { method: "squash", deleteBranch: true, allowStacked: true });

  expect(polled).toBe(2);
});

test("merge: a PUT that settles immediately never polls", async () => {
  let polled = 0;
  const { forge } = harness([
    [PROBE, stackedProbe],
    [
      POLL_PATH,
      () => {
        polled++;
        return "";
      },
    ],
    [PUT_PATH, () => JSON.stringify({ status: "merged", details: { sha: "deadbeef" } })],
  ]);

  await forge.merge(7, { method: "squash", deleteBranch: true, allowStacked: true });

  expect(polled).toBe(0);
});

test("merge: no terminal status and no uuid is an error, not a silent success", async () => {
  const { forge } = harness([
    [PROBE, stackedProbe],
    [PUT_PATH, () => JSON.stringify({ status: "pending", details: {} })],
  ]);

  const err = await forge
    .merge(7, { method: "squash", deleteBranch: true, allowStacked: true })
    .catch((e: unknown) => e);

  expect((err as Error).message).toContain("uuid");
});

test("merge: a malformed uuid is never interpolated into the API path", async () => {
  const { forge, joined } = harness([
    [PROBE, stackedProbe],
    [
      PUT_PATH,
      () =>
        JSON.stringify({
          status: "pending",
          details: { uuid: "../../../repos/o/r/pulls/1/merge" },
        }),
    ],
  ]);

  const err = await forge
    .merge(7, { method: "squash", deleteBranch: true, allowStacked: true })
    .catch((e: unknown) => e);

  // Traversal would show up as a GET on the retargeted path; the guard makes it "no uuid" instead.
  expect((err as Error).message).toContain("uuid");
  expect(joined().some((c) => c.includes("pulls/1/merge"))).toBe(false);
  // The PUT is the only merge-async traffic — nothing was polled at all.
  expect(joined().filter((c) => c.includes("merge-async")).length).toBe(1);
});

// #2062 — a required merge queue rejects `merge_method`. The rule lives on the stack's TRUNK,
// because merging any layer lands the whole stack there; the layer this PR directly targets is
// irrelevant. `harness` matches routes by substring, so a `rules/branches/` stub answers for ANY
// branch — these tests must therefore assert the exact path probed, not merely that one was.

test("merge: a merge-queue trunk drops merge_method and enqueues (#2062)", async () => {
  const { forge, calls, joined } = harness([
    [PROBE, stackedProbe],
    [RULES, () => "1"], // one `merge_queue` rule applies to the trunk
    [PUT_PATH, () => JSON.stringify({ status: "enqueued", details: { uuid: UUID } })],
  ]);

  const err = await forge
    .merge(7, { method: "squash", deleteBranch: true, allowStacked: true })
    .catch((e: unknown) => e);

  // The trunk was probed — NOT `b2-fail`, the layer pr#7 actually bases on.
  expect(calls.find((c) => c.some((a) => a.includes(RULES)))?.[1]).toBe(
    `repos/o/r/${RULES}${TRUNK}`,
  );
  expect(joined().some((c) => c.includes(PARENT))).toBe(false);
  // The whole point: an explicit queue action, and no merge params for the queue to reject.
  expect(putFields(calls)).toEqual(["merge_action=merge_queue", `sha=${HEAD_SHA}`]);
  expect(err).toBeInstanceOf(MergeEnqueuedError);
  expect((err as MergeEnqueuedError).code).toBe("merge_enqueued");
});

test("merge: a trunk with other rules but no merge queue keeps merge_method (#2062)", async () => {
  const { forge, calls } = harness([
    [PROBE, stackedProbe],
    [RULES, () => "0"], // required_status_checks, pull_request, … — but no merge_queue
    [POLL_PATH, () => JSON.stringify({ status: "merged" })],
    [PUT_PATH, () => JSON.stringify({ status: "pending", details: { uuid: UUID } })],
  ]);

  await forge.merge(7, { method: "squash", deleteBranch: true, allowStacked: true });

  expect(putFields(calls)).toEqual(["merge_method=squash", `sha=${HEAD_SHA}`]);
});

test("merge: a failed merge-queue probe falls open to today's request shape (#2062)", async () => {
  const { forge, calls } = harness([
    [PROBE, stackedProbe],
    [
      RULES,
      () => {
        throw new Error("HTTP 503: upstream unavailable");
      },
    ],
    [POLL_PATH, () => JSON.stringify({ status: "merged" })],
    [PUT_PATH, () => JSON.stringify({ status: "pending", details: { uuid: UUID } })],
  ]);

  // Fails open: the merge still happens, exactly as it does today.
  await forge.merge(7, { method: "squash", deleteBranch: true, allowStacked: true });

  expect(putFields(calls)).toEqual(["merge_method=squash", `sha=${HEAD_SHA}`]);
});

test("merge: no trunk on the stack object probes nothing and refuses (#2062, #3192)", async () => {
  const { forge, joined } = harness([
    [PROBE, trunklessProbe],
    [RULES, () => "1"], // would report a queue if anything asked
    [POLL_PATH, () => JSON.stringify({ status: "merged" })],
    [PUT_PATH, () => JSON.stringify({ status: "pending", details: { uuid: UUID } })],
  ]);

  const err = await forge
    .merge(7, { method: "squash", deleteBranch: true, allowStacked: true })
    .catch((e: unknown) => e);

  // Never the layer below — and with no trunk to vouch for, fail closed.
  expect(joined().some((c) => c.includes(RULES))).toBe(false);
  expect(joined().some((c) => c.includes(COMPARE))).toBe(false);
  expect(err).toBeInstanceOf(StackUntestedError);
  expect(joined().some((c) => c.includes("merge-async"))).toBe(false);
});

test("merge: a malformed trunk ref is never interpolated into the API path (#2062)", async () => {
  const { forge, calls, joined } = harness([
    [
      PROBE,
      () =>
        JSON.stringify({
          stack: { size: 3, position: 2, base: { ref: "../../pulls/1/merge" } },
          sha: HEAD_SHA,
        }),
    ],
    [RULES, () => "1"],
    [POLL_PATH, () => JSON.stringify({ status: "merged" })],
    [PUT_PATH, () => JSON.stringify({ status: "pending", details: { uuid: UUID } })],
  ]);

  const err = await forge
    .merge(7, { method: "squash", deleteBranch: true, allowStacked: true })
    .catch((e: unknown) => e);

  // Traversal would show up as a GET on the retargeted path; the guard makes it "no trunk",
  // which the ancestry gate refuses (#3192).
  expect(joined().some((c) => c.includes(RULES))).toBe(false);
  expect(joined().some((c) => c.includes("pulls/1/merge"))).toBe(false);
  expect(joined().some((c) => c.includes(COMPARE))).toBe(false);
  expect(err).toBeInstanceOf(StackUntestedError);
  expect(putFields(calls)).toEqual([]);
});

// #3192 — outside a merge queue, merge-async restacks onto the trunk AS IT IS NOW and runs no CI
// on the result. So the merging layer's head must already contain the trunk's current tip.

const stackedMerge = (forge: GithubForge, extra: { expectedHeadSha?: string } = {}) =>
  forge
    .merge(7, { method: "squash", deleteBranch: true, allowStacked: true, ...extra })
    .then(() => null)
    .catch((e: unknown) => e);

for (const status of ["ahead", "identical"]) {
  test(`merge: head containing the trunk tip (compare \`${status}\`) merges (#3192)`, async () => {
    const { forge, calls } = harness([
      [PROBE, stackedProbe],
      [COMPARE, () => status],
      [PUT_PATH, () => JSON.stringify({ status: "merged" })],
    ]);

    expect(await stackedMerge(forge)).toBeNull();
    // Asked about the TRUNK and this head — not `b2-fail`, the layer pr#7 bases on.
    expect(calls.find((c) => c.some((a) => a.includes(COMPARE)))?.[1]).toBe(
      `repos/o/r/compare/${TRUNK}...${HEAD_SHA}`,
    );
    expect(putFields(calls)).toEqual(["merge_method=squash", `sha=${HEAD_SHA}`]);
  });
}

for (const status of ["behind", "diverged", ""]) {
  test(`merge: a trunk that moved past the head (compare \`${status}\`) refuses before the PUT (#3192)`, async () => {
    const { forge, joined } = harness([
      [PROBE, stackedProbe],
      [COMPARE, () => status],
      [PUT_PATH, () => JSON.stringify({ status: "merged" })],
    ]);

    const err = await stackedMerge(forge);

    expect(err).toBeInstanceOf(StackUntestedError);
    expect((err as StackUntestedError).code).toBe("stack_untested");
    expect((err as StackUntestedError).message).toContain(TRUNK);
    expect(joined().some((c) => c.includes("merge-async"))).toBe(false);
  });
}

test("merge: a failed ancestry read fails CLOSED (#3192)", async () => {
  const { forge, joined } = harness([
    [PROBE, stackedProbe],
    [
      COMPARE,
      () => {
        throw new Error("HTTP 503: upstream unavailable");
      },
    ],
    [PUT_PATH, () => JSON.stringify({ status: "merged" })],
  ]);

  expect(await stackedMerge(forge)).toBeInstanceOf(StackUntestedError);
  expect(joined().some((c) => c.includes("merge-async"))).toBe(false);
});

test("merge: the ancestry read checks the operator-confirmed head (#3192, #2299)", async () => {
  const confirmed = "abcdef1234567";
  const { forge, calls } = harness([
    [PROBE, stackedProbe],
    [PUT_PATH, () => JSON.stringify({ status: "merged" })],
  ]);

  expect(await stackedMerge(forge, { expectedHeadSha: confirmed })).toBeNull();
  expect(calls.find((c) => c.some((a) => a.includes(COMPARE)))?.[1]).toBe(
    `repos/o/r/compare/${TRUNK}...${confirmed}`,
  );
  expect(putFields(calls)).toEqual(["merge_method=squash", `sha=${confirmed}`]);
});

test("merge: a merge-queue trunk skips the ancestry gate — the queue tests the group (#3192)", async () => {
  const { forge, calls, joined } = harness([
    [PROBE, stackedProbe],
    [RULES, () => "1"],
    [COMPARE, () => "behind"], // would refuse if anything asked
    [PUT_PATH, () => JSON.stringify({ status: "enqueued", details: { uuid: UUID } })],
  ]);

  expect(await stackedMerge(forge)).toBeInstanceOf(MergeEnqueuedError);
  expect(joined().some((c) => c.includes(COMPARE))).toBe(false);
  expect(putFields(calls)).toEqual(["merge_action=merge_queue", `sha=${HEAD_SHA}`]);
});

test("merge: without allowStacked the refusal comes first — no ancestry read (#3192)", async () => {
  const { forge, joined } = harness([[PROBE, stackedProbe]]);

  const err = await forge
    .merge(7, { method: "squash", deleteBranch: true })
    .catch((e: unknown) => e);

  expect(err).toBeInstanceOf(StackedMergeRefusedError);
  expect(joined().some((c) => c.includes(COMPARE))).toBe(false);
});

// ── Unstacked PR on a merge-queue base (#3219) ─────────────────────────────────────────────────
// `gh pr merge` refuses `--delete-branch` when the base requires a merge queue, and on success it
// only ENQUEUES (or arms auto-merge) — so resolving would settle a session whose PR has not landed.

/** An unstacked PR whose own base is `main`. */
const unstackedOnMain = (): string =>
  JSON.stringify({ stack: null, sha: HEAD_SHA, baseRef: TRUNK });
const prMergeCall = (calls: string[][]): string[] | undefined =>
  calls.find((c) => c[0] === "pr" && c[1] === "merge");

test("merge: unstacked on a merge-queue base enqueues without method/-d (#3219)", async () => {
  const { forge, calls } = harness([
    [PROBE, unstackedOnMain],
    [RULES, () => "1"],
  ]);

  const err = await forge
    .merge(7, { method: "squash", deleteBranch: true })
    .catch((e: unknown) => e);

  expect(calls.find((c) => c.some((a) => a.includes(RULES)))?.[1]).toBe(
    `repos/o/r/${RULES}${TRUNK}`,
  );
  expect(prMergeCall(calls)).toEqual(["pr", "merge", "7", "--repo", "o/r"]);
  expect(err).toBeInstanceOf(MergeEnqueuedError);
  expect((err as MergeEnqueuedError).code).toBe("merge_enqueued");
});

test("merge: unstacked merge-queue enqueue keeps the head-commit guard (#3219)", async () => {
  const { forge, calls } = harness([
    [PROBE, unstackedOnMain],
    [RULES, () => "1"],
  ]);

  const err = await forge
    .merge(7, { method: "squash", deleteBranch: true, expectedHeadSha: HEAD_SHA })
    .catch((e: unknown) => e);

  expect(prMergeCall(calls)).toEqual([
    "pr",
    "merge",
    "7",
    "--repo",
    "o/r",
    "--match-head-commit",
    HEAD_SHA,
  ]);
  expect(err).toBeInstanceOf(MergeEnqueuedError);
});

test("merge: unstacked on a base without a merge queue keeps today's args (#3219)", async () => {
  const { forge, calls } = harness([
    [PROBE, unstackedOnMain],
    [RULES, () => "0"],
  ]);

  await forge.merge(7, { method: "squash", deleteBranch: true });

  expect(prMergeCall(calls)).toEqual([
    "pr",
    "merge",
    "7",
    "--repo",
    "o/r",
    "--squash",
    "--delete-branch",
  ]);
});

test("merge: a failed merge-queue probe on an unstacked PR falls open (#3219)", async () => {
  const { forge, calls } = harness([
    [PROBE, unstackedOnMain],
    [
      RULES,
      () => {
        throw new Error("HTTP 503: upstream unavailable");
      },
    ],
  ]);

  await forge.merge(7, { method: "squash", deleteBranch: true });

  expect(prMergeCall(calls)).toEqual([
    "pr",
    "merge",
    "7",
    "--repo",
    "o/r",
    "--squash",
    "--delete-branch",
  ]);
});
