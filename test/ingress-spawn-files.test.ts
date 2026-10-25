// #3337: every session's agent-ingress capability is a per-session HMAC key carried in 0600 spawn
// files — never the bare UUID, never argv JSON.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeAgentIngressApp, type AppDeps } from "../src/server";
import { BrowserTokenSigner } from "../src/browser-token";
import { ASSISTANT_INGRESS_HEADER } from "../src/assistant-ingress";
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
  for (const p of [settingsPath, mcpPath, join(spawnDir, `${s.id}.key`)])
    expect(statSync(p).mode & 0o777).toBe(0o600);

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(settings.hooks.Stop[0].hooks[0].headers[ASSISTANT_INGRESS_HEADER]).toBe(key);
  const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
  expect(mcp.mcpServers.shepherd.headers[ASSISTANT_INGRESS_HEADER]).toBe(key);
  expect(readFileSync(join(spawnDir, `${s.id}.key`), "utf8")).toBe(key);

  // Nothing the process list shows carries the key or an ingress URL.
  expect(argv.some((a) => a.includes(key) || a.includes("/api/sessions/"))).toBe(false);
  expect(Object.values(env).some((v) => v.includes(key))).toBe(false);
  expect(env.SHEPHERD_INGRESS_KEY_FILE).toBe(join(spawnDir, `${s.id}.key`));
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
  for (const f of ["settings.json", "mcp.json", "key"])
    expect(existsSync(join(spawnDir, `${s.id}.${f}`))).toBe(false);
});

test("a membrane-wrapped session RO-binds exactly its own spawn files", async () => {
  const { svc, spawnDir, started } = harness({ profile: "standard" });
  const s = await create(svc);
  const argv = started[0]!.argv;
  expect(argv[0]).toBe("bwrap");
  for (const f of ["settings.json", "mcp.json", "key"]) {
    const p = join(spawnDir, `${s.id}.${f}`);
    const i = argv.indexOf(p);
    expect(argv[i - 1]).toBe("--ro-bind");
    expect(argv[i + 1]).toBe(p);
  }
  // The spawn dir itself is never bound.
  expect(argv).not.toContain(spawnDir);
});

test("codex: curl directives read the key from SHEPHERD_INGRESS_KEY_FILE, never inline it", async () => {
  const { svc, spawnDir, started } = harness();
  const s = await create(svc, "codex");
  const { argv, env } = started[0]!;
  const prompt = argv.at(-1)!;
  expect(prompt).toContain(`-H "${ASSISTANT_INGRESS_HEADER}: $(cat "$SHEPHERD_INGRESS_KEY_FILE")"`);
  expect(prompt).not.toContain(SIGNER.sign(s.id));
  expect(env.SHEPHERD_INGRESS_KEY_FILE).toBe(join(spawnDir, `${s.id}.key`));
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
