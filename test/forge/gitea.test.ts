import { test, expect } from "bun:test";
import { GiteaForge } from "../../src/forge/gitea";
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
    "GET /api/v1/repos/team/proj/commits/deadbeef/status": { json: { state: "success" } },
  });
  const forge = new GiteaForge("team/proj", CFG, fn);
  const prs = await forge.listPullRequests();
  expect(prs).toEqual([
    {
      number: 9,
      title: "feat: gitea pr",
      url: "https://git.example.com/team/proj/pulls/9",
      author: "carol",
      createdAt: Date.parse("2024-03-03T00:00:00Z"),
      isDraft: false,
      mergeable: true,
      checks: "success",
    },
  ]);
  // list call + one commit-status call
  expect(calls.length).toBe(2);
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
    },
  ]);
  expect(calls[0]!.headers.get("Authorization")).toBe("token secret");
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
