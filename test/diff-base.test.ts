import { test, expect } from "bun:test";
import { resolveDiffBase } from "../src/diff-base";
import type { GitForge, GitState, PrStatus } from "../src/forge/types";

type Sess = Parameters<typeof resolveDiffBase>[0];
const SESSION: Sess = { id: "s1", baseBranch: "dev", branch: "hotfix/x", repoPath: "/repo" };

function cache(git: Partial<GitState> | undefined): { get: (id: string) => GitState | undefined } {
  return {
    get: () => (git ? ({ kind: "github", checks: "none", ...git } as GitState) : undefined),
  };
}

function forgeWith(prStatus: () => Promise<PrStatus>): (dir: string) => GitForge {
  return () => ({ prStatus }) as unknown as GitForge;
}

test("warm cache with baseRefName → authoritative PR base, no forge call", async () => {
  let forgeCalled = false;
  const forge = () => {
    forgeCalled = true;
    return null;
  };
  const r = await resolveDiffBase(SESSION, cache({ state: "open", baseRefName: "main" }), forge);
  expect(r).toEqual({ base: "main", resolved: true });
  expect(forgeCalled).toBe(false);
});

test("cached state=none → baseBranch, authoritative, no forge call", async () => {
  let forgeCalled = false;
  const forge = () => {
    forgeCalled = true;
    return null;
  };
  const r = await resolveDiffBase(SESSION, cache({ state: "none" }), forge);
  expect(r).toEqual({ base: "dev", resolved: true });
  expect(forgeCalled).toBe(false);
});

test("cold cache → on-demand prStatus baseRefName (authoritative)", async () => {
  const forge = forgeWith(async () => ({
    state: "open",
    checks: "none",
    baseRefName: "main",
    deployConfigured: false,
  }));
  const r = await resolveDiffBase(SESSION, cache(undefined), forge);
  expect(r).toEqual({ base: "main", resolved: true });
});

test("cold cache + on-demand reports no PR → baseBranch, authoritative", async () => {
  const forge = forgeWith(async () => ({ state: "none", checks: "none", deployConfigured: false }));
  const r = await resolveDiffBase(SESSION, cache(undefined), forge);
  expect(r).toEqual({ base: "dev", resolved: true });
});

test("cold cache + on-demand throws → baseBranch fallback, NOT authoritative (no thrash)", async () => {
  const forge = forgeWith(async () => {
    throw new Error("gh exploded");
  });
  const r = await resolveDiffBase(SESSION, cache(undefined), forge);
  expect(r).toEqual({ base: "dev", resolved: false });
});

test("no branch / no forge → baseBranch fallback, not authoritative", async () => {
  const r = await resolveDiffBase({ ...SESSION, branch: null }, undefined, undefined);
  expect(r).toEqual({ base: "dev", resolved: false });
});
