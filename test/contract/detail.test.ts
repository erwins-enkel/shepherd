import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fx from "./detail-fixtures";
import {
  bearer,
  collectEvents,
  coverage,
  HTTP_METHODS,
  loadContract,
  login,
  mintToken,
  restoreAuth,
  startContractServer,
  validateEvent,
  validateResponse,
  validateRequest,
  withAuth,
  type ContractServer,
  type Operation,
} from "./harness";
import { eventsForStream, operationsForStream, streamBlocks } from "./stream-blocks";

const STREAM = "detail";
let s: ContractServer;
let token: string;
/** A session with a REAL worktree directory and a null branch: the diff route then takes
 *  computeDiff's non-isolated short circuit instead of shelling out to git. */
let ok = "";
/** A session whose worktree path does not exist, so git throws and /diff answers 500. */
let broken = "";

async function create(repoPath = s.validRepo): Promise<string> {
  const res = await fetch(`${s.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ repoPath, baseBranch: "main", prompt: "detail" }),
  });
  return ((await res.json()) as { id: string }).id;
}
const get = (path: string) => fetch(`${s.baseUrl}${path}`, { headers: bearer(token) });
const post = (path: string, body?: unknown) =>
  fetch(`${s.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify(body ?? {}),
  });

beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  ({ token } = await mintToken(s, await login(s)));
  broken = await create();

  const worktree = join(s.tmpRoot, "wt-ok");
  mkdirSync(join(worktree, "docs"), { recursive: true });
  writeFileSync(join(worktree, "README.md"), "hi\n");
  const create0 = s.stubs.worktree.create;
  s.stubs.worktree.create = () => ({ worktreePath: worktree, branch: null, isolated: false });
  try {
    ok = await create();
  } finally {
    s.stubs.worktree.create = create0;
  }
  // A non-empty claudeSessionId makes the scratchpad root resolve to the synthetic empty listing
  // instead of 404, and resolveGitState reads worktree.currentBranch, which the shared stub does
  // not define — a missing method would otherwise surface as the /git family's 502.
  s.deps.store.update(ok, { claudeSessionId: "claude-ok" });
  s.stubs.worktree.currentBranch = () => null;
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});

describe("detail: reads", () => {
  test("GET /activity answers a list; an unknown id is 404", async () => {
    const res = await get(`/api/sessions/${ok}/activity`);
    const body = (await validateResponse("GET", "/api/sessions/{id}/activity", res)) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    const missing = await get(`/api/sessions/nope/activity`);
    await validateResponse("GET", "/api/sessions/{id}/activity", missing);
    expect(missing.status).toBe(404);
  });

  test("GET /diff short-circuits for a branchless session, 500s without a worktree, 404s for an unknown id", async () => {
    const res = await get(`/api/sessions/${ok}/diff`);
    const body = (await validateResponse("GET", "/api/sessions/{id}/diff", res)) as {
      head: string | null;
      files: unknown[];
    };
    expect(body.head).toBe(null);
    expect(body.files).toEqual([]);
    const failed = await get(`/api/sessions/${broken}/diff`);
    await validateResponse("GET", "/api/sessions/{id}/diff", failed);
    expect(failed.status).toBe(500);
    const missing = await get(`/api/sessions/nope/diff`);
    await validateResponse("GET", "/api/sessions/{id}/diff", missing);
    expect(missing.status).toBe(404);
  });

  test("GET /diff/annotations degrades to an empty list; an unknown id is 404", async () => {
    const res = await get(`/api/sessions/${broken}/diff/annotations`);
    const body = (await validateResponse("GET", "/api/sessions/{id}/diff/annotations", res)) as {
      notes: unknown[];
    };
    expect(body.notes).toEqual([]);
    const missing = await get(`/api/sessions/nope/diff/annotations`);
    await validateResponse("GET", "/api/sessions/{id}/diff/annotations", missing);
    expect(missing.status).toBe(404);
  });

  test("GET /scratchpad lists the synthetic root; an escaping path is 404", async () => {
    const res = await get(`/api/sessions/${ok}/scratchpad`);
    const body = (await validateResponse("GET", "/api/sessions/{id}/scratchpad", res)) as {
      parent: string | null;
    };
    expect(body.parent).toBe(null);
    const bad = await get(`/api/sessions/${ok}/scratchpad?path=../escape`);
    await validateResponse("GET", "/api/sessions/{id}/scratchpad", bad);
    expect(bad.status).toBe(404);
  });

  test("GET /worktree lists a real directory and descends into it", async () => {
    const root = await get(`/api/sessions/${ok}/worktree`);
    const body = (await validateResponse("GET", "/api/sessions/{id}/worktree", root)) as {
      entries: { name: string }[];
    };
    expect(body.entries.map((e) => e.name).sort()).toEqual(["README.md", "docs"]);
    const child = await get(`/api/sessions/${ok}/worktree?path=docs`);
    await validateResponse("GET", "/api/sessions/{id}/worktree", child);
    expect(child.status).toBe(200);
  });

  test("GET /worktree is 404 for an unknown id", async () => {
    const missing = await get(`/api/sessions/nope/worktree`);
    await validateResponse("GET", "/api/sessions/{id}/worktree", missing);
    expect(missing.status).toBe(404);
  });
});

describe("detail: git", () => {
  const actions = ["pr", "merge", "ready", "draft", "close"] as const;

  test("every git route 404s while no forge is configured", async () => {
    for (const path of ["git", "git/reviewers"]) {
      const res = await get(`/api/sessions/${ok}/${path}`);
      await validateResponse("GET", `/api/sessions/{id}/${path}`, res);
      expect(res.status).toBe(404);
    }
    for (const action of [...actions, "request-review"]) {
      const res = await post(`/api/sessions/${ok}/git/${action}`, {
        prNumber: 12,
        reviewer: "octocat",
      });
      await validateResponse("POST", `/api/sessions/{id}/git/${action}`, res);
      expect(res.status, action).toBe(404);
    }
  });

  test("an open PR answers 200 everywhere", async () => {
    s.deps.resolveForge = () => fx.makeForge();
    try {
      const state = await get(`/api/sessions/${ok}/git`);
      const git = (await validateResponse("GET", "/api/sessions/{id}/git", state)) as {
        kind: string;
        state: string;
      };
      expect(git.kind).toBe("github");
      expect(git.state).toBe("open");
      for (const action of actions) {
        const res = await post(`/api/sessions/${ok}/git/${action}`);
        await validateResponse("POST", `/api/sessions/{id}/git/${action}`, res);
        expect(res.status, action).toBe(200);
      }
      const reviewers = await get(`/api/sessions/${ok}/git/reviewers`);
      const options = (await validateResponse(
        "GET",
        "/api/sessions/{id}/git/reviewers",
        reviewers,
      )) as { logins: string[] };
      expect(options.logins).toContain("octocat");
      const requested = await post(`/api/sessions/${ok}/git/request-review`, {
        prNumber: 12,
        reviewer: "octocat",
      });
      const ack = (await validateResponse(
        "POST",
        "/api/sessions/{id}/git/request-review",
        requested,
      )) as { ok: boolean };
      expect(ack.ok).toBe(true);
    } finally {
      delete s.deps.resolveForge;
    }
  });

  test("manual merge validates the displayed target, revision and configured takeover", async () => {
    const savedForge = s.deps.resolveForge;
    const savedRoles = s.deps.readRoles;
    const repo = join(s.tmpRoot, "takeover-repo");
    const roles = { reviewer: "reviewer", merger: "owner" };
    mkdirSync(join(repo, ".shepherd"), { recursive: true });
    writeFileSync(join(repo, ".shepherd/roles.json"), JSON.stringify(roles));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
    git("init", "-q", "-b", "main");
    git("add", ".shepherd/roles.json");
    git(
      "-c",
      "user.name=Contract Test",
      "-c",
      "user.email=contract@test.local",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture roles",
    );
    const calls: { number: number; options: unknown }[] = [];
    const id = await create(repo);
    s.deps.readRoles = () => roles;
    s.deps.resolveForge = () =>
      fx.makeForge({
        currentUser: async () => "operator",
        prStatus: async () => fx.takeoverStatus,
        merge: async (number: number, options: unknown) => {
          calls.push({ number, options });
        },
      });
    const template = "/api/sessions/{id}/git/merge";
    const invoke = async (confirm?: unknown) => {
      const request = confirm === undefined ? {} : { confirm };
      validateRequest("POST", template, request);
      const res = await post(`/api/sessions/${id}/git/merge`, request);
      return { status: res.status, body: await validateResponse("POST", template, res) };
    };
    try {
      const response = await get(`/api/sessions/${id}/git`);
      const state = await validateResponse("GET", "/api/sessions/{id}/git", response);
      expect(response.status).toBe(200);
      expect(state).toMatchObject({
        baseRefName: "release",
        headSha: "head-a",
        checks: "pending",
        mergeGate: { handoff: "reviewer", handoffWho: "reviewer", reviewBlockBy: "reviewer" },
      });
      expect(state).not.toHaveProperty("handoff");
      const missing = await invoke();
      expect(missing.status).toBe(409);
      expect(missing.body).toMatchObject({
        code: "merge_confirm_required",
        headSha: "head-a",
        baseRefName: "release",
        gate: {
          handoff: "reviewer",
          handoffWho: "reviewer",
          reviewBlockBy: "reviewer",
          requiresConfirm: true,
        },
      });
      expect((await invoke({})).status).toBe(409);
      expect(
        (
          await invoke({
            headSha: null,
            baseRefName: null,
            handoff: null,
            handoffWho: null,
            reviewBlockBy: null,
          })
        ).status,
      ).toBe(409);
      for (const drift of [
        { headSha: "head-old" },
        { baseRefName: "main" },
        { handoffWho: "previous-reviewer" },
        { reviewBlockBy: "previous-reviewer" },
      ]) {
        const stale = await invoke({ ...fx.takeoverConfirm, ...drift });
        expect(stale.status).toBe(409);
        expect(stale.body).toMatchObject({ code: "merge_confirm_stale" });
      }
      expect(calls).toEqual([]);
      const frames = await collectEvents(s, token, async () => {
        const accepted = await invoke(fx.takeoverConfirm);
        expect(accepted.status).toBe(200);
        expect(accepted.body).toMatchObject({ headSha: "head-a", baseRefName: "release" });
      });
      const frame = frames.find((f) => f.event === "session:git");
      expect(frame).toBeDefined();
      validateEvent("session:git", frame!.data);
      expect(frame!.data).toMatchObject({
        id,
        git: {
          mergeGate: {
            handoff: "reviewer",
            handoffWho: "reviewer",
            reviewBlockBy: "reviewer",
          },
          baseRefName: "release",
        },
      });
      expect(calls).toEqual([
        {
          number: 12,
          options: {
            method: "squash",
            deleteBranch: true,
            allowStacked: true,
            expectedHeadSha: "head-a",
          },
        },
      ]);
      expect(() =>
        validateRequest("POST", template, { confirm: { handoff: "future-role" } }),
      ).toThrow();
      expect(() =>
        validateRequest("POST", template, { confirm: { requiresConfirm: true } }),
      ).toThrow();
    } finally {
      s.deps.resolveForge = savedForge;
      s.deps.readRoles = savedRoles;
      delete s.stubs.prCache.rows[id];
    }
  });

  test("no open PR is 409 everywhere it matters", async () => {
    s.deps.resolveForge = () => fx.noPrForge();
    try {
      for (const action of ["merge", "ready", "draft", "close"]) {
        const res = await post(`/api/sessions/${ok}/git/${action}`);
        await validateResponse("POST", `/api/sessions/{id}/git/${action}`, res);
        expect(res.status, action).toBe(409);
      }
      const reviewers = await get(`/api/sessions/${ok}/git/reviewers`);
      const body = (await validateResponse(
        "GET",
        "/api/sessions/{id}/git/reviewers",
        reviewers,
      )) as { code: string };
      expect(reviewers.status).toBe(409);
      expect(body.code).toBe("review_request_stale");
      const review = await post(`/api/sessions/${ok}/git/request-review`, {
        prNumber: 12,
        reviewer: "octocat",
      });
      await validateResponse("POST", "/api/sessions/{id}/git/request-review", review);
      expect(review.status).toBe(409);
    } finally {
      delete s.deps.resolveForge;
    }
  });

  test("an empty diff is 409 on /git/pr", async () => {
    s.deps.resolveForge = () => fx.emptyDiffForge();
    try {
      const res = await post(`/api/sessions/${ok}/git/pr`);
      await validateResponse("POST", "/api/sessions/{id}/git/pr", res);
      expect(res.status).toBe(409);
    } finally {
      delete s.deps.resolveForge;
    }
  });

  test("a forge that throws is 502", async () => {
    s.deps.resolveForge = () => fx.angryForge();
    try {
      const state = await get(`/api/sessions/${ok}/git`);
      await validateResponse("GET", "/api/sessions/{id}/git", state);
      expect(state.status).toBe(502);
      for (const action of actions) {
        const res = await post(`/api/sessions/${ok}/git/${action}`);
        await validateResponse("POST", `/api/sessions/{id}/git/${action}`, res);
        expect(res.status, action).toBe(502);
      }
      const reviewers = await get(`/api/sessions/${ok}/git/reviewers`);
      await validateResponse("GET", "/api/sessions/{id}/git/reviewers", reviewers);
      expect(reviewers.status).toBe(502);
      // request-review answers 502 through the same reviewRequestError() as /git/reviewers, and
      // the contract has to declare it: undeclared, a plain forge outage reaches a generated
      // client as an undocumented status and reads as a contract mismatch.
      const review = await post(`/api/sessions/${ok}/git/request-review`, {
        prNumber: 12,
        reviewer: "octocat",
      });
      const body = (await validateResponse(
        "POST",
        "/api/sessions/{id}/git/request-review",
        review,
      )) as { code: string };
      expect(review.status).toBe(502);
      expect(body.code).toBe("review_request_failed");
    } finally {
      delete s.deps.resolveForge;
    }
  });

  test("a forge missing one PR-mutation capability is 400 on just that action", async () => {
    s.deps.resolveForge = () => fx.noClosePrForge();
    try {
      const res = await post(`/api/sessions/${ok}/git/close`);
      await validateResponse("POST", "/api/sessions/{id}/git/close", res);
      expect(res.status).toBe(400);
    } finally {
      delete s.deps.resolveForge;
    }
    s.deps.resolveForge = () => fx.noMarkReadyForDraftForge();
    try {
      const res = await post(`/api/sessions/${ok}/git/draft`);
      await validateResponse("POST", "/api/sessions/{id}/git/draft", res);
      expect(res.status).toBe(400);
    } finally {
      delete s.deps.resolveForge;
    }
    s.deps.resolveForge = () => fx.noMarkReadyForge();
    try {
      const res = await post(`/api/sessions/${ok}/git/ready`);
      await validateResponse("POST", "/api/sessions/{id}/git/ready", res);
      expect(res.status).toBe(400);
    } finally {
      delete s.deps.resolveForge;
    }
  });

  test("the host's review-request refusal maps to 403, an invalid reviewer to 422", async () => {
    s.deps.resolveForge = () => fx.forbiddenReviewForge();
    try {
      const res = await post(`/api/sessions/${ok}/git/request-review`, {
        prNumber: 12,
        reviewer: "octocat",
      });
      const body = (await validateResponse(
        "POST",
        "/api/sessions/{id}/git/request-review",
        res,
      )) as { code: string };
      expect(res.status).toBe(403);
      expect(body.code).toBe("review_request_forbidden");
    } finally {
      delete s.deps.resolveForge;
    }
    s.deps.resolveForge = () => fx.invalidReviewerForge();
    try {
      const res = await post(`/api/sessions/${ok}/git/request-review`, {
        prNumber: 12,
        reviewer: "octocat",
      });
      const body = (await validateResponse(
        "POST",
        "/api/sessions/{id}/git/request-review",
        res,
      )) as { code: string };
      expect(res.status).toBe(422);
      expect(body.code).toBe("review_request_invalid_reviewer");
    } finally {
      delete s.deps.resolveForge;
    }
  });

  test("a forge that cannot request reviews is 400", async () => {
    s.deps.resolveForge = () => fx.makeForge({ kind: "local", requestReview: undefined });
    try {
      const reviewers = await get(`/api/sessions/${ok}/git/reviewers`);
      const body = (await validateResponse(
        "GET",
        "/api/sessions/{id}/git/reviewers",
        reviewers,
      )) as { code: string };
      expect(reviewers.status).toBe(400);
      expect(body.code).toBe("review_request_unsupported");
      const review = await post(`/api/sessions/${ok}/git/request-review`, {
        prNumber: 12,
        reviewer: "octocat",
      });
      await validateResponse("POST", "/api/sessions/{id}/git/request-review", review);
      expect(review.status).toBe(400);
    } finally {
      delete s.deps.resolveForge;
    }
  });
});

describe("detail: events", () => {
  test("typed fixtures for session:git and session:activity match the contract", async () => {
    const emits: [string, unknown][] = [
      ["session:git", fx.gitEvent],
      ["session:git", fx.reviewBlockedGitEvent],
      ["session:git", fx.undatedReviewBlockedGitEvent],
      ["session:activity", fx.activityEvent],
    ];
    const frames = await collectEvents(s, token, async () => {
      for (const [name, data] of emits) s.deps.events.emit(name, data);
    });
    for (const [name, data] of emits) {
      const seen = frames.find(
        (f) => f.event === name && JSON.stringify(f.data) === JSON.stringify(data),
      );
      expect(seen, `frame ${name} not received`).toBeTruthy();
      validateEvent(name, seen!.data);
    }
  });
});

describe("detail: unauthenticated sweep", () => {
  test("every detail route rejects a credential-less request with 401", async () => {
    for (const template of streamBlocks().paths.get(STREAM)!) {
      for (const [method, op] of Object.entries(loadContract().paths[template]!)) {
        if (!HTTP_METHODS.includes(method as never)) continue;
        if (!(op as Operation).responses["401"]) continue;
        const init: RequestInit = { method: method.toUpperCase() };
        if (method === "post") {
          init.headers = { "content-type": "application/json" };
          init.body = "{}";
        }
        const res = await fetch(`${s.baseUrl}${template.replace(/\{[^}]+\}/g, "x")}`, init);
        await validateResponse(method.toUpperCase(), template, res);
        expect(res.status, `${method} ${template}`).toBe(401);
      }
    }
  });
});

// Stays the LAST describe in this file: it gates everything above it, and only its own block —
// `openapi.test.ts`'s gate covers everything outside every stream's markers, so the two never
// double-count and neither is ever edited by this stream.
describe("detail: coverage gate", () => {
  test("every operation and event in the detail block was exercised", () => {
    const { operations, events } = coverage();
    expect(operationsForStream(STREAM).filter((o) => !operations.has(o))).toEqual([]);
    expect(eventsForStream(STREAM).filter((e) => !events.has(e))).toEqual([]);
  });
});
