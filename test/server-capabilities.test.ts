import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { config } from "../src/config";
import { signCookie, hashPassword, SESSION_COOKIE } from "../src/operator-auth";
import { CapabilityService, type ExecResult } from "../src/remote-instances/capability-probe";

// Verified capabilities (#2770) through the real routes: GET /api/instance serves the report and
// POST /api/instance/capabilities re-probes. The probe's exec is injected — nothing is spawned.

const SECRET = "test-cookie-signing-secret";

const operator = () => ({
  "content-type": "application/json",
  Cookie: `${SESSION_COOKIE}=${signCookie(SECRET)}`,
});

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, timedOut: false, notFound: false });
const absent: ExecResult = { code: null, stdout: "", timedOut: false, notFound: true };

/** A Linux host with claude installed and logged in, codex installed but logged out, no Android
 *  SDK and no sandbox backend. Counts how often the probe ran. */
function fakeHost() {
  const probe = { runs: 0 };
  const capabilities = new CapabilityService({
    platform: "linux",
    env: {},
    home: "/nonexistent",
    codexBin: "codex",
    readdir: () => null,
    detectSandbox: () => ({ backend: false, egress: false }),
    exec: async (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      if (key === "claude --version") probe.runs++;
      if (key === "claude auth status --json") return ok(JSON.stringify({ loggedIn: true }));
      if (key === "codex login status") return { ...ok(), code: 1 };
      return cmd === "claude" || cmd === "codex" ? ok() : absent;
    },
  });
  return { capabilities, probe };
}

interface Instance {
  app: ReturnType<typeof makeApp>;
  probe: { runs: number };
  created: unknown[];
  deps: AppDeps;
}

function makeInstance(): Instance {
  const store = new SessionStore(":memory:");
  const { capabilities, probe } = fakeHost();
  const created: unknown[] = [];
  const deps: AppDeps = {
    store,
    events: new EventHub(),
    capabilities,
    // Only `create` is reached on the create path; recording it proves what started.
    service: {
      create: async (input: unknown) => {
        created.push(input);
        return { id: `s${created.length}` };
      },
    } as never,
    usageLimits: {
      limits: () => ({
        session5h: null,
        week: null,
        perModelWeek: [],
        credits: null,
        stale: true,
        calibratedAt: null,
        subscriptionOnly: false,
      }),
      projections: () => [],
    },
  };
  return { app: makeApp(deps), probe, created, deps };
}

async function call(
  i: Instance,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = operator(),
) {
  const res = await i.app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

type Report = { probedAt: number; stale: boolean; checks: { id: string; ok: boolean }[] };

let prev: { secret: string | null; hash: string | null; token: string | null; root: string };
let repoRoot: string;

beforeEach(async () => {
  prev = {
    secret: config.cookieSecret,
    hash: config.passwordHash,
    token: config.token,
    root: config.repoRoot,
  };
  config.cookieSecret = SECRET;
  config.passwordHash = await hashPassword("pw");
  config.token = null;
  repoRoot = mkdtempSync(join(tmpdir(), "shepherd-capabilities-"));
  mkdirSync(join(repoRoot, "app"));
  config.repoRoot = repoRoot;
});

afterEach(() => {
  config.cookieSecret = prev.secret;
  config.passwordHash = prev.hash;
  config.token = prev.token;
  config.repoRoot = prev.root;
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("capabilities on /api/instance", () => {
  test("GET reports null before the first probe and never probes by itself", async () => {
    const a = makeInstance();
    const res = await call(a, "GET", "/api/instance");
    expect(res.status).toBe(200);
    expect(res.body.capabilities).toBeNull();
    expect(a.probe.runs).toBe(0);
  });

  test("POST /api/instance/capabilities probes now and returns the identity with the report", async () => {
    const a = makeInstance();
    const res = await call(a, "POST", "/api/instance/capabilities");
    expect(res.status).toBe(200);
    expect(res.body.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    const report = res.body.capabilities as Report;
    expect(report.stale).toBe(false);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.ok]));
    expect(byId).toMatchObject({
      "platform:linux": true,
      "agent:claude": true,
      "agent:codex": false,
      "android-sdk": false,
    });
    expect(a.probe.runs).toBe(1);
    const again = (await call(a, "GET", "/api/instance")).body.capabilities as Report;
    expect(again.probedAt).toBe(report.probedAt);
  });

  test("a rename keeps the report in its answer", async () => {
    const a = makeInstance();
    await call(a, "POST", "/api/instance/capabilities");
    const renamed = await call(a, "PATCH", "/api/instance", { name: "Linux box" });
    expect(renamed.body.name).toBe("Linux box");
    expect(renamed.body.capabilities).not.toBeNull();
  });

  test("a read-scope token can neither read nor re-probe capabilities", async () => {
    const a = makeInstance();
    const minted = await call(a, "POST", "/api/access-tokens", {
      name: "dash",
      expiresInDays: null,
      scope: "read",
      repoPaths: null,
    });
    const bearer = { authorization: `Bearer ${minted.body.token as string}` };
    expect((await call(a, "GET", "/api/instance", undefined, bearer)).status).toBe(403);
    expect((await call(a, "POST", "/api/instance/capabilities", undefined, bearer)).status).toBe(
      403,
    );
    expect(a.probe.runs).toBe(0);
  });
});

describe("readiness at acceptance (POST /api/sessions)", () => {
  const create = (i: Instance, extra: Record<string, unknown> = {}) =>
    call(i, "POST", "/api/sessions", {
      repoPath: join(repoRoot, "app"),
      baseBranch: "main",
      prompt: "build it",
      ...extra,
    });

  test("a missing requirement is refused by name and nothing starts or is held", async () => {
    const a = makeInstance();
    const res = await create(a, { requirements: ["android-sdk", "agent:codex", "agent:claude"] });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "missing capabilities: agent:codex (not_logged_in), android-sdk (sdk_not_found)",
      code: "missing_capabilities",
      missing: [
        { capability: "agent:codex", reason: "not_logged_in" },
        { capability: "android-sdk", reason: "sdk_not_found" },
      ],
    });
    expect(a.created).toEqual([]);
    expect(a.deps.store.countHeldTasks()).toBe(0);
  });

  test("met requirements are checked against a fresh probe, then the task starts", async () => {
    const a = makeInstance();
    await call(a, "POST", "/api/instance/capabilities");
    const res = await create(a, { requirements: ["platform:linux", "agent:claude"] });
    expect(res.status).toBe(201);
    expect(a.probe.runs).toBe(2);
    expect(a.created).toHaveLength(1);
    expect(a.created[0]).toMatchObject({ requirements: ["agent:claude", "platform:linux"] });
  });

  test("a Linux instance refuses Xcode work because the capability belongs to macOS", async () => {
    const a = makeInstance();
    const res = await create(a, { requirements: ["xcode"] });
    expect(res.status).toBe(422);
    expect(res.body.missing).toEqual([{ capability: "xcode", reason: "other_platform" }]);
    expect(a.created).toEqual([]);
  });

  test("a keyed create that is refused settles its key; a retry replays the refusal", async () => {
    const a = makeInstance();
    const keyed = { ...operator(), "idempotency-key": "order-1" };
    const body = { repoPath: join(repoRoot, "app"), baseBranch: "main", prompt: "x" };
    const first = await call(
      a,
      "POST",
      "/api/sessions",
      { ...body, requirements: ["xcode"] },
      keyed,
    );
    expect(first.status).toBe(422);
    const retry = await call(
      a,
      "POST",
      "/api/sessions",
      { ...body, requirements: ["xcode"] },
      keyed,
    );
    expect(retry.status).toBe(422);
    expect(retry.body).toMatchObject({
      code: "missing_capabilities",
      error: "missing capabilities: xcode (other_platform)",
    });
    expect((await call(a, "GET", "/api/dispatches/order-1")).body).toMatchObject({
      state: "failed",
      code: "missing_capabilities",
    });
    expect(a.created).toEqual([]);
  });

  test("an unknown capability is a 400 and probes nothing", async () => {
    const a = makeInstance();
    const res = await create(a, { requirements: ["gpu"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown capability: gpu");
    expect(a.probe.runs).toBe(0);
    expect(a.created).toEqual([]);
  });

  test("without requirements nothing is probed and the create runs as before", async () => {
    const a = makeInstance();
    expect((await create(a)).status).toBe(201);
    expect((await create(a, { requirements: [] })).status).toBe(201);
    expect(a.probe.runs).toBe(0);
    expect(a.created).toHaveLength(2);
    expect((a.created[1] as { requirements?: unknown }).requirements).toBeUndefined();
  });
});
