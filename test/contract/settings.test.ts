import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  bearer,
  collectEvents,
  coverage,
  login,
  mintToken,
  restoreAuth,
  startContractServer,
  validateEvent,
  validateResponse,
  withAuth,
  type ContractServer,
} from "./harness";
import { operationsForStream, eventsForStream } from "./stream-blocks";
import { config } from "../../src/config";
import { firstRun } from "../../src/first-run";
import { diagnostic } from "./settings-fixtures";
let s: ContractServer, token: string, cookie: string;
const OPS = operationsForStream("settings"),
  EVENTS = eventsForStream("settings");
async function request(
  method: string,
  template: string,
  status: number,
  body?: unknown,
  path = template,
  headers: Record<string, string> = bearer(token),
) {
  const res = await fetch(s.baseUrl + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(res.status, `${method} ${path}`).toBe(status);
  return await validateResponse(method, template, res);
}
beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  cookie = await login(s);
  ({ token } = await mintToken(s, cookie, "settings contract"));
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});
test("repo config, role no-op, push refusal and collaborator fallback", async () => {
  const query = `?repo=${encodeURIComponent(s.validRepo)}`;
  for (const path of ["/api/repo-config", "/api/repo-roles", "/api/repo-collaborators"]) {
    await request("GET", path, 200, undefined, path + query);
    await request("GET", path, 400, undefined, path + "?repo=/outside");
  }
  const cfg = (await request(
    "PUT",
    "/api/repo-config",
    200,
    { hidden: true },
    "/api/repo-config" + query,
  )) as { hidden: boolean };
  expect(cfg.hidden).toBe(true);
  await request("PUT", "/api/repo-config", 400, { maxAuto: "many" }, "/api/repo-config" + query);
  await request(
    "PUT",
    "/api/repo-roles",
    200,
    { reviewer: null, merger: null },
    "/api/repo-roles" + query,
  );
  await request("PUT", "/api/repo-roles", 400, null, "/api/repo-roles" + query);
  const saved = s.stubs.resolveForge.forge;
  try {
    s.stubs.resolveForge.forge = null;
    const failed = (await request(
      "PUT",
      "/api/repo-roles",
      502,
      { reviewer: "operator", merger: null },
      "/api/repo-roles" + query,
    )) as { pushError: string };
    expect(failed.pushError).toBe("push rejected");
  } finally {
    s.stubs.resolveForge.forge = saved;
  }
});
test("diagnostics current, refresh, fix and all refusal statuses", async () => {
  const saved = s.deps.diagnostics;
  let currentCalls = 0,
    checkCalls = 0;
  try {
    s.deps.diagnostics = {
      current: async () => {
        currentCalls++;
        return diagnostic;
      },
      check: async () => {
        checkCalls++;
        return diagnostic;
      },
      fix: async (id: string) => {
        if (id === "unknown") throw new Error("unknown check unknown");
        if (id === "broken") throw new Error("fixture failure");
        return diagnostic;
      },
    } as never;
    expect(await request("GET", "/api/diagnostics", 200)).toEqual(diagnostic);
    await request("GET", "/api/diagnostics", 200, undefined, "/api/diagnostics?refresh=1");
    expect(currentCalls).toBe(1);
    expect(checkCalls).toBe(1);
    const frames = await collectEvents(s, token, async () => {
      await request("POST", "/api/diagnostics/fix", 200, { checkId: "bun" });
    });
    const frame = frames.find((f) => f.event === "diagnostics:status");
    expect(frame).toBeDefined();
    validateEvent("diagnostics:status", frame!.data);
    expect(frame!.data).toEqual(diagnostic);
    await request("POST", "/api/diagnostics/fix", 400, {});
    await request("POST", "/api/diagnostics/fix", 409, { checkId: "unknown" });
    await request("POST", "/api/diagnostics/fix", 502, { checkId: "broken" });
    s.deps.diagnostics = undefined;
    await request("POST", "/api/diagnostics/fix", 503, { checkId: "bun" });
  } finally {
    s.deps.diagnostics = saved;
  }
});
test("verify-key is transient work and has no 400 branch", async () => {
  const saved = s.deps.verifyKey,
    pending = firstRun.pending;
  try {
    firstRun.pending = false;
    s.deps.verifyKey = async () => ({ ok: true });
    expect(await request("POST", "/api/settings/verify-key", 200)).toEqual({ ok: true });
    s.deps.verifyKey = undefined;
    await request("POST", "/api/settings/verify-key", 503);
    firstRun.pending = true;
    await request("POST", "/api/settings/verify-key", 409);
  } finally {
    s.deps.verifyKey = saved;
    firstRun.pending = pending;
  }
});
test("directory traversal is clamped rather than 400", async () => {
  const dirs = (await request(
    "GET",
    "/api/fs/dirs",
    200,
    undefined,
    "/api/fs/dirs?path=/outside",
  )) as { path: string; parent: string | null };
  expect(dirs.path).toBe(s.tmpRoot);
  expect(dirs.parent).toBeNull();
});
test("pull uses a temporary local bare remote, never the operator checkout", async () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const remote = join(s.tmpRoot, "remote.git");
  git(s.tmpRoot, "init", "--bare", remote);
  git(s.validRepo, "init", "-b", "main");
  git(
    s.validRepo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "seed",
  );
  git(s.validRepo, "remote", "add", "origin", remote);
  git(s.validRepo, "push", "-u", "origin", "main");
  const p = "/api/repos/pull";
  const body = { repo: s.validRepo, branch: "main" };
  const ok = (await request("POST", p, 200, body)) as { ok: boolean; updated: boolean };
  expect(ok.ok).toBe(true);
  expect(ok.updated).toBe(false);
  git(s.validRepo, "checkout", "-b", "feature");
  const refused = (await request("POST", p, 409, body)) as { reason: string };
  expect(refused.reason).toBe("wrong_branch");
  git(s.validRepo, "checkout", "main");
  git(s.validRepo, "remote", "set-url", "origin", join(s.tmpRoot, "missing.git"));
  const failed = (await request("POST", p, 502, body)) as { ok: boolean };
  expect(failed.ok).toBe(false);
  await request("POST", p, 400, { repo: "/outside" });
});
test("fork reports 201, rejects targets, existing directories and runner failures", async () => {
  const saved = s.deps.newProjectGhRunner,
    pending = firstRun.pending;
  try {
    firstRun.pending = false;
    const calls: string[][] = [];
    s.deps.newProjectGhRunner = async (args) => {
      calls.push(args);
    };
    const r = (await request("POST", "/api/repos/fork", 201, { target: "fixture/new-repo" })) as {
      name: string;
    };
    expect(r.name).toBe("new-repo");
    expect(calls[1]?.slice(0, 2)).toEqual(["repo", "fork"]);
    await request("POST", "/api/repos/fork", 400, { target: "invalid" });
    await request("POST", "/api/repos/fork", 409, { target: "fixture/repo" });
    s.deps.newProjectGhRunner = async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    await request("POST", "/api/repos/fork", 422, { target: "fixture/new-repo" });
    s.deps.newProjectGhRunner = async (args) => {
      if (args[0] === "repo") throw Object.assign(new Error("timeout"), { code: "_timeout" });
    };
    await request("POST", "/api/repos/fork", 504, { target: "fixture/new-repo" });
    firstRun.pending = true;
    await request("POST", "/api/repos/fork", 409, { target: "fixture/new-repo" });
  } finally {
    s.deps.newProjectGhRunner = saved;
    firstRun.pending = pending;
  }
});
test("sync-fork errors differ from best-effort local pull", async () => {
  const saved = s.stubs.resolveForge.forge;
  const p = "/api/repos/sync-fork",
    body = { repo: s.validRepo };
  try {
    s.stubs.resolveForge.forge = null;
    await request("POST", p, 400, body);
    s.stubs.resolveForge.forge = {
      isFork: true,
      syncFork: async () => {},
      defaultBranch: async () => "main",
    };
    expect(await request("POST", p, 200, body)).toEqual({ ok: true, branch: "main" });
    s.stubs.resolveForge.forge = {
      isFork: true,
      syncFork: async () => {
        throw new Error("diverged");
      },
    };
    await request("POST", p, 409, body);
    s.stubs.resolveForge.forge = {
      isFork: true,
      syncFork: async () => {
        throw new Error("authentication");
      },
    };
    await request("POST", p, 502, body);
  } finally {
    s.stubs.resolveForge.forge = saved;
  }
});
test("approved core PATCH exception writes one field, preserves GET and refuses batches", async () => {
  const saved = config.reducedPushMode;
  try {
    const result = await request("PATCH", "/api/settings", 200, { reducedPushMode: !saved });
    expect(result).toEqual({ reducedPushMode: !saved });
    const settings = (await request("GET", "/api/settings", 200)) as {
      reducedPushMode: boolean;
      hasApiKey: boolean;
    };
    expect(settings.reducedPushMode).toBe(!saved);
    expect(typeof settings.hasApiKey).toBe("boolean");
    expect(settings).not.toHaveProperty("anthropicApiKey");
    await request("PATCH", "/api/settings", 400, { reducedPushMode: "yes" });
    await request("PATCH", "/api/settings", 400, {
      reducedPushMode: true,
      autoReviveEnabled: true,
    });
    await request("PATCH", "/api/settings", 400, { repoRoot: s.tmpRoot });
    await request("PATCH", "/api/settings", 401, { reducedPushMode: true }, undefined, {});
  } finally {
    config.reducedPushMode = saved;
  }
});
test("existing token contract is cookie-admin only", async () => {
  const admin = { cookie };
  await request("GET", "/api/access-tokens", 200, undefined, undefined, admin);
  await request("GET", "/api/access-tokens", 403);
  await request("GET", "/api/access-tokens", 401, undefined, undefined, {});
  await request("POST", "/api/access-tokens", 400, { name: "" }, undefined, admin);
  await request("POST", "/api/access-tokens", 403, { name: "forbidden" });
  await request("POST", "/api/access-tokens", 401, { name: "missing" }, undefined, {});
  const minted = (await request(
    "POST",
    "/api/access-tokens",
    201,
    { name: "fixture", scope: "read", expiresInDays: 30 },
    undefined,
    admin,
  )) as { token: string; entry: { id: string; scope: string } };
  expect(minted.token.startsWith("shp_")).toBe(true);
  expect(minted.entry.scope).toBe("read");
  const path = `/api/access-tokens/${minted.entry.id}`;
  await request("DELETE", "/api/access-tokens/{id}", 403, undefined, path);
  await request("DELETE", "/api/access-tokens/{id}", 401, undefined, path, {});
  await request("DELETE", "/api/access-tokens/{id}", 200, undefined, path, admin);
  await request("DELETE", "/api/access-tokens/{id}", 404, undefined, path, admin);
});
test("settings owns a full unauthenticated sweep and its exception coverage", async () => {
  for (const op of OPS.filter((o) => o.endsWith(" 401"))) {
    const [method, path] = op.split(" ") as [string, string];
    await request(method, path, 401, method === "GET" ? undefined : {}, undefined, {});
  }
  expect(OPS.length).toBeGreaterThan(35);
  expect(EVENTS).toEqual(["diagnostics:status"]);
  const seen = coverage();
  expect(OPS.filter((o) => !seen.operations.has(o))).toEqual([]);
  expect(EVENTS.filter((e) => !seen.events.has(e))).toEqual([]);
  for (const status of [200, 400, 401])
    expect(seen.operations.has(`PATCH /api/settings ${status}`)).toBe(true);
});
