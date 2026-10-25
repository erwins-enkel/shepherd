// #3337: every session's agent-ingress capability is a per-session HMAC key carried in 0600 spawn
// files — never the bare UUID, never argv JSON.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { SessionService, epicAuthoringDirective } from "../src/service";
import { EventHub } from "../src/events";
import { makeAgentIngressApp, type AppDeps } from "../src/server";
import { BrowserTokenSigner } from "../src/browser-token";
import { ASSISTANT_INGRESS_HEADER, ingressStamp } from "../src/assistant-ingress";
import { config } from "../src/config";

const SIGNER = new BrowserTokenSigner(Buffer.alloc(32, 3));
const dirs: string[] = [];
const prevHooksIngest = config.hooksIngest;

afterEach(() => {
  config.hooksIngest = prevHooksIngest;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(opts: { profile?: "trusted" | "standard"; signer?: boolean } = {}) {
  const spawnDir = mkdtempSync(join(tmpdir(), "agent-spawn-"));
  dirs.push(spawnDir);
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", {
    ...store.getRepoConfig("/repo"),
    buildQueueEnabled: true,
    sandboxProfile: opts.profile ?? "trusted",
  });
  const started: { argv: string[]; env: Record<string, string> }[] = [];
  const svc = new SessionService({
    store,
    agentSpawnDir: spawnDir,
    ...(opts.signer === false ? {} : { assistantIngress: SIGNER }),
    agentIngressPort: () => 7331,
    namer: async () => "x",
    transcriptExists: () => true,
    worktree: {
      create: () => ({ worktreePath: "/wt/x", branch: "shepherd/x", isolated: true }),
      ensureBaseRef: async () => {},
      branchExists: () => false,
      remove: () => {},
      gitCommonDir: () => "/wt/x/.git",
    } as any,
    herdr: {
      start: async (_n: string, _c: string, argv: string[], env: Record<string, string>) => {
        started.push({ argv, env });
        return { terminalId: "t1", agentStatus: "working" } as any;
      },
      listAsync: async () => [],
      stop: async () => {},
      send: () => {},
    } as any,
    detectBackend: () => (opts.profile === "standard" ? "bwrap" : null),
    detectEgressBackend: () => null,
  });
  return { store, svc, spawnDir, started };
}

const create = (svc: SessionService, agentProvider?: "claude" | "codex") =>
  svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
    ...(agentProvider ? { agentProvider } : {}),
  });

const flagValue = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1]!;

test("spawn: --settings / --mcp-config are 0600 file paths carrying the key; argv holds neither", async () => {
  config.hooksIngest = true;
  const { svc, spawnDir, started } = harness();
  const s = await create(svc);
  const { argv, env } = started[0]!;
  const key = SIGNER.sign(s.id);
  const settingsPath = flagValue(argv, "--settings");
  const mcpPath = flagValue(argv, "--mcp-config");
  expect(settingsPath).toBe(join(spawnDir, `${s.id}.settings.json`));
  expect(mcpPath).toBe(join(spawnDir, `${s.id}.mcp.json`));
  const headerPath = join(spawnDir, `${s.id}.header`);
  for (const p of [settingsPath, mcpPath, join(spawnDir, `${s.id}.key`), headerPath])
    expect(statSync(p).mode & 0o777).toBe(0o600);

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(settings.hooks.Stop[0].hooks[0].headers[ASSISTANT_INGRESS_HEADER]).toBe(key);
  const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
  expect(mcp.mcpServers.shepherd.headers[ASSISTANT_INGRESS_HEADER]).toBe(key);
  expect(readFileSync(join(spawnDir, `${s.id}.key`), "utf8")).toBe(key);
  expect(readFileSync(headerPath, "utf8")).toBe(`${ASSISTANT_INGRESS_HEADER}: ${key}\n`);

  // Nothing the process list shows carries the key or an ingress URL.
  expect(argv.some((a) => a.includes(key) || a.includes("/api/sessions/"))).toBe(false);
  expect(Object.values(env).some((v) => v.includes(key))).toBe(false);
  expect(env.SHEPHERD_INGRESS_KEY_FILE).toBe(join(spawnDir, `${s.id}.key`));
  expect(env.SHEPHERD_INGRESS_HEADER_FILE).toBe(headerPath);
});

test("resume rewrites the session's spawn files; archive removes them", async () => {
  const { svc, store, spawnDir, started } = harness();
  const s = await create(svc);
  rmSync(join(spawnDir, `${s.id}.settings.json`));
  store.update(s.id, { status: "done", lastState: "done" });
  await svc.resume(s.id);
  const resumed = started.at(-1)!.argv;
  expect(resumed).toContain("--resume");
  expect(flagValue(resumed, "--settings")).toBe(join(spawnDir, `${s.id}.settings.json`));
  expect(existsSync(join(spawnDir, `${s.id}.settings.json`))).toBe(true);

  await svc.archive(s.id);
  for (const f of ["settings.json", "mcp.json", "key", "header"])
    expect(existsSync(join(spawnDir, `${s.id}.${f}`))).toBe(false);
});

test("a membrane-wrapped session RO-binds exactly its own spawn files", async () => {
  const { svc, spawnDir, started } = harness({ profile: "standard" });
  const s = await create(svc);
  const argv = started[0]!.argv;
  expect(argv[0]).toBe("bwrap");
  for (const f of ["settings.json", "mcp.json", "key", "header"]) {
    const p = join(spawnDir, `${s.id}.${f}`);
    const i = argv.indexOf(p);
    expect(argv[i - 1]).toBe("--ro-bind");
    expect(argv[i + 1]).toBe(p);
  }
  // The spawn dir itself is never bound.
  expect(argv).not.toContain(spawnDir);
});

// #3370: a `$(cat …)` expansion would put the key in curl's argv; curl's `-H @file` keeps it off.
function expectCurlsReadHeaderFile(prompt: string): void {
  expect(prompt).not.toContain("$(cat");
  const curls = prompt.split(/(?=curl -s)/).filter((c) => c.startsWith("curl -s"));
  expect(curls.length).toBeGreaterThan(0);
  for (const c of curls) expect(c).toContain(`-H @"$SHEPHERD_INGRESS_HEADER_FILE"`);
}

test("codex: curl directives send the key via -H @header-file, never in argv", async () => {
  const { svc, spawnDir, started } = harness();
  const s = await create(svc, "codex");
  const { argv, env } = started[0]!;
  const prompt = argv.at(-1)!;
  expectCurlsReadHeaderFile(prompt);
  expect(prompt).not.toContain(SIGNER.sign(s.id));
  expect(env.SHEPHERD_INGRESS_HEADER_FILE).toBe(join(spawnDir, `${s.id}.header`));
});

test("codex: the epic-authoring directive sends the key via -H @header-file", () => {
  expectCurlsReadHeaderFile(
    epicAuthoringDirective({ sessionId: "s1", baseUrl: "http://x", agentProvider: "codex" }),
  );
});

function ingressDeps(svc: SessionService, store: SessionStore, signer = true): AppDeps {
  return {
    store,
    service: svc,
    events: new EventHub(),
    ...(signer ? { assistantIngress: SIGNER } : {}),
  } as unknown as AppDeps;
}

test("ingress: a keyless or wrong-key call to a normal session is 401 on every keyed route", async () => {
  const { svc, store } = harness();
  const s = await create(svc);
  const app = makeAgentIngressApp(ingressDeps(svc, store));
  const routes: [string, string][] = [
    ["POST", "hooks"],
    ["POST", "mcp"],
    ["GET", "queue"],
    ["PUT", "queue"],
    ["GET", "epic-draft"],
    ["POST", "rename"],
    ["GET", ""],
  ];
  for (const [method, sub] of routes) {
    for (const key of [null, "0".repeat(64), SIGNER.sign("other-session")]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (key) headers[ASSISTANT_INGRESS_HEADER] = key;
      const res = await app.fetch(
        new Request(`http://x/api/sessions/${s.id}${sub ? `/${sub}` : ""}`, {
          method,
          headers,
          ...(method === "GET" ? {} : { body: "{}" }),
        }),
      );
      expect(`${method} ${sub} ${res.status}`).toBe(`${method} ${sub} 401`);
    }
  }
});

test("ingress: the right key passes; browser needs no header (its own token gates it)", async () => {
  const { svc, store } = harness();
  const s = await create(svc);
  const app = makeAgentIngressApp(ingressDeps(svc, store));
  const ok = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/queue`, {
      headers: { [ASSISTANT_INGRESS_HEADER]: SIGNER.sign(s.id) },
    }),
  );
  expect(ok.status).toBe(200);
  const browser = await app.fetch(new Request(`http://x/api/sessions/${s.id}/browser`));
  expect(browser.status).not.toBe(401);
});

test("ingress: an archived session's key is refused (#3370)", async () => {
  const { svc, store } = harness();
  const s = await create(svc);
  await svc.archive(s.id);
  const app = makeAgentIngressApp(ingressDeps(svc, store));
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/queue`, {
      headers: { [ASSISTANT_INGRESS_HEADER]: SIGNER.sign(s.id) },
    }),
  );
  expect(res.status).toBe(401);
});

test("ingress: no signer (broken key file) refuses every keyed call", async () => {
  const { svc, store } = harness();
  const s = await create(svc);
  const app = makeAgentIngressApp(ingressDeps(svc, store, false));
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/queue`, {
      headers: { [ASSISTANT_INGRESS_HEADER]: SIGNER.sign(s.id) },
    }),
  );
  expect(res.status).toBe(401);
});

// #3341: a session spawned without the current key is stale until a resume re-keys it.
function unstamp(store: SessionStore, id: string): void {
  (store as unknown as { db: { run: (sql: string, p: unknown[]) => void } }).db.run(
    `UPDATE sessions SET ingressStamp=NULL WHERE id=?`,
    [id],
  );
}

test("spawn stamps the current ingress key; codex is never stamped", async () => {
  const { svc, store } = harness();
  const s = await create(svc);
  const stamp = store.get(s.id)!.ingressStamp;
  expect(stamp).toBe(ingressStamp(SIGNER));
  expect(stamp).not.toContain(SIGNER.sign(s.id));
  expect(await svc.ingressStale(store.get(s.id)!)).toBe(false);
  const c = await create(svc, "codex");
  expect(store.get(c.id)!.ingressStamp ?? null).toBeNull();
});

test("regression: keyless session → resume at idle → hook POST with key is accepted", async () => {
  config.hooksIngest = true;
  const { svc, store, spawnDir } = harness();
  const s = await create(svc);
  // Simulate a pre-#3339 spawn: no spawn files, no stamp.
  for (const f of ["settings.json", "mcp.json", "key", "header"])
    rmSync(join(spawnDir, `${s.id}.${f}`));
  unstamp(store, s.id);
  expect(await svc.ingressStale(store.get(s.id)!)).toBe(true);

  store.update(s.id, { status: "done", lastState: "done" });
  expect(await svc.resume(s.id, { force: true })).not.toBeNull();
  expect(store.get(s.id)!.ingressStamp).toBe(ingressStamp(SIGNER));
  expect(await svc.ingressStale(store.get(s.id)!)).toBe(false);

  const settings = JSON.parse(readFileSync(join(spawnDir, `${s.id}.settings.json`), "utf8"));
  const key = settings.hooks.Stop[0].hooks[0].headers[ASSISTANT_INGRESS_HEADER];
  const app = makeAgentIngressApp(ingressDeps(svc, store));
  const post = (headers: Record<string, string>) =>
    app.fetch(
      new Request(`http://x/api/sessions/${s.id}/hooks`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ hook_event_name: "Stop", session_id: s.claudeSessionId }),
      }),
    );
  expect((await post({ [ASSISTANT_INGRESS_HEADER]: key })).status).toBe(202); // the Stop ack
  expect((await post({})).status).toBe(401);
});

test("a null stamp whose settings file already carries the key is backfilled, not stale", async () => {
  config.hooksIngest = true;
  const { svc, store } = harness();
  const s = await create(svc);
  unstamp(store, s.id);
  expect(await svc.ingressStale(store.get(s.id)!)).toBe(false);
  expect(store.get(s.id)!.ingressStamp).toBe(ingressStamp(SIGNER));
});

test("a stamp from another key or spawn-file version is stale", async () => {
  const { svc, store } = harness();
  const s = await create(svc);
  store.setIngressStamp(s.id, "v0:deadbeefdeadbeef");
  expect(await svc.ingressStale(store.get(s.id)!)).toBe(true);
});

test("no signer: never stale (a resume cannot help)", async () => {
  const { svc, store } = harness({ signer: false });
  const s = await create(svc);
  expect(store.get(s.id)!.ingressStamp ?? null).toBeNull();
  expect(await svc.ingressStale(store.get(s.id)!)).toBe(false);
});
