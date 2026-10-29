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
import { generateKeyPairSync } from "node:crypto";
import { PushService, pushDeviceId } from "../../src/push";
import { ApnsSender, apnsEndpoint } from "../../src/apns";
import { ApnsSettings } from "../../src/apns-settings";
import { JudgeSettings } from "../../src/judge-settings";
import type { TypeSafeProbeResult } from "../../src/judge-typesafe";
import type { Judge } from "../../src/judge";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    { hidden: true, priorityLabels: [" ci-gate-rot ", "ci-gate-rot"] },
    "/api/repo-config" + query,
  )) as { hidden: boolean; automationConfirmed: boolean; priorityLabels: string[] };
  expect(cfg.hidden).toBe(true);
  expect(cfg.priorityLabels).toEqual(["ci-gate-rot"]);
  expect(typeof cfg.automationConfirmed).toBe("boolean");
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
test("repo roles: a pending roles PR, merge settings and turning auto-merge on", async () => {
  // A repo carrying the roles-PR marker ref, so GET finds the open PR again (`pending`).
  const repo = join(config.repoRoot, "roles-pending");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  mkdirSync(join(repo, ".shepherd"));
  writeFileSync(join(repo, ".shepherd/roles.json"), '{"reviewer":"operator","merger":null}\n');
  git("add", ".shepherd/roles.json");
  git("-c", "user.name=Fixture", "-c", "user.email=f@example.com", "commit", "-q", "-m", "roles");
  git("update-ref", "refs/remotes/origin/shepherd/repo-roles", "HEAD");
  const settings = { requiresPr: true, autoMergeAllowed: false, canAdminister: true };
  const forge = {
    mergeMethod: "squash",
    currentUser: async () => "operator",
    defaultBranch: async () => "main",
    prStatus: async () => ({ state: "open", number: 9, url: "https://host/pr/9", checks: "none" }),
    repoMergeSettings: async () => ({ ...settings }),
    enableRepoAutoMerge: async () => {
      settings.autoMergeAllowed = true;
    },
    enableAutoMerge: async () => {},
  };
  const q = `?repo=${encodeURIComponent(repo)}`;
  const saved = s.stubs.resolveForge.forge;
  try {
    s.stubs.resolveForge.forge = forge;
    const read = (await request(
      "GET",
      "/api/repo-roles",
      200,
      undefined,
      "/api/repo-roles" + q,
    )) as {
      pending: unknown;
      mergeSettings: unknown;
    };
    expect(read.pending).toEqual({
      number: 9,
      url: "https://host/pr/9",
      roles: { reviewer: "operator", merger: null },
    });
    expect(read.mergeSettings).toEqual({ ...settings });

    const path = "/api/repo-roles/auto-merge";
    const enabled = (await request("POST", path, 200, undefined, path + q)) as {
      pending: { autoMerge: string };
      mergeSettings: { autoMergeAllowed: boolean };
    };
    expect(enabled.pending.autoMerge).toBe("enabled");
    expect(enabled.mergeSettings.autoMergeAllowed).toBe(true);

    s.stubs.resolveForge.forge = {
      ...forge,
      enableRepoAutoMerge: async () => {
        throw new Error("HTTP 403");
      },
    };
    const refused = (await request("POST", path, 502, undefined, path + q)) as { error: string };
    expect(refused.error).toBe("auto_merge_enable_failed");
    s.stubs.resolveForge.forge = null;
    const unsupported = (await request("POST", path, 409, undefined, path + q)) as {
      error: string;
    };
    expect(unsupported.error).toBe("unsupported");
    await request("POST", path, 400, undefined, path + "?repo=/outside");
  } finally {
    s.stubs.resolveForge.forge = saved;
    rmSync(repo, { recursive: true, force: true });
  }
});
test("repo browser open: refusals, launch failure and success", async () => {
  const path = "/api/repo-browser/open";
  const repo = s.validRepo;
  const saved = s.deps.sharedBrowser;
  const savedCfg = s.deps.store.getRepoConfig(repo);
  try {
    await request("POST", path, 400, { repo: "/outside" });
    await request("POST", path, 409, { repo });
    s.deps.store.setRepoConfig(repo, { ...savedCfg, sharedBrowserEnabled: true });
    s.deps.sharedBrowser = undefined;
    const failed = (await request("POST", path, 503, { repo })) as { error: string };
    expect(failed.error).toBe("launch-failed");
    const opened: string[] = [];
    s.deps.sharedBrowser = {
      attach: () => Promise.reject(new Error("unused")),
      open: async (_repo: string, url: string) => {
        opened.push(url);
        return "T1";
      },
      sessionTab: () => null,
      stop: () => {},
    };
    await request("POST", path, 404, { repo, sessionId: "missing" });
    const ok = (await request("POST", path, 200, { repo })) as { url: string };
    expect(ok.url).toBe("about:blank");
    expect(opened).toEqual(["about:blank"]);
  } finally {
    s.deps.sharedBrowser = saved;
    s.deps.store.setRepoConfig(repo, savedCfg);
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
    // #2494: the CLI's generated type keeps only schema'd fields, so these must be in the contract.
    expect(settings).toHaveProperty("providerFailover");
    expect(settings).toHaveProperty("telemetryHealth");
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
test("PATCH assistantPermissions merges a partial set, GET and the assistant state report it", async () => {
  const saved = config.assistantPermissions;
  try {
    const result = (await request("PATCH", "/api/settings", 200, {
      assistantPermissions: { steer: "allow" },
    })) as { assistantPermissions: { steer: string; shell: string } };
    expect(result.assistantPermissions).toEqual({ ...saved, steer: "allow" });
    const settings = (await request("GET", "/api/settings", 200)) as {
      assistantPermissions: unknown;
    };
    expect(settings.assistantPermissions).toEqual({ ...saved, steer: "allow" });
    await request("PATCH", "/api/settings", 400, { assistantPermissions: { steer: "read" } });
    await request("PATCH", "/api/settings", 400, { assistantPermissions: { files: "allow" } });
  } finally {
    config.assistantPermissions = saved;
  }
});
test("PATCH issueFilter merges a partial filter, GET reports it and settings:issue-filter fires", async () => {
  try {
    const frames = await collectEvents(s, token, async () => {
      const result = (await request("PATCH", "/api/settings", 200, {
        issueFilter: { forks: "own", hiddenLabels: [" wip ", "WIP"] },
      })) as { issueFilter: { forks: string; hiddenLabels: string[]; scope: string } };
      expect(result.issueFilter).toMatchObject({
        scope: "mine_unassigned",
        forks: "own",
        hiddenLabels: ["wip"],
      });
    });
    const frame = frames.find((f) => f.event === "settings:issue-filter");
    expect(frame).toBeDefined();
    validateEvent("settings:issue-filter", frame!.data);
    const settings = (await request("GET", "/api/settings", 200)) as {
      issueFilter: { forks: string };
    };
    expect(settings.issueFilter.forks).toBe("own");
    await request("PATCH", "/api/settings", 400, { issueFilter: { scope: "everyone" } });
    await request("PATCH", "/api/settings", 400, { issueFilter: { colour: "red" } });
  } finally {
    await request("PATCH", "/api/settings", 200, {
      issueFilter: { scope: "mine_unassigned", forks: "all", hiddenLabels: [] },
    });
  }
});
test("PATCH upnextQuickStarts merges per CLI, GET reports it, bad presets 400", async () => {
  try {
    const codex = { enabled: true, model: "gpt-6.1-sol", effort: "medium" };
    const first = (await request("PATCH", "/api/settings", 200, {
      upnextQuickStarts: { codex },
    })) as { upnextQuickStarts: unknown };
    expect(first.upnextQuickStarts).toEqual({ codex });
    const second = (await request("PATCH", "/api/settings", 200, {
      upnextQuickStarts: { claude: { enabled: false } },
    })) as { upnextQuickStarts: unknown };
    const claude = { enabled: false, model: null, effort: null };
    expect(second.upnextQuickStarts).toEqual({ claude, codex });
    const settings = (await request("GET", "/api/settings", 200)) as {
      upnextQuickStarts: unknown;
    };
    expect(settings.upnextQuickStarts).toEqual({ claude, codex });
    await request("PATCH", "/api/settings", 400, {
      upnextQuickStarts: { claude: { enabled: true, effort: "ultra" } },
    });
    await request("PATCH", "/api/settings", 400, { upnextQuickStarts: {} });
  } finally {
    s.deps.store.deleteSetting("upnextQuickStarts");
  }
});
test("native iOS registration: 503 without an APNs key, 400 on a bad token, 200 once configured", async () => {
  const device = { token: "ab".repeat(32), environment: "production", locale: "de" };
  const saved = s.deps.push;
  try {
    s.deps.push = undefined;
    await request("POST", "/api/push/apns", 503, device);
    await request("POST", "/api/push/apns", 400, { token: "nope", environment: "production" });
    const key = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    s.deps.push = new PushService(
      s.deps.store,
      async () => ({}),
      () => ({ publicKey: "PUB", privateKey: "PRIV" }),
      undefined,
      undefined,
      new ApnsSender(
        { key, keyId: "KEY1234567", teamId: "TEAM123456", topic: "run.shepherd.ios" },
        async () => ({ status: 200 }),
      ),
    );
    const ok = (await request("POST", "/api/push/apns", 200, device)) as { endpoint: string };
    expect(ok.endpoint).toBe(`apns:production:${device.token}`);
    // The relay fields of #3058: a device registered with another server too.
    const covered = { ...device, coveredInstances: ["0b6f2c1e-7c1d-4e53-9d1a-3c1f2e4b5a6d"] };
    await request("POST", "/api/push/apns", 200, { ...covered, relayRemote: true });
    await request("POST", "/api/push/apns", 400, { ...device, coveredInstances: [""] });
  } finally {
    s.deps.push = saved;
  }
});
test("push administration is cookie-admin only and never returns the key", async () => {
  const admin = { cookie };
  const p256 = () =>
    generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
  const noEnv = { key: null, keyId: null, teamId: null, topic: null };
  const dir = mkdtempSync(join(tmpdir(), "contract-apns-"));
  const sender = new ApnsSender({ key: null, keyId: null, teamId: null, topic: "" }, async () => ({
    status: 400,
    reason: "BadDeviceToken",
  }));
  const settings = new ApnsSettings(join(dir, "apns.json"), noEnv, sender);
  settings.load();
  const savedPush = s.deps.push,
    savedSettings = s.deps.apnsSettings;
  const ios = apnsEndpoint("production", "ef".repeat(32));
  const devicePath = `/api/push/devices/${pushDeviceId(ios)}`;
  try {
    s.deps.apnsSettings = undefined;
    s.deps.push = undefined;
    await request("GET", "/api/push/apns/config", 503, undefined, undefined, admin);
    await request("PUT", "/api/push/apns/config", 503, {}, undefined, admin);
    await request("DELETE", "/api/push/apns/config", 503, undefined, undefined, admin);
    s.deps.store.putPushSub({ endpoint: ios, keys: { p256dh: "", auth: "" }, locale: "de" }, "iOS");
    await request(
      "POST",
      "/api/push/devices/{id}/test",
      503,
      undefined,
      devicePath + "/test",
      admin,
    );

    s.deps.apnsSettings = settings;
    s.deps.push = new PushService(
      s.deps.store,
      async () => ({ statusCode: 201 }),
      () => ({ publicKey: "PUB", privateKey: "PRIV" }),
      undefined,
      undefined,
      sender,
    );
    const key = p256();
    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", { keyId: "KEY1234567" }],
      ["DELETE", undefined],
    ] as const) {
      await request(method, "/api/push/apns/config", 403, body);
    }
    await request("PUT", "/api/push/apns/config", 400, { keyId: 1 }, undefined, admin);
    await request("PUT", "/api/push/apns/config", 422, { key: "x" }, undefined, admin);
    const saved = (await request(
      "PUT",
      "/api/push/apns/config",
      200,
      { key, keyId: "KEY1234567", teamId: "TEAM123456" },
      undefined,
      admin,
    )) as { state: string };
    expect(saved.state).toBe("configured");
    const res = await fetch(s.baseUrl + "/api/push/apns/config", { headers: admin });
    expect(await res.text()).not.toContain(key.split("\n")[1]!);
    await request("GET", "/api/push/apns/config", 200, undefined, undefined, admin);

    s.deps.apnsSettings = new ApnsSettings(join(dir, "env.json"), { ...noEnv, key }, sender);
    await request("PUT", "/api/push/apns/config", 409, { key }, undefined, admin);
    s.deps.apnsSettings = settings;

    await request("GET", "/api/push/devices", 403);
    const list = (await request("GET", "/api/push/devices", 200, undefined, undefined, admin)) as {
      devices: { kind: string }[];
    };
    expect(list.devices.some((d) => d.kind === "ios")).toBe(true);
    const cats = { categories: { agent: true, reviews: false, ci: true } };
    await request("PATCH", "/api/push/devices/{id}", 403, cats, devicePath);
    await request("PATCH", "/api/push/devices/{id}", 400, {}, devicePath, admin);
    await request("PATCH", "/api/push/devices/{id}", 200, cats, devicePath, admin);
    await request("PATCH", "/api/push/devices/{id}", 404, cats, "/api/push/devices/none", admin);
    await request("POST", "/api/push/devices/{id}/test", 403, undefined, devicePath + "/test");
    const tested = (await request(
      "POST",
      "/api/push/devices/{id}/test",
      200,
      undefined,
      devicePath + "/test",
      admin,
    )) as { delivered: boolean; reason: string };
    expect(tested).toMatchObject({ delivered: false, reason: "BadDeviceToken" });
    await request("DELETE", "/api/push/devices/{id}", 403, undefined, devicePath);
    await request("DELETE", "/api/push/devices/{id}", 200, undefined, devicePath, admin);
    await request("DELETE", "/api/push/devices/{id}", 404, undefined, devicePath, admin);
    await request(
      "POST",
      "/api/push/devices/{id}/test",
      404,
      undefined,
      devicePath + "/test",
      admin,
    );
    await request("DELETE", "/api/push/apns/config", 200, undefined, undefined, admin);
  } finally {
    s.deps.push = savedPush;
    s.deps.apnsSettings = savedSettings;
    s.deps.store.deletePushSub(ios);
  }
});
test("repo bootstrap state, phase and logged override (#3105)", async () => {
  const q = `?repo=${encodeURIComponent(s.validRepo)}`;
  const base = "/api/repo-bootstrap",
    ovr = "/api/repo-bootstrap/override";
  await request("GET", base, 200, undefined, base + q);
  await request("GET", base, 400, undefined, base + "?repo=/outside");
  await request("PUT", base, 409, { phase: 2 }, base + q);
  await request("POST", ovr, 409, { on: true }, ovr + q);
  await request("PUT", base, 400, { state: "done" }, base + q);
  const frames = await collectEvents(s, token, async () => {
    const view = (await request("PUT", base, 200, { state: "active" }, base + q)) as {
      next: unknown;
    };
    expect(view.next).toEqual({ kind: "bootstrap", phase: 1, sessionId: null });
  });
  const frame = frames.find((f) => f.event === "repo-bootstrap:update");
  expect(frame).toBeDefined();
  validateEvent("repo-bootstrap:update", frame!.data);
  await request("POST", ovr, 400, { on: "yes" }, ovr + q);
  await request("POST", ovr, 200, { on: false }, ovr + q);
  await request("PUT", base, 200, { state: "off" }, base + q);
});
test("schedules CRUD, run now and runs (#3469)", async () => {
  const base = "/api/schedules";
  const one = "/api/schedules/{id}";
  const input = {
    repoPath: s.validRepo,
    name: "Triage",
    prompt: "/triage-feedback",
    days: 0b0011111,
    times: ["09:00", "18:00"],
  };
  await request("POST", base, 400, { ...input, days: 0 });
  let created: { id: string } | undefined;
  const frames = await collectEvents(s, token, async () => {
    created = (await request("POST", base, 201, input)) as { id: string };
  });
  const frame = frames.find((f) => f.event === "schedules:changed");
  expect(frame).toBeDefined();
  validateEvent("schedules:changed", frame!.data);
  const id = created!.id;
  const at = (suffix = "") => `/api/schedules/${id}${suffix}`;
  await request("GET", base, 200, undefined, `${base}?repo=${encodeURIComponent(s.validRepo)}`);
  await request("PATCH", one, 200, { enabled: false }, at());
  await request("PATCH", one, 400, { times: [] }, at());
  await request("PATCH", one, 404, { name: "x" }, "/api/schedules/nope");
  const saved = s.deps.schedules;
  s.deps.schedules = {
    runNow: async (rid) =>
      s.deps.store.getSchedule(rid)
        ? {
            id: 1,
            scheduleId: rid,
            slotKey: "manual:x",
            outcome: "skipped:overlap",
            sessionId: null,
            reason: "previous run still open",
            at: 1,
          }
        : null,
  };
  try {
    await request("POST", "/api/schedules/{id}/run", 200, undefined, at("/run"));
    await request("POST", "/api/schedules/{id}/run", 404, undefined, "/api/schedules/nope/run");
  } finally {
    s.deps.schedules = saved;
  }
  await request("GET", "/api/schedules/{id}/runs", 200, undefined, at("/runs"));
  await request("GET", "/api/schedules/{id}/runs", 404, undefined, "/api/schedules/nope/runs");
  await request("DELETE", one, 200, undefined, at());
  await request("DELETE", one, 404, undefined, at());
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
test("runner update contract uses existing backend actions and all event payloads", async () => {
  const herdr = {
    current: "0.8.2",
    latest: "0.9.3",
    updateAvailable: true,
    notes: null,
    checkedAt: 1,
    phase: "idle" as const,
    revision: 1,
    currentUnsupported: true,
    downgradeTarget: "0.8.1",
    sandboxIdleRegressed: true,
    sandboxDowngradeTarget: "0.6.9",
  };
  const codex = {
    current: "0.160.1",
    latest: "0.162.1",
    updateAvailable: true,
    notes: null,
    checkedAt: 1,
  };
  const saved = { herdr: s.deps.herdrUpdates, codex: s.deps.codexUpdates };
  let started = true;
  const calls: string[] = [];
  s.deps.herdrUpdates = {
    current: () => herdr,
    status: async () => herdr,
    apply: () => {
      calls.push("herdr");
      return { started };
    },
    downgrade: (target) => {
      calls.push(target ?? "supported");
      return { started };
    },
    restartServer: async (runtime) => {
      expect(runtime).toEqual({ installedVersion: "0.9.3", serverVersion: "0.8.2" });
      calls.push("restart");
      return started ? { started } : { started, error: "runtime_changed" };
    },
  };
  s.deps.codexUpdates = {
    current: () => codex,
    apply: () => {
      calls.push("codex");
      return { started };
    },
    releaseNotes: async () => ({
      current: codex.current,
      latest: codex.latest,
      notes: [{ version: "0.162.1", body: "fixture notes" }],
      complete: false,
    }),
  };
  const actions = [
    "/api/herdr-update",
    "/api/herdr-update/downgrade",
    "/api/herdr-update/downgrade/sandbox",
    "/api/herdr-update/restart",
    "/api/codex-update",
  ];
  const restart = { confirmed: true, installedVersion: "0.9.3", serverVersion: "0.8.2" };
  const body = (path: string) => (path.endsWith("/restart") ? restart : undefined);
  try {
    await request("GET", "/api/herdr-update", 200);
    await request("GET", "/api/codex-update", 200);
    await request("GET", "/api/codex-update/notes", 200);
    await request("POST", "/api/herdr-update/restart", 400, {});
    for (const path of actions) await request("POST", path, 202, body(path));
    expect(calls).toEqual(["herdr", "supported", "0.6.9", "restart", "codex"]);
    started = false;
    for (const path of actions) await request("POST", path, 409, body(path));
    herdr.updateAvailable = false;
    codex.updateAvailable = false;
    await request("POST", "/api/herdr-update", 409);
    await request("POST", "/api/codex-update", 409);
    herdr.currentUnsupported = false;
    herdr.sandboxIdleRegressed = false;
    await request("POST", "/api/herdr-update/downgrade", 409);
    await request("POST", "/api/herdr-update/downgrade/sandbox", 409);
    const readToken = (await request(
      "POST",
      "/api/access-tokens",
      201,
      { name: "runner-read", scope: "read", expiresInDays: 30 },
      undefined,
      { cookie },
    )) as { token: string };
    const denied = [
      ...actions.map((path) => ["POST", path]),
      ...["/api/herdr-update", "/api/codex-update", "/api/codex-update/notes"].map((path) => [
        "GET",
        path,
      ]),
    ];
    for (const [method, path] of denied)
      await request(
        method!,
        path!,
        403,
        method === "POST" ? body(path!) : undefined,
        undefined,
        bearer(readToken.token),
      );
    const payloads = {
      "herdr-update:status": herdr,
      "codex-update:status": codex,
      "herdr-update:log": { line: "herdr fixture" },
      "codex-update:log": { line: "codex fixture" },
      "herdr-update:done": {
        ok: false,
        from: "0.8.2",
        to: "0.9.3",
        errorCode: "restart_required",
        error: "restart required",
      },
      "codex-update:done": {
        ok: false,
        from: "0.160.1",
        to: "0.160.1",
        onPathBinary: "/fixture/codex",
        error: "no progress",
      },
    };
    const frames = await collectEvents(s, token, async () => {
      for (const [event, data] of Object.entries(payloads)) s.deps.events.emit(event, data);
    });
    for (const event of Object.keys(payloads)) {
      const frame = frames.find((frame) => frame.event === event);
      expect(frame).toBeDefined();
      validateEvent(event, frame!.data);
    }
    s.deps.herdrUpdates = undefined;
    s.deps.codexUpdates = undefined;
    for (const path of actions) await request("POST", path, 503, body(path));
    for (const path of ["/api/herdr-update", "/api/codex-update", "/api/codex-update/notes"])
      await request("GET", path, 200);
  } finally {
    s.deps.herdrUpdates = saved.herdr;
    s.deps.codexUpdates = saved.codex;
  }
});

test("the decision-model connection is cookie-admin only and never returns the key", async () => {
  const admin = { cookie };
  const KEY = "jev_contract_0123456789abcdef";
  const noEnv = { key: null, model: null, baseUrl: null, timeoutMs: null };
  const dir = mkdtempSync(join(tmpdir(), "contract-judge-"));
  let probe: TypeSafeProbeResult = { ok: true, models: ["jev-1.13.0"] };
  const deps = { probe: async () => probe, createJudge: () => ({}) as Judge };
  const settings = new JudgeSettings(join(dir, "judge.json"), noEnv, deps);
  settings.load();
  const saved = s.deps.judgeSettings;
  const path = "/api/judge/connection";
  const verify = "/api/judge/connection/verify";
  try {
    s.deps.judgeSettings = undefined;
    await request("GET", path, 503, undefined, undefined, admin);
    await request("PUT", path, 503, {}, undefined, admin);
    await request("DELETE", path, 503, undefined, undefined, admin);
    await request("POST", verify, 503, undefined, undefined, admin);

    s.deps.judgeSettings = settings;
    for (const [method, route, body] of [
      ["GET", path, undefined],
      ["PUT", path, { model: "jev-1.14.0" }],
      ["DELETE", path, undefined],
      ["POST", verify, undefined],
    ] as const) {
      await request(method, route, 403, body);
    }
    await request("POST", verify, 409, undefined, undefined, admin);
    await request("PUT", path, 400, { timeoutMs: "slow" }, undefined, admin);
    await request("PUT", path, 422, { model: "two words" }, undefined, admin);

    probe = { ok: false, kind: "rejected", status: 401 };
    const rejected = (await request("PUT", path, 422, { key: KEY }, undefined, admin)) as {
      error: string;
    };
    expect(rejected.error).toBe("key_rejected");
    probe = { ok: false, kind: "unreachable", status: null };
    await request("PUT", path, 502, { key: KEY }, undefined, admin);

    probe = { ok: true, models: ["jev-1.13.0"] };
    const stored = (await request("PUT", path, 200, { key: KEY }, undefined, admin)) as {
      keySource: string;
      keyLast4: string;
    };
    expect(stored).toMatchObject({ keySource: "stored", keyLast4: "cdef" });
    const moved = (await request(
      "PUT",
      path,
      422,
      { baseUrl: "https://elsewhere.example" },
      undefined,
      admin,
    )) as { error: string };
    expect(moved.error).toBe("key_required");
    await request("POST", verify, 200, undefined, undefined, admin);
    await request("GET", path, 200, undefined, undefined, admin);
    for (const [method, route] of [
      ["GET", path],
      ["POST", verify],
    ] as const) {
      const res = await fetch(s.baseUrl + route, { method, headers: admin });
      expect(await res.text()).not.toContain(KEY);
    }

    s.deps.judgeSettings = new JudgeSettings(join(dir, "env.json"), { ...noEnv, key: KEY }, deps);
    await request("PUT", path, 409, { baseUrl: "https://elsewhere.example" }, undefined, admin);
    s.deps.judgeSettings = settings;

    const removed = (await request("DELETE", path, 200, undefined, undefined, admin)) as {
      keySource: string;
    };
    expect(removed.keySource).toBe("none");
  } finally {
    s.deps.judgeSettings = saved;
  }
});

test("settings owns a full unauthenticated sweep and its exception coverage", async () => {
  for (const op of OPS.filter((o) => o.endsWith(" 401"))) {
    const [method, path] = op.split(" ") as [string, string];
    await request(method, path, 401, method === "GET" ? undefined : {}, undefined, {});
  }
  expect(OPS.length).toBeGreaterThan(35);
  expect(EVENTS).toContain("diagnostics:status");
  expect(EVENTS).toContain("repo-bootstrap:update");
  expect(EVENTS.filter((event) => event.includes("-update:"))).toHaveLength(6);
  const seen = coverage();
  expect(OPS.filter((o) => !seen.operations.has(o))).toEqual([]);
  expect(EVENTS.filter((e) => !seen.events.has(e))).toEqual([]);
  for (const status of [200, 400, 401])
    expect(seen.operations.has(`PATCH /api/settings ${status}`)).toBe(true);
});

test("resource settings contract round-trips partial changes and rejects invalid thresholds", async () => {
  const listPath = config.heavyListPath;
  const shimDir = config.slotShimDir;
  config.heavyListPath = join(s.tmpRoot, "heavy-list", "list.json");
  config.slotShimDir = join(s.tmpRoot, "slot-shims");
  try {
    const result = await request("PATCH", "/api/settings", 200, {
      heavySlot: {
        enabled: false,
        slots: 2,
        waitMinutes: 5,
        heavyList: { custom: [{ command: "mycheck", subcommands: [] }], disabled: ["cargo"] },
      },
    });
    expect(result).toMatchObject({ heavySlot: { enabled: false, slots: 2, waitMinutes: 5 } });
    await request("PATCH", "/api/settings", 400, { heavySlot: { brake: { psiFullMax: 101 } } });
    const view = await request("GET", "/api/settings", 200);
    expect(view).toMatchObject({ heavySlot: { slots: 2, heavyList: { disabled: ["cargo"] } } });
  } finally {
    config.heavyListPath = listPath;
    config.slotShimDir = shimDir;
  }
});
