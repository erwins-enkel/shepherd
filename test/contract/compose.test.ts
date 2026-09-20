import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { clearBranchStatusCacheForTests } from "../../src/server";
import * as fx from "./compose-fixtures";
import {
  bearer,
  coverage,
  login,
  loadContract,
  mintToken,
  restoreAuth,
  startContractServer,
  validateResponse,
  withAuth,
  type ContractServer,
} from "./harness";
import { eventsForStream, operationsForStream } from "./stream-blocks";

const OPERATIONS = operationsForStream("compose");
const EVENTS = eventsForStream("compose");
let s: ContractServer;
let token: string;
async function get(path: string, auth = true): Promise<Response> {
  return fetch(`${s.baseUrl}${path}`, { headers: auth ? bearer(token) : {} });
}
beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  ({ token } = await mintToken(s, await login(s), "compose contract test"));
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});

describe("issues", () => {
  test("answers the listing with the viewer, and 400 on a repo outside the root", async () => {
    s.stubs.resolveForge.forge = fx.fakeForge();
    try {
      const ok = await get(`/api/issues?repo=${encodeURIComponent(s.validRepo)}`);
      expect(ok.status).toBe(200);
      const body = (await validateResponse("GET", "/api/issues", ok)) as {
        slug: string | null;
        issues: unknown[];
        viewer: string | null;
        lightweight?: boolean;
      };
      expect(body.slug).toBe("owner/repo");
      expect(body.issues.length).toBe(4);
      // `viewer` is what the "mine & unassigned" filter fails open on when null, so it is
      // asserted rather than assumed.
      expect(body.viewer).toBe("operator");
      expect(body.lightweight).toBe(false);
    } finally {
      s.stubs.resolveForge.forge = null;
    }

    // A repo path outside config.repoRoot is the only 400 this route has.
    const bad = await get("/api/issues?repo=/etc");
    expect(bad.status).toBe(400);
    await validateResponse("GET", "/api/issues", bad);
  });

  test("a repo with no forge is a 200 empty listing, not an error", async () => {
    // resolveForge returns null by default in the harness, which is exactly the real
    // "this repo has no GitHub upstream" case the picker shows `promptsources_no_github` for.
    const ok = await get(`/api/issues?repo=${encodeURIComponent(s.validRepo)}`);
    expect(ok.status).toBe(200);
    const body = (await validateResponse("GET", "/api/issues", ok)) as {
      slug: string | null;
      issues: unknown[];
    };
    expect(body.slug).toBeNull();
    expect(body.issues).toEqual([]);
  });

  test("a throwing listing answers 200 with error: fetch_failed", async () => {
    s.stubs.resolveForge.forge = fx.fakeForge({
      listIssues: async () => {
        throw new Error("rate limited");
      },
    });
    try {
      const ok = await get(`/api/issues?repo=${encodeURIComponent(s.validRepo)}`);
      // NEVER a 5xx: the picker renders `common_issues_load_failed` from this body, and a
      // client that treated it as a transport failure would show the wrong message.
      expect(ok.status).toBe(200);
      const body = (await validateResponse("GET", "/api/issues", ok)) as { error?: string };
      expect(body.error).toBe("fetch_failed");
    } finally {
      s.stubs.resolveForge.forge = null;
    }
  });

  test("401 without a credential", async () => {
    const anon = await get(`/api/issues?repo=${encodeURIComponent(s.validRepo)}`, false);
    expect(anon.status).toBe(401);
    await validateResponse("GET", "/api/issues", anon);
  });
});

describe("commands", () => {
  test("answers a list, 400 on a bad provider, and 401", async () => {
    // No dep to seed: handleCommands reads the real filesystem (the repo dir, ~/.claude,
    // $CODEX_HOME). An empty list is a legitimate answer and the schema must allow it.
    const ok = await get(`/api/commands?repo=${encodeURIComponent(s.validRepo)}&provider=claude`);
    expect(ok.status).toBe(200);
    const body = (await validateResponse("GET", "/api/commands", ok)) as { commands: unknown[] };
    expect(Array.isArray(body.commands)).toBe(true);

    const bad = await get(`/api/commands?repo=${encodeURIComponent(s.validRepo)}&provider=nope`);
    expect(bad.status).toBe(400);
    await validateResponse("GET", "/api/commands", bad);

    const anon = await get("/api/commands", false);
    expect(anon.status).toBe(401);
    await validateResponse("GET", "/api/commands", anon);
  });
});

describe("create from an issue", () => {
  test("a create carrying issueRef is accepted and the session records it", async () => {
    const res = await fetch(`${s.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({
        repoPath: s.validRepo,
        baseBranch: "main",
        prompt: "Bearbeite Issue #412: Rate-limit the admin route",
        issueRef: {
          number: 412,
          url: "https://example.test/i/412",
          title: "Rate-limit the admin route",
          body: "The admin route bypasses the limiter entirely.",
        },
      }),
    });
    expect(res.status).toBe(201);
    const session = (await res.json()) as { id: string; issueNumber: number | null };
    // The whole point of the field: the session remembers which issue it came from, which is
    // what the row's issue badge and the drain's claim label read.
    expect(session.issueNumber).toBe(412);
  });
});

describe("epics", () => {
  test("non-empty epics match the actual emitter payload", async () => {
    const previousDrain = s.deps.drain;
    // This list route only checks drain presence; it never invokes a drain method.
    s.deps.drain = {} as NonNullable<typeof s.deps.drain>;
    s.stubs.resolveForge.forge = fx.fakeForge({
      listSubIssueSummaries: async () => ({
        summaries: new Map([[412, { total: 2, completed: 0 }]]),
        subIssueNumbers: [413, 414],
        childrenByParent: new Map([[412, [413, 414]]]),
      }),
    });
    try {
      const ok = await get(`/api/epics?repo=${encodeURIComponent(s.validRepo)}`);
      expect(ok.status).toBe(200);
      expect(await validateResponse("GET", "/api/epics", ok)).toEqual(fx.epicListing);
    } finally {
      s.deps.drain = previousDrain;
      s.stubs.resolveForge.forge = null;
    }
  });

  test("answers an empty listing without a drain, 400 on an invalid repo, and 401", async () => {
    const ok = await get(`/api/epics?repo=${encodeURIComponent(s.validRepo)}`);
    expect(ok.status).toBe(200);
    expect(await validateResponse("GET", "/api/epics", ok)).toEqual({ epics: [], subIssues: [] });
    const bad = await get("/api/epics?repo=/etc");
    expect(bad.status).toBe(400);
    await validateResponse("GET", "/api/epics", bad);
    const anon = await get(`/api/epics?repo=${encodeURIComponent(s.validRepo)}`, false);
    expect(anon.status).toBe(401);
    await validateResponse("GET", "/api/epics", anon);
  });
});

describe("repo and base branch", () => {
  test("the repair request schema rejects unknown keys instead of accepting branch typos", () => {
    const validate = new Ajv2020({ strict: false }).compile(
      loadContract().components.schemas.InitEmptyCommitRequest as object,
    );
    expect(validate({ repo: "/repo" })).toBe(true);
    expect(validate({ repo: "/repo", branch: "trunk" })).toBe(true);
    expect(validate({ repo: "/repo", brnach: "trunk" })).toBe(false);
  });

  test("lists an unborn repo, rejects an invalid repo, and requires auth", async () => {
    const ok = await get(`/api/branches?repo=${encodeURIComponent(s.validRepo)}`);
    expect(ok.status).toBe(200);
    expect(await validateResponse("GET", "/api/branches", ok)).toEqual({
      branches: [],
      current: null,
      default: null,
    });
    const bad = await get("/api/branches?repo=/etc");
    expect(bad.status).toBe(400);
    expect(await validateResponse("GET", "/api/branches", bad)).toEqual({ error: "invalid repo" });
    const anon = await get("/api/branches", false);
    expect(anon.status).toBe(401);
    await validateResponse("GET", "/api/branches", anon);
  });

  test("checks a local commitless repo without a remote, both 400 reasons, and 401", async () => {
    clearBranchStatusCacheForTests();
    try {
      const ok = await get(
        `/api/branch-status?repo=${encodeURIComponent(s.validRepo)}&branch=main`,
      );
      expect(ok.status).toBe(200);
      expect(await validateResponse("GET", "/api/branch-status", ok)).toEqual({
        behind: 0,
        ahead: 0,
        diverged: false,
        hasUpstream: false,
        localExists: false,
      });
      for (const [query, error] of [
        ["repo=/etc&branch=main", "invalid repo"],
        [`repo=${encodeURIComponent(s.validRepo)}&branch=-bad`, "invalid branch"],
      ]) {
        clearBranchStatusCacheForTests();
        const bad = await get(`/api/branch-status?${query}`);
        expect(bad.status).toBe(400);
        expect(await validateResponse("GET", "/api/branch-status", bad)).toEqual({ error });
      }
      const anon = await get("/api/branch-status", false);
      expect(anon.status).toBe(401);
      await validateResponse("GET", "/api/branch-status", anon);
    } finally {
      clearBranchStatusCacheForTests();
    }
  });

  test("repairs only the harness repo and covers invalid repo, invalid branch, and auth", async () => {
    const post = (repo: string, branch: string, auth = true) =>
      fetch(`${s.baseUrl}/api/repos/init-empty-commit`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? bearer(token) : {}) },
        body: JSON.stringify({ repo, branch }),
      });
    for (const [repo, branch, status, error] of [
      ["/etc", "main", 400, "invalid repo"],
      [s.validRepo, "-bad", 422, "invalid branch"],
    ] as const) {
      const bad = await post(repo, branch);
      expect(bad.status).toBe(status);
      expect(await validateResponse("POST", "/api/repos/init-empty-commit", bad)).toEqual({
        error,
      });
    }
    const anon = await post(s.validRepo, "main", false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/repos/init-empty-commit", anon);
    try {
      const ok = await post(s.validRepo, "main");
      expect(ok.status).toBe(200);
      expect(await validateResponse("POST", "/api/repos/init-empty-commit", ok)).toEqual({
        branch: "main",
      });
      clearBranchStatusCacheForTests();
      const status = await get(
        `/api/branch-status?repo=${encodeURIComponent(s.validRepo)}&branch=main`,
      );
      expect(status.status).toBe(200);
      expect(await validateResponse("GET", "/api/branch-status", status)).toEqual({
        behind: 0,
        ahead: 0,
        diverged: false,
        hasUpstream: false,
        localExists: true,
      });
      const branches = await get(`/api/branches?repo=${encodeURIComponent(s.validRepo)}`);
      expect(await validateResponse("GET", "/api/branches", branches)).toEqual({
        branches: ["main"],
        current: "main",
        default: null,
      });
    } finally {
      clearBranchStatusCacheForTests();
    }
  });
});

describe("uploads", () => {
  const form = () => {
    const body = new FormData();
    body.append("file", new File(["attachment bytes"], "original.txt", { type: "text/plain" }));
    return body;
  };
  const upload = (body: FormData, query = "", auth = true) =>
    fetch(`${s.baseUrl}/api/uploads${query}`, {
      method: "POST",
      headers: auth ? bearer(token) : {},
      body,
    });

  test("multipart file stages exact bytes and returns an absolute path", async () => {
    const response = await upload(form());
    expect(response.status).toBe(200);
    const body = (await validateResponse("POST", "/api/uploads", response)) as { path: string };
    expect(isAbsolute(body.path)).toBe(true);
    expect(readFileSync(body.path, "utf8")).toBe("attachment bytes");
  });

  test("missing file is 400, a tiny seam exercises 413, optional unknown session is 404, and auth is required", async () => {
    const missing = await upload(new FormData());
    expect(missing.status).toBe(400);
    expect(await validateResponse("POST", "/api/uploads", missing)).toEqual({
      error: "missing file field",
    });
    s.setMaxUploadBytes(2);
    try {
      const large = await upload(form());
      expect(large.status).toBe(413);
      expect(await validateResponse("POST", "/api/uploads", large)).toEqual({
        error: "file too large",
      });
    } finally {
      s.setMaxUploadBytes(undefined);
    }
    const unknown = await upload(form(), "?session=does-not-exist");
    expect(unknown.status).toBe(404);
    expect(await validateResponse("POST", "/api/uploads", unknown)).toEqual({
      error: "unknown session",
    });
    const anon = await upload(form(), "", false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/uploads", anon);
  });
});

describe("shaping round", () => {
  async function post(path: string, body: unknown, auth = true) {
    return fetch(`${s.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? bearer(token) : {}) },
      body: JSON.stringify(body),
    });
  }
  const request = () => ({
    repoPath: s.validRepo,
    prompt: "Add limits",
    provider: "codex",
    model: null,
  });

  test("200 carries the shared question form and accepts a default model", async () => {
    s.stubs.shapeTask.impl = async (...args: unknown[]) => {
      expect(args).toEqual([s.validRepo, "Add limits", "codex", null]);
      return fx.shapeRound;
    };
    try {
      const res = await post("/api/shape", request());
      expect(res.status).toBe(200);
      expect(await validateResponse("POST", "/api/shape", res)).toEqual(fx.shapeRound);
    } finally {
      s.stubs.shapeTask.impl = null;
    }
  });

  test("both 400 reasons, all four 422 slugs, unwired 503, and 401", async () => {
    for (const [body, error] of [
      [
        { ...request(), provider: "invalid" },
        "body must be {repoPath, prompt, provider: 'claude'|'codex', model?: string}",
      ],
      [{ ...request(), repoPath: "/etc" }, "invalid repo"],
    ] as const) {
      const res = await post("/api/shape", body);
      expect(res.status).toBe(400);
      expect(await validateResponse("POST", "/api/shape", res)).toEqual({ error });
    }
    for (const error of ["empty-prompt", "spawn-failed", "timeout", "unavailable"] as const) {
      s.stubs.shapeTask.impl = async () => ({ error });
      try {
        const res = await post("/api/shape", request());
        expect(res.status).toBe(422);
        expect(await validateResponse("POST", "/api/shape", res)).toEqual({ error });
      } finally {
        s.stubs.shapeTask.impl = null;
      }
    }
    const previous = s.deps.shapeTask;
    s.deps.shapeTask = undefined;
    try {
      const res = await post("/api/shape", request());
      expect(res.status).toBe(503);
      expect(await validateResponse("POST", "/api/shape", res)).toEqual({ error: "unavailable" });
    } finally {
      s.deps.shapeTask = previous;
    }
    const anon = await post("/api/shape", request(), false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/shape", anon);
  });

  test("brief resolves answers, supports draft-only rounds, rejects an invalid round, and requires auth", async () => {
    const answers = [
      { blockId: "shape-questions", questionId: "scope", optionIndices: [0] },
      { blockId: "shape-questions", questionId: "checks", optionIndices: [] },
      { blockId: "shape-questions", questionId: "detail", text: "Preserve latency" },
      { blockId: "wrong-block", questionId: "detail", text: "UNTRUSTED" },
    ];
    const res = await post("/api/shape/brief", { ...fx.shapeRound, answers });
    expect(res.status).toBe(200);
    const body = (await validateResponse("POST", "/api/shape/brief", res)) as { brief: string };
    expect(body.brief).toContain("Missing limits");
    expect(body.brief).toContain("Admin");
    expect(body.brief).toContain("Preserve latency");
    expect(body.brief).not.toContain("UNTRUSTED");
    const draftOnly = await post("/api/shape/brief", {
      ...fx.shapeRound,
      block: { ...fx.shapeRound.block, questions: [] },
      answers: [],
    });
    expect(draftOnly.status).toBe(200);
    await validateResponse("POST", "/api/shape/brief", draftOnly);
    const bad = await post("/api/shape/brief", {});
    expect(bad.status).toBe(400);
    expect(await validateResponse("POST", "/api/shape/brief", bad)).toEqual({
      error: "invalid round",
    });
    const anon = await post("/api/shape/brief", fx.shapeRound, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/shape/brief", anon);
  });
});

describe("compose coverage gate", () => {
  test("every compose operation and event was exercised", () => {
    const { operations, events } = coverage();
    expect(OPERATIONS.filter((o) => !operations.has(o))).toEqual([]);
    expect(EVENTS.filter((e) => !events.has(e))).toEqual([]);
  });
});
