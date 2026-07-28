// Coverage for the `ctx.sessions` plugin capability (#1958): the pure projection
// (src/plugins/session-view.ts), the read-only store getter it reads PR state from, and the
// whole path end-to-end through a real PluginRegistry + a real plugin folder.
//
// Lives under test/ rather than beside the loader because CI runs `bun test ./test` only —
// a co-located src/**/*.test.ts would not gate anything.
import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { PluginRegistry } from "../src/plugins/loader";
import { toPluginSessionSnapshot } from "../src/plugins/session-view";
import type { PluginSessionSnapshot } from "../src/plugins/types";
import type { GitState } from "../src/forge/types";
import type { Session } from "../src/types";

// ── fixtures ───────────────────────────────────────────────────────────────────

const sessionInput = (name: string, repo = "/repos/shepherd") => ({
  name,
  prompt: "secret task text",
  repoPath: repo,
  baseBranch: "main",
  branch: `shepherd/${name}`,
  worktreePath: `/worktrees/${name}`,
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_a",
});

const GIT: GitState = {
  kind: "github",
  state: "open",
  number: 42,
  url: "https://github.com/o/r/pull/42",
  title: "feat: a thing",
  checks: "success",
  isDraft: false,
  deployConfigured: false,
};

/** Point a registry at a throwaway plugin folder whose entry echoes `ctx.sessions` back
 *  out over its own routes — the only way to observe the capability as a plugin sees it. */
async function makeProbePlugin(dir: string): Promise<void> {
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({
      id: "probe",
      name: "Probe",
      version: "1.0.0",
      apiVersion: 1,
      capabilities: ["state"],
    }),
  );
  await writeFile(
    join(dir, "index.ts"),
    `export function register(ctx) {
       ctx.route("GET", "one", (req) => {
         const id = new URL(req.url).searchParams.get("id");
         return Response.json({ snapshot: ctx.sessions.get(id) });
       });
       ctx.route("GET", "all", () => Response.json({ list: ctx.sessions.list() }));
     }`,
  );
}

async function probe(registry: PluginRegistry, path: string): Promise<Record<string, unknown>> {
  // Routes are keyed by the sub-path alone; the query string rides on the Request, exactly as
  // the real server splits it.
  const route = path.split("?")[0]!;
  const res = await registry.handleRoute("GET", "probe", route, new Request(`http://x/${path}`));
  expect(res?.status).toBe(200);
  return (await res!.json()) as Record<string, unknown>;
}

// ── the pure projection ────────────────────────────────────────────────────────

test("toPluginSessionSnapshot projects the curated fields and the PR block", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(sessionInput("alpha"));

  const snap = toPluginSessionSnapshot(s, GIT);

  expect(snap.id).toBe(s.id);
  expect(snap.desig).toBe(s.desig);
  expect(snap.name).toBe("alpha");
  expect(snap.repoPath).toBe("/repos/shepherd");
  expect(snap.baseBranch).toBe("main");
  expect(snap.branch).toBe("shepherd/alpha");
  expect(snap.status).toBe("running");
  expect(snap.archivedAt).toBeNull();
  expect(snap.pr).toEqual({
    state: "open",
    number: 42,
    url: "https://github.com/o/r/pull/42",
    title: "feat: a thing",
    checks: "success",
    isDraft: false,
  });
});

test("toPluginSessionSnapshot withholds prompt, worktree and account fields", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(sessionInput("beta"));

  const snap = toPluginSessionSnapshot(s, null) as unknown as Record<string, unknown>;

  // The guard that keeps the curated surface curated as `Session` grows: these must never
  // appear, whatever is added to the row.
  for (const withheld of ["prompt", "worktreePath", "spawnAccountDir", "launchMetadata"]) {
    expect(Object.keys(snap)).not.toContain(withheld);
  }
  expect(snap.pr).toBeNull();
});

test("toPluginSessionSnapshot omits absent optional PR fields and defaults a legacy provider", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(sessionInput("gamma"));
  // A row predating the agentProvider column reads as undefined; every such session is Claude.
  const legacy: Session = { ...s, agentProvider: undefined };

  const snap = toPluginSessionSnapshot(legacy, {
    kind: "github",
    state: "none",
    checks: "none",
    deployConfigured: false,
  });

  expect(snap.agentProvider).toBe("claude");
  // Omitted, not present-and-undefined — the snapshot must survive a JSON round-trip
  // unchanged, since a plugin may persist it in ctx.state.
  expect(snap.pr).toEqual({ state: "none", checks: "none" });
  expect(JSON.parse(JSON.stringify(snap.pr)) as unknown).toEqual(snap.pr);
});

// ── the read-only store getter ─────────────────────────────────────────────────

test("getSessionGitCache reads a cached PR back and returns null for an uncached session", () => {
  const store = new SessionStore(":memory:");
  const withPr = store.create(sessionInput("delta"));
  const withoutPr = store.create(sessionInput("epsilon"));
  expect(store.putSessionGitCache(withPr.id, GIT)).toBe(true);

  expect(store.getSessionGitCache(withPr.id)?.number).toBe(42);
  expect(store.getSessionGitCache(withoutPr.id)).toBeNull();
  expect(store.getSessionGitCache("no-such-session")).toBeNull();
});

test("getSessionGitCache reads an archived session as null", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(sessionInput("zeta"));
  store.putSessionGitCache(s.id, GIT);

  store.archive(s.id);

  expect(store.getSessionGitCache(s.id)).toBeNull();
});

test("getSessionGitCache reads an unparseable row as null WITHOUT pruning it", async () => {
  // A file-backed store so a second connection can plant the malformed row — the read must be
  // provably side-effect-free, which an in-memory store gives no way to observe.
  const dir = await mkdtemp(join(tmpdir(), "shepherd-plugin-sessions-"));
  const dbPath = join(dir, "s.db");
  try {
    const store = new SessionStore(dbPath);
    const s = store.create(sessionInput("eta"));
    store.putSessionGitCache(s.id, GIT);

    const side = new Database(dbPath);
    side.run(`UPDATE session_git_cache SET gitJson = ? WHERE sessionId = ?`, ["{not json", s.id]);

    expect(store.getSessionGitCache(s.id)).toBeNull();
    // listSessionGitCache prunes invalid rows; this read must not — a plugin read may never
    // mutate core state.
    const row = side
      .query(`SELECT COUNT(*) AS n FROM session_git_cache WHERE sessionId = ?`)
      .get(s.id) as { n: number };
    expect(row.n).toBe(1);
    side.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── end-to-end through a real registry ─────────────────────────────────────────

test("ctx.sessions resolves ids for a loaded plugin, with PR state and null for unknown ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shepherd-plugin-sessions-"));
  const pluginDir = join(dir, "probe");
  await mkdir(pluginDir);
  await makeProbePlugin(pluginDir);

  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const registry = new PluginRegistry({ pluginsDir: dir, store, events });
  try {
    const withPr = store.create(sessionInput("theta"));
    const plain = store.create(sessionInput("iota", "/repos/other"));
    store.putSessionGitCache(withPr.id, GIT);

    await registry.loadAll();
    expect(registry.list().find((p) => p.id === "probe")?.health).toBe("ok");

    const hit = (await probe(registry, `one?id=${withPr.id}`)).snapshot as PluginSessionSnapshot;
    expect(hit.desig).toBe(withPr.desig);
    expect(hit.name).toBe("theta");
    expect(hit.pr?.number).toBe(42);

    const bare = (await probe(registry, `one?id=${plain.id}`)).snapshot as PluginSessionSnapshot;
    expect(bare.repoPath).toBe("/repos/other");
    expect(bare.pr).toBeNull();

    expect((await probe(registry, "one?id=nope")).snapshot).toBeNull();

    const list = (await probe(registry, "all")).list as PluginSessionSnapshot[];
    expect(list.map((s) => s.name).sort()).toEqual(["iota", "theta"]);
  } finally {
    registry.teardown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ctx.sessions reflects state written after register(), not a boot-time freeze", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shepherd-plugin-sessions-"));
  const pluginDir = join(dir, "probe");
  await mkdir(pluginDir);
  await makeProbePlugin(pluginDir);

  const store = new SessionStore(":memory:");
  const registry = new PluginRegistry({ pluginsDir: dir, store, events: new EventHub() });
  try {
    await registry.loadAll();
    expect((await probe(registry, "all")).list).toEqual([]);

    // The session a plugin actually cares about is usually spawned long after it registered.
    const late = store.create(sessionInput("kappa"));

    const snap = (await probe(registry, `one?id=${late.id}`)).snapshot as PluginSessionSnapshot;
    expect(snap.name).toBe("kappa");
  } finally {
    registry.teardown();
    await rm(dir, { recursive: true, force: true });
  }
});
