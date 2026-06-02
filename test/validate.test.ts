import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  validateCreate,
  validateCloneUrl,
  isAuthorized,
  originAllowed,
  isValidTerminalId,
  expandHome,
  parseTermDims,
} from "../src/validate";
import { stagingDir } from "../src/uploads";

test("expandHome expands leading ~ to homedir", () => {
  expect(expandHome("~")).toBe(homedir());
  expect(expandHome("~/Work/tank")).toBe(join(homedir(), "Work/tank"));
  expect(expandHome("/abs/path")).toBe("/abs/path");
  expect(expandHome("~notme/x")).toBe("~notme/x"); // only bare ~ or ~/ expand
});

test("validateCreate accepts a ~ path inside repoRoot", () => {
  // repoRoot = home; repoPath '~' resolves to home (which exists & is a dir)
  const r = validateCreate({ repoPath: "~", baseBranch: "main", prompt: "go" }, homedir());
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.repoPath).toBe(homedir());
});

// ── validateCreate ────────────────────────────────────────────────────────────

let root: string;
let validRepo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shepherd-val-root-"));
  validRepo = join(root, "myrepo");
  mkdirSync(validRepo);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("valid input returns ok with value", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "do the thing" },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.repoPath).toBe(validRepo);
    expect(r.value.baseBranch).toBe("main");
    expect(r.value.prompt).toBe("do the thing");
    expect(r.value.model).toBeNull(); // model omitted → null (claude default)
  }
});

test("known model accepted and passed through", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", model: "opus" },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.model).toBe("opus");
});

test('model "default" normalizes to null', () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", model: "default" },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.model).toBeNull();
});

test("unknown model rejected", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", model: "gpt-4" },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/model/i);
});

test("unknown key is rejected", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", evil: "x" },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/unknown/i);
});

test("non-object body rejected", () => {
  expect(validateCreate(null, root).ok).toBe(false);
  expect(validateCreate("string", root).ok).toBe(false);
  expect(validateCreate(42, root).ok).toBe(false);
});

test("empty prompt rejected", () => {
  const r = validateCreate({ repoPath: validRepo, baseBranch: "main", prompt: "  " }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/prompt/i);
});

test("oversized prompt (>8000 chars) rejected", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "x".repeat(8001) },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/prompt/i);
});

test("prompt exactly 8000 chars accepted", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "x".repeat(8000) },
    root,
  );
  expect(r.ok).toBe(true);
});

test("leading-dash baseBranch rejected", () => {
  const r = validateCreate({ repoPath: validRepo, baseBranch: "--evil", prompt: "go" }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/baseBranch/i);
});

test("bad-char baseBranch rejected", () => {
  const r = validateCreate({ repoPath: validRepo, baseBranch: "feat;rm -rf", prompt: "go" }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/baseBranch/i);
});

test("valid baseBranch with slash and dot accepted", () => {
  const r = validateCreate({ repoPath: validRepo, baseBranch: "origin/main", prompt: "go" }, root);
  expect(r.ok).toBe(true);
});

test("repoPath outside root rejected", () => {
  const r = validateCreate({ repoPath: "/etc", baseBranch: "main", prompt: "go" }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/repoPath/i);
});

test("repoPath that does not exist rejected", () => {
  const r = validateCreate(
    { repoPath: join(root, "nonexistent"), baseBranch: "main", prompt: "go" },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/repoPath/i);
});

test("path-traversal attempt rejected", () => {
  // join resolves to /etc, which is outside root
  const r = validateCreate(
    { repoPath: join(root, "../etc"), baseBranch: "main", prompt: "go" },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/repoPath/i);
});

// ── parseTermDims ─────────────────────────────────────────────────────────────

test("parseTermDims: valid numeric strings pass through", () => {
  expect(parseTermDims("180", "50")).toEqual({ cols: 180, rows: 50 });
});

test("parseTermDims: missing/null params fall back to 100×30 default", () => {
  expect(parseTermDims(null, null)).toEqual({ cols: 100, rows: 30 });
});

test("parseTermDims: non-numeric falls back to default", () => {
  expect(parseTermDims("abc", "1e9; rm -rf")).toEqual({ cols: 100, rows: 30 });
});

test("parseTermDims: zero / negative fall back to default", () => {
  expect(parseTermDims("0", "-5")).toEqual({ cols: 100, rows: 30 });
});

test("parseTermDims: fractional values floored", () => {
  expect(parseTermDims("180.9", "50.4")).toEqual({ cols: 180, rows: 50 });
});

test("parseTermDims: oversized values clamped to 1000", () => {
  expect(parseTermDims("99999", "99999")).toEqual({ cols: 1000, rows: 1000 });
});

// ── isAuthorized ─────────────────────────────────────────────────────────────

test("isAuthorized: correct token passes", () => {
  expect(isAuthorized("Bearer secret123", "secret123")).toBe(true);
});

test("isAuthorized: wrong token fails", () => {
  expect(isAuthorized("Bearer wrongtoken", "secret123")).toBe(false);
});

test("isAuthorized: missing header fails", () => {
  expect(isAuthorized(null, "secret123")).toBe(false);
  expect(isAuthorized(undefined, "secret123")).toBe(false);
});

test("isAuthorized: no-token config always passes", () => {
  expect(isAuthorized(null, null)).toBe(true);
  expect(isAuthorized("Bearer anything", null)).toBe(true);
});

// ── originAllowed ─────────────────────────────────────────────────────────────

const allowedHosts = ["localhost", "127.0.0.1", "::1", "[::1]"];

test("originAllowed: no origin header passes (curl/cli)", () => {
  expect(originAllowed(null, allowedHosts)).toBe(true);
  expect(originAllowed(undefined, allowedHosts)).toBe(true);
});

test("originAllowed: localhost origin passes", () => {
  expect(originAllowed("http://localhost:7330", allowedHosts)).toBe(true);
});

test("originAllowed: 127.0.0.1 origin passes", () => {
  expect(originAllowed("http://127.0.0.1:3000", allowedHosts)).toBe(true);
});

test("originAllowed: external origin rejected", () => {
  expect(originAllowed("https://evil.com", allowedHosts)).toBe(false);
});

test("originAllowed: subdomain of localhost rejected", () => {
  expect(originAllowed("http://attacker.localhost:7330", allowedHosts)).toBe(false);
});

// ── isValidTerminalId ─────────────────────────────────────────────────────────

test("isValidTerminalId: accepts typical herdr id", () => {
  expect(isValidTerminalId("term_65306e7cb9451a")).toBe(true);
});

test("isValidTerminalId: accepts alphanumeric with dash and underscore", () => {
  expect(isValidTerminalId("a-b_c")).toBe(true);
});

test("isValidTerminalId: rejects empty string", () => {
  expect(isValidTerminalId("")).toBe(false);
});

test("isValidTerminalId: rejects leading-dash (short flag)", () => {
  expect(isValidTerminalId("-rf")).toBe(false);
});

test("isValidTerminalId: rejects leading double-dash (long flag)", () => {
  expect(isValidTerminalId("--help")).toBe(false);
});

test("isValidTerminalId: rejects 65-char string (too long)", () => {
  expect(isValidTerminalId("a".repeat(65))).toBe(false);
});

test("isValidTerminalId: rejects id with space", () => {
  expect(isValidTerminalId("term x")).toBe(false);
});

test("isValidTerminalId: rejects id with semicolon", () => {
  expect(isValidTerminalId("a;b")).toBe(false);
});

test("validateCreate accepts images inside the staging dir", () => {
  const staging = stagingDir(root);
  mkdirSync(staging, { recursive: true });
  const img = join(staging, "a.png");
  writeFileSync(img, "x");
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", images: [img] },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.images).toEqual([img]);
});

test("validateCreate defaults images to [] when omitted", () => {
  const r = validateCreate({ repoPath: validRepo, baseBranch: "main", prompt: "go" }, root);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.images).toEqual([]);
});

// regression: an empty images array must NOT require the staging dir to exist.
// `root` here has no staging dir (as a freshly-configured repoRoot wouldn't),
// which previously failed with "no staged uploads exist" on every create.
test("validateCreate accepts an empty images array without a staging dir", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", images: [] },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.images).toEqual([]);
});

test("validateCreate rejects an image outside the staging dir", () => {
  const outside = join(root, "evil.png");
  writeFileSync(outside, "x");
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", images: [outside] },
    root,
  );
  expect(r.ok).toBe(false);
});

test("validateCreate rejects a non-existent image", () => {
  const r = validateCreate(
    {
      repoPath: validRepo,
      baseBranch: "main",
      prompt: "go",
      images: [join(stagingDir(root), "nope.png")],
    },
    root,
  );
  expect(r.ok).toBe(false);
});

test("validateCreate rejects more than 10 images", () => {
  const staging = stagingDir(root);
  mkdirSync(staging, { recursive: true });
  const imgs: string[] = [];
  for (let i = 0; i < 11; i++) {
    const p = join(staging, `i${i}.png`);
    writeFileSync(p, "x");
    imgs.push(p);
  }
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", images: imgs },
    root,
  );
  expect(r.ok).toBe(false);
});

test("validateCreate rejects a non-array images value", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", images: "x" },
    root,
  );
  expect(r.ok).toBe(false);
});

test("validateCreate rejects duplicate image paths", () => {
  const staging = stagingDir(root);
  mkdirSync(staging, { recursive: true });
  const img = join(staging, "dup.png");
  writeFileSync(img, "x");
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", images: [img, img] },
    root,
  );
  expect(r.ok).toBe(false);
});

const validIssueRef = {
  number: 42,
  url: "https://github.com/o/r/issues/42",
  title: "Soft-delete users",
  body: "x".repeat(20_000), // far past the 8000 prompt guard — but rides out-of-band
};

test("validateCreate accepts a valid issueRef with an oversized body", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", issueRef: validIssueRef },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.issueRef).toEqual(validIssueRef);
});

test("validateCreate defaults issueRef to undefined when omitted", () => {
  const r = validateCreate({ repoPath: validRepo, baseBranch: "main", prompt: "go" }, root);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.issueRef).toBeUndefined();
});

test("validateCreate rejects an issueRef with a non-positive number", () => {
  const r = validateCreate(
    {
      repoPath: validRepo,
      baseBranch: "main",
      prompt: "go",
      issueRef: { ...validIssueRef, number: 0 },
    },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/issueRef/i);
});

test("validateCreate rejects an issueRef with a non-http url", () => {
  const r = validateCreate(
    {
      repoPath: validRepo,
      baseBranch: "main",
      prompt: "go",
      issueRef: { ...validIssueRef, url: "javascript:alert(1)" },
    },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/issueRef/i);
});

import { validateSteers, validateBroadcast } from "../src/validate";

// ── validateCloneUrl ──────────────────────────────────────────────────────────

test("validateCloneUrl: valid https URL yields name from slug", () => {
  const r = validateCloneUrl("https://github.com/owner/myrepo");
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.url).toBe("https://github.com/owner/myrepo");
    expect(r.value.name).toBe("myrepo");
  }
});

test("validateCloneUrl: .git suffix stripped from https URL", () => {
  const r = validateCloneUrl("https://github.com/owner/myrepo.git");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.name).toBe("myrepo");
});

test("validateCloneUrl: trailing slash tolerated on https URL", () => {
  const r = validateCloneUrl("https://github.com/owner/myrepo/");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.name).toBe("myrepo");
});

test("validateCloneUrl: valid scp-style git@ URL yields name", () => {
  const r = validateCloneUrl("git@github.com:owner/myrepo.git");
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.url).toBe("git@github.com:owner/myrepo.git");
    expect(r.value.name).toBe("myrepo");
  }
});

test("validateCloneUrl: scp URL without .git suffix yields name", () => {
  const r = validateCloneUrl("git@bitbucket.org:acme/toolkit");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.name).toBe("toolkit");
});

test("validateCloneUrl: http:// (no owner segment) rejected as _url", () => {
  // parseRemote requires slug to contain '/' for url-style
  const r = validateCloneUrl("http://example.com/repo");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("clonerepo_failed_url");
});

test("validateCloneUrl: ftp:// rejected as _url", () => {
  const r = validateCloneUrl("ftp://example.com/owner/repo");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("clonerepo_failed_url");
});

test("validateCloneUrl: plain string not a URL rejected as _url", () => {
  const r = validateCloneUrl("not-a-url");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("clonerepo_failed_url");
});

test("validateCloneUrl: non-string input rejected as _url", () => {
  expect(validateCloneUrl(42).ok).toBe(false);
  expect(validateCloneUrl(null).ok).toBe(false);
  expect(validateCloneUrl(undefined).ok).toBe(false);
});

test("validateCloneUrl: empty string rejected as _url", () => {
  const r = validateCloneUrl("  ");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("clonerepo_failed_url");
});

test("validateCloneUrl: leading-dash name rejected as _url", () => {
  // Craft a URL whose final segment starts with '-'
  const r = validateCloneUrl("https://github.com/owner/-evil-repo");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("clonerepo_failed_url");
});

test("validateCloneUrl: crafted slug producing path traversal rejected as _outside", () => {
  // scp form where the slug's last segment resolves to '..'
  // parseRemote will parse "host:owner/.." → slug "owner/.." → last segment ".."
  const r = validateCloneUrl("git@example.com:owner/../escape");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("clonerepo_failed_outside");
});

test("validateCloneUrl: name with backslash rejected as _outside", () => {
  // Can only inject a backslash by passing a crafted value — simulate via a slug that would
  // yield a name containing '\' (backslash is not valid in git repo names, but we guard anyway)
  // Use the raw validator with a pre-built crafted slug path — the easiest approach is to
  // directly verify the guard by constructing an impossible but valid-structure URL.
  // Since we can't force parseRemote to include '\', we test validateCloneUrl returns _url
  // for a URL that contains backslash (which is not a valid URL character).
  const r = validateCloneUrl("https://github.com/owner/repo\\evil");
  expect(r.ok).toBe(false);
  // Either _url (parseRemote rejects it) or _outside is acceptable
  if (!r.ok) expect(["clonerepo_failed_url", "clonerepo_failed_outside"]).toContain(r.error);
});

test("validateSteers normalizes valid entries and assigns missing ids", () => {
  const out = validateSteers([
    { label: "  run tests ", text: "  run the tests " },
    { id: "keep", label: "rebase", text: "rebase onto main" },
  ]);
  expect(out).not.toBeNull();
  expect(out![0]!.label).toBe("run tests");
  expect(out![0]!.text).toBe("run the tests");
  expect(out![0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(out![1]!.id).toBe("keep");
});

test("validateSteers rejects bad shapes", () => {
  expect(validateSteers({})).toBeNull(); // not an array
  expect(validateSteers([{ label: "x" }])).toBeNull(); // missing text
  expect(validateSteers([{ label: "", text: "y" }])).toBeNull(); // empty label
  expect(validateSteers([{ label: "x", text: "  " }])).toBeNull(); // blank text
  expect(validateSteers([{ label: "a".repeat(61), text: "y" }])).toBeNull(); // label too long
  expect(validateSteers(Array(41).fill({ label: "x", text: "y" }))).toBeNull(); // too many
});

test("validateBroadcast accepts text + ids and trims", () => {
  expect(validateBroadcast({ text: "  go ", ids: ["a", "b"] })).toEqual({
    text: "go",
    ids: ["a", "b"],
  });
});

test("validateBroadcast rejects bad shapes", () => {
  expect(validateBroadcast({ text: "", ids: ["a"] })).toBeNull();
  expect(validateBroadcast({ text: "go", ids: "a" })).toBeNull();
  expect(validateBroadcast({ text: "go", ids: [1] })).toBeNull();
  expect(validateBroadcast({ ids: ["a"] })).toBeNull();
});
