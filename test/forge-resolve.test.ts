/**
 * Unit tests for the makeForgeResolver helper (src/forge/resolve.ts).
 *
 * All deps are stubs — no git I/O, no real store.
 */
import { test, expect } from "bun:test";
import { makeForgeResolver, makeForgeMemo } from "../src/forge/resolve";
import type { LocalForge } from "../src/forge/local";
import type { GitForge } from "../src/forge/types";

// ── helpers ───────────────────────────────────────────────────────────────────

function stubLocalForge(dir: string): LocalForge {
  return { kind: "local", repoPath: dir } as unknown as LocalForge;
}

function stubGithubForge(): GitForge {
  return { kind: "github", slug: "org/repo" } as unknown as GitForge;
}

// ── tests ─────────────────────────────────────────────────────────────────────

test("lightweight dir → LocalForge (kind=local)", () => {
  const resolver = makeForgeResolver({
    getRepoConfig: () => ({ repoMode: "lightweight" }),
    detectForge: () => null,
    makeLocalForge: stubLocalForge,
  });

  const forge = resolver("/repo/a");
  expect(forge?.kind).toBe("local");
});

test("forge dir → detectForge result (kind=github)", () => {
  const ghForge = stubGithubForge();
  const resolver = makeForgeResolver({
    getRepoConfig: () => ({ repoMode: "forge" }),
    detectForge: () => ghForge,
    makeLocalForge: stubLocalForge,
  });

  const forge = resolver("/repo/b");
  expect(forge?.kind).toBe("github");
  expect(forge).toBe(ghForge); // same reference
});

test("forge dir with no remote → null", () => {
  const resolver = makeForgeResolver({
    getRepoConfig: () => ({ repoMode: "forge" }),
    detectForge: () => null,
    makeLocalForge: stubLocalForge,
  });

  const forge = resolver("/repo/no-remote");
  expect(forge).toBeNull();
});

test("lightweight dir reuses the same LocalForge instance across calls", () => {
  let makeCount = 0;
  const resolver = makeForgeResolver({
    getRepoConfig: () => ({ repoMode: "lightweight" }),
    detectForge: () => null,
    makeLocalForge: (dir) => {
      makeCount++;
      return stubLocalForge(dir);
    },
  });

  const f1 = resolver("/repo/c");
  const f2 = resolver("/repo/c");
  expect(f1).toBe(f2);
  expect(makeCount).toBe(1);
});

test("forge dir memoizes detectForge (only one call per dir)", () => {
  let detectCount = 0;
  const ghForge = stubGithubForge();
  const resolver = makeForgeResolver({
    getRepoConfig: () => ({ repoMode: "forge" }),
    detectForge: () => {
      detectCount++;
      return ghForge;
    },
    makeLocalForge: stubLocalForge,
  });

  resolver("/repo/d");
  resolver("/repo/d");
  resolver("/repo/d");
  expect(detectCount).toBe(1);
});

test("toggle: flipping repoMode lightweight→forge propagates immediately", () => {
  let mode: "forge" | "lightweight" = "lightweight";
  const ghForge = stubGithubForge();
  const resolver = makeForgeResolver({
    getRepoConfig: () => ({ repoMode: mode }),
    detectForge: () => ghForge,
    makeLocalForge: stubLocalForge,
  });

  // starts lightweight → LocalForge
  expect(resolver("/repo/e")?.kind).toBe("local");

  // flip to forge → now returns the detectForge result
  mode = "forge";
  expect(resolver("/repo/e")?.kind).toBe("github");
});

test("toggle: flipping repoMode forge→lightweight propagates immediately", () => {
  let mode: "forge" | "lightweight" = "forge";
  const ghForge = stubGithubForge();
  const resolver = makeForgeResolver({
    getRepoConfig: () => ({ repoMode: mode }),
    detectForge: () => ghForge,
    makeLocalForge: stubLocalForge,
  });

  // starts forge → GitHub
  expect(resolver("/repo/f")?.kind).toBe("github");

  // flip to lightweight → now returns LocalForge
  mode = "lightweight";
  expect(resolver("/repo/f")?.kind).toBe("local");
});

// ── makeForgeMemo: negative-TTL re-probe (#1023) ────────────────────────────────

test("makeForgeMemo: positive result is cached for the process lifetime (one detect)", () => {
  let detectCount = 0;
  const gh = stubGithubForge();
  const memo = makeForgeMemo(() => {
    detectCount++;
    return gh;
  });

  expect(memo("/repo/a")).toBe(gh);
  expect(memo("/repo/a")).toBe(gh);
  expect(memo("/repo/a")).toBe(gh);
  expect(detectCount).toBe(1);
});

test("makeForgeMemo: a negative result is NOT re-probed within the TTL window", () => {
  let detectCount = 0;
  let clock = 1_000;
  const memo = makeForgeMemo(
    () => {
      detectCount++;
      return null;
    },
    { negativeTtlMs: 30_000, now: () => clock },
  );

  expect(memo("/repo/x")).toBeNull(); // first miss → one detect, caches negative @1000
  clock = 1_000 + 29_999; // still inside the window
  expect(memo("/repo/x")).toBeNull();
  expect(detectCount).toBe(1); // not re-probed
});

test("makeForgeMemo: a negative result is re-probed (and heals) once the TTL elapses", () => {
  let detectCount = 0;
  let clock = 1_000;
  const gh = stubGithubForge();
  // Simulate `git remote add origin` after the second probe: detect flips null → forge.
  const memo = makeForgeMemo(
    () => {
      detectCount++;
      return detectCount >= 2 ? gh : null;
    },
    { negativeTtlMs: 30_000, now: () => clock },
  );

  expect(memo("/repo/y")).toBeNull(); // probe #1 → null, caches negative @1000
  clock = 1_000 + 30_000; // TTL elapsed
  expect(memo("/repo/y")).toBe(gh); // probe #2 → forge, now cached positive
  clock = 1_000 + 100_000; // far in the future
  expect(memo("/repo/y")).toBe(gh); // served from positive cache, no further detect
  expect(detectCount).toBe(2);
});

test("two dirs are independent", () => {
  const resolver = makeForgeResolver({
    getRepoConfig: (dir) => ({
      repoMode: dir === "/repo/lightweight" ? "lightweight" : "forge",
    }),
    detectForge: () => stubGithubForge(),
    makeLocalForge: stubLocalForge,
  });

  expect(resolver("/repo/lightweight")?.kind).toBe("local");
  expect(resolver("/repo/forge")?.kind).toBe("github");
});
