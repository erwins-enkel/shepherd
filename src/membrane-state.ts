/**
 * Host-side Claude state a membrane spawn needs prepared BEFORE bwrap starts (audit F04/F06).
 *
 * The membrane never binds the host `.claude.json` RW: it holds user- and project-scope
 * `mcpServers` whose `command` later UNCONFINED sessions (trusted profile, the operator's own
 * `claude`) launch without a prompt. Each spawn instead gets a private COPY, seeded with trust for
 * its cwd, bound RW in place of the original — Claude's onboarding/trust writes land there and are
 * dropped with it. Nothing is merged back.
 *
 * The dirs buildMembraneFlags mounts over (own transcript dir + its memory/, and the
 * shell-snapshots/todos/statsig tmpfs targets) are created here: bwrap cannot mkdir a mountpoint
 * under the read-only claudeDir/projects binds.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeConfigPath, dashify } from "./claude-trust";
import { shepherdRuntimeDir } from "./runtime-dir";
import { EPHEMERAL_CLAUDE_DIRS } from "./sandbox";

function membraneStateRoot(): string {
  return shepherdRuntimeDir("membrane");
}

export interface MembraneStateInputs {
  home: string;
  /** The config dir bound as the membrane's claudeDir. */
  claudeDir: string;
  /** Host dir bound AS `<claudeDir>/projects` (MembraneInputs.projectsBindSource ?? default). */
  projectsSource: string;
  /** The agent's cwd (MembraneInputs.worktreePath). */
  cwd: string;
  sessionId: string;
  /** Distinguishes concurrent spawns for one session (`session`, `review`, …). */
  key: string;
}

/**
 * Create the mountpoints and write this spawn's `.claude.json` copy. Returns the copy's path, or
 * null when the host file is missing (nothing to bind — Claude starts fresh, as before).
 */
export async function prepareMembraneClaudeState(i: MembraneStateInputs): Promise<string | null> {
  await mkdir(join(i.projectsSource, dashify(i.cwd), "memory"), { recursive: true });
  for (const d of EPHEMERAL_CLAUDE_DIRS) await mkdir(join(i.claudeDir, d), { recursive: true });

  let raw: string;
  try {
    raw = await readFile(claudeConfigPath(i.home, i.claudeDir), "utf8");
  } catch {
    return null;
  }
  return writeStateFile(i.sessionId, `${i.key}.claude.json`, withTrust(raw, i.cwd));
}

/** Write one 0600 file into the session's 0700 state dir and return its path. */
async function writeStateFile(sessionId: string, name: string, content: string): Promise<string> {
  const dir = join(membraneStateRoot(), sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = join(dir, name);
  // tmp + rename: a still-running earlier spawn keeps the inode it mounted.
  const tmp = `${file}.tmp.${randomUUID()}`; // unique: concurrent same-kind spawns share `file`
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, file);
  return file;
}

export interface MembraneMiseInputs {
  home: string;
  sessionId: string;
  key: string;
  /** The membrane's real node/bun binaries (null entries ignored). */
  pinnedBins: (string | null | undefined)[];
}

/** `<tool> = <version>` for a bin under `<home>/.local/share/mise/installs/<tool>/<version>/`. */
function misePins(home: string, bins: (string | null | undefined)[]): Record<string, string> {
  const prefix = `${home}/.local/share/mise/installs/`;
  const pins: Record<string, string> = {};
  for (const bin of bins) {
    if (typeof bin !== "string" || !bin.startsWith(prefix)) continue;
    const [tool, version] = bin.slice(prefix.length).split("/");
    if (tool && version) pins[tool] = version;
  }
  return pins;
}

/** The host global config's `[tools]`, string / string-array values only; {} when unreadable. */
async function hostMiseTools(home: string): Promise<Record<string, string | string[]>> {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(await readFile(join(home, ".config", "mise", "config.toml"), "utf8"));
  } catch {
    return {};
  }
  const tools = (parsed as { tools?: unknown } | null)?.tools;
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return {};
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(tools)) {
    const isStrings = Array.isArray(v) && v.every((x) => typeof x === "string");
    if (typeof v === "string" || isStrings) out[k] = v as string | string[];
  }
  return out;
}

/**
 * This spawn's derived mise config (see `MEMBRANE_MISE_CONFIG` in sandbox.ts): the host's
 * `[tools]` table ONLY — never `[env]` (operator secrets), `[settings]`, `[hooks]` or `[tasks]` —
 * with the membrane's own node/bun pinned to their install versions so they stay on PATH whatever
 * the global config lists. null when there is nothing to write.
 */
export async function prepareMembraneMiseConfig(i: MembraneMiseInputs): Promise<string | null> {
  const tools = { ...(await hostMiseTools(i.home)), ...misePins(i.home, i.pinnedBins) };
  const entries = Object.entries(tools);
  if (entries.length === 0) return null;
  const lines = entries.map(
    ([k, v]) =>
      `${JSON.stringify(k)} = ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : JSON.stringify(v)}`,
  );
  return writeStateFile(i.sessionId, `${i.key}.mise.toml`, `[tools]\n${lines.join("\n")}\n`);
}

const execFileAsync = promisify(execFile);

export interface MembraneGhInputs {
  home: string;
  sessionId: string;
  key: string;
}

export interface MembraneGhDeps {
  /** The host's github.com token; default `gh auth token` (async, 5s cap). */
  ghToken?: () => Promise<string>;
}

/** Env vars gh prefers over stored credentials (`gh help environment`). */
const GH_ENV_TOKENS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

/** `env` minus the gh token vars, so `gh auth token` reports only the keyring/config token —
 *  never a server env secret that `--clearenv` keeps out of the membrane. */
export function ghStoredTokenEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of GH_ENV_TOKENS) delete out[k];
  return out;
}

async function defaultGhToken(): Promise<string> {
  const { stdout } = await execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
    timeout: 5000,
    env: ghStoredTokenEnv(process.env),
  });
  return stdout;
}

/** A 4-space-indented scalar of the `github.com:` block matching `valid`, or null. */
function ghHostField(raw: string, field: string, valid: RegExp): string | null {
  const m = raw.match(new RegExp(`^github\\.com:\\n(?:[ ]{4}.*\\n)*?[ ]{4}${field}: *(\\S+)`, "m"));
  const v = m?.[1];
  return v && valid.test(v) ? v : null;
}

/**
 * gh keeps its token in the OS keyring when one is available, and the membrane (no D-Bus,
 * `--clearenv`) cannot reach it — so `gh` and the `gh auth git-credential` helper 401 inside it
 * even though `~/.config/gh` is bound for exactly that purpose. This writes a per-spawn 0600
 * github.com `hosts.yml` carrying the token, bound RO over the host file (task sessions only;
 * same in-membrane readability as a file-stored token, audit R3). null — no override — when the
 * host file is absent, already holds a token, or the token can't be read (best-effort).
 */
export async function prepareMembraneGhHosts(
  i: MembraneGhInputs,
  deps: MembraneGhDeps = {},
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(join(i.home, ".config", "gh", "hosts.yml"), "utf8");
  } catch {
    return null;
  }
  if (/^\s*oauth_token:/m.test(raw)) return null;
  let token: string;
  try {
    token = (await (deps.ghToken ?? defaultGhToken)()).trim();
  } catch (err) {
    console.warn("[sandbox] gh token unavailable for the membrane:", err);
    return null;
  }
  // Token text goes into YAML verbatim: accept only gh's token alphabet.
  if (!/^[A-Za-z0-9_]+$/.test(token)) return null;
  const user = ghHostField(raw, "user", /^[A-Za-z0-9-]+$/);
  const protocol = ghHostField(raw, "git_protocol", /^[a-z]+$/);
  const lines = ["github.com:"];
  if (user) lines.push("    users:", `        ${user}:`, `            oauth_token: ${token}`);
  if (protocol) lines.push(`    git_protocol: ${protocol}`);
  if (user) lines.push(`    user: ${user}`);
  lines.push(`    oauth_token: ${token}`);
  return writeStateFile(i.sessionId, `${i.key}.gh-hosts.yml`, `${lines.join("\n")}\n`);
}

/** `raw` with `projects[cwd].hasTrustDialogAccepted = true`; unparseable input is kept verbatim. */
function withTrust(raw: string, cwd: string): string {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return raw;
  const cfg = j as Record<string, unknown>;
  const projects = (cfg.projects && typeof cfg.projects === "object" ? cfg.projects : {}) as Record<
    string,
    Record<string, unknown>
  >;
  const entry = projects[cwd] && typeof projects[cwd] === "object" ? projects[cwd] : {};
  projects[cwd] = { ...entry, hasTrustDialogAccepted: true };
  cfg.projects = projects;
  return JSON.stringify(cfg);
}

/**
 * A host log file a sandboxed preview can append to (audit F03 follow-up): the membrane re-binds
 * `<git-common-dir>/shepherd` read-only, where the generated script's default log lives, and its
 * `set -e` would abort on that EROFS before the dev server starts. Created (empty if new) so it can
 * be single-file bound; lives with the session's membrane state, removed at archive.
 */
export function previewLogFile(sessionId: string): string {
  const dir = join(membraneStateRoot(), sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "preview-start.log");
  closeSync(openSync(file, "a", 0o600));
  return file;
}

/** Best-effort removal of one session's copies (session teardown). */
export function removeMembraneState(sessionId: string): void {
  try {
    rmSync(join(membraneStateRoot(), sessionId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** Boot reconcile: drop copies of sessions no longer live (teardown missed across a crash). */
export function sweepMembraneState(liveSessionIds: Iterable<string>): void {
  const live = new Set(liveSessionIds);
  let entries: string[];
  try {
    entries = readdirSync(membraneStateRoot());
  } catch {
    return;
  }
  for (const id of entries) if (!live.has(id)) removeMembraneState(id);
}
