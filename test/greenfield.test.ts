import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READINESS_PENDING, type RepoBootstrap } from "../src/bootstrap";
import type { GitForge } from "../src/forge/types";
import { GreenfieldService } from "../src/greenfield";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shepherd-greenfield-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(rel: string, body = "x") {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

function fakeStore(initial: RepoBootstrap) {
  let b = { ...initial };
  return {
    sets: [] as string[],
    getRepoBootstrap: () => ({ ...b }),
    setRepoBootstrap(_: string, next: { state: RepoBootstrap["state"]; phase: number }) {
      b = { state: next.state, phase: next.phase, overrideAt: null };
      this.sets.push(next.state);
    },
    getRepoConfig: () => ({ autoLabel: "shepherd:auto" }) as never,
  };
}

const active = (phase: number): RepoBootstrap => ({ state: "active", phase, overrideAt: null });

/** A fully bootstrapped JS/TS repo on disk (forge-free: settings omitted, runs unverified). */
function scaffold() {
  write(
    "package.json",
    JSON.stringify({
      name: "app",
      packageManager: "bun@1.3.0",
      devDependencies: { husky: "9", fallow: "2" },
    }),
  );
  write("CLAUDE.md", "# Rules\n\n## Pinned stack\n\n- svelte 5\n");
  write(".husky/pre-push", "bun run test");
  write(".github/workflows/ci.yml", "on: push");
}

describe("GreenfieldService", () => {
  test("empty repo scans to a greenfield report with every must-have red", async () => {
    const svc = new GreenfieldService({ store: fakeStore(active(1)), resolveForge: () => null });
    const r = await svc.refresh(dir);
    expect(r.ecosystem).toBeNull();
    expect(r.mustHavesMissing).toEqual([
      "stack_pinned",
      "scaffold_builds",
      "ci_on_main",
      "hooks_pre_push",
      "dead_code_audit",
    ]);
    expect(svc.cached(dir)).toBe(r);
  });

  test("docs and the pinned-stack section are detected", async () => {
    scaffold();
    write("docs/prd/prd.md");
    write("docs/design/screen.png");
    write("docs/decisions/0001.md");
    const r = await new GreenfieldService({
      store: fakeStore(active(2)),
      resolveForge: () => null,
    }).refresh(dir);
    expect(r.mustHavesMissing).toEqual([]);
    expect(r.items.find((i) => i.id === "stack_pinned")?.evidence).toEqual([
      "CLAUDE.md",
      "packageManager",
    ]);
    expect(r.items.filter((i) => i.tier === "nice" && i.present).map((i) => i.id)).toEqual(
      expect.arrayContaining(["prd", "design_export", "foundation_decisions"]),
    );
  });

  test("cold cache answers pending (fail-closed) and starts one scan", async () => {
    const store = fakeStore(active(1));
    const changed: string[] = [];
    const svc = new GreenfieldService({
      store,
      resolveForge: () => null,
      onChange: (d) => changed.push(d),
    });
    expect(svc.mustHavesMissing(dir)).toEqual([READINESS_PENDING]);
    expect(svc.mustHavesMissing(dir)).toEqual([READINESS_PENDING]); // throttled, still single scan
    await svc.refresh(dir);
    expect(svc.mustHavesMissing(dir)).toContain("stack_pinned");
    expect(changed).toEqual([dir]);
  });

  test("a non-active repo is never scanned by the gate read", () => {
    const svc = new GreenfieldService({
      store: fakeStore({ state: "off", phase: 1, overrideAt: null }),
      resolveForge: () => null,
    });
    expect(svc.mustHavesMissing(dir)).toEqual([]);
    expect(svc.cached(dir)).toBeNull();
  });

  test("phase 5 + all must-haves green flips the repo to done", async () => {
    scaffold();
    const store = fakeStore(active(5));
    const changed: string[] = [];
    await new GreenfieldService({
      store,
      resolveForge: () => null,
      onChange: (d) => changed.push(d),
    }).refresh(dir);
    expect(store.sets).toEqual(["done"]);
    expect(changed).toEqual([dir]);
  });

  test("a red must-have keeps a phase-5 repo active", async () => {
    scaffold();
    rmSync(join(dir, ".husky"), { recursive: true });
    const store = fakeStore(active(5));
    const r = await new GreenfieldService({ store, resolveForge: () => null }).refresh(dir);
    expect(r.mustHavesMissing).toEqual(["hooks_pre_push"]);
    expect(store.sets).toEqual([]);
  });

  test("onMerged pulls then re-scans an active repo, and ignores others", async () => {
    const pulls: string[] = [];
    const pull = async (d: string) => {
      pulls.push(d);
      scaffold(); // what the merge landed
    };
    const svc = new GreenfieldService({
      store: fakeStore(active(2)),
      resolveForge: () => null,
      pull,
    });
    await svc.onMerged(dir);
    expect(pulls).toEqual([dir]);
    expect(svc.cached(dir)?.mustHavesMissing).toEqual([]);

    const off = new GreenfieldService({
      store: fakeStore({ state: "done", phase: 5, overrideAt: null }),
      resolveForge: () => null,
      pull,
    });
    await off.onMerged(dir);
    expect(pulls).toEqual([dir]);
  });

  test("onMerged of a bootstrap session advances the phase, never backwards (#3110)", async () => {
    const changes: string[] = [];
    const store = fakeStore(active(1));
    const svc = new GreenfieldService({
      store,
      resolveForge: () => null,
      pull: async () => {},
      onChange: (d) => changes.push(d),
    });
    await svc.onMerged(dir, 1);
    expect(store.getRepoBootstrap().phase).toBe(3);
    expect(changes.length).toBeGreaterThanOrEqual(1);
    await svc.onMerged(dir, 1); // a late P1+P2 merge never lowers P3
    expect(store.getRepoBootstrap().phase).toBe(3);
    await svc.onMerged(dir, 3);
    expect(store.getRepoBootstrap().phase).toBe(4);
    await svc.onMerged(dir); // a non-bootstrap merge leaves the phase alone
    expect(store.getRepoBootstrap().phase).toBe(4);
  });

  test("forge runs gate scaffold_builds; a forge read error is red, not a crash", async () => {
    scaffold();
    const forge = {
      isFork: false,
      mergeMethod: "squash",
      repoForgeSettings: async () => {
        throw new Error("gh down");
      },
      listDefaultBranchRuns: async () => [
        {
          id: 1,
          workflowName: "ci",
          workflowFile: "ci.yml",
          event: "push",
          status: "completed",
          conclusion: "failure",
          attempt: 1,
          headSha: "a",
          createdAt: 1,
          url: "u",
        },
      ],
    } as unknown as GitForge;
    const r = await new GreenfieldService({
      store: fakeStore(active(2)),
      resolveForge: () => forge,
    }).refresh(dir);
    expect(r.mustHavesMissing).toEqual(["scaffold_builds", "forge_settings"]);
  });
});
