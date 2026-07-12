import { test, expect } from "bun:test";
import { GiteaForge } from "../../src/forge/gitea";
import { EmptyDiffError } from "../../src/forge/types";
import type { ForgeConfig } from "../../src/forge/types";

const CFG: ForgeConfig = {
  type: "gitea",
  baseUrl: "https://git.example.com",
  token: "secret",
  deployWorkflow: "deploy.yaml",
  mergeMethod: "squash",
};

// Build a fake fetch that records requests and answers by "METHOD path".
function fakeFetch(routes: Record<string, { status?: number; json?: unknown }>) {
  const calls: { method: string; url: string; body: unknown; headers: Headers }[] = [];
  const fn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body, headers });
    const path = new URL(url).pathname + new URL(url).search;
    const key = `${method} ${path}`;
    const route = routes[key];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.json === undefined ? null : JSON.stringify(route.json), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

test("GiteaForge.listBacklogCounts: reads open counts from the repo summary (no CI/kinds)", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj": { json: { open_issues_count: 5, open_pr_counter: 2 } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const counts = await forge.listBacklogCounts();
  expect(counts).toEqual({ openIssues: 5, openPRs: 2, ciStatus: null, prKinds: null });
  expect(calls[0]!.url).toBe("https://git.example.com/api/v1/repos/team/proj");
  expect(calls[0]!.headers.get("authorization")).toBe("token secret");
});

test("GiteaForge.listPullRequests: maps open PRs and fans out per-PR checks", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls?state=open&limit=200": {
      json: [
        {
          number: 9,
          title: "feat: gitea pr",
          state: "open",
          draft: false,
          mergeable: true,
          html_url: "https://git.example.com/team/proj/pulls/9",
          user: { login: "carol" },
          created_at: "2024-03-03T00:00:00Z",
          head: { ref: "feature", sha: "deadbeef" },
        },
      ],
    },
    "GET /api/v1/repos/team/proj/commits/deadbeef/status": {
      json: {
        state: "success",
        statuses: [
          { status: "success", context: "build", target_url: "https://git.example.com/build" },
          { status: "success", context: "test", target_url: "" },
        ],
      },
    },
    // defaultBranch() — needed so nonDefaultBase can be computed (and so this call
    // is recorded by fakeFetch, see the count assertion below).
    "GET /api/v1/repos/team/proj": { json: { default_branch: "main" } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const prs = await forge.listPullRequests();
  expect(prs).toEqual([
    {
      number: 9,
      title: "feat: gitea pr",
      url: "https://git.example.com/team/proj/pulls/9",
      author: "carol",
      kind: "regular",
      createdAt: Date.parse("2024-03-03T00:00:00Z"),
      isDraft: false,
      mergeable: true,
      checks: "success",
      jobs: [
        { name: "build", state: "success", url: "https://git.example.com/build" },
        { name: "test", state: "success", url: undefined },
      ],
      headSha: "deadbeef",
      headRefName: "feature",
    },
  ]);
  // list call + default-branch call + one commit-status call
  expect(calls.length).toBe(3);
});

test("GiteaForge.listPullRequests: nonDefaultBase set only for non-default-targeting PRs", async () => {
  const { fn } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls?state=open&limit=200": {
      json: [
        {
          number: 1,
          title: "targets default",
          state: "open",
          mergeable: true,
          html_url: "u1",
          head: { ref: "f1", sha: "a" },
          base: { ref: "main" },
        },
        {
          number: 2,
          title: "stacked on epic",
          state: "open",
          mergeable: true,
          html_url: "u2",
          head: { ref: "f2", sha: "b" },
          base: { ref: "epic/foo" },
        },
      ],
    },
    "GET /api/v1/repos/team/proj/commits/a/status": { json: { state: "success" } },
    "GET /api/v1/repos/team/proj/commits/b/status": { json: { state: "success" } },
    "GET /api/v1/repos/team/proj": { json: { default_branch: "main" } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const prs = await forge.listPullRequests();
  expect(prs.map((p) => p.nonDefaultBase)).toEqual([undefined, "epic/foo"]);
});

test("GiteaForge.listPullRequests: classifies dependabot + release PRs by kind", async () => {
  const { fn } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls?state=open&limit=200": {
      json: [
        {
          number: 1,
          title: "Bump lodash from 1 to 2",
          state: "open",
          html_url: "u1",
          user: { login: "dependabot[bot]" },
          head: { ref: "dependabot/npm/lodash", sha: "a" },
        },
        {
          number: 2,
          title: "chore(main): release 1.0.0",
          state: "open",
          html_url: "u2",
          user: { login: "release-please" },
          head: { ref: "release-please--branches--main", sha: "b" },
        },
        {
          number: 3,
          title: "feat: real work",
          state: "open",
          html_url: "u3",
          user: { login: "carol" },
          head: { ref: "feature", sha: "c" },
        },
      ],
    },
    "GET /api/v1/repos/team/proj/commits/a/status": { json: { state: "success" } },
    "GET /api/v1/repos/team/proj/commits/b/status": { json: { state: "success" } },
    "GET /api/v1/repos/team/proj/commits/c/status": { json: { state: "success" } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const prs = await forge.listPullRequests();
  expect(prs.map((p) => p.kind)).toEqual(["dependabot", "release", "regular"]);
});

test("GiteaForge.listPullRequests: a failing per-PR status call degrades to checks:none, not a rejected list", async () => {
  const { fn } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls?state=open&limit=200": {
      json: [
        {
          number: 9,
          title: "good",
          state: "open",
          mergeable: true,
          html_url: "https://git.example.com/team/proj/pulls/9",
          head: { ref: "f", sha: "live" },
        },
        {
          number: 8,
          title: "stale head",
          state: "open",
          mergeable: true,
          html_url: "https://git.example.com/team/proj/pulls/8",
          head: { ref: "g", sha: "gone" },
        },
      ],
    },
    "GET /api/v1/repos/team/proj/commits/live/status": { json: { state: "success" } },
    // no route for /commits/gone/status → req throws 404
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const prs = await forge.listPullRequests();
  expect(prs.map((p) => [p.number, p.checks])).toEqual([
    [9, "success"],
    [8, "none"],
  ]);
});

test("GiteaForge.listPullRequests: bounds concurrent status calls and preserves order", async () => {
  const N = 20;
  const prs = Array.from({ length: N }, (_, i) => ({
    number: i + 1,
    title: `p${i + 1}`,
    state: "open",
    mergeable: true,
    html_url: `https://git.example.com/team/proj/pulls/${i + 1}`,
    head: { ref: `r${i}`, sha: `s${i}` },
  }));
  let inFlight = 0;
  let peak = 0;
  const pending: Array<() => void> = [];
  const fn = (async (input: string | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/pulls?state=open")) {
      return new Response(JSON.stringify(prs), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // a /commits/{sha}/status call — park it so we can observe peak concurrency
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) =>
      pending.push(() => {
        inFlight--;
        resolve();
      }),
    );
    return new Response(JSON.stringify({ state: "success" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const forge = new GiteaForge("team/proj", CFG, fn);
  let settled = false;
  const promise = forge.listPullRequests().finally(() => {
    settled = true;
  });
  // Drain in waves: flush microtasks so workers park their status calls, then
  // release the parked wave; repeat until the list resolves. (pending is empty
  // on the first tick because the workers haven't run yet — flush first.)
  for (let i = 0; i < 100 && !settled; i++) {
    await new Promise((r) => setTimeout(r, 0));
    pending.splice(0).forEach((release) => release());
  }
  const result = await promise;

  expect(result.map((p) => p.number)).toEqual(prs.map((p) => p.number)); // order preserved
  expect(peak).toBeLessThanOrEqual(6); // bounded by STATUS_FETCH_CONCURRENCY
  expect(peak).toBeGreaterThan(1); // but genuinely fanned out
});

test("GiteaForge.kind + slug", () => {
  const { fn } = fakeFetch({});
  const forge = new GiteaForge("team/proj", CFG, fn);
  expect(forge.kind).toBe("gitea");
  expect(forge.slug).toBe("team/proj");
});

test("GiteaForge.webUrl: with baseUrl returns <base>/<slug>", () => {
  const { fn } = fakeFetch({});
  const forge = new GiteaForge("team/proj", { ...CFG, baseUrl: "https://gitea.example.com" }, fn);
  expect(forge.webUrl).toBe("https://gitea.example.com/team/proj");
});

test("GiteaForge.webUrl: trailing slash on baseUrl is stripped", () => {
  const { fn } = fakeFetch({});
  const forge = new GiteaForge("team/proj", { ...CFG, baseUrl: "https://gitea.example.com/" }, fn);
  expect(forge.webUrl).toBe("https://gitea.example.com/team/proj");
});

test("GiteaForge.webUrl: no baseUrl → null", () => {
  const { fn } = fakeFetch({});
  const forge = new GiteaForge("team/proj", { type: "gitea" }, fn);
  expect(forge.webUrl).toBeNull();
});

const GITEA_ISSUE_CREATED_AT = "2024-02-01T12:00:00Z";

test("GiteaForge.listIssues: maps gitea issues, filters out PRs via type=issues", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/issues?state=open&type=issues&limit=200": {
      json: [
        {
          number: 3,
          title: "Bug",
          body: "desc",
          html_url: "https://git.example.com/team/proj/issues/3",
          labels: [{ name: "bug" }, { name: "p1" }],
          created_at: GITEA_ISSUE_CREATED_AT,
          assignees: [{ login: "alice" }, { login: "bob" }],
          user: { login: "carol" },
        },
        {
          number: 4,
          title: "Unassigned",
          body: "",
          html_url: "https://git.example.com/team/proj/issues/4",
          labels: [],
          created_at: GITEA_ISSUE_CREATED_AT,
          assignees: null,
        },
      ],
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const issues = await forge.listIssues();
  expect(issues).toEqual([
    {
      number: 3,
      title: "Bug",
      body: "desc",
      url: "https://git.example.com/team/proj/issues/3",
      labels: ["bug", "p1"],
      createdAt: Date.parse(GITEA_ISSUE_CREATED_AT),
      assignees: ["alice", "bob"],
      author: "carol",
    },
    {
      number: 4,
      title: "Unassigned",
      body: "",
      url: "https://git.example.com/team/proj/issues/4",
      labels: [],
      createdAt: Date.parse(GITEA_ISSUE_CREATED_AT),
      assignees: [],
    },
  ]);
  expect(calls[0]!.headers.get("Authorization")).toBe("token secret");
});

test("GiteaForge.listIssues: threads labelColors, handling both #-prefixed and bare hex", async () => {
  const { fn } = fakeFetch({
    "GET /api/v1/repos/team/proj/issues?state=open&type=issues&limit=200": {
      json: [
        {
          number: 3,
          title: "Bug",
          body: "desc",
          html_url: "https://git.example.com/team/proj/issues/3",
          labels: [
            { name: "bug", color: "#d73a4a" },
            { name: "p1", color: "00ff00" },
            { name: "no-color" },
          ],
          created_at: GITEA_ISSUE_CREATED_AT,
        },
      ],
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const issues = await forge.listIssues();
  expect(issues[0]!.labels).toEqual(["bug", "p1", "no-color"]);
  expect(issues[0]!.labelColors).toEqual({ bug: "#d73a4a", p1: "#00ff00" });
});

test("GiteaForge.listIssues: no label carries a color → labelColors omitted", async () => {
  const { fn } = fakeFetch({
    "GET /api/v1/repos/team/proj/issues?state=open&type=issues&limit=200": {
      json: [
        {
          number: 3,
          title: "Bug",
          body: "desc",
          html_url: "https://git.example.com/team/proj/issues/3",
          labels: [{ name: "bug" }],
          created_at: GITEA_ISSUE_CREATED_AT,
        },
      ],
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const issues = await forge.listIssues();
  expect(issues[0]!.labelColors).toBeUndefined();
});

test("GiteaForge.currentUser: returns the authenticated login (#824)", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/user": { json: { login: "octogit" } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  expect(await forge.currentUser()).toBe("octogit");
  // Cached: a second call must not hit the API again.
  expect(await forge.currentUser()).toBe("octogit");
  expect(calls.filter((c) => c.url.endsWith("/api/v1/user")).length).toBe(1);
});

test("GiteaForge.currentUser: null when the host can't resolve a user", async () => {
  const { fn } = fakeFetch({ "GET /api/v1/user": { status: 401 } });
  const forge = new GiteaForge("team/proj", CFG, fn);
  expect(await forge.currentUser()).toBeNull();
});

test("GiteaForge.prStatus: open PR + success status → mapped", async () => {
  const { fn } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls?state=all&limit=50": {
      json: [
        {
          number: 9,
          title: "feat",
          state: "open",
          merged: false,
          mergeable: true,
          html_url: "https://git.example.com/team/proj/pulls/9",
          head: { ref: "feature", sha: "abc123" },
        },
      ],
    },
    "GET /api/v1/repos/team/proj/commits/abc123/status": {
      json: { state: "success" },
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const st = await forge.prStatus("feature");
  expect(st.state).toBe("open");
  expect(st.number).toBe(9);
  expect(st.url).toBe("https://git.example.com/team/proj/pulls/9");
  expect(st.mergeable).toBe(true);
  expect(st.checks).toBe("success");
  expect(st.deployConfigured).toBe(true);
});

test("GiteaForge.prStatus: merged PR", async () => {
  const { fn } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls?state=all&limit=50": {
      json: [
        {
          number: 9,
          state: "closed",
          merged: true,
          head: { ref: "feature", sha: "z" },
          html_url: "u",
        },
      ],
    },
    "GET /api/v1/repos/team/proj/commits/z/status": { json: { state: "success" } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const st = await forge.prStatus("feature");
  expect(st.state).toBe("merged");
});

test("GiteaForge.prStatus: no matching head → none", async () => {
  const { fn } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls?state=all&limit=50": { json: [] },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const st = await forge.prStatus("feature");
  expect(st.state).toBe("none");
  expect(st.checks).toBe("none");
});

test("GiteaForge.openPr: POSTs pull then returns status", async () => {
  const { fn, calls } = fakeFetch({
    "POST /api/v1/repos/team/proj/pulls": {
      status: 201,
      json: {
        number: 12,
        state: "open",
        merged: false,
        mergeable: true,
        html_url: "u12",
        head: { ref: "feature", sha: "s12" },
      },
    },
    "GET /api/v1/repos/team/proj/commits/s12/status": { json: { state: "pending" } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const st = await forge.openPr({ head: "feature", base: "main", title: "T", body: "B" });
  expect(st.state).toBe("open");
  expect(st.number).toBe(12);
  expect(st.checks).toBe("pending");
  const post = calls.find((c) => c.method === "POST")!;
  expect(post.body).toEqual({ head: "feature", base: "main", title: "T", body: "B" });
});

test("GiteaForge.openPr: empty-diff response (422 no changes) → EmptyDiffError", async () => {
  const { fn } = fakeFetch({
    "POST /api/v1/repos/team/proj/pulls": {
      status: 422,
      // Gitea's wording when head == base (422 Unprocessable Entity).
      json: { message: "There are no changes between the head and the base" },
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  let caught: unknown;
  try {
    await forge.openPr({ head: "epic/327-foo", base: "main", title: "T", body: "B" });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(EmptyDiffError);
  expect((caught as EmptyDiffError).head).toBe("epic/327-foo");
  expect((caught as EmptyDiffError).base).toBe("main");
});

test("GiteaForge.openPr: unrelated error (500) propagates unchanged (NOT EmptyDiffError)", async () => {
  const { fn } = fakeFetch({
    "POST /api/v1/repos/team/proj/pulls": {
      status: 500,
      json: { message: "internal server error" },
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  let caught: unknown;
  try {
    await forge.openPr({ head: "feat", base: "main", title: "T", body: "B" });
  } catch (e) {
    caught = e;
  }
  expect(caught).not.toBeInstanceOf(EmptyDiffError);
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain("500");
});

test("GiteaForge.merge: POSTs merge with Do + delete_branch_after_merge", async () => {
  const { fn, calls } = fakeFetch({
    "POST /api/v1/repos/team/proj/pulls/9/merge": { status: 200 },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.merge(9, { method: "squash", deleteBranch: true });
  const post = calls[0]!;
  expect(post.body).toEqual({ Do: "squash", delete_branch_after_merge: true });
});

test("GiteaForge.redeploy: dispatches workflow with ref", async () => {
  const { fn, calls } = fakeFetch({
    "POST /api/v1/repos/team/proj/actions/workflows/deploy.yaml/dispatches": { status: 204 },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.redeploy({ workflow: "deploy.yaml", ref: "main" });
  expect(calls[0]!.body).toEqual({ ref: "main" });
});

test("GiteaForge: non-2xx throws", async () => {
  const { fn } = fakeFetch({
    "POST /api/v1/repos/team/proj/pulls/9/merge": { status: 409, json: { message: "conflict" } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await expect(forge.merge(9, { method: "squash", deleteBranch: true })).rejects.toThrow();
});

test("GiteaForge.postReview: POSTs review and returns url from html_url", async () => {
  const { fn, calls } = fakeFetch({
    "POST /api/v1/repos/team/proj/pulls/7/reviews": {
      status: 200,
      json: { html_url: "https://git.example.com/team/proj/pulls/7#review-42" },
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const result = await forge.postReview(7, { event: "REQUEST_CHANGES", body: "nope" });
  expect(result).toEqual({ url: "https://git.example.com/team/proj/pulls/7#review-42" });
  const post = calls[0]!;
  expect(post.method).toBe("POST");
  expect(post.url).toContain("/api/v1/repos/team/proj/pulls/7/reviews");
  expect(post.body).toEqual({ event: "REQUEST_CHANGES", body: "nope" });
});

test("GiteaForge.listIssues: createdAt is parsed to a finite ms number from ISO string", async () => {
  const isoDate = "2024-06-01T08:00:00Z";
  const expectedMs = Date.parse(isoDate);
  const { fn } = fakeFetch({
    "GET /api/v1/repos/team/proj/issues?state=open&type=issues&limit=200": {
      json: [
        {
          number: 5,
          title: "Issue",
          body: "body",
          html_url: "https://git.example.com/team/proj/issues/5",
          labels: [],
          created_at: isoDate,
        },
      ],
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const issues = await forge.listIssues();
  expect(issues[0]!.createdAt).toBe(expectedMs);
  expect(Number.isFinite(issues[0]!.createdAt)).toBe(true);
});

test("GiteaForge.listIssues: missing created_at falls back to Date.now() (finite number)", async () => {
  const before = Date.now();
  const { fn } = fakeFetch({
    "GET /api/v1/repos/team/proj/issues?state=open&type=issues&limit=200": {
      json: [
        {
          number: 6,
          title: "Issue2",
          body: "",
          html_url: "u6",
          labels: [],
          // no created_at
        },
      ],
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const issues = await forge.listIssues();
  const after = Date.now();
  expect(Number.isFinite(issues[0]!.createdAt)).toBe(true);
  expect(issues[0]!.createdAt).toBeGreaterThanOrEqual(before);
  expect(issues[0]!.createdAt).toBeLessThanOrEqual(after);
});

test("GiteaForge.listIssues: invalid created_at string falls back to Date.now()", async () => {
  const before = Date.now();
  const { fn } = fakeFetch({
    "GET /api/v1/repos/team/proj/issues?state=open&type=issues&limit=200": {
      json: [
        {
          number: 7,
          title: "Issue3",
          body: "",
          html_url: "u7",
          labels: [],
          created_at: "bogus-date",
        },
      ],
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const issues = await forge.listIssues();
  const after = Date.now();
  expect(Number.isFinite(issues[0]!.createdAt)).toBe(true);
  expect(issues[0]!.createdAt).toBeGreaterThanOrEqual(before);
  expect(issues[0]!.createdAt).toBeLessThanOrEqual(after);
});

test("GiteaForge.closeIssue: PATCHes the issue state to closed", async () => {
  const { fn, calls } = fakeFetch({
    "PATCH /api/v1/repos/team/proj/issues/42": { status: 200, json: {} },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.closeIssue(42);
  const patch = calls[0]!;
  expect(patch.method).toBe("PATCH");
  expect(patch.url).toContain("/api/v1/repos/team/proj/issues/42");
  expect(patch.body).toEqual({ state: "closed" });
});

test("GiteaForge.addIssueLabel: resolves the label id by name, then POSTs it", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/labels?limit=100&page=1": {
      json: [
        { id: 11, name: "bug" },
        { id: 42, name: "shepherd:active" },
      ],
    },
    "POST /api/v1/repos/team/proj/issues/7/labels": { status: 200, json: {} },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.addIssueLabel(7, "shepherd:active");
  const post = calls.find((c) => c.method === "POST")!;
  expect(post.url).toContain("/issues/7/labels");
  expect(post.body).toEqual({ labels: [42] });
});

test("GiteaForge.addIssueLabel: creates the label when the repo lacks it", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/labels?limit=100&page=1": { json: [] },
    "POST /api/v1/repos/team/proj/labels": {
      status: 201,
      json: { id: 99, name: "shepherd:active" },
    },
    "POST /api/v1/repos/team/proj/issues/7/labels": { status: 200, json: {} },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.addIssueLabel(7, "shepherd:active");
  const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/labels"))!;
  expect(create.body).toEqual({ name: "shepherd:active", color: "#5319e7" });
  const apply = calls.find((c) => c.method === "POST" && c.url.includes("/issues/7/labels"))!;
  expect(apply.body).toEqual({ labels: [99] });
});

test("GiteaForge.addIssueLabel: a concurrent create (409) re-resolves the id instead of throwing", async () => {
  // First lookup misses; a sibling instance creates the label; our create 409s; we
  // re-resolve and apply the id another instance just minted.
  const calls: { method: string; url: string; body: unknown }[] = [];
  let labelLookups = 0;
  const fn = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.includes("/labels?limit=")) {
      // miss on the first lookup, hit on the post-conflict re-resolve
      return json(labelLookups++ === 0 ? [] : [{ id: 55, name: "shepherd:active" }]);
    }
    if (method === "POST" && url.endsWith("/proj/labels")) return json({ message: "exists" }, 409);
    if (method === "POST" && url.includes("/issues/7/labels")) return json({});
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.addIssueLabel(7, "shepherd:active"); // must not throw
  const apply = calls.find((c) => c.method === "POST" && c.url.includes("/issues/7/labels"))!;
  expect(apply.body).toEqual({ labels: [55] }); // re-resolved id applied
});

test("GiteaForge.addIssueLabel: a create failure with the label still absent propagates", async () => {
  const { fn } = fakeFetch({
    "GET /api/v1/repos/team/proj/labels?limit=100&page=1": { json: [] },
    "POST /api/v1/repos/team/proj/labels": { status: 500, json: { message: "boom" } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await expect(forge.addIssueLabel(7, "shepherd:active")).rejects.toThrow();
});

test("GiteaForge.addIssueLabel: paginates past a full first page to find the label (no spurious create)", async () => {
  const firstPage = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `label-${i}` }));
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/labels?limit=100&page=1": { json: firstPage },
    "GET /api/v1/repos/team/proj/labels?limit=100&page=2": {
      json: [{ id: 777, name: "shepherd:active" }],
    },
    "POST /api/v1/repos/team/proj/issues/7/labels": { status: 200, json: {} },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.addIssueLabel(7, "shepherd:active");
  // resolved on page 2 → no label-create POST (the repo /labels collection), apply uses the found id
  expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/proj/labels"))).toBe(false);
  const apply = calls.find((c) => c.method === "POST" && c.url.includes("/issues/7/labels"))!;
  expect(apply.body).toEqual({ labels: [777] });
});

test("GiteaForge.removeIssueLabel: DELETEs the resolved label id off the issue", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/labels?limit=100&page=1": {
      json: [{ id: 42, name: "shepherd:active" }],
    },
    "DELETE /api/v1/repos/team/proj/issues/7/labels/42": { status: 204 },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.removeIssueLabel(7, "shepherd:active");
  const del = calls.find((c) => c.method === "DELETE")!;
  expect(del.url).toContain("/issues/7/labels/42");
});

test("GiteaForge.removeIssueLabel: no-op when the repo never defined the label", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/labels?limit=100&page=1": { json: [] },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.removeIssueLabel(7, "shepherd:active");
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
});

test("GiteaForge.ensureIssueLink: appends Closes #N when body has no link", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls/7": { json: { body: "Some PR description" } },
    "PATCH /api/v1/repos/team/proj/pulls/7": { status: 200, json: {} },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.ensureIssueLink!(7, 3);
  const patch = calls.find((c) => c.method === "PATCH")!;
  expect(patch).toBeDefined();
  expect(patch.body).toEqual({ body: "Some PR description\n\nCloses #3" });
});

test("GiteaForge.ensureIssueLink: appends to empty body without leading newlines", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls/7": { json: { body: "" } },
    "PATCH /api/v1/repos/team/proj/pulls/7": { status: 200, json: {} },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.ensureIssueLink!(7, 3);
  const patch = calls.find((c) => c.method === "PATCH")!;
  expect(patch.body).toEqual({ body: "Closes #3" });
});

test("GiteaForge.ensureIssueLink: no-op when body already contains Closes #N", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls/7": { json: { body: "Description\n\nCloses #3" } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.ensureIssueLink!(7, 3);
  expect(calls.find((c) => c.method === "PATCH")).toBeUndefined();
});

test("GiteaForge.ensureIssueLink: no-op when body contains a different closing keyword (Fixes #N)", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls/7": { json: { body: "Description\n\nFixes #3" } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.ensureIssueLink!(7, 3);
  expect(calls.find((c) => c.method === "PATCH")).toBeUndefined();
});

test("GiteaForge.ensureIssueLink: does not treat Closes #15 as a link for issue #1", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls/7": { json: { body: "Description\n\nCloses #15" } },
    "PATCH /api/v1/repos/team/proj/pulls/7": { status: 200, json: {} },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.ensureIssueLink!(7, 1);
  // #15 should NOT match issue #1 — PATCH must be called
  expect(calls.find((c) => c.method === "PATCH")).toBeDefined();
});

const ACTIONS_TASKS = "GET /api/v1/repos/team/proj/actions/tasks?limit=50";

test("GiteaForge.listWorkflowRuns: dedups to newest run per workflow, newest-first", async () => {
  const { fn } = fakeFetch({
    [ACTIONS_TASKS]: {
      json: {
        workflow_runs: [
          // older CI run (should be dropped in favor of the newer one below)
          {
            id: 1,
            name: "CI",
            run_number: 1,
            status: "failure",
            url: "https://git.example.com/team/proj/actions/runs/1",
            head_sha: "old",
            workflow_id: "ci.yaml",
            created_at: "2024-01-01T00:00:00Z",
          },
          // newest Deploy run
          {
            id: 3,
            name: "Deploy",
            run_number: 2,
            status: "running",
            url: "https://git.example.com/team/proj/actions/runs/3",
            head_sha: "dep",
            workflow_id: "deploy.yaml",
            created_at: "2024-03-03T00:00:00Z",
          },
          // newer CI run
          {
            id: 2,
            name: "CI",
            run_number: 2,
            status: "success",
            url: "https://git.example.com/team/proj/actions/runs/2",
            head_sha: "new",
            workflow_id: "ci.yaml",
            created_at: "2024-02-02T00:00:00Z",
          },
        ],
        total_count: 3,
      },
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const runs = await forge.listWorkflowRuns!();
  expect(runs).toEqual([
    {
      runId: 3,
      workflowId: 0,
      workflowName: "Deploy",
      runUrl: "https://git.example.com/team/proj/actions/runs/3",
      headSha: "dep",
      createdAt: Date.parse("2024-03-03T00:00:00Z"),
      state: "pending",
      jobs: [],
    },
    {
      runId: 2,
      workflowId: 0,
      workflowName: "CI",
      runUrl: "https://git.example.com/team/proj/actions/runs/2",
      headSha: "new",
      createdAt: Date.parse("2024-02-02T00:00:00Z"),
      state: "success",
      jobs: [],
    },
  ]);
});

test("GiteaForge.listWorkflowRuns: maps native statuses to ChecksState", async () => {
  const mk = (id: number, name: string, status: string, created_at: string) => ({
    id,
    name,
    status,
    url: `https://git.example.com/r/${id}`,
    head_sha: `s${id}`,
    workflow_id: `${name}.yaml`,
    created_at,
  });
  const { fn } = fakeFetch({
    [ACTIONS_TASKS]: {
      json: {
        workflow_runs: [
          mk(1, "A", "success", "2024-01-04T00:00:00Z"),
          mk(2, "B", "running", "2024-01-03T00:00:00Z"),
          mk(3, "C", "waiting", "2024-01-02T00:00:00Z"),
          mk(4, "D", "cancelled", "2024-01-01T00:00:00Z"),
        ],
        total_count: 4,
      },
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const runs = await forge.listWorkflowRuns!();
  expect(runs.map((r) => [r.workflowName, r.state])).toEqual([
    ["A", "success"],
    ["B", "pending"],
    ["C", "pending"],
    ["D", "failure"],
  ]);
});

test("GiteaForge.listWorkflowRuns: empty workflow_runs → []", async () => {
  const { fn } = fakeFetch({
    [ACTIONS_TASKS]: { json: { workflow_runs: [], total_count: 0 } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  expect(await forge.listWorkflowRuns!()).toEqual([]);
});

test("GiteaForge.listWorkflowRuns: missing workflow_runs key → []", async () => {
  const { fn } = fakeFetch({
    [ACTIONS_TASKS]: { json: { total_count: 0 } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  expect(await forge.listWorkflowRuns!()).toEqual([]);
});

test("GiteaForge.listWorkflowRuns: caps at 10 distinct workflows", async () => {
  const workflow_runs = Array.from({ length: 25 }, (_, i) => ({
    id: i + 1,
    name: `wf-${i + 1}`,
    status: "success",
    url: `https://git.example.com/r/${i + 1}`,
    head_sha: `s${i + 1}`,
    workflow_id: `wf-${i + 1}.yaml`,
    // ascending time so newest is the last (wf-25); cap keeps the 10 newest
    created_at: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
  }));
  const { fn } = fakeFetch({
    [ACTIONS_TASKS]: { json: { workflow_runs, total_count: 25 } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const runs = await forge.listWorkflowRuns!();
  expect(runs.length).toBe(10);
  // newest-first, so the 10 highest-numbered workflows
  expect(runs.map((r) => r.workflowName)).toEqual([
    "wf-25",
    "wf-24",
    "wf-23",
    "wf-22",
    "wf-21",
    "wf-20",
    "wf-19",
    "wf-18",
    "wf-17",
    "wf-16",
  ]);
});

test("GiteaForge.listWorkflowRuns: every run has jobs: [] (no per-job data)", async () => {
  const { fn } = fakeFetch({
    [ACTIONS_TASKS]: {
      json: {
        workflow_runs: [
          {
            id: 1,
            name: "CI",
            status: "success",
            url: "u",
            head_sha: "s",
            workflow_id: "ci.yaml",
            created_at: "2024-01-01T00:00:00Z",
          },
        ],
        total_count: 1,
      },
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const runs = await forge.listWorkflowRuns!();
  expect(runs.every((r) => Array.isArray(r.jobs) && r.jobs.length === 0)).toBe(true);
});

test("GiteaForge.listWorkflowRuns: keys dedup on workflow_id when name is missing, unparseable created_at falls back to now", async () => {
  const before = Date.now();
  const { fn } = fakeFetch({
    [ACTIONS_TASKS]: {
      json: {
        workflow_runs: [
          {
            id: 1,
            name: "",
            status: "success",
            url: "u1",
            head_sha: "s1",
            workflow_id: "ci.yaml",
            created_at: "bogus",
          },
        ],
        total_count: 1,
      },
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const runs = await forge.listWorkflowRuns!();
  const after = Date.now();
  expect(runs.length).toBe(1);
  expect(runs[0]!.workflowName).toBe("ci.yaml");
  expect(runs[0]!.createdAt).toBeGreaterThanOrEqual(before);
  expect(runs[0]!.createdAt).toBeLessThanOrEqual(after);
});

test("GiteaForge.prStatus: surfaces head SHA from PR head.sha", async () => {
  const { fn } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls?state=all&limit=50": {
      json: [
        {
          number: 9,
          title: "feat",
          state: "open",
          merged: false,
          mergeable: true,
          html_url: "https://git.example.com/team/proj/pulls/9",
          head: { ref: "feature", sha: "def456" },
        },
      ],
    },
    "GET /api/v1/repos/team/proj/commits/def456/status": {
      json: { state: "success" },
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const st = await forge.prStatus("feature");
  expect(st.headSha).toBe("def456");
});

// --- draft support (WIP-prefix convention) ---

test("GiteaForge.openPr: draft:true prefixes title with 'WIP: '", async () => {
  const { fn, calls } = fakeFetch({
    "POST /api/v1/repos/team/proj/pulls": {
      status: 201,
      json: {
        number: 20,
        title: "WIP: My Feature",
        state: "open",
        merged: false,
        mergeable: true,
        html_url: "u20",
        head: { ref: "feat", sha: "s20" },
      },
    },
    "GET /api/v1/repos/team/proj/commits/s20/status": { json: { state: "none" } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.openPr({ head: "feat", base: "main", title: "My Feature", body: "B", draft: true });
  const post = calls.find((c) => c.method === "POST")!;
  expect(post.body).toMatchObject({ title: "WIP: My Feature" });
});

test("GiteaForge.openPr: draft:false (or omitted) does NOT prefix title", async () => {
  const { fn, calls } = fakeFetch({
    "POST /api/v1/repos/team/proj/pulls": {
      status: 201,
      json: {
        number: 21,
        title: "My Feature",
        state: "open",
        merged: false,
        mergeable: true,
        html_url: "u21",
        head: { ref: "feat", sha: "s21" },
      },
    },
    "GET /api/v1/repos/team/proj/commits/s21/status": { json: { state: "none" } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.openPr({ head: "feat", base: "main", title: "My Feature", body: "B" });
  const post = calls.find((c) => c.method === "POST")!;
  expect(post.body).toMatchObject({ title: "My Feature" });
});

test("GiteaForge.prStatus: WIP-prefixed title → isDraft true", async () => {
  const { fn } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls?state=all&limit=50": {
      json: [
        {
          number: 9,
          title: "WIP: feat",
          state: "open",
          merged: false,
          mergeable: true,
          html_url: "u9",
          head: { ref: "feature", sha: "abc123" },
        },
      ],
    },
    "GET /api/v1/repos/team/proj/commits/abc123/status": { json: { state: "success" } },
  });
  const st = await new GiteaForge("team/proj", CFG, fn).prStatus("feature");
  expect(st.isDraft).toBe(true);
});

test("GiteaForge.prStatus: non-WIP title → isDraft false", async () => {
  const { fn } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls?state=all&limit=50": {
      json: [
        {
          number: 9,
          title: "feat",
          state: "open",
          merged: false,
          mergeable: true,
          html_url: "u9",
          head: { ref: "feature", sha: "abc123" },
        },
      ],
    },
    "GET /api/v1/repos/team/proj/commits/abc123/status": { json: { state: "success" } },
  });
  const st = await new GiteaForge("team/proj", CFG, fn).prStatus("feature");
  expect(st.isDraft).toBe(false);
});

test("GiteaForge.markReady: strips WIP: prefix via PATCH", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls/20": {
      json: { number: 20, title: "WIP: My Feature", state: "open", html_url: "u20" },
    },
    "PATCH /api/v1/repos/team/proj/pulls/20": { status: 200, json: {} },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.markReady!(20);
  const patch = calls.find((c) => c.method === "PATCH")!;
  expect(patch.body).toEqual({ title: "My Feature" });
});

test("GiteaForge.markReady: still PATCHes (title unchanged) when no WIP prefix present", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls/21": {
      json: { number: 21, title: "My Feature", state: "open", html_url: "u21" },
    },
    "PATCH /api/v1/repos/team/proj/pulls/21": { status: 200, json: {} },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.markReady!(21);
  // title unchanged (no WIP prefix to strip)
  const patch = calls.find((c) => c.method === "PATCH")!;
  expect(patch.body).toEqual({ title: "My Feature" });
});

test("GiteaForge.convertToDraft: adds WIP: prefix via PATCH when absent", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls/21": {
      json: { number: 21, title: "My Feature", state: "open", html_url: "u21" },
    },
    "PATCH /api/v1/repos/team/proj/pulls/21": { status: 200, json: {} },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.convertToDraft!(21);
  const patch = calls.find((c) => c.method === "PATCH")!;
  expect(patch.body).toEqual({ title: "WIP: My Feature" });
});

test("GiteaForge.convertToDraft: no-ops when WIP: prefix already present", async () => {
  const { fn, calls } = fakeFetch({
    "GET /api/v1/repos/team/proj/pulls/20": {
      json: { number: 20, title: "WIP: My Feature", state: "open", html_url: "u20" },
    },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  await forge.convertToDraft!(20);
  // already a draft → no PATCH
  expect(calls.find((c) => c.method === "PATCH")).toBeUndefined();
});
