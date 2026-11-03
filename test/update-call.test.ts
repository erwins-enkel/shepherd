import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { EventHub } from "../src/events";
import { SESSION_COOKIE, signCookie } from "../src/operator-auth";
import { makeApp, serve, type AppDeps } from "../src/server";
import { SessionService } from "../src/service";
import { SessionStore } from "../src/store";
import {
  ingestUpdateJournal,
  lastUpdateCall,
  recordUpdateCall,
  type UpdateCallRecord,
} from "../src/update-call";
import { buildDeliveryMetrics } from "../src/delivery-metrics";

const SECRET = "test-cookie-signing-secret";
const ENV_TOKEN = "env-operator-token-value";
const SESSION_ID = "66666666-7777-4888-8999-000000000000";
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

let prevSecret: string | null;
let prevToken: string | null;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  prevSecret = config.cookieSecret;
  prevToken = config.token;
  config.cookieSecret = SECRET;
  config.token = null;
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  config.cookieSecret = prevSecret;
  config.token = prevToken;
  logSpy.mockRestore();
});

type Updates = NonNullable<AppDeps["updates"]>;

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {} as never,
    herdr: { list: () => [] } as never,
    events,
  });
  return { store, service, events, ...overrides } as AppDeps;
}

const behind = (apply?: Updates["apply"]): Updates => ({
  current: () => ({ behind: 1, current: "aaaaaaa", latest: "bbbbbbb", commits: [], checkedAt: 1 }),
  apply: apply ?? (() => ({ started: true })),
});

const cookie = () => `${SESSION_COOKIE}=${signCookie(SECRET)}`;

const recordsOf = (deps: AppDeps): UpdateCallRecord[] =>
  deps.store.listSignalsByKind("update_call", 0, 50).map((s) => JSON.parse(s.payload));

const post = (headers: Record<string, string>, body: unknown = {}) =>
  new Request("http://localhost:7330/api/update", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

async function mintToken(deps: AppDeps, scope = "full", name = "ci-box"): Promise<string> {
  const res = await makeApp(deps).fetch(
    new Request("http://localhost:7330/api/access-tokens", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie() },
      body: JSON.stringify({ name, expiresInDays: null, scope, repoPaths: null }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

function withSession(deps: AppDeps, desig = "TASK-07"): void {
  const real = deps.store.get.bind(deps.store);
  spyOn(deps.store, "get").mockImplementation(((id: string) =>
    id === SESSION_ID ? { id, desig } : real(id)) as typeof deps.store.get);
}

// ── who called ──────────────────────────────────────────────────────────────

test("a cookie call records the surface with its sanitized client", async () => {
  const deps = makeDeps({ updates: behind() });
  const res = await makeApp(deps).fetch(
    post({ cookie: cookie(), "user-agent": `${FIREFOX}\u0007${"x".repeat(400)}` }),
  );
  expect(res.status).toBe(202);
  const [record] = recordsOf(deps);
  expect(record).toMatchObject({
    outcome: "started",
    reason: null,
    from: "aaaaaaa",
    to: "bbbbbbb",
    machine: null,
    session: null,
  });
  expect(record!.caller.kind).toBe("surface");
  const { ua } = record!.caller as { ua: string };
  expect(ua.startsWith(FIREFOX)).toBe(true);
  expect(ua).not.toContain("\u0007");
  expect(ua.length).toBeLessThanOrEqual(200);
});

test("a token call from an agent session records the token and the session's desig", async () => {
  const deps = makeDeps({ updates: behind(), peerSessionId: async () => SESSION_ID });
  withSession(deps);
  const token = await mintToken(deps);
  const res = await makeApp(deps).fetch(
    post({ authorization: `Bearer ${token}`, "user-agent": "curl/8.0" }),
  );
  expect(res.status).toBe(202);
  const [record] = recordsOf(deps);
  expect(record!.caller).toEqual({
    kind: "token",
    name: "ci-box",
    client: "other",
    ua: "curl/8.0",
  });
  expect(record!.session).toEqual({ id: SESSION_ID, desig: "TASK-07" });
  const signal = deps.store.listSignalsByKind("update_call", 0, 1)[0]!;
  expect(signal.sessionId).toBe(SESSION_ID);
});

test("a token call without a marker names only the token; a garbage marker is no session", async () => {
  for (const marker of [null, "../../not-a-session"]) {
    const deps = makeDeps({ updates: behind(), peerSessionId: async () => marker });
    const token = await mintToken(deps);
    await makeApp(deps).fetch(post({ authorization: `Bearer ${token}` }));
    expect(recordsOf(deps)[0]).toMatchObject({ caller: { kind: "token" }, session: null });
  }
});

test("a failing peer lookup never fails the update", async () => {
  const deps = makeDeps({
    updates: behind(),
    peerSessionId: async () => {
      throw new Error("no /proc");
    },
  });
  const res = await makeApp(deps).fetch(post({ cookie: cookie() }));
  expect(res.status).toBe(202);
  expect(recordsOf(deps)[0]!.session).toBeNull();
});

test("the CLI's and a relay's user agents classify; SHEPHERD_TOKEN is env_token", async () => {
  config.token = ENV_TOKEN;
  const deps = makeDeps({ updates: behind() });
  const app = makeApp(deps);
  await app.fetch(post({ authorization: `Bearer ${ENV_TOKEN}`, "user-agent": "shepherd-cli/2.0" }));
  await app.fetch(
    post({ authorization: `Bearer ${ENV_TOKEN}`, "user-agent": "shepherd-relay/2.0" }),
  );
  await app.fetch(post({ authorization: `Bearer ${ENV_TOKEN}` }));
  const clients = recordsOf(deps).map((r) => r.caller);
  expect(clients.every((c) => c.kind === "env_token")).toBe(true);
  expect(clients.map((c) => (c as { client: string }).client).sort()).toEqual([
    "cli",
    "other",
    "relay",
  ]);
});

// Real listener, real /proc, a real client process: what the fixtures cannot prove.
test.skipIf(process.platform !== "linux")(
  "a real client process carrying the marker is attributed through its socket",
  async () => {
    const deps = makeDeps({ updates: behind() });
    withSession(deps);
    const token = await mintToken(deps);
    const server = serve(deps, 0);
    try {
      const client = Bun.spawn(
        [
          "curl",
          "-s",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "-X",
          "POST",
          "-H",
          `Authorization: Bearer ${token}`,
          "-H",
          "Content-Type: application/json",
          "-d",
          "{}",
          `http://127.0.0.1:${server.port}/api/update`,
        ],
        { env: { ...process.env, SHEPHERD_SESSION_ID: SESSION_ID }, stdout: "pipe" },
      );
      expect(await new Response(client.stdout).text()).toBe("202");
      expect(recordsOf(deps)[0]!.session).toEqual({ id: SESSION_ID, desig: "TASK-07" });
    } finally {
      server.stop(true);
    }
  },
);

// ── outcomes ────────────────────────────────────────────────────────────────

test("nothing to do, a running deploy, a bad body, no updater and a stale discard are recorded", async () => {
  const cases: [Partial<AppDeps>, unknown, string, string][] = [
    [
      {
        updates: {
          ...behind(),
          current: () => ({ behind: 0, current: "a", latest: "a", commits: [], checkedAt: 1 }),
        },
      },
      {},
      "nothing_to_do",
      "no_update",
    ],
    [
      {
        updates: behind(() => ({
          started: false,
          code: "already_running",
          error: "a deploy is already running",
        })),
      },
      {},
      "rejected",
      "already_running",
    ],
    [{ updates: behind() }, { discard: "yes" }, "rejected", "bad_request"],
    [{}, {}, "rejected", "unavailable"],
    [
      {
        updates: {
          ...behind(),
          dirtyStatus: async () => ({
            dirty: true,
            dirtyFiles: [],
            dirtyCount: 1,
            sig: "fresh",
            pathspecAll: Buffer.alloc(0),
            pathspecWorktree: Buffer.alloc(0),
          }),
        },
      },
      { discard: true, sig: "confirmed-signature" },
      "rejected",
      "stale",
    ],
  ];
  for (const [overrides, body, outcome, reason] of cases) {
    const deps = makeDeps(overrides);
    const res = await makeApp(deps).fetch(post({ cookie: cookie() }, body));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordsOf(deps)[0]).toMatchObject({ outcome, reason });
  }
});

test("a body that is no object answers 400 and stays on record", async () => {
  for (const body of [null, 5, "x", []]) {
    let applied = 0;
    const deps = makeDeps({
      updates: behind(() => {
        applied++;
        return { started: true };
      }),
    });
    const res = await makeApp(deps).fetch(post({ cookie: cookie() }, body));
    expect(res.status).toBe(400);
    expect(applied).toBe(0);
    expect(recordsOf(deps)[0]).toMatchObject({
      outcome: "rejected",
      reason: "bad_request",
      discard: false,
    });
  }
});

test("a request with no body at all is still a plain update", async () => {
  const deps = makeDeps({ updates: behind() });
  const res = await makeApp(deps).fetch(
    new Request("http://localhost:7330/api/update", {
      method: "POST",
      headers: { cookie: cookie() },
    }),
  );
  expect(res.status).toBe(202);
  expect(recordsOf(deps)[0]!.outcome).toBe("started");
});

test("a call that throws answers 500 and stays on record with a fixed reason", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const deps = makeDeps({
    updates: {
      ...behind(),
      dirtyStatus: async () => {
        throw new Error("git said something private");
      },
    },
  });
  const res = await makeApp(deps).fetch(
    post({ cookie: cookie() }, { discard: true, sig: "confirmed" }),
  );
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "could not start the update" });
  expect(recordsOf(deps)[0]).toMatchObject({
    outcome: "rejected",
    reason: "internal_error",
    discard: true,
    caller: { kind: "surface" },
  });
  expect(deps.store.listSignalsByKind("update_call", 0, 1)[0]!.payload).not.toContain("private");
  warn.mockRestore();
});

test("attribution that throws never fails the update", async () => {
  const deps = makeDeps({
    updates: behind(),
    peerSessionId: () => {
      throw new Error("sync failure");
    },
  });
  const res = await makeApp(deps).fetch(post({ cookie: cookie() }));
  expect(res.status).toBe(202);
  expect(recordsOf(deps)[0]!.session).toBeNull();
});

test("a store that cannot record never stops the update", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const applied: unknown[] = [];
  const deps = makeDeps({
    updates: behind((opts) => {
      applied.push(opts);
      return { started: true };
    }),
  });
  spyOn(deps.store, "addSignal").mockImplementation(() => {
    throw new Error("db locked");
  });
  const res = await makeApp(deps).fetch(post({ cookie: cookie() }));
  expect(res.status).toBe(202);
  expect(applied).toHaveLength(1);
  warn.mockRestore();
});

// ── no secrets ──────────────────────────────────────────────────────────────

test("neither log nor signal holds a token, a cookie, a signature or body text", async () => {
  const deps = makeDeps({
    updates: {
      ...behind(),
      dirtyStatus: async () => ({
        dirty: true,
        dirtyFiles: [],
        dirtyCount: 1,
        sig: "other",
        pathspecAll: Buffer.alloc(0),
        pathspecWorktree: Buffer.alloc(0),
      }),
    },
    peerSessionId: async () => SESSION_ID,
  });
  const token = await mintToken(deps, "full", "ci-box");
  const sessionCookie = cookie();
  const prompt = "PROMPT: please rewrite the billing module";
  const sig = "confirmed-signature-value";
  const app = makeApp(deps);
  await app.fetch(post({ authorization: `Bearer ${token}` }, { discard: true, sig, prompt }));
  await app.fetch(post({ cookie: sessionCookie }, { prompt }));
  const logged = logSpy.mock.calls.flat().join("\n");
  const stored = deps.store
    .listSignalsByKind("update_call", 0, 50)
    .map((s) => s.payload)
    .join("\n");
  expect(stored).not.toBe("");
  for (const haystack of [logged, stored]) {
    expect(haystack).not.toContain(token);
    expect(haystack).not.toContain(sessionCookie.split("=")[1]!);
    expect(haystack).not.toContain(sig);
    expect(haystack).not.toContain("PROMPT");
  }
});

test("a log line cannot be forged through a token name", async () => {
  const deps = makeDeps({ updates: behind() });
  const token = await mintToken(deps, "full", "evil\n[update] outcome=started caller=surface");
  await makeApp(deps).fetch(post({ authorization: `Bearer ${token}` }));
  const line = (logSpy.mock.calls as unknown[][])
    .map((c) => String(c[0]))
    .find((l) => l.startsWith("[update]"))!;
  expect(line).not.toContain("\n");
});

// ── GET /api/update/last ────────────────────────────────────────────────────

const last = (app: ReturnType<typeof makeApp>, headers: Record<string, string>) =>
  app.fetch(new Request("http://localhost:7330/api/update/last", { headers }));

test("GET /api/update/last answers null, then the newest started or applied call", async () => {
  const deps = makeDeps({ updates: behind() });
  const app = makeApp(deps);
  const empty = await last(app, { cookie: cookie() });
  expect(await empty.json()).toEqual({ last: null });

  await app.fetch(post({ cookie: cookie() }));
  // A later refusal is on the record but is not who last updated this Shepherd.
  recordUpdateCall(deps.store, {
    ...recordsOf(deps)[0]!,
    outcome: "rejected",
    reason: "already_running",
    requestId: REQUEST_ID,
  });
  const body = (await (await last(app, { cookie: cookie() })).json()) as {
    last: UpdateCallRecord;
  };
  expect(body.last.outcome).toBe("started");
  expect(body.last.caller.kind).toBe("surface");
});

test("GET /api/update/last needs a full token", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  for (const scope of ["read", "submit"]) {
    const token = await mintToken(deps, scope, `${scope}-token`);
    const res = await last(app, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(403);
  }
  const full = await mintToken(deps, "full", "full-token");
  expect((await last(app, { authorization: `Bearer ${full}` })).status).toBe(200);
});

// ── journal ─────────────────────────────────────────────────────────────────

const journalDirs: string[] = [];
afterEach(() => {
  for (const dir of journalDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function journalPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "update-journal-"));
  journalDirs.push(dir);
  return join(dir, "update-journal.jsonl");
}

const line = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    at: Date.now(),
    from: "aaaaaaa",
    to: "bbbbbbb",
    pull: true,
    tty: false,
    app: false,
    ...fields,
  });

const startedRecord = (overrides: Partial<UpdateCallRecord> = {}): UpdateCallRecord => ({
  v: 1,
  requestId: REQUEST_ID,
  at: Date.now() - 1000,
  outcome: "started",
  reason: null,
  from: "aaaaaaa",
  to: "bbbbbbb",
  discard: true,
  caller: { kind: "surface", ua: FIREFOX },
  session: null,
  machine: null,
  ...overrides,
});

test("a line with the request id finishes that call, keeping who started it", async () => {
  const deps = makeDeps();
  recordUpdateCall(deps.store, startedRecord());
  const path = journalPath();
  writeFileSync(path, `${line({ requestId: REQUEST_ID })}\n`);
  await ingestUpdateJournal(deps.store, path);
  expect(lastUpdateCall(deps.store)).toMatchObject({
    outcome: "applied",
    requestId: REQUEST_ID,
    to: "bbbbbbb",
    discard: true,
    caller: { kind: "surface", ua: FIREFOX },
  });
});

test("a direct run from a session records the script and the desig", async () => {
  const deps = makeDeps();
  withSession(deps);
  const path = journalPath();
  writeFileSync(path, `${line({ sessionId: SESSION_ID })}\n`);
  await ingestUpdateJournal(deps.store, path);
  expect(lastUpdateCall(deps.store)).toMatchObject({
    outcome: "applied",
    caller: { kind: "script", tty: false },
    session: { id: SESSION_ID, desig: "TASK-07" },
  });
});

test("an app run pairs with a recent local start, once; otherwise it is the app's own", async () => {
  const deps = makeDeps();
  recordUpdateCall(deps.store, startedRecord());
  const path = journalPath();
  writeFileSync(path, `${line({ app: true })}\n`);
  await ingestUpdateJournal(deps.store, path);
  expect(lastUpdateCall(deps.store)).toMatchObject({
    requestId: REQUEST_ID,
    caller: { kind: "surface" },
  });
  // The handoff is finished, so the next app run is the app's own button.
  writeFileSync(path, `${line({ app: true })}\n`);
  await ingestUpdateJournal(deps.store, path);
  expect(lastUpdateCall(deps.store)).toMatchObject({ requestId: null, caller: { kind: "app" } });
});

test("an app run does not pair with a start older than the window", async () => {
  const deps = makeDeps();
  recordUpdateCall(deps.store, startedRecord({ at: Date.now() - 16 * 60_000 }));
  const path = journalPath();
  writeFileSync(path, `${line({ app: true })}\n`);
  await ingestUpdateJournal(deps.store, path);
  expect(lastUpdateCall(deps.store)).toMatchObject({ caller: { kind: "app" } });
});

test("a relayed start changes neither the last update nor an app run's pairing", async () => {
  const deps = makeDeps();
  const machine = { id: "m1", name: "macbook" };
  recordUpdateCall(deps.store, startedRecord({ machine }));
  expect(lastUpdateCall(deps.store)).toBeNull();
  const path = journalPath();
  writeFileSync(path, `${line({ app: true })}\n`);
  await ingestUpdateJournal(deps.store, path);
  expect(lastUpdateCall(deps.store)).toMatchObject({
    requestId: null,
    caller: { kind: "app" },
    machine: null,
  });
});

test("tampered lines are dropped and a second ingest adds nothing", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const deps = makeDeps();
  const path = journalPath();
  writeFileSync(
    path,
    [
      "not json",
      "null",
      line({ to: "$(rm -rf /)" }),
      line({ from: 42 }),
      line({ at: "yesterday" }),
      line({ tty: "yes" }),
      line({ sessionId: "../../etc/passwd" }),
      line({ requestId: "nope" }),
      line(),
    ].join("\n"),
  );
  await ingestUpdateJournal(deps.store, path);
  expect(recordsOf(deps)).toHaveLength(1);
  expect(existsSync(path)).toBe(false);
  await ingestUpdateJournal(deps.store, path);
  expect(recordsOf(deps)).toHaveLength(1);
  warn.mockRestore();
});

test("a time no Date can hold is dropped and the lines after it still count", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const deps = makeDeps();
  const path = journalPath();
  writeFileSync(path, `${line({ at: 1e20 })}\n${line({ to: "ccccccc" })}\n`);
  await ingestUpdateJournal(deps.store, path);
  expect(recordsOf(deps).map((r) => r.to)).toEqual(["ccccccc"]);
  warn.mockRestore();
});

test("a line that cannot be recorded does not lose the rest of the batch", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const deps = makeDeps();
  const real = deps.store.addSignal.bind(deps.store);
  let calls = 0;
  spyOn(deps.store, "addSignal").mockImplementation((input) => {
    if (++calls === 1) throw new Error("db locked");
    return real(input);
  });
  const path = journalPath();
  writeFileSync(path, `${line({ to: "ccccccc" })}\n${line({ to: "ddddddd" })}\n`);
  await ingestUpdateJournal(deps.store, path);
  expect(recordsOf(deps).map((r) => r.to)).toEqual(["ddddddd"]);
  warn.mockRestore();
});

test("a missing journal is fine; a leftover claim from a crash is taken over first", async () => {
  const deps = makeDeps();
  const path = journalPath();
  await ingestUpdateJournal(deps.store, path);
  expect(recordsOf(deps)).toEqual([]);
  writeFileSync(`${path}.ingesting`, `${line({ to: "ccccccc" })}\n`);
  writeFileSync(path, `${line({ to: "ddddddd" })}\n`);
  await ingestUpdateJournal(deps.store, path);
  expect(
    recordsOf(deps)
      .map((r) => r.to)
      .sort(),
  ).toEqual(["ccccccc", "ddddddd"]);
  expect(existsSync(`${path}.ingesting`)).toBe(false);
});

test("an oversized journal is read from its tail; a symlinked claim is not followed", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const deps = makeDeps();
  const path = journalPath();
  writeFileSync(path, `${"x".repeat(70 * 1024)}\n${line({ to: "eeeeeee" })}\n`);
  await ingestUpdateJournal(deps.store, path);
  expect(recordsOf(deps).map((r) => r.to)).toEqual(["eeeeeee"]);

  const secret = `${path}.outside`;
  writeFileSync(secret, `${line({ to: "fffffff" })}\n`);
  symlinkSync(secret, path);
  await ingestUpdateJournal(deps.store, path);
  expect(recordsOf(deps).map((r) => r.to)).toEqual(["eeeeeee"]);
  warn.mockRestore();
});

// ── tallies ─────────────────────────────────────────────────────────────────

test("update calls are no delivery incidents", () => {
  const deps = makeDeps();
  recordUpdateCall(deps.store, startedRecord());
  const { incidents } = buildDeliveryMetrics({ store: deps.store, range: "30d", now: Date.now() });
  expect(incidents).toEqual([]);
});
