import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  previewLogFile,
  prepareMembraneClaudeState,
  removeMembraneState,
  sweepMembraneState,
} from "../src/membrane-state";
import { dashify } from "../src/claude-trust";

let root: string;
let prevXdg: string | undefined;
let home: string;
const cwd = "/repos/proj/.shepherd-worktrees/wt-1";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "membrane-state-"));
  home = join(root, "home");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  prevXdg = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = join(root, "run");
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = prevXdg;
  rmSync(root, { recursive: true, force: true });
});

const inputs = (over: Partial<Parameters<typeof prepareMembraneClaudeState>[0]> = {}) => ({
  home,
  claudeDir: join(home, ".claude"),
  projectsSource: join(home, ".claude", "projects"),
  cwd,
  sessionId: "s-1",
  key: "session",
  ...over,
});

describe("prepareMembraneClaudeState (F04/F06)", () => {
  test("copy is seeded with cwd trust; host .claude.json is untouched, even by writes to the copy", async () => {
    const host = join(home, ".claude.json");
    const original = JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { "/other": { hasTrustDialogAccepted: true } },
    });
    writeFileSync(host, original);

    const copy = await prepareMembraneClaudeState(inputs());
    expect(copy).not.toBeNull();
    expect(copy).not.toBe(host);
    const parsed = JSON.parse(readFileSync(copy!, "utf8"));
    expect(parsed.hasCompletedOnboarding).toBe(true);
    expect(parsed.projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(parsed.projects["/other"].hasTrustDialogAccepted).toBe(true);

    // What an in-membrane agent would do to the file it sees.
    writeFileSync(copy!, JSON.stringify({ mcpServers: { x: { command: "/bin/sh" } } }));
    expect(readFileSync(host, "utf8")).toBe(original);
    expect(statSync(copy!).mode & 0o777).toBe(0o600);
  });

  test("custom CLAUDE_CONFIG_DIR copies <claudeDir>/.claude.json", async () => {
    const cd = join(root, "pool");
    mkdirSync(cd, { recursive: true });
    writeFileSync(join(cd, ".claude.json"), JSON.stringify({ marker: "pool" }));
    const copy = await prepareMembraneClaudeState(inputs({ claudeDir: cd }));
    expect(JSON.parse(readFileSync(copy!, "utf8")).marker).toBe("pool");
  });

  test("missing host file → null; unparseable → copied verbatim", async () => {
    expect(await prepareMembraneClaudeState(inputs())).toBeNull();
    writeFileSync(join(home, ".claude.json"), "{not json");
    const copy = await prepareMembraneClaudeState(inputs());
    expect(readFileSync(copy!, "utf8")).toBe("{not json");
  });

  test("creates own transcript memory dir and the tmpfs mountpoints", async () => {
    await prepareMembraneClaudeState(inputs());
    expect(existsSync(join(home, ".claude", "projects", dashify(cwd), "memory"))).toBe(true);
    for (const d of ["shell-snapshots", "todos", "statsig"])
      expect(existsSync(join(home, ".claude", d))).toBe(true);
  });

  test("remove + sweep drop copies of dead sessions only", async () => {
    writeFileSync(join(home, ".claude.json"), "{}");
    const a = await prepareMembraneClaudeState(inputs({ sessionId: "live" }));
    const b = await prepareMembraneClaudeState(inputs({ sessionId: "dead" }));
    const c = await prepareMembraneClaudeState(inputs({ sessionId: "gone" }));
    sweepMembraneState(["live", "gone"]);
    expect(existsSync(a!)).toBe(true);
    expect(existsSync(b!)).toBe(false);
    removeMembraneState("gone");
    expect(existsSync(c!)).toBe(false);
  });

  test("previewLogFile: owner-only file under the session dir, removed with it", () => {
    const f = previewLogFile("s-log");
    expect(existsSync(f)).toBe(true);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(previewLogFile("s-log")).toBe(f); // idempotent, keeps content
    removeMembraneState("s-log");
    expect(existsSync(f)).toBe(false);
  });

  test("concurrent same-kind copies never tear the shared file", async () => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ big: "x".repeat(200_000) }));
    const copies = await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        prepareMembraneClaudeState(inputs({ sessionId: "aux", key: "plugin", cwd: `/wt/${n}` })),
      ),
    );
    expect(new Set(copies).size).toBe(1);
    expect(() => JSON.parse(readFileSync(copies[0]!, "utf8"))).not.toThrow();
  });
});
