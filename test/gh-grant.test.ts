import { describe, expect, test } from "bun:test";
import {
  GithubAppConfigError,
  type AgentGhAppTokenOptions,
  type AgentGhAppTokenSource,
  type ReleaseSessionResult,
} from "../src/agent-gh-app";
import { EventHub } from "../src/events";
import {
  GH_GRANTS_EVENT,
  GH_PERMISSION_REQUEST_EVENT,
  GhGrantService,
  GhPermissionRequestService,
} from "../src/gh-grant";
import { SessionStore } from "../src/store";

const base = {
  name: "ci-fix",
  prompt: "fix ci",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/ci-fix",
  worktreePath: "/r-wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_1",
  sandboxApplied: "standard" as const,
};

function setup(
  opts: {
    mint?: (o?: AgentGhAppTokenOptions) => Promise<{ token: string; expiresAt: number } | null>;
    release?: () => Promise<ReleaseSessionResult>;
    running?: boolean;
    appMode?: boolean;
  } = {},
) {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const emitted: [string, unknown][] = [];
  events.subscribe((event, data) => void emitted.push([event, data]));
  const requests = new GhPermissionRequestService({ events, now: () => 5 });
  const order: string[] = [];
  const mints: (AgentGhAppTokenOptions | undefined)[] = [];
  const source = Object.assign(
    async (_repo: string, o?: AgentGhAppTokenOptions) => {
      mints.push(o);
      order.push("mint");
      return opts.mint ? opts.mint(o) : { token: "ghs_w", expiresAt: 1e15 };
    },
    {
      releaseSession: async (): Promise<ReleaseSessionResult> => {
        order.push("release");
        return opts.release ? opts.release() : { ok: true, revoked: 1 };
      },
    },
  ) as AgentGhAppTokenSource;
  const refresher = {
    isRunning: () => opts.running ?? true,
    refreshNow: async () => void order.push("refresh"),
  };
  const svc = new GhGrantService({
    store,
    events,
    requests,
    source,
    refresher,
    appModeConfigured: () => opts.appMode ?? true,
    now: () => 100,
  });
  const s = store.create(base);
  return { store, events, emitted, requests, svc, s, order, mints };
}

describe("GhPermissionRequestService", () => {
  test("request → wait → resolve; re-attach keeps one request; archive denies", async () => {
    const { requests, emitted, events } = setup();
    const r = requests.request("s1", "workflows", "edit ci.yml", [".github/workflows/ci.yml"]);
    expect(r.status).toBe("open");
    if (r.status !== "open") return;
    expect(requests.request("s1", "workflows", "other", []).status).toBe("open");
    expect(requests.snapshot()).toEqual({ s1: r.request });
    const waiting = requests.wait("s1", r.request.id, 1000);
    requests.resolve("s1", "granted");
    expect(await waiting).toBe("granted");
    expect(emitted.filter(([e]) => e === GH_PERMISSION_REQUEST_EVENT)).toHaveLength(2);

    // answered while nobody waited: the next call gets it once
    const r2 = requests.request("s2", "workflows", "x", []);
    if (r2.status !== "open") throw new Error("open");
    requests.resolve("s2", "denied");
    expect(requests.request("s2", "workflows", "x", [])).toEqual({ status: "denied" });
    expect(requests.request("s2", "workflows", "x", []).status).toBe("open");

    events.emit("session:archived", { id: "s2" });
    expect(requests.get("s2")).toBeNull();
  });

  test("wait times out to pending", async () => {
    const { requests } = setup();
    const r = requests.request("s1", "workflows", "x", []);
    if (r.status !== "open") throw new Error("open");
    expect(await requests.wait("s1", r.request.id, 5)).toBe("pending");
  });
});

describe("GhGrantService", () => {
  test("grant: preflight widened mint, persist + audit + event, refresh, resolve request", async () => {
    const { store, svc, s, requests, emitted, order, mints } = setup();
    const r = requests.request(s.id, "workflows", "edit ci.yml", []);
    if (r.status !== "open") throw new Error("open");
    const waiting = requests.wait(s.id, r.request.id, 1000);
    expect(await svc.grant(s.id, "workflows", "operator")).toEqual({ ok: true });
    expect(await waiting).toBe("granted");
    expect(mints).toEqual([{ extra: ["workflows"], sessionId: s.id }]);
    expect(order).toEqual(["mint", "refresh"]);
    const grants = [{ permission: "workflows" as const, grantedAt: 100, grantedBy: "operator" }];
    expect(store.get(s.id)?.ghGrants).toEqual(grants);
    expect(emitted).toContainEqual([GH_GRANTS_EVENT, { id: s.id, ghGrants: grants }]);
    expect(store.ghGrantLog(s.id).map((l) => [l.action, l.actor, l.detail])).toEqual([
      ["grant", "operator", "edit ci.yml"],
    ]);
    // granting again is a no-op success
    expect(await svc.grant(s.id, "workflows", "operator")).toEqual({ ok: true });
    expect(store.ghGrantLog(s.id)).toHaveLength(1);
  });

  test("preconditions: unknown, trusted, App mode off, no membrane token", async () => {
    expect((await setup().svc.grant("nope", "workflows", "operator")).ok).toBe(false);
    const trusted = setup();
    trusted.store.setSandboxState(trusted.s.id, { applied: "trusted", degraded: false });
    expect(await trusted.svc.grant(trusted.s.id, "workflows", "operator")).toMatchObject({
      code: "not-sandboxed",
    });
    const off = setup({ appMode: false });
    expect(await off.svc.grant(off.s.id, "workflows", "operator")).toMatchObject({
      code: "app-mode-off",
    });
    const idle = setup({ running: false });
    expect(await idle.svc.grant(idle.s.id, "workflows", "operator")).toMatchObject({
      code: "no-membrane-token",
    });
    expect(idle.order).toEqual([]);
  });

  test("installation lacks the permission (422) → 409, nothing persisted, request stays open", async () => {
    const h = setup({
      mint: async () => {
        throw new GithubAppConfigError("token mint: HTTP 422", { status: 422 });
      },
    });
    h.requests.request(h.s.id, "workflows", "x", []);
    const r = await h.svc.grant(h.s.id, "workflows", "operator");
    expect(r).toMatchObject({ ok: false, status: 409, code: "installation-lacks-permission" });
    expect(!r.ok && r.error).toContain("Grant it on the App installation first");
    expect(h.store.get(h.s.id)?.ghGrants).toEqual([]);
    expect(h.store.ghGrantLog(h.s.id)).toEqual([]);
    expect(h.requests.get(h.s.id)).not.toBeNull();
    expect(h.order).toEqual(["mint"]);

    const transient = setup({
      mint: async () => {
        throw new Error("timed out");
      },
    });
    expect(await transient.svc.grant(transient.s.id, "workflows", "operator")).toMatchObject({
      status: 502,
      code: "mint-failed",
    });
  });

  test("revoke: default token written first, then widened token revoked at GitHub", async () => {
    const h = setup();
    await h.svc.grant(h.s.id, "workflows", "operator");
    h.order.length = 0;
    expect(await h.svc.revoke(h.s.id, "workflows", "token:ci")).toEqual({ ok: true });
    expect(h.order).toEqual(["refresh", "release"]);
    expect(h.store.get(h.s.id)?.ghGrants).toEqual([]);
    expect(h.store.ghGrantLog(h.s.id).map((l) => [l.action, l.actor])).toEqual([
      ["grant", "operator"],
      ["revoke", "token:ci"],
      ["github-revoke", "shepherd"],
    ]);
    expect(await h.svc.revoke(h.s.id, "workflows", "operator")).toMatchObject({
      code: "not-granted",
    });
  });

  test("revoke: a failed GitHub revoke is audited, the grant still removed", async () => {
    const h = setup({ release: async () => ({ ok: false, failure: "HTTP 503" }) });
    await h.svc.grant(h.s.id, "workflows", "operator");
    const orig = console.warn;
    console.warn = () => {};
    try {
      expect(await h.svc.revoke(h.s.id, "workflows", "operator")).toEqual({ ok: true });
    } finally {
      console.warn = orig;
    }
    expect(h.store.get(h.s.id)?.ghGrants).toEqual([]);
    expect(h.store.ghGrantLog(h.s.id).at(-1)).toMatchObject({
      action: "github-revoke-failed",
      detail: "HTTP 503",
    });
  });

  test("archive clears grants, audits, and revokes at GitHub", async () => {
    const h = setup();
    await h.svc.grant(h.s.id, "workflows", "operator");
    h.order.length = 0;
    await h.svc.endForArchive(h.s.id);
    expect(h.order).toEqual(["release"]);
    expect(h.store.get(h.s.id)?.ghGrants).toEqual([]);
    expect(h.store.ghGrantLog(h.s.id).map((l) => l.action)).toEqual([
      "grant",
      "archive",
      "github-revoke",
    ]);
    // nothing granted, nothing revoked: no audit noise
    const quiet = setup({ release: async () => ({ ok: true, revoked: 0 }) });
    await quiet.svc.endForArchive(quiet.s.id);
    expect(quiet.store.ghGrantLog(quiet.s.id)).toEqual([]);
  });
});
