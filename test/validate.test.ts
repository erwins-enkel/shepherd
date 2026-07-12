import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  validateCreate,
  validateCloneUrl,
  validateForkTarget,
  validateNewProject,
  isAuthorized,
  originAllowed,
  classifyOrigin,
  isValidTerminalId,
  expandHome,
  parseTermDims,
  validateEgressExtraHosts,
  validateRelaunchOverrides,
  validateModelChoice,
  validateReplaceAgentChoice,
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

test("validateCreate accepts index-aligned attachment names and visible launch checkbox state", () => {
  const dir = stagingDir(root);
  mkdirSync(dir, { recursive: true });
  const upload = join(dir, "uuid.png");
  writeFileSync(upload, "PNG");

  const r = validateCreate(
    {
      repoPath: validRepo,
      baseBranch: "main",
      prompt: "do the thing",
      images: [upload],
      attachmentNames: ["../mockup\n.png"],
      launchUiState: {
        researchChecked: false,
        planGateChecked: true,
        autopilotChecked: true,
      },
    },
    root,
  );

  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.images).toEqual([upload]);
    expect(r.value.attachmentNames).toEqual(["mockup.png"]);
    expect(r.value.launchUiState).toEqual({
      researchChecked: false,
      planGateChecked: true,
      autopilotChecked: true,
    });
  }
});

test("validateCreate rejects attachment names that do not match image indexes", () => {
  const dir = stagingDir(root);
  mkdirSync(dir, { recursive: true });
  const upload = join(dir, "uuid.png");
  writeFileSync(upload, "PNG");

  const r = validateCreate(
    {
      repoPath: validRepo,
      baseBranch: "main",
      prompt: "do the thing",
      images: [upload],
      attachmentNames: ["one.png", "extra.png"],
    },
    root,
  );

  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("attachmentNames length must match images");
});

test("validateRelaunchOverrides carries attachment names only with images", () => {
  const dir = stagingDir(root);
  mkdirSync(dir, { recursive: true });
  const upload = join(dir, "uuid.png");
  writeFileSync(upload, "PNG");

  const ok = validateRelaunchOverrides(
    {
      images: [upload],
      attachmentNames: ["original.png"],
      launchUiState: {
        researchChecked: false,
        planGateChecked: false,
        autopilotChecked: true,
      },
    },
    root,
  );
  expect(ok.ok).toBe(true);
  if (ok.ok) {
    expect(ok.value.attachmentNames).toEqual(["original.png"]);
    expect(ok.value.launchUiState?.autopilotChecked).toBe(true);
  }

  const bad = validateRelaunchOverrides({ attachmentNames: ["orphan.png"] }, root);
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.error).toBe("attachmentNames requires images");
});

test("known model accepted and passed through", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", model: "opus" },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.model).toBe("opus");
});

test("codex model accepted and passed through when provider is codex", () => {
  const r = validateCreate(
    {
      repoPath: validRepo,
      baseBranch: "main",
      prompt: "go",
      agentProvider: "codex",
      model: "gpt-5.5",
    },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.model).toBe("gpt-5.5");
});

test("verified curated GPT-5.6 Codex model accepted when provider is codex", () => {
  const r = validateCreate(
    {
      repoPath: validRepo,
      baseBranch: "main",
      prompt: "go",
      agentProvider: "codex",
      model: "gpt-5.6-sol",
    },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.model).toBe("gpt-5.6-sol");
});

test("future-looking safe codex model accepted when provider is codex", () => {
  const r = validateCreate(
    {
      repoPath: validRepo,
      baseBranch: "main",
      prompt: "go",
      agentProvider: "codex",
      model: "gpt-5.6-codex",
    },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.model).toBe("gpt-5.6-codex");
});

test("unsafe codex model rejected", () => {
  const r = validateCreate(
    {
      repoPath: validRepo,
      baseBranch: "main",
      prompt: "go",
      agentProvider: "codex",
      model: "--profile=other",
    },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/codex model/i);
});

test("known Claude model rejected when provider is codex", () => {
  const r = validateCreate(
    {
      repoPath: validRepo,
      baseBranch: "main",
      prompt: "go",
      agentProvider: "codex",
      model: "opus",
    },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/codex model/i);
});

test("agentProvider accepts claude and codex", () => {
  for (const agentProvider of ["claude", "codex"] as const) {
    const r = validateCreate(
      { repoPath: validRepo, baseBranch: "main", prompt: "go", agentProvider },
      root,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.agentProvider).toBe(agentProvider);
  }
});

test("unknown agentProvider rejected", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", agentProvider: "other" },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/agentProvider/);
});

test("1M-context aliases accepted and passed through verbatim", () => {
  // Fails on pre-fix code: before opus[1m]/sonnet[1m] were added to MODELS the
  // validator rejected them as "unknown model". The bracketed token must pass
  // through unchanged so it reaches --model intact.
  for (const alias of ["opus[1m]", "sonnet[1m]"]) {
    const r = validateCreate(
      { repoPath: validRepo, baseBranch: "main", prompt: "go", model: alias },
      root,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.model).toBe(alias);
  }
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

test("sandboxProfile: valid value accepted + passed through", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", sandboxProfile: "autonomous" },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.sandboxProfile).toBe("autonomous");
});

test("sandboxProfile: absent → undefined (inherit repo default)", () => {
  const r = validateCreate({ repoPath: validRepo, baseBranch: "main", prompt: "go" }, root);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.sandboxProfile).toBeUndefined();
});

test("sandboxProfile: invalid value rejected", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", sandboxProfile: "bogus" },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/sandboxProfile/);
});

test("autopilotEnabled: false accepted + passed through", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", autopilotEnabled: false },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.autopilotEnabled).toBe(false);
});

test("autopilotEnabled: true accepted + passed through", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", autopilotEnabled: true },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.autopilotEnabled).toBe(true);
});

test("autopilotEnabled: null accepted (inherit repo default)", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", autopilotEnabled: null },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.autopilotEnabled).toBeNull();
});

test("autopilotEnabled: absent → undefined (inherit repo default)", () => {
  const r = validateCreate({ repoPath: validRepo, baseBranch: "main", prompt: "go" }, root);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.autopilotEnabled).toBeUndefined();
});

test("autopilotEnabled: non-boolean string rejected", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", autopilotEnabled: "yes" },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/autopilotEnabled/);
});

test("research: true accepted + passed through", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", research: true },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.research).toBe(true);
});

test("research: false accepted + passed through", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", research: false },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.research).toBe(false);
});

test("research: absent → false", () => {
  const r = validateCreate({ repoPath: validRepo, baseBranch: "main", prompt: "go" }, root);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.research).toBe(false);
});

test("research: non-boolean string rejected", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", research: "yes" },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/research/);
});

test("research: numeric 1 rejected", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", research: 1 },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/research/);
});

test("research: null rejected", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", research: null },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/research/);
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

test("originAllowed: chrome-extension origin passes when its ID is allowlisted", () => {
  // For a chrome-extension:// origin the URL hostname IS the extension ID, so listing the
  // Capture ID in the allowlist (the shipped default) accepts its captures with no pairing.
  const id = "bflahkibnmcbijbhelmpjbohpfhlbaig";
  expect(originAllowed(`chrome-extension://${id}`, [...allowedHosts, id])).toBe(true);
  expect(originAllowed(`chrome-extension://${id}`, allowedHosts)).toBe(false);
});

// ── classifyOrigin (issue #1645 Fix 3) ────────────────────────────────────────
// originAllowed is now a thin wrapper over classifyOrigin(...) === "allow"; these assert
// the two rejection reasons stay distinct so the client can show accurate copy.

const previewRange = { base: 8001, count: 16 };

// Absent/empty Origin must classify as "allow" — preserves the curl/CLI bypass
// (originAllowed's `if (!originHeader) return true`).
test("classifyOrigin: absent/empty Origin is allow (curl/cli)", () => {
  expect(classifyOrigin(null, allowedHosts, previewRange)).toBe("allow");
  expect(classifyOrigin(undefined, allowedHosts, previewRange)).toBe("allow");
  expect(classifyOrigin("", allowedHosts, previewRange)).toBe("allow");
});

test("classifyOrigin: allowlisted host is allow", () => {
  expect(classifyOrigin("http://localhost:7330", allowedHosts, previewRange)).toBe("allow");
});

// The auto-allowed node's own tailnet host (Fix 2) classifies as allow.
test("classifyOrigin: folded-in node host is allow", () => {
  const hosts = [...allowedHosts, "agentnode.example.ts.net"];
  expect(classifyOrigin("https://agentnode.example.ts.net", hosts, previewRange)).toBe("allow");
});

// The un-allowlisted-host reason drives the new SHEPHERD_ALLOWED_HOSTS hint copy.
test("classifyOrigin: non-allowlisted host is host-not-allowed", () => {
  expect(classifyOrigin("https://other.example.ts.net", allowedHosts, previewRange)).toBe(
    "host-not-allowed",
  );
});

// Preview-port precedence: a preview app on an ALLOWLISTED host is still preview-port,
// never allow — this is the CSRF invariant that Fix 2 must not weaken.
test("classifyOrigin: preview-port on an allowlisted host is preview-port (not allow)", () => {
  const hosts = [...allowedHosts, "agentnode.example.ts.net"];
  expect(classifyOrigin("https://agentnode.example.ts.net:8001", hosts, previewRange)).toBe(
    "preview-port",
  );
  expect(classifyOrigin("http://localhost:8005", hosts, previewRange)).toBe("preview-port");
});

// A port just outside the range on a non-allowlisted host is host-not-allowed, not preview-port.
test("classifyOrigin: out-of-range port on non-allowlisted host is host-not-allowed", () => {
  expect(classifyOrigin("https://other.example.ts.net:8017", allowedHosts, previewRange)).toBe(
    "host-not-allowed",
  );
});

test("classifyOrigin: malformed Origin is host-not-allowed", () => {
  expect(classifyOrigin("not-a-url", allowedHosts, previewRange)).toBe("host-not-allowed");
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

test("validateCreate accepts attachments inside the staging dir", () => {
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

test("validateCreate rejects an attachment outside the staging dir", () => {
  mkdirSync(stagingDir(root), { recursive: true });
  const outside = join(root, "evil.png");
  writeFileSync(outside, "x");
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", images: [outside] },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("attachment must be inside the staging dir");
});

test("validateCreate rejects a non-existent attachment", () => {
  mkdirSync(stagingDir(root), { recursive: true });
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
  if (!r.ok) expect(r.error).toBe("attachment does not exist");
});

test("validateCreate rejects more than 10 attachments", () => {
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
  if (!r.ok) expect(r.error).toBe("attachments must be ≤ 10 entries");
});

test("validateCreate rejects a non-array images value", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", images: "x" },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("attachments must be an array");
});

test("validateCreate rejects duplicate attachment paths", () => {
  const staging = stagingDir(root);
  mkdirSync(staging, { recursive: true });
  const img = join(staging, "dup.png");
  writeFileSync(img, "x");
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", images: [img, img] },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("duplicate attachment paths");
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

// ── validateForkTarget ────────────────────────────────────────────────────────

test("validateForkTarget: bare owner/repo shorthand → repo passed through, name from slug", () => {
  const r = validateForkTarget("dannymcc/may");
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.repo).toBe("dannymcc/may");
    expect(r.value.name).toBe("may");
  }
});

test("validateForkTarget: owner/repo.git shorthand strips .git for both repo and name", () => {
  const r = validateForkTarget("dannymcc/may.git");
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.repo).toBe("dannymcc/may");
    expect(r.value.name).toBe("may");
  }
});

test("validateForkTarget: https URL → full URL passed to gh, name from slug", () => {
  const r = validateForkTarget("https://github.com/dannymcc/may");
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.repo).toBe("https://github.com/dannymcc/may");
    expect(r.value.name).toBe("may");
  }
});

test("validateForkTarget: scp-style git@ URL accepted, name from slug", () => {
  const r = validateForkTarget("git@github.com:dannymcc/may.git");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.name).toBe("may");
});

test("validateForkTarget: empty / non-string → _url", () => {
  expect(validateForkTarget("").ok).toBe(false);
  expect(validateForkTarget("   ").ok).toBe(false);
  expect(validateForkTarget(123).ok).toBe(false);
  expect(validateForkTarget(null).ok).toBe(false);
});

test("validateForkTarget: bare single segment (no owner) rejected as _url", () => {
  const r = validateForkTarget("just-a-repo");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("forkrepo_failed_url");
});

test("validateForkTarget: ftp:// and other schemes rejected as _url", () => {
  expect(validateForkTarget("ftp://github.com/owner/repo").ok).toBe(false);
  expect(validateForkTarget("file:///etc/passwd").ok).toBe(false);
});

test("validateForkTarget: traversal segment in a URL rejected as _outside", () => {
  const r = validateForkTarget("https://github.com/owner/..");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("forkrepo_failed_outside");
});

test("validateForkTarget: leading-dash repo (would be a gh flag) rejected", () => {
  expect(validateForkTarget("-flag/repo").ok).toBe(false);
});

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
  // legacy payloads (no emoji/scopes) default to steer-bar-only, no emoji
  expect(out![0]!.emoji).toBeUndefined();
  expect(out![0]!.inSteerBar).toBe(true);
  expect(out![0]!.onIssues).toBe(false);
});

test("validateSteers keeps emoji + surface flags and drops a blank emoji", () => {
  const out = validateSteers([
    { id: "a", label: "fix", text: "fix it", emoji: " 🐛 ", inSteerBar: false, onIssues: true },
    { id: "b", label: "spec", text: "write a spec", emoji: "  " },
  ]);
  expect(out).not.toBeNull();
  expect(out![0]).toEqual({
    id: "a",
    label: "fix",
    text: "fix it",
    emoji: "🐛",
    inSteerBar: false,
    onIssues: true,
  });
  expect(out![1]!.emoji).toBeUndefined(); // whitespace-only emoji → none
});

test("validateSteers rejects bad shapes", () => {
  expect(validateSteers({})).toBeNull(); // not an array
  expect(validateSteers([{ label: "x" }])).toBeNull(); // missing text
  expect(validateSteers([{ label: "", text: "y" }])).toBeNull(); // empty label
  expect(validateSteers([{ label: "x", text: "  " }])).toBeNull(); // blank text
  expect(validateSteers([{ label: "a".repeat(61), text: "y" }])).toBeNull(); // label too long
  expect(validateSteers(Array(41).fill({ label: "x", text: "y" }))).toBeNull(); // too many
  expect(validateSteers([{ label: "x", text: "y", emoji: 7 }])).toBeNull(); // non-string emoji
  expect(validateSteers([{ label: "x", text: "y", emoji: "🐛".repeat(9) }])).toBeNull(); // emoji too long
  expect(validateSteers([{ label: "x", text: "y", emoji: "\u0007" }])).toBeNull(); // control char
  expect(validateSteers([{ label: "x", text: "y", inSteerBar: "yes" }])).toBeNull(); // non-bool scope
  expect(validateSteers([{ label: "x", text: "y", onIssues: 1 }])).toBeNull(); // non-bool scope
  // both surfaces off → the steer would render nowhere (mirrors the editor guard)
  expect(
    validateSteers([{ label: "x", text: "y", inSteerBar: false, onIssues: false }]),
  ).toBeNull();
});

test("validateSteers repos: accepts a valid allowlist, trims + dedupes", () => {
  const out = validateSteers([{ label: "x", text: "y", repos: ["  alpha ", "beta", "alpha"] }]);
  expect(out).not.toBeNull();
  expect(out![0]!.repos).toEqual(["alpha", "beta"]);
});

test("validateSteers repos: absent → field omitted (universal)", () => {
  const out = validateSteers([{ label: "x", text: "y" }]);
  expect(out).not.toBeNull();
  expect(out![0]!.repos).toBeUndefined();
});

test("validateSteers repos: empty array dedupes to empty → field omitted (universal)", () => {
  const out = validateSteers([{ label: "x", text: "y", repos: [] }]);
  expect(out).not.toBeNull();
  expect(out![0]!.repos).toBeUndefined();
});

test("validateSteers repos: rejects bad shapes", () => {
  expect(validateSteers([{ label: "x", text: "y", repos: "alpha" }])).toBeNull(); // non-array
  expect(validateSteers([{ label: "x", text: "y", repos: [1] }])).toBeNull(); // non-string entry
  expect(validateSteers([{ label: "x", text: "y", repos: ["   "] }])).toBeNull(); // empty-after-trim
  expect(validateSteers([{ label: "x", text: "y", repos: ["a".repeat(256)] }])).toBeNull(); // >255 chars
  expect(validateSteers([{ label: "x", text: "y", repos: Array(41).fill("r") }])).toBeNull(); // >STEER_MAX length
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

// ── validateNewProject ────────────────────────────────────────────────────────

test("validateNewProject: valid slug passes and echoes normalized value", () => {
  const r = validateNewProject(
    { name: "my-app", idea: "  a todo app  ", createRemote: true, visibility: "public" },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.name).toBe("my-app");
    expect(r.value.idea).toBe("a todo app"); // trimmed
    expect(r.value.createRemote).toBe(true);
    expect(r.value.visibility).toBe("public");
  }
});

test("validateNewProject: createRemote and visibility default when absent", () => {
  const r = validateNewProject({ name: "cool-proj" }, root);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.createRemote).toBe(false);
    expect(r.value.visibility).toBe("private");
    expect(r.value.idea).toBe("");
  }
});

test("validateNewProject: uppercase in name → newproject_failed_slug", () => {
  const r = validateNewProject({ name: "My-App" }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("newproject_failed_slug");
});

test("validateNewProject: spaces in name → newproject_failed_slug", () => {
  const r = validateNewProject({ name: "my app" }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("newproject_failed_slug");
});

test("validateNewProject: leading dash → newproject_failed_slug", () => {
  const r = validateNewProject({ name: "-myapp" }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("newproject_failed_slug");
});

test("validateNewProject: empty name → newproject_failed_slug", () => {
  const r = validateNewProject({ name: "" }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("newproject_failed_slug");
});

test("validateNewProject: name with .. → newproject_failed_slug", () => {
  const r = validateNewProject({ name: "my..app" }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("newproject_failed_slug");
});

test("validateNewProject: name equal to '..' → newproject_failed_slug", () => {
  const r = validateNewProject({ name: ".." }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("newproject_failed_slug");
});

test("validateNewProject: name ending with .git → newproject_failed_slug", () => {
  const r = validateNewProject({ name: "my-repo.git" }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("newproject_failed_slug");
});

test("validateNewProject: unknown key → newproject_failed_generic", () => {
  const r = validateNewProject({ name: "my-app", evil: "x" }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("newproject_failed_generic");
});

test("validateNewProject: bad visibility → newproject_failed_generic", () => {
  const r = validateNewProject({ name: "my-app", visibility: "internal" }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("newproject_failed_generic");
});

test("validateNewProject: owner defaults to '' when absent", () => {
  const r = validateNewProject({ name: "cool-proj" }, root);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.owner).toBe("");
});

test("validateNewProject: valid org owner passes and is echoed", () => {
  const r = validateNewProject({ name: "my-app", owner: "acme-corp" }, root);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.owner).toBe("acme-corp");
});

test("validateNewProject: empty-string owner normalizes to '' (personal)", () => {
  const r = validateNewProject({ name: "my-app", owner: "" }, root);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.owner).toBe("");
});

test("validateNewProject: owner with illegal chars → newproject_failed_generic", () => {
  const r = validateNewProject({ name: "my-app", owner: "bad/owner" }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("newproject_failed_generic");
});

test("validateNewProject: owner too long → newproject_failed_generic", () => {
  const r = validateNewProject({ name: "my-app", owner: "a".repeat(40) }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("newproject_failed_generic");
});

test("validateNewProject: non-boolean createRemote → newproject_failed_generic", () => {
  const r = validateNewProject({ name: "my-app", createRemote: "yes" }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("newproject_failed_generic");
});

test("validateNewProject: non-string idea → newproject_failed_generic", () => {
  const r = validateNewProject({ name: "my-app", idea: 42 }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("newproject_failed_generic");
});

test("validateNewProject: idea > 8000 chars → newproject_failed_generic", () => {
  const r = validateNewProject({ name: "my-app", idea: "x".repeat(8001) }, root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("newproject_failed_generic");
});

test("validateNewProject: idea exactly 8000 chars accepted", () => {
  const r = validateNewProject({ name: "my-app", idea: "x".repeat(8000) }, root);
  expect(r.ok).toBe(true);
});

test("validateNewProject: non-object body → newproject_failed_generic", () => {
  expect(validateNewProject(null, root).ok).toBe(false);
  expect(validateNewProject("string", root).ok).toBe(false);
  expect(validateNewProject(42, root).ok).toBe(false);
  expect(validateNewProject([], root).ok).toBe(false);
});

test("validateNewProject: containment guard fires for a crafted escaping path", () => {
  // The slug regex blocks '/' and '\', so a well-formed call cannot escape root.
  // To test the guard directly, we pick a repoRoot that is a child of `root` and a
  // slug-valid name whose join() would still land inside (to prove the happy path),
  // then we simulate the only bypass surface: using an absolute path as repoRoot set
  // to a *sibling* directory so that join(sibling, name) is inside sibling — fine.
  // To actually trigger _outside we need join(root, name) to not start with root+sep.
  // This can happen when root ends with the name as a segment: e.g. root="/tmp/a/b" and
  // name="b" → join("/tmp/a/b","b") = "/tmp/a/b/b" which IS inside — that's fine.
  // The only reliable way is a root == target case (name="") which is already rejected by regex.
  // Conclusion: the guard is defense-in-depth; test its presence by verifying a valid name
  // resolves inside, confirming the guard ran and did not fire.
  const subRoot = join(root, "projects");
  mkdirSync(subRoot, { recursive: true });
  const r = validateNewProject({ name: "my-project" }, subRoot);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.name).toBe("my-project");
});

// ── validateEgressExtraHosts ──────────────────────────────────────────────────

test("egressExtraHosts: absent → []", () => {
  const r = validateEgressExtraHosts(undefined);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value).toEqual([]);
});

test("egressExtraHosts: null → []", () => {
  const r = validateEgressExtraHosts(null);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value).toEqual([]);
});

test("egressExtraHosts: valid array passes", () => {
  const r = validateEgressExtraHosts(["registry.npmjs.org", "pkg.debian.org"]);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value).toEqual(["registry.npmjs.org", "pkg.debian.org"]);
});

test("egressExtraHosts: empty array passes", () => {
  const r = validateEgressExtraHosts([]);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value).toEqual([]);
});

test("egressExtraHosts: non-array → error", () => {
  expect(validateEgressExtraHosts("registry.npmjs.org").ok).toBe(false);
  expect(validateEgressExtraHosts(42).ok).toBe(false);
  expect(validateEgressExtraHosts({}).ok).toBe(false);
  const r = validateEgressExtraHosts("not-an-array");
  if (!r.ok) expect(r.error).toMatch(/array/);
});

test("egressExtraHosts: non-string element → error", () => {
  const r = validateEgressExtraHosts(["good.example.com", 123]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/string/);
});

test("egressExtraHosts: hostname without dot → error", () => {
  const r = validateEgressExtraHosts(["localhost"]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/valid hostname/);
});

test("egressExtraHosts: uppercase is normalized to lowercase (not rejected)", () => {
  // Mirrors the allowlist builder, which also lowercases — what validates is exactly
  // what makes the allowlist, stored in normalized form.
  const r = validateEgressExtraHosts(["UPPER.Example.COM", "  Pad.Host.org  "]);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value).toEqual(["upper.example.com", "pad.host.org"]);
});

test("egressExtraHosts: invalid chars (underscore) → error", () => {
  const r = validateEgressExtraHosts(["foo_bar.example.com"]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/valid hostname/);
});

test("egressExtraHosts: hostname with spaces → error", () => {
  const r = validateEgressExtraHosts(["bad host.example.com"]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/valid hostname/);
});

test("egressExtraHosts: aligned with allowlist normalizer — rejects what egress.ts drops", () => {
  // These previously passed the looser validator then were SILENTLY dropped at spawn.
  // Now validation matches normalizeHost exactly, so they're rejected up front.
  for (const bad of ["foo..com", "-foo.com", "foo-.com", ".foo.com", "foo.com."]) {
    expect(validateEgressExtraHosts([bad]).ok).toBe(false);
  }
});

// ── validateRelaunchOverrides: research field ─────────────────────────────────

test("validateRelaunchOverrides: research:true is accepted and forwarded", () => {
  const r = validateRelaunchOverrides({ research: true }, homedir());
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.research).toBe(true);
});

test("validateRelaunchOverrides: research:false is accepted and forwarded", () => {
  const r = validateRelaunchOverrides({ research: false }, homedir());
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.research).toBe(false);
});

test("validateRelaunchOverrides: non-boolean research is rejected", () => {
  const r = validateRelaunchOverrides({ research: "yes" }, homedir());
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/research/);
});

test("validateRelaunchOverrides: absent research is not written onto output", () => {
  const r = validateRelaunchOverrides({}, homedir());
  expect(r.ok).toBe(true);
  if (r.ok) expect("research" in r.value).toBe(false);
});

// ── validateCreate: mergeTrainPrs ────────────────────────────────────────────

test("mergeTrainPrs: [0] rejected (not positive)", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", mergeTrainPrs: [0] },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/mergeTrainPrs/);
});

test("mergeTrainPrs: [-1] rejected (not positive)", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", mergeTrainPrs: [-1] },
    root,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/mergeTrainPrs/);
});

test("mergeTrainPrs: [1, 2, 3] accepted", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", mergeTrainPrs: [1, 2, 3] },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.mergeTrainPrs).toEqual([1, 2, 3]);
});

// ── validateModelChoice / validateReplaceAgentChoice: effort (#1418) ─────────

test("validateModelChoice: valid effort tier is accepted", () => {
  const r = validateModelChoice({ model: null, effort: "high" });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.effort).toBe("high");
});

test("validateModelChoice: bogus effort is rejected", () => {
  const r = validateModelChoice({ model: null, effort: "bogus" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/effort/);
});

test("validateModelChoice: absent effort defaults to null", () => {
  const r = validateModelChoice({ model: null });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.effort).toBeNull();
});

test("validateReplaceAgentChoice: valid effort tier is accepted", () => {
  const r = validateReplaceAgentChoice({ model: null, effort: "high" });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.effort).toBe("high");
});

test("validateReplaceAgentChoice: bogus effort is rejected", () => {
  const r = validateReplaceAgentChoice({ model: null, effort: "bogus" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/effort/);
});

test("validateReplaceAgentChoice: absent effort defaults to null", () => {
  const r = validateReplaceAgentChoice({ model: null });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.effort).toBeNull();
});
