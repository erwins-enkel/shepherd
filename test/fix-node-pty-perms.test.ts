import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  statSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixNodePtyPerms, resolveNodePtyDir } from "../scripts/fix-node-pty-perms.mjs";

/** Build a throwaway node-pty tree with a prebuilt helper at `mode`. Returns [dir, helper]. */
function fakeTree(platformArch: string, mode: number): [string, string] {
  const dir = mkdtempSync(join(tmpdir(), "node-pty-perms-"));
  const helperDir = join(dir, "prebuilds", platformArch);
  mkdirSync(helperDir, { recursive: true });
  const helper = join(helperDir, "spawn-helper");
  writeFileSync(helper, "#!/bin/sh\n");
  chmodSync(helper, mode);
  return [dir, helper];
}

const modeOf = (p: string) => statSync(p).mode & 0o777;

test("flips a non-executable prebuilt helper to 0755 and logs exactly one line", () => {
  const [dir, helper] = fakeTree("darwin-arm64", 0o644);
  const logs: string[] = [];
  const flipped = fixNodePtyPerms(dir, "darwin-arm64", (m) => logs.push(m));
  expect(flipped).toEqual([helper]);
  expect(modeOf(helper)).toBe(0o755);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain(helper);
  expect(logs[0]).toContain("executable");
  rmSync(dir, { recursive: true, force: true });
});

test("is idempotent and silent on a second run (already executable)", () => {
  const [dir] = fakeTree("darwin-arm64", 0o644);
  fixNodePtyPerms(dir, "darwin-arm64");
  const logs: string[] = [];
  const flipped = fixNodePtyPerms(dir, "darwin-arm64", (m) => logs.push(m));
  expect(flipped).toEqual([]);
  expect(logs).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("also fixes a source-built build/Release helper", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-pty-perms-"));
  const relDir = join(dir, "build", "Release");
  mkdirSync(relDir, { recursive: true });
  const helper = join(relDir, "spawn-helper");
  writeFileSync(helper, "#!/bin/sh\n");
  chmodSync(helper, 0o644);
  const flipped = fixNodePtyPerms(dir, "linux-x64");
  expect(flipped).toEqual([helper]);
  expect(modeOf(helper)).toBe(0o755);
  rmSync(dir, { recursive: true, force: true });
});

test("restores only the exec bits, without broadening read/write (0600 → 0711)", () => {
  const [dir, helper] = fakeTree("darwin-arm64", 0o600);
  fixNodePtyPerms(dir, "darwin-arm64");
  expect(modeOf(helper)).toBe(0o711); // exec added; group/other r/w NOT granted
  rmSync(dir, { recursive: true, force: true });
});

test("absent tree → no throw, nothing flipped, silent (Linux no-op)", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-pty-perms-"));
  const logs: string[] = [];
  const flipped = fixNodePtyPerms(dir, "linux-x64", (m) => logs.push(m));
  expect(flipped).toEqual([]);
  expect(logs).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("resolveNodePtyDir is absolute and repo-anchored (not cwd-dependent)", () => {
  const resolved = resolveNodePtyDir();
  expect(resolved.startsWith("/")).toBe(true);
  expect(resolved.endsWith(join("node_modules", "node-pty"))).toBe(true);
});

// Wiring assertions: prove the guaranteed install paths actually invoke the script.
// (This proves wiring, not execution — execution is proven by the on-Mac provision run.)
test("deploy/provision.ts buildOnly invokes the perms script", () => {
  const src = readFileSync(new URL("../deploy/provision.ts", import.meta.url), "utf8");
  expect(src).toContain("bun scripts/fix-node-pty-perms.mjs");
});

test("deploy/update.sh invokes the perms script after bun install", () => {
  const src = readFileSync(new URL("../deploy/update.sh", import.meta.url), "utf8");
  expect(src).toContain("bun scripts/fix-node-pty-perms.mjs");
});
