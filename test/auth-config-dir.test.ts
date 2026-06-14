import { test, expect, describe, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  realpathSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CREDENTIAL_FILE,
  CONFIG_FILE,
  apiKeyConfigDir,
  provisionApiKeyConfigDir,
  ensureApiKeyConfigDir,
} from "../src/auth-config-dir";

// ── helpers ───────────────────────────────────────────────────────────────────

let tmpRoot: string | null = null;

function makeTmp(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), "auth-config-dir-test-"));
  return tmpRoot;
}

afterEach(() => {
  if (tmpRoot) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    tmpRoot = null;
  }
});

/** Build a fake source claude dir with representative contents. */
function buildFakeSource(root: string): string {
  const src = join(root, "fake-claude");
  mkdirSync(src, { recursive: true });

  // Credential file — must NOT appear in dest.
  writeFileSync(join(src, ".credentials.json"), '{"token":"super-secret"}');
  // Representative files that MUST appear in dest.
  writeFileSync(join(src, "settings.json"), '{"theme":"dark"}');
  writeFileSync(join(src, "CLAUDE.md"), "# Instructions");
  // Subdir with a file.
  mkdirSync(join(src, "skills"), { recursive: true });
  writeFileSync(join(src, "skills", "my-skill.md"), "skill content");

  return src;
}

// ── CREDENTIAL_FILE ───────────────────────────────────────────────────────────

describe("CREDENTIAL_FILE", () => {
  test("is .credentials.json", () => {
    expect(CREDENTIAL_FILE).toBe(".credentials.json");
  });
});

// ── CONFIG_FILE (.claude.json copy) ─────────────────────────────────────────────

describe("CONFIG_FILE", () => {
  test("is .claude.json", () => {
    expect(CONFIG_FILE).toBe(".claude.json");
  });
});

describe("provisionApiKeyConfigDir .claude.json handling", () => {
  // .claude.json lives at $HOME/.claude.json — a SIBLING of ~/.claude, so it's never
  // a child the symlink mirror would pick up. Claude reads it from CLAUDE_CONFIG_DIR,
  // so the mirror must COPY it in or the spawn fails to start. These cover that copy.
  test("copies the HOME-sibling .claude.json into dest as a real file (not a symlink)", () => {
    const root = makeTmp();
    const src = buildFakeSource(root); // ${root}/fake-claude
    writeFileSync(join(root, ".claude.json"), '{"hasCompletedOnboarding":true}');
    const dest = join(root, "dest");

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });

    const destConfig = join(dest, ".claude.json");
    expect(existsSync(destConfig)).toBe(true);
    expect(lstatSync(destConfig).isSymbolicLink()).toBe(false); // a copy, not a symlink
    expect(readFileSync(destConfig, "utf8")).toBe('{"hasCompletedOnboarding":true}');
    // credential still absent; no stray temp file left behind
    expect(existsSync(join(dest, CREDENTIAL_FILE))).toBe(false);
    expect(existsSync(`${destConfig}.tmp.${process.pid}`)).toBe(false);
  });

  test("does not prune .claude.json on re-provision (idempotent) and refreshes it", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const homeConfig = join(root, ".claude.json");
    writeFileSync(homeConfig, '{"v":1}');
    const dest = join(root, "dest");

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });
    expect(readFileSync(join(dest, ".claude.json"), "utf8")).toBe('{"v":1}');

    // source changes → re-provision picks it up, and the prune step must NOT delete it
    writeFileSync(homeConfig, '{"v":2}');
    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });
    expect(existsSync(join(dest, ".claude.json"))).toBe(true);
    expect(readFileSync(join(dest, ".claude.json"), "utf8")).toBe('{"v":2}');
  });

  test("is a snapshot copy — mutating dest does not touch the source", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const homeConfig = join(root, ".claude.json");
    writeFileSync(homeConfig, '{"v":1}');
    const dest = join(root, "dest");

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });
    writeFileSync(join(dest, ".claude.json"), '{"v":"mutated-by-spawn"}');
    expect(readFileSync(homeConfig, "utf8")).toBe('{"v":1}'); // source untouched
  });

  test("missing HOME-sibling .claude.json → no dest copy, no throw, credential still absent", () => {
    const root = makeTmp();
    const src = buildFakeSource(root); // no ${root}/.claude.json written
    const dest = join(root, "dest");

    expect(() => provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest })).not.toThrow();
    expect(existsSync(join(dest, ".claude.json"))).toBe(false);
    expect(existsSync(join(dest, CREDENTIAL_FILE))).toBe(false);
    // mirror still built
    expect(existsSync(join(dest, "settings.json"))).toBe(true);
  });
});

// ── apiKeyConfigDir ───────────────────────────────────────────────────────────

describe("apiKeyConfigDir", () => {
  test("is nested under .shepherd/", () => {
    const dir = apiKeyConfigDir("/home/user");
    expect(dir).toContain(".shepherd");
    expect(dir.startsWith("/home/user")).toBe(true);
  });

  test("is deterministic for same home", () => {
    expect(apiKeyConfigDir("/home/user")).toBe(apiKeyConfigDir("/home/user"));
  });
});

// ── provisionApiKeyConfigDir — basic provisioning ─────────────────────────────

describe("provisionApiKeyConfigDir — basic provisioning", () => {
  test("destDir is created and exists", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const dest = join(root, "dest");

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });

    expect(existsSync(dest)).toBe(true);
  });

  test("settings.json appears as a symlink in dest", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const dest = join(root, "dest");

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });

    const stat = lstatSync(join(dest, "settings.json"));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  test("CLAUDE.md appears as a symlink in dest", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const dest = join(root, "dest");

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });

    const stat = lstatSync(join(dest, "CLAUDE.md"));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  test("skills/ subdir appears as a symlink in dest", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const dest = join(root, "dest");

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });

    const stat = lstatSync(join(dest, "skills"));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  test(".credentials.json does NOT appear in dest", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const dest = join(root, "dest");

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });

    expect(existsSync(join(dest, CREDENTIAL_FILE))).toBe(false);
  });
});

// ── symlinks resolve to correct absolute source paths ─────────────────────────

describe("provisionApiKeyConfigDir — symlink targets", () => {
  test("settings.json symlink resolves to the source file", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const dest = join(root, "dest");

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });

    const resolved = realpathSync(join(dest, "settings.json"));
    expect(resolved).toBe(realpathSync(join(src, "settings.json")));
  });

  test("skills/ symlink resolves to source skills/ dir", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const dest = join(root, "dest");

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });

    const resolved = realpathSync(join(dest, "skills"));
    expect(resolved).toBe(realpathSync(join(src, "skills")));
  });
});

// ── idempotency ───────────────────────────────────────────────────────────────

describe("provisionApiKeyConfigDir — idempotent", () => {
  test("calling twice does not throw", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const dest = join(root, "dest");

    expect(() => {
      provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });
      provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });
    }).not.toThrow();
  });

  test("calling twice yields the same symlinks", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const dest = join(root, "dest");

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });
    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });

    const resolved = realpathSync(join(dest, "settings.json"));
    expect(resolved).toBe(realpathSync(join(src, "settings.json")));
    expect(existsSync(join(dest, CREDENTIAL_FILE))).toBe(false);
  });
});

// ── self-healing ──────────────────────────────────────────────────────────────

describe("provisionApiKeyConfigDir — self-healing", () => {
  test("stale symlink in dest is removed on re-provision", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const dest = join(root, "dest");
    mkdirSync(dest, { recursive: true });

    // Add a stale symlink pointing to a non-existent source entry.
    const stale = join(src, "old-entry.txt");
    symlinkSync(stale, join(dest, "old-entry.txt"));

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });

    expect(existsSync(join(dest, "old-entry.txt"))).toBe(false);
  });

  test("stale real file in dest is removed on re-provision", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const dest = join(root, "dest");
    mkdirSync(dest, { recursive: true });

    // Write a real file for an entry that no longer exists in source.
    writeFileSync(join(dest, "orphan.txt"), "stale data");

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });

    expect(existsSync(join(dest, "orphan.txt"))).toBe(false);
  });

  test("removed source entry causes dest symlink to disappear on re-provision", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const dest = join(root, "dest");

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });
    expect(lstatSync(join(dest, "CLAUDE.md")).isSymbolicLink()).toBe(true);

    // Remove source entry.
    rmSync(join(src, "CLAUDE.md"));

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });

    expect(existsSync(join(dest, "CLAUDE.md"))).toBe(false);
  });

  test("wrong-target symlink in dest is replaced with correct target on re-provision", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const dest = join(root, "dest");
    mkdirSync(dest, { recursive: true });

    // Pre-create a symlink for settings.json pointing at a WRONG absolute path.
    const wrongTarget = join(root, "wrong", "settings.json");
    symlinkSync(wrongTarget, join(dest, "settings.json"));

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });

    // The symlink must now resolve to the correct source file.
    const stat = lstatSync(join(dest, "settings.json"));
    expect(stat.isSymbolicLink()).toBe(true);
    const resolved = realpathSync(join(dest, "settings.json"));
    expect(resolved).toBe(realpathSync(join(src, "settings.json")));
  });

  test("pre-existing real .credentials.json in dest is removed", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const dest = join(root, "dest");
    mkdirSync(dest, { recursive: true });

    // Manually place a real credential file in dest (bad prior state).
    writeFileSync(join(dest, CREDENTIAL_FILE), '{"token":"leaked"}');

    provisionApiKeyConfigDir({ sourceClaudeDir: src, destDir: dest });

    expect(existsSync(join(dest, CREDENTIAL_FILE))).toBe(false);
  });
});

// ── missing source dir ────────────────────────────────────────────────────────

describe("provisionApiKeyConfigDir — missing source dir", () => {
  test("does not throw when sourceClaudeDir does not exist", () => {
    const root = makeTmp();
    const dest = join(root, "dest");

    expect(() =>
      provisionApiKeyConfigDir({
        sourceClaudeDir: join(root, "nonexistent"),
        destDir: dest,
      }),
    ).not.toThrow();
  });

  test("creates destDir when source is missing", () => {
    const root = makeTmp();
    const dest = join(root, "dest");

    provisionApiKeyConfigDir({
      sourceClaudeDir: join(root, "nonexistent"),
      destDir: dest,
    });

    expect(existsSync(dest)).toBe(true);
  });

  test("returns destDir when source is missing", () => {
    const root = makeTmp();
    const dest = join(root, "dest");

    const result = provisionApiKeyConfigDir({
      sourceClaudeDir: join(root, "nonexistent"),
      destDir: dest,
    });

    expect(result).toBe(dest);
  });
});

// ── ensureApiKeyConfigDir ─────────────────────────────────────────────────────

describe("ensureApiKeyConfigDir", () => {
  test("returns the canonical apiKeyConfigDir path", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });

    const result = ensureApiKeyConfigDir(home, src);

    expect(result).toBe(apiKeyConfigDir(home));
  });

  test("provisions symlinks correctly via the convenience wrapper", () => {
    const root = makeTmp();
    const src = buildFakeSource(root);
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });

    ensureApiKeyConfigDir(home, src);

    const dest = apiKeyConfigDir(home);
    expect(existsSync(join(dest, "settings.json"))).toBe(true);
    expect(lstatSync(join(dest, "settings.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dest, CREDENTIAL_FILE))).toBe(false);
  });
});
