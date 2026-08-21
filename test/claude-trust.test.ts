import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeConfigPath,
  ensureRepoRootTrusted,
  readRepoRootTrusted,
  trustRepoRoot,
} from "../src/claude-trust";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "claude-trust-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── path selection: config-dir-aware target (#1075 blocking) ─────────────────
// Mirrors sandbox.ts:404 — the seed/read MUST hit the same file Claude uses, else a
// custom-config-dir install seeds the wrong file (wedge persists) and reads the wrong
// file (read-gate never trips → spurious rewrite every run).
test("claudeConfigPath targets $HOME/.claude.json for the default config dir", () => {
  const home = "/home/alice";
  expect(claudeConfigPath(home, `${home}/.claude`)).toBe("/home/alice/.claude.json");
});

test("claudeConfigPath targets ${CLAUDE_CONFIG_DIR}/.claude.json for a custom config dir", () => {
  const home = "/home/alice";
  expect(claudeConfigPath(home, "/custom/cfg")).toBe("/custom/cfg/.claude.json");
});

// ── round-trip ───────────────────────────────────────────────────────────────
test("untrusted → trust → trusted", async () => {
  await withTmp(async (dir) => {
    const cfg = join(dir, ".claude.json");
    await writeFile(
      cfg,
      JSON.stringify({ projects: { "/repo": { hasTrustDialogAccepted: false } } }),
    );

    expect(await readRepoRootTrusted(cfg, "/repo")).toBe(false);
    await trustRepoRoot(cfg, "/repo");
    expect(await readRepoRootTrusted(cfg, "/repo")).toBe(true);
  });
});

test("trust preserves sibling project fields and other top-level keys", async () => {
  await withTmp(async (dir) => {
    const cfg = join(dir, ".claude.json");
    await writeFile(
      cfg,
      JSON.stringify({
        oauthAccount: { email: "a@b.c" },
        projects: {
          "/repo": { history: [1, 2, 3], hasTrustDialogAccepted: false },
          "/other": { hasTrustDialogAccepted: true },
        },
      }),
    );

    await trustRepoRoot(cfg, "/repo");
    const j = JSON.parse(await readFile(cfg, "utf8"));

    expect(j.projects["/repo"].hasTrustDialogAccepted).toBe(true);
    expect(j.projects["/repo"].history).toEqual([1, 2, 3]); // sibling field intact
    expect(j.projects["/other"].hasTrustDialogAccepted).toBe(true); // other project intact
    expect(j.oauthAccount).toEqual({ email: "a@b.c" }); // other top-level key intact
  });
});

test("readRepoRootTrusted → false for a missing file; trust creates it", async () => {
  await withTmp(async (dir) => {
    const cfg = join(dir, ".claude.json"); // does not exist yet
    expect(await readRepoRootTrusted(cfg, "/repo")).toBe(false);

    await trustRepoRoot(cfg, "/repo");
    const j = JSON.parse(await readFile(cfg, "utf8"));
    expect(j.projects["/repo"].hasTrustDialogAccepted).toBe(true);
  });
});

test("malformed JSON → readRepoRootTrusted false; trust rewrites a clean file", async () => {
  await withTmp(async (dir) => {
    const cfg = join(dir, ".claude.json");
    await writeFile(cfg, "{ not valid json ");

    expect(await readRepoRootTrusted(cfg, "/repo")).toBe(false);
    await trustRepoRoot(cfg, "/repo");
    expect(await readRepoRootTrusted(cfg, "/repo")).toBe(true);
  });
});

test("trust writes compact JSON (no pretty-print reflow)", async () => {
  await withTmp(async (dir) => {
    const cfg = join(dir, ".claude.json");
    await writeFile(cfg, JSON.stringify({ projects: {} }));

    await trustRepoRoot(cfg, "/repo");
    const raw = await readFile(cfg, "utf8");
    expect(raw).not.toContain("\n"); // compact — single line
    expect(JSON.parse(raw).projects["/repo"].hasTrustDialogAccepted).toBe(true);
  });
});

test("ensureRepoRootTrusted seeds an untrusted dir and leaves a trusted one untouched", async () => {
  await withTmp(async (dir) => {
    const cfg = join(dir, ".claude.json");
    await writeFile(cfg, JSON.stringify({ projects: {} }));

    await ensureRepoRootTrusted(cfg, "/repo");
    expect(await readRepoRootTrusted(cfg, "/repo")).toBe(true);

    // Already trusted → read-gated, so the file is not rewritten. Byte-compare rather than
    // trusting mtime: the second call is sub-ms after the first.
    const before = await readFile(cfg, "utf8");
    await ensureRepoRootTrusted(cfg, "/repo");
    expect(await readFile(cfg, "utf8")).toBe(before);
  });
});

test("ensureRepoRootTrusted preserves unrelated project state", async () => {
  await withTmp(async (dir) => {
    const cfg = join(dir, ".claude.json");
    await writeFile(
      cfg,
      JSON.stringify({ projects: { "/other": { history: ["x"] } }, hasCompletedOnboarding: true }),
    );

    await ensureRepoRootTrusted(cfg, "/repo");
    const j = JSON.parse(await readFile(cfg, "utf8"));
    expect(j.projects["/other"].history).toEqual(["x"]);
    expect(j.hasCompletedOnboarding).toBe(true);
    expect(j.projects["/repo"].hasTrustDialogAccepted).toBe(true);
  });
});
