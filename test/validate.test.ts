import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  validateCreate,
  isAuthorized,
  originAllowed,
  isValidTerminalId,
  expandHome,
  parseTermDims,
} from "../src/validate";

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
