import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectForge } from "../src/forge";

// `index.ts` wires resolveForge as (dir) => detectForge(dir, forgeMap). These
// tests cover that resolution path: an origin remote → a concrete forge.

let dir: string;

function git(...args: string[]) {
  execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "ignore", "ignore"] });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shepherd-forge-detect-"));
  git("init", "-q");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("detectForge resolves a github.com origin to a github forge with the slug", () => {
  git("remote", "add", "origin", "https://github.com/acme/widget.git");
  const forge = detectForge(dir, {});
  expect(forge).not.toBeNull();
  expect(forge!.kind).toBe("github");
  expect(forge!.slug).toBe("acme/widget");
});

test("detectForge fork mode: origin=fork + upstream=original → forge targets the upstream slug", () => {
  // The topology `gh repo fork --clone` produces: origin = the user's fork,
  // upstream = the original. The forge must target upstream so issues/PRs/checks
  // and the PR base all point at the repo the contributor works against.
  git("remote", "add", "origin", "https://github.com/kai/widget.git");
  git("remote", "add", "upstream", "https://github.com/acme/widget.git");
  const forge = detectForge(dir, {});
  expect(forge!.kind).toBe("github");
  expect(forge!.slug).toBe("acme/widget"); // upstream, not the fork
});

test("detectForge: upstream remote with the SAME slug as origin → not fork mode (origin slug)", () => {
  git("remote", "add", "origin", "https://github.com/acme/widget.git");
  git("remote", "add", "upstream", "https://github.com/acme/widget.git");
  const forge = detectForge(dir, {});
  expect(forge!.slug).toBe("acme/widget");
});

test("detectForge returns null for a repo without an origin remote", () => {
  expect(detectForge(dir, {})).toBeNull();
});

test("detectForge returns null for a non-repo / unreadable dir", () => {
  expect(detectForge(join(dir, "does-not-exist"), {})).toBeNull();
});
