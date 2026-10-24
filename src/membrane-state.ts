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

import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  const dir = join(membraneStateRoot(), i.sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const copy = join(dir, `${i.key}.claude.json`);
  // tmp + rename: a still-running earlier spawn keeps the inode it mounted.
  const tmp = `${copy}.tmp.${randomUUID()}`; // unique: concurrent same-kind spawns share `copy`
  await writeFile(tmp, withTrust(raw, i.cwd), { mode: 0o600 });
  await rename(tmp, copy);
  return copy;
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
