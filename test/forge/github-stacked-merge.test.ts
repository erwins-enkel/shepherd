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
} from "../../src/forge/types";

const HEAD_SHA = "f00dcafe0000";
const UUID = "11111111-2222-3333-4444-555555555555";
// The `--jq` suffix keeps this from also matching the merge-async paths, which extend it.
const PROBE = "repos/o/r/pulls/7 --jq";
const PUT_PATH = "repos/o/r/pulls/7/merge-async";
const POLL_PATH = `repos/o/r/pulls/7/merge-async/${UUID}`;

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
 *  the traffic it cares about. */
function harness(routes: [match: string, reply: () => string][]) {
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
const stackedProbe = (): string =>
  JSON.stringify({ stack: { id: 9, number: 3, size: 3, position: 2 }, sha: HEAD_SHA });

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
  expect(polled).toBe(30); // the whole budget, then gave up
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
