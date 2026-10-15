/**
 * #3112 end to end: an empty New Project walks every bootstrap phase through the real server,
 * store and greenfield scan — P1+P2 merge → P3 merge → P4 epic approve → exit — and the drain gate
 * falls. Sessions and merges are simulated at the store; everything else is the production path.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrapMissing } from "../src/bootstrap";
import { config } from "../src/config";
import { EventHub } from "../src/events";
import type { GitForge } from "../src/forge/types";
import { GreenfieldService } from "../src/greenfield";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";

const name = `bootstrap-e2e-${process.pid}-${Date.now()}`;
const dir = join(config.repoRoot, name);
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeForge(): GitForge {
  let next = 100;
  return {
    kind: "github",
    createIssue: async ({ title }: { title: string }) => ({
      number: next,
      url: `https://example.test/issues/${next++}`,
      title,
    }),
    listSubIssues: async () => [],
    listBlockedBy: async () => [],
    addSubIssue: async () => {},
    addBlockedBy: async () => {},
  } as unknown as GitForge;
}

/** The P1+P2 PR's content: pinned stack, scaffold, hooks, CI, dead-code audit (forge-free). */
function landScaffold() {
  const write = (rel: string, body: string) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  write(
    "package.json",
    JSON.stringify({
      name,
      packageManager: "bun@1.3.0",
      devDependencies: { husky: "9", fallow: "2" },
    }),
  );
  write("CLAUDE.md", "# Rules\n\n## Pinned stack\n\n- svelte 5\n");
  write(".husky/pre-push", "bun run test");
  write(".github/workflows/ci.yml", "on: push");
}

test("an empty project runs every bootstrap phase and the drain gate falls", async () => {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const greenfield = new GreenfieldService({
    store,
    resolveForge: () => null,
    pull: async () => {},
  });
  const advances: number[] = [];
  const deps = {
    store,
    events,
    service: { reply: () => true },
    resolveForge: () => fakeForge(),
    greenfield,
    onBootstrapAdvance: (_: string, phase: number) => advances.push(phase),
    drain: {
      buildEpic: async (repoPath: string, run: { parentIssueNumber: number }) => ({
        repoPath,
        parentIssueNumber: run.parentIssueNumber,
        children: [],
        run,
      }),
      tick: async () => {},
    },
  } as unknown as AppDeps;
  const app = makeApp(deps);
  const req = (method: string, path: string, body?: BodyInit, json = true) =>
    app.fetch(
      new Request(`http://x${path}`, {
        method,
        headers: json ? { "content-type": "application/json" } : {},
        body,
      }),
    );
  const view = async () =>
    (await (await req("GET", `/api/repo-bootstrap?repo=${encodeURIComponent(dir)}`)).json()) as {
      state: string;
      phase: number;
      next: { kind: string; phase: number } | null;
    };
  const session = (extra: Record<string, unknown>) =>
    store.create({
      name: "s",
      prompt: "p",
      repoPath: dir,
      baseBranch: "main",
      branch: "b",
      worktreePath: dir,
      isolated: false,
      herdrSession: "h",
      herdrAgentId: `a-${Math.random()}`,
      ...extra,
    });
  const merge = async (phase: 1 | 3) => {
    const s = session({ bootstrapPhase: phase });
    store.archive(s.id, "merged");
    await greenfield.onMerged(dir, phase);
  };

  // New Project with the bootstrap kickoff: the PRD lands in the initial commit, the repo is P1.
  const fd = new FormData();
  fd.append("project", JSON.stringify({ name, idea: "", createRemote: false }));
  fd.append("prd", new File(["# PRD"], "prd.md"));
  expect((await req("POST", "/api/projects", fd, false)).status).toBe(201);
  expect(await view()).toMatchObject({ state: "active", phase: 1, next: { kind: "bootstrap" } });

  // P1+P2: the bootstrap session's PR merges with the scaffold.
  landScaffold();
  await merge(1);
  expect(await view()).toMatchObject({ phase: 3, next: { kind: "bootstrap", phase: 3 } });

  // P3: the gap-sweep PR merges.
  await merge(3);
  expect(await view()).toMatchObject({ phase: 4, next: { kind: "epic" } });
  expect(bootstrapMissing(store.getRepoBootstrap(dir), greenfield.mustHavesMissing(dir))).toEqual([
    "P4",
  ]);

  // P4: the backlog epic is approved — its issues are created.
  const epic = session({ epicAuthoring: true });
  const draft = {
    parent: { title: "M0", body: "b", acceptanceCriteria: [], nonGoals: [] },
    children: [{ key: "c1", title: "Shell", body: "", acceptanceCriteria: [], blockedBy: [] }],
  };
  expect(
    (await req("PUT", `/api/sessions/${epic.id}/epic-draft`, JSON.stringify(draft))).status,
  ).toBe(200);
  expect((await req("POST", `/api/sessions/${epic.id}/epic-draft/approve`)).status).toBe(200);
  expect(advances).toEqual([5]);

  // Exit: the re-scan finds every must-have green → done, the drain hold is gone.
  await greenfield.refresh(dir);
  expect(store.getRepoBootstrap(dir).state).toBe("done");
  expect(
    bootstrapMissing(store.getRepoBootstrap(dir), greenfield.mustHavesMissing(dir)),
  ).toBeNull();
  expect((await view()).next).toBeNull();
});
