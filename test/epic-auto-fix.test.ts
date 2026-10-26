import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import { autoBlockers, type AutoBlockers, type EpicAutoFixState } from "../src/auto-blockers";
import { resolveProfile } from "../src/sandbox";
import { validateEpicAutoFixRequest } from "../src/validate";
import type { Epic } from "../src/epic-core";

// #3453: GET|POST /api/epic/auto-fix — the blockers model for any epic, a fix in one step, Undo.

let tmpRoot: string;
let repo: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-epic-auto-fix-test-"));
  repo = join(tmpRoot, "repo");
  mkdirSync(repo);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

type FakeDrain = NonNullable<AppDeps["drain"]>;

function harness(opts: { host?: { bwrap: boolean; egress: boolean }; remoteHttps?: boolean } = {}) {
  const store = new SessionStore(":memory:");
  const emitted: Epic[] = [];
  const events = new EventHub();
  events.subscribe((event, data) => {
    if (event === "epic:update") emitted.push(data as Epic);
  });
  let ticks = 0;
  const drain: FakeDrain = {
    snapshot: async () => [],
    queue: async () => [],
    retainClaim: () => {},
    buildEpic: async (repoPath, run) => ({
      repoPath,
      parentIssueNumber: run.parentIssueNumber,
      parentTitle: "Epic",
      source: "native",
      children: [],
      warnings: [],
      run,
    }),
    diagnoseEpic: async () => null,
    approveEpicNext: () => {},
    promoteQueuedEpic: () => null,
    tick: async () => {
      ticks++;
    },
    // The real model over the store's live settings: inherit → standard, the global CLI → Claude.
    autoBlockers: (repoPath, run) =>
      autoBlockers(
        { agentProvider: run.agentProvider ?? "claude" },
        {
          profile: resolveProfile(
            undefined,
            store.getRepoConfig(repoPath).sandboxProfile,
            "standard",
          ),
          remoteHttps: opts.remoteHttps ?? true,
        },
        opts.host ?? { bwrap: true, egress: true },
      ),
  };
  const deps: AppDeps = {
    store,
    service: {} as AppDeps["service"],
    events,
    usageLimits: { limits: () => ({}) } as any,
    drain,
    readCodexAuthMode: () => "unknown",
  };
  return { app: makeApp(deps), deps, store, emitted, ticks: () => ticks };
}

const q = (dir: string, parent: number) =>
  `http://x/api/epic/auto-fix?repo=${encodeURIComponent(dir)}&parent=${parent}`;

async function get(app: ReturnType<typeof makeApp>, dir: string, parent: number) {
  return app.fetch(new Request(q(dir, parent)));
}

async function post(app: ReturnType<typeof makeApp>, dir: string, parent: number, body: unknown) {
  return app.fetch(
    new Request(q(dir, parent), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const CODEX = { agentProvider: "codex", model: "gpt-5.5", effort: "ultra" } as const;
const EXPECTED_A: AutoBlockers = autoBlockers(
  { agentProvider: "codex" },
  { profile: "standard", remoteHttps: true },
  { bwrap: true, egress: true },
);

/** Seed epic 7 in `place` with Codex settings (a leader #1 holds the run for a queued epic). */
function seed(store: SessionStore, place: "run" | "queue" | "remembered") {
  const settings = { repoPath: repo, parentIssueNumber: 7, mode: "auto" as const, ...CODEX };
  if (place === "run") {
    store.setEpicRun({ ...settings, status: "running" });
    return;
  }
  if (place === "queue") {
    store.setEpicRun({ repoPath: repo, parentIssueNumber: 1, mode: "auto", status: "running" });
    store.enqueueEpic(settings);
    return;
  }
  store.setEpicSettings(settings);
}

/** Epic 7's CLI settings where they live. */
function cliSettings(store: SessionStore, place: "run" | "queue" | "remembered") {
  const row =
    place === "run"
      ? store.getEpicRun(repo)
      : place === "queue"
        ? store.getEpicQueueEntry(repo, 7)
        : store.getEpicSettings(repo, 7);
  return {
    agentProvider: row?.agentProvider ?? null,
    model: row?.model ?? null,
    effort: row?.effort ?? null,
  };
}

describe("GET /api/epic/auto-fix", () => {
  test("a leading, a queued and a not-started epic with the same settings get the same answer", async () => {
    const { app, store } = harness();
    store.setEpicRun({
      repoPath: repo,
      parentIssueNumber: 1,
      mode: "auto",
      status: "running",
      ...CODEX,
    });
    store.enqueueEpic({ repoPath: repo, parentIssueNumber: 2, mode: "auto", ...CODEX });
    store.setEpicSettings({ repoPath: repo, parentIssueNumber: 3, mode: "auto", ...CODEX });
    for (const parent of [1, 2, 3]) {
      const res = await get(app, repo, parent);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(EXPECTED_A);
    }
    // An epic with no stored settings follows the global CLI (Claude here): case B.
    const fresh = (await (await get(app, repo, 4)).json()) as AutoBlockers;
    expect(fresh.preselect).toBe("autonomous");
  });

  test("400 on a bad repo or parent, 503 without a drain that answers the model", async () => {
    const { app, deps } = harness();
    expect((await get(app, "/nope/not/here", 7)).status).toBe(400);
    expect((await get(app, repo, 0)).status).toBe(400);
    const drain = { ...deps.drain! };
    delete drain.autoBlockers;
    const bare = makeApp({ ...deps, drain });
    expect(await (await get(bare, repo, 7)).json()).toEqual({ error: "drain unavailable" });
    expect((await post(bare, repo, 7, { option: "trusted" })).status).toBe(503);
  });
});

describe("POST /api/epic/auto-fix", () => {
  for (const place of ["run", "queue", "remembered"] as const) {
    test(`${place}: Autonomous + Claude Code applies in one step and Undo restores it exactly`, async () => {
      const h = harness();
      seed(h.store, place);
      const before = {
        sandbox: h.store.getRepoConfig(repo).sandboxProfile,
        cli: cliSettings(h.store, place),
      };
      expect(before.sandbox).toBe("inherit");

      const applied = await post(h.app, repo, 7, { option: "autonomous_claude" });
      expect(applied.status).toBe(200);
      const body = (await applied.json()) as { previous: EpicAutoFixState; blockers: AutoBlockers };
      expect(body.previous).toEqual({ sandboxProfile: "inherit", ...CODEX });
      expect(body.blockers).toEqual({ causes: [], options: [], preselect: null });
      expect(h.store.getRepoConfig(repo).sandboxProfile).toBe("autonomous");
      expect(cliSettings(h.store, place)).toEqual({
        agentProvider: "claude",
        model: null,
        effort: null,
      });
      expect(h.ticks()).toBe(1);
      expect(h.emitted.map((e) => [e.parentIssueNumber, e.run.agentProvider])).toEqual([
        [7, "claude"],
      ]);

      const undone = await post(h.app, repo, 7, { restore: body.previous });
      expect(undone.status).toBe(200);
      const undo = (await undone.json()) as { previous: EpicAutoFixState; blockers: AutoBlockers };
      expect(undo.previous).toEqual({
        sandboxProfile: "autonomous",
        agentProvider: "claude",
        model: null,
        effort: null,
      });
      expect(undo.blockers).toEqual(EXPECTED_A);
      expect({
        sandbox: h.store.getRepoConfig(repo).sandboxProfile,
        cli: cliSettings(h.store, place),
      }).toEqual(before);
      expect(h.ticks()).toBe(2);
    });
  }

  test("a fix never changes where the epic stands", async () => {
    const h = harness();
    seed(h.store, "queue");
    await post(h.app, repo, 7, { option: "autonomous_claude" });
    expect(h.store.getEpicRun(repo)).toMatchObject({ parentIssueNumber: 1, status: "running" });
    expect(h.store.listEpicQueue(repo).map((e) => e.parentIssueNumber)).toEqual([7]);

    const r = harness();
    seed(r.store, "run");
    await post(r.app, repo, 7, { option: "trusted" });
    await post(r.app, repo, 7, { option: "autonomous_claude" });
    expect(r.store.getEpicRun(repo)).toMatchObject({ parentIssueNumber: 7, status: "running" });
    expect(r.store.getEpicRunEnd(repo, 7)).toBeNull();
  });

  test("Trusted writes only the repo's sandbox and leaves the epic alone", async () => {
    const h = harness();
    seed(h.store, "remembered");
    const res = await post(h.app, repo, 7, { option: "trusted" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { previous: EpicAutoFixState }).previous).toEqual({
      sandboxProfile: "inherit",
    });
    expect(h.store.getRepoConfig(repo).sandboxProfile).toBe("trusted");
    expect(cliSettings(h.store, "remembered")).toEqual(CODEX);
    expect(h.emitted).toEqual([]);
    expect(h.ticks()).toBe(1);
  });

  test("409 for a fix the model doesn't offer enabled — nothing written, no tick", async () => {
    const h = harness();
    seed(h.store, "run");
    // Codex: Autonomous alone can't start it.
    expect((await post(h.app, repo, 7, { option: "autonomous" })).status).toBe(409);
    const ssh = harness({ remoteHttps: false });
    seed(ssh.store, "run");
    expect((await post(ssh.app, repo, 7, { option: "autonomous_claude" })).status).toBe(409);
    for (const x of [h, ssh]) {
      expect(x.store.getRepoConfig(repo).sandboxProfile).toBe("inherit");
      expect(cliSettings(x.store, "run")).toEqual(CODEX);
      expect(x.ticks()).toBe(0);
    }
    // Nothing blocks a trusted repo, so there is nothing to apply.
    h.store.setRepoConfig(repo, { ...h.store.getRepoConfig(repo), sandboxProfile: "trusted" });
    expect(await (await post(h.app, repo, 7, { option: "trusted" })).json()).toEqual({
      error: "option unavailable",
    });
  });

  test("400 on a malformed body or a refused restore", async () => {
    const h = harness();
    seed(h.store, "run");
    for (const bad of [
      null,
      [],
      {},
      { option: "bogus" },
      { option: "trusted", restore: { sandboxProfile: "inherit" } },
      { restore: {} },
      { restore: { sandboxProfile: "bogus" } },
      { restore: { agentProvider: "claude", model: "gpt-5.5" } },
      { restore: { mode: "attended" } },
    ])
      expect((await post(h.app, repo, 7, bad)).status, JSON.stringify(bad)).toBe(400);
    expect(h.ticks()).toBe(0);
    expect(h.store.getRepoConfig(repo).sandboxProfile).toBe("inherit");
  });
});

describe("validateEpicAutoFixRequest", () => {
  test("accepts exactly one of option or restore", () => {
    expect(validateEpicAutoFixRequest({ option: "autonomous_claude" })).toEqual({
      option: "autonomous_claude",
    });
    expect(
      validateEpicAutoFixRequest({
        restore: { sandboxProfile: "inherit", agentProvider: null, model: null, effort: null },
      }),
    ).toEqual({
      restore: { sandboxProfile: "inherit", agentProvider: null, model: null, effort: null },
    });
    expect(
      validateEpicAutoFixRequest({ restore: { agentProvider: "codex", model: "gpt-5.5" } }),
    ).toEqual({
      restore: { agentProvider: "codex", model: "gpt-5.5" },
    });
  });

  test("rejects anything else", () => {
    for (const bad of [
      undefined,
      "trusted",
      { option: null },
      { option: "autonomous", extra: 1 },
      { restore: null },
      { restore: [] },
      { restore: {} },
      { restore: { sandboxProfile: "inherit", status: "running" } },
      { restore: { effort: "bogus" } },
    ])
      expect(validateEpicAutoFixRequest(bad), JSON.stringify(bad)).toBeNull();
  });
});
