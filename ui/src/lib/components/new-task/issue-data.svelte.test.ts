import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Issue } from "$lib/types";

// The loader's direct unit seam: listIssues is mocked; viewerCache is the real
// session-lived cache (reset per test) so the warm-cache semantics are observable.
vi.mock("$lib/api", () => ({ listIssues: vi.fn() }));

import { listIssues } from "$lib/api";
import { viewerCache } from "$lib/viewer-cache.svelte";
import { IssueData } from "./issue-data.svelte";

const listIssuesMock = vi.mocked(listIssues);

function issue(number: number): Issue {
  return { number, title: `t${number}`, url: `u${number}`, body: "" } as Issue;
}

type ListIssuesResult = Awaited<ReturnType<typeof listIssues>>;

function ok(over: Partial<ListIssuesResult> = {}): ListIssuesResult {
  return {
    slug: "o/r",
    issues: [issue(1)],
    viewer: "kai",
    error: null,
    ...over,
  } as ListIssuesResult;
}

/** A listIssues call the test resolves by hand — models an in-flight response. */
function deferred() {
  let resolve!: (r: ListIssuesResult) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<ListIssuesResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  listIssuesMock.mockReset();
});

describe("IssueData generations", () => {
  it("one fetch per selection generation: A→B→A issues exactly 3 calls", async () => {
    listIssuesMock.mockResolvedValue(ok());
    const d = new IssueData();
    d.load("A");
    d.load("B");
    d.load("A");
    await Promise.resolve();
    expect(listIssuesMock).toHaveBeenCalledTimes(3);
    expect(listIssuesMock.mock.calls.map((c) => c[0])).toEqual(["A", "B", "A"]);
  });

  it("discards a stale generation-1 response after A→B→A, even though the path matches", async () => {
    const first = deferred();
    const third = deferred();
    listIssuesMock
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(ok({ slug: "o/b", issues: [issue(9)] }))
      .mockReturnValueOnce(third.promise);
    const d = new IssueData();
    d.load("A"); // gen 1 — stays in flight
    d.load("B"); // gen 2
    d.load("A"); // gen 3 — stays in flight
    // The FIRST A response lands late, after the return to A: a path check would
    // wrongly accept it; the generation check discards it.
    first.resolve(ok({ issues: [issue(111)], viewer: "stale" }));
    await Promise.resolve();
    expect(d.issues).toEqual([]);
    expect(d.loading).toBe(true);
    // The current generation's response wins regardless of arrival order.
    third.resolve(ok({ issues: [issue(3)] }));
    await Promise.resolve();
    expect(d.issues).toEqual([issue(3)]);
    expect(d.loading).toBe(false);
  });

  it("drops a stale payload on a plain repo switch mid-flight", async () => {
    const a = deferred();
    listIssuesMock.mockReturnValueOnce(a.promise).mockResolvedValueOnce(ok({ slug: "o/b" }));
    const d = new IssueData();
    d.load("A");
    d.load("B");
    a.resolve(ok({ issues: [issue(42)] }));
    await Promise.resolve();
    expect(d.issues).not.toEqual([issue(42)]);
    expect(d.slug).toBe("o/b");
  });
});

describe("IssueData error semantics", () => {
  it("distinguishes a failed fetch from a genuine zero-open-issues success", async () => {
    listIssuesMock.mockResolvedValueOnce(ok({ issues: [] }));
    const d = new IssueData();
    d.load("A");
    await Promise.resolve();
    expect(d.loadError).toBe(false);
    expect(d.slug).toBe("o/r"); // empty-but-loaded

    listIssuesMock.mockRejectedValueOnce(new Error("boom"));
    d.load("A");
    await Promise.resolve();
    await Promise.resolve();
    expect(d.loadError).toBe(true);
    expect(d.slug).toBeNull(); // error state, not "no issues"
  });

  it("a partial success (issues alongside an error) still flags loadError", async () => {
    listIssuesMock.mockResolvedValueOnce(
      ok({ error: "rate-limited" } as Partial<ListIssuesResult>),
    );
    const d = new IssueData();
    d.load("A");
    await Promise.resolve();
    expect(d.loadError).toBe(true);
    expect(d.issues).toEqual([issue(1)]);
  });
});

describe("IssueData warm viewerCache semantics", () => {
  it("populates the cache on success and keeps it warm on a failed reload", async () => {
    listIssuesMock.mockResolvedValueOnce(ok({ viewer: "kai" }));
    const d = new IssueData();
    d.load("A");
    await Promise.resolve();
    expect(viewerCache.get("A")).toBe("kai");

    listIssuesMock.mockRejectedValueOnce(new Error("transient"));
    d.load("A");
    await Promise.resolve();
    await Promise.resolve();
    // Local viewer degrades (mine-filter chip hides)…
    expect(d.viewer).toBeNull();
    // …but the last-known-good cache entry survives, so the assigned-others
    // notice keeps working through a transient reload failure.
    expect(viewerCache.get("A")).toBe("kai");
  });
});
