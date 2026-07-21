import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionScratchpadDir, scratchpadHasFiles } from "../src/tmp-sweep";
import {
  listScratchpad,
  resolveScratchpadPath,
  resolveScratchpadFile,
  resolveScratchpadUploadDir,
  attachmentDisposition,
} from "../src/scratchpad";

const WT = "/home/u/Work/proj";
const SID = "sess-uuid-1";

let tmpRoot: string; // SHEPHERD_TMP_SWEEP_DIR → claudeTmpRoot()
let outside: string; // a sibling dir OUTSIDE the scratchpad root, for escape tests
let root: string; // the resolved scratchpad root
const prevEnv = process.env.SHEPHERD_TMP_SWEEP_DIR;

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-scratch-test-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-scratch-out-")));
  process.env.SHEPHERD_TMP_SWEEP_DIR = tmpRoot;

  root = sessionScratchpadDir(WT, SID);
  mkdirSync(root, { recursive: true });
  // files + a subdir + a dotfile + nested content
  writeFileSync(join(root, "config.yaml"), "yaml: 1");
  writeFileSync(join(root, "alpha.txt"), "a");
  writeFileSync(join(root, ".env"), "SECRET=1");
  mkdirSync(join(root, "logs"));
  writeFileSync(join(root, "logs", "run.log"), "log");
  writeFileSync(join(outside, "secret.txt"), "leak");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.SHEPHERD_TMP_SWEEP_DIR;
  else process.env.SHEPHERD_TMP_SWEEP_DIR = prevEnv;
});

// ── #1875 dual-read migration: reads/uploads follow an adopted session onto the legacy tmpfs ──

/**
 * Set up disk (primary, via SHEPHERD_TMP_SWEEP_DIR) + legacy (via TMPDIR) roots, run `fn`, and
 * restore TMPDIR. SHEPHERD_TMP_SWEEP_DIR is restored by the file-level afterEach.
 */
async function withDualRoots(
  fn: (ctx: { diskRoot: string; legacyBase: string; uidn: number }) => Promise<void>,
): Promise<void> {
  const prevTmp = process.env.TMPDIR;
  const diskRoot = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-disk-")));
  const legacyBase = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-legacy-")));
  process.env.SHEPHERD_TMP_SWEEP_DIR = diskRoot; // claudeTmpRoot() → disk primary
  process.env.TMPDIR = legacyBase; // legacyClaudeTmpRoot() → legacyBase/claude-$uid
  try {
    await fn({ diskRoot, legacyBase, uidn: process.getuid?.() ?? 1000 });
  } finally {
    rmSync(diskRoot, { recursive: true, force: true });
    rmSync(legacyBase, { recursive: true, force: true });
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
  }
}

test("dual-read: resolves reads against the legacy tmpfs root when only it exists", async () => {
  await withDualRoots(async ({ legacyBase, uidn }) => {
    const wt = "/home/u/Work/legacyproj";
    const sid = "legacy-sid";
    const dash = wt.replace(/[/.]/g, "-");
    const legacyDir = join(legacyBase, `claude-${uidn}`, dash, sid, "scratchpad");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "hello.txt"), "hi");
    // The disk primary does NOT exist → list/resolve fall back to the legacy root.
    const listing = await listScratchpad(wt, sid, "");
    expect(listing?.entries.map((e) => e.name)).toEqual(["hello.txt"]);
    const file = await resolveScratchpadFile(wt, sid, "hello.txt");
    expect(file).toContain(legacyBase);
    expect(file?.endsWith("hello.txt")).toBe(true);
    const path = await resolveScratchpadPath(wt, sid, "hello.txt");
    expect(path?.rootReal).toBe(realpathSync(legacyDir));
  });
});

test("upload: targets the session's existing (legacy) root, else creates the disk primary", async () => {
  await withDualRoots(async ({ diskRoot, legacyBase, uidn }) => {
    // Adopted session: legacy scratchpad already exists → uploads land there, beside the agent's files.
    const wt = "/home/u/Work/legacyproj";
    const sid = "legacy-sid";
    const dash = wt.replace(/[/.]/g, "-");
    const legacyDir = join(legacyBase, `claude-${uidn}`, dash, sid, "scratchpad");
    mkdirSync(legacyDir, { recursive: true });
    const adopted = await resolveScratchpadUploadDir(wt, sid, "");
    expect(adopted?.rootReal).toBe(realpathSync(legacyDir));

    // Brand-new session: neither root exists → the disk primary is created on demand.
    const freshSid = "fresh-sid";
    const fresh = await resolveScratchpadUploadDir(wt, freshSid, "");
    expect(fresh?.rootReal).toBe(realpathSync(join(diskRoot, dash, freshSid, "scratchpad")));
  });
});

// ── scratchpadHasFiles ──────────────────────────────────────────────────────────

test("scratchpadHasFiles: true for a non-empty scratchpad", async () => {
  expect(await scratchpadHasFiles(WT, SID)).toBe(true);
});

test("scratchpadHasFiles: false for a blank claudeSessionId", async () => {
  expect(await scratchpadHasFiles(WT, "")).toBe(false);
});

test("scratchpadHasFiles: false for a missing scratchpad dir", async () => {
  expect(await scratchpadHasFiles(WT, "no-such-session")).toBe(false);
});

test("scratchpadHasFiles: true when only a dotfile is present", async () => {
  const sid = "dot-only";
  const d = sessionScratchpadDir(WT, sid);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, ".hidden"), "x");
  expect(await scratchpadHasFiles(WT, sid)).toBe(true);
});

test("scratchpadHasFiles: false for an empty scratchpad dir", async () => {
  const sid = "empty";
  mkdirSync(sessionScratchpadDir(WT, sid), { recursive: true });
  expect(await scratchpadHasFiles(WT, sid)).toBe(false);
});

// ── listScratchpad ──────────────────────────────────────────────────────────────

test("listScratchpad: lists files + dirs + dotfiles, directories first then alphabetical", async () => {
  const l = await listScratchpad(WT, SID, "");
  expect(l).not.toBeNull();
  expect(l!.path).toBe("");
  expect(l!.parent).toBeNull();
  // dir (logs) first, then files alphabetically incl. the dotfile
  expect(l!.entries.map((e) => `${e.type}:${e.name}`)).toEqual([
    "dir:logs",
    "file:.env",
    "file:alpha.txt",
    "file:config.yaml",
  ]);
  expect(l!.entries.find((e) => e.name === "logs")!.path).toBe("logs");
});

test("listScratchpad: descends into a subdir and exposes parent === root ('')", async () => {
  const l = await listScratchpad(WT, SID, "logs");
  expect(l).not.toBeNull();
  expect(l!.path).toBe("logs");
  expect(l!.parent).toBe("");
  expect(l!.entries.map((e) => e.name)).toEqual(["run.log"]);
  expect(l!.entries[0]!.path).toBe("logs/run.log");
});

test("listScratchpad: null for a blank claudeSessionId / missing root", async () => {
  expect(await listScratchpad(WT, "", "")).toBeNull();
  expect(await listScratchpad(WT, "no-such-session", "")).toBeNull();
});

test("listScratchpad: null when the target is a file, not a dir", async () => {
  expect(await listScratchpad(WT, SID, "config.yaml")).toBeNull();
});

test("listScratchpad: rejects `..` and absolute-path escapes", async () => {
  for (const rel of ["..", "../..", "../secret.txt", "/etc"]) {
    expect(await listScratchpad(WT, SID, rel)).toBeNull();
  }
});

test("listScratchpad: drops an entry whose symlink escapes the root", async () => {
  symlinkSync(outside, join(root, "escape")); // → outside the scratchpad
  symlinkSync(join(root, "config.yaml"), join(root, "inside-link")); // → inside, kept
  const l = await listScratchpad(WT, SID, "");
  const names = l!.entries.map((e) => e.name);
  expect(names).not.toContain("escape");
  expect(names).toContain("inside-link");
});

// ── resolveScratchpadPath / resolveScratchpadFile ─────────────────────────────────

test("resolveScratchpadPath: resolves a contained path and rejects escapes", async () => {
  expect(await resolveScratchpadPath(WT, SID, "logs")).not.toBeNull();
  // a symlink that points outside resolves out → rejected
  symlinkSync(join(outside, "secret.txt"), join(root, "out"));
  expect(await resolveScratchpadPath(WT, SID, "out")).toBeNull();
});

test("resolveScratchpadFile: returns a file path, null for a dir / escape", async () => {
  const f = await resolveScratchpadFile(WT, SID, "config.yaml");
  expect(f).toBe(realpathSync(join(root, "config.yaml")));
  expect(await resolveScratchpadFile(WT, SID, "logs")).toBeNull(); // a dir
  expect(await resolveScratchpadFile(WT, SID, "../secret.txt")).toBeNull(); // escape
});

// ── attachmentDisposition ─────────────────────────────────────────────────────────

test("attachmentDisposition: ASCII name passes through with an RFC 5987 copy", () => {
  expect(attachmentDisposition("config.yaml")).toBe(
    "attachment; filename=\"config.yaml\"; filename*=UTF-8''config.yaml",
  );
});

test("attachmentDisposition: strips CR/LF/quote from the ASCII fallback (no header injection)", () => {
  const d = attachmentDisposition('a"b\r\nc.txt');
  expect(d).toContain('filename="a_b__c.txt"');
  expect(d).not.toContain("\r");
  expect(d).not.toContain("\n");
});

test("attachmentDisposition: percent-encodes a non-ASCII name in filename*", () => {
  const d = attachmentDisposition("café.txt");
  expect(d).toContain("filename*=UTF-8''caf%C3%A9.txt");
  expect(d).toContain('filename="caf_.txt"'); // é replaced in the ASCII fallback
});

test("attachmentDisposition: percent-encodes RFC 5987 non-attr-chars ('()*) in filename*", () => {
  const d = attachmentDisposition("a'b(c)*d.txt");
  // ' ( ) * → %27 %28 %29 %2A (encodeURIComponent would otherwise leave them raw)
  expect(d).toContain("filename*=UTF-8''a%27b%28c%29%2Ad.txt");
});
