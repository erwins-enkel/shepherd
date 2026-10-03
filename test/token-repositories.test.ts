import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeRepositoryPaths,
  repositoryAllows,
  repositoryRoutePolicy,
  filterRepositoryEvent,
} from "../src/token-repositories";

test("repository policy: canonical aliases are exact grants and missing roots fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-policy-"));
  try {
    const a = join(root, "a"),
      sibling = join(root, "a-secret"),
      child = join(a, "child"),
      alias = join(root, "alias");
    mkdirSync(a);
    mkdirSync(child);
    mkdirSync(sibling);
    symlinkSync(a, alias);
    expect(normalizeRepositoryPaths([a, alias], root)).toEqual({ repoPaths: [a] });
    expect(normalizeRepositoryPaths([child], root)).toHaveProperty("error");
    expect(repositoryAllows([a], alias, root)).toBe(true);
    expect(repositoryAllows([a], child, root)).toBe(false);
    expect(repositoryAllows([a], sibling, root)).toBe(false);
    expect(repositoryAllows([], a, root)).toBe(false);
    rmSync(a, { recursive: true });
    expect(normalizeRepositoryPaths([a], root, [a])).toEqual({ repoPaths: [a] });
    expect(repositoryAllows([a], a, root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository policy: method and full leaf must match, including normalized separators", () => {
  const policy = (method: string, path: string) =>
    repositoryRoutePolicy(method, new URL(`http://localhost${path}`));
  expect(policy("GET", "/api//sessions/abc/activity/")).toEqual({ kind: "session", id: "abc" });
  for (const [method, path] of [
    ["POST", "/api/settings"],
    ["GET", "/api/sessions/clear-merged"],
    ["POST", "/api/sessions/abc/constructor"],
    ["GET", "/api/sessions/abc/activity/extra"],
    ["POST", "/api/sessions/abc/queue/approve/extra"],
    ["POST", "/api/sessions/abc/hooks"],
    ["GET", "/api/sessions/abc/mcp"],
    ["GET", "/api/unknown"],
    ["GET", "/api/sessions%2fabc/activity"],
  ] as const)
    expect(policy(method, path)).toBeNull();
});

test("repository policy: unknown and unresolvable event shapes are not trusted", () => {
  const allowed = (id: string) => id === "own";
  expect(filterRepositoryEvent("session:status", { id: "own" }, allowed)).toBe(true);
  expect(filterRepositoryEvent("queue:update", { sessionId: "own" }, allowed)).toBe(true);
  expect(filterRepositoryEvent("session:status", { id: "other" }, allowed)).toBe(false);
  expect(filterRepositoryEvent("future:event", { id: "own" }, allowed)).toBe(false);
  expect(filterRepositoryEvent("queue:update", { id: "own" }, allowed)).toBe(false);
});
