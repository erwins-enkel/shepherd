import { homedir } from "node:os";
import { config } from "./config";
import { apiKeyMembraneFields } from "./spawn-auth";
import {
  detectBackend as realDetectBackend,
  wrapArgv,
  safeRealpath,
  collectPassthroughEnv,
  type SandboxBackend,
  type MembraneInputs,
} from "./sandbox";

export interface MembraneEnv {
  claudeDir: string;
  home: string;
  nodeBinReal: string;
  extraEnv?: Record<string, string>;
}

/** Injectable spawn/membrane seams shared by every reviewer-style spawner. Tests override
 *  these so no real bwrap probe runs and no host paths are touched. */
export interface MembraneSeams {
  /** Injectable sandbox backend probe seam (tests inject `() => null`). PRESENCE-checked
   *  (not `??`) because the seam legitimately returns null (no backend). */
  detectBackend?: () => SandboxBackend;
  /** Injectable membrane env seam (tests inject a stub so no host paths are touched). */
  membraneEnv?: () => MembraneEnv;
}

/** Backend probe: injected seam (tests) or the real cached self-test. */
export function resolveBackend(seams: MembraneSeams): SandboxBackend {
  if (seams.detectBackend) return seams.detectBackend(); // PRESENCE-check, NOT ??
  return realDetectBackend({
    home: homedir(),
    claudeDir: config.claudeDir,
    nodeBinReal: safeRealpath(config.nodeBin),
  });
}

/** Membrane env: injected seam (tests) or real host values. */
export function resolveMembraneEnv(seams: MembraneSeams): MembraneEnv {
  if (seams.membraneEnv) return seams.membraneEnv(); // PRESENCE-check
  return {
    claudeDir: config.claudeDir,
    home: homedir(),
    nodeBinReal: safeRealpath(config.nodeBin),
    extraEnv: collectPassthroughEnv(),
  };
}

/** Assemble the standard per-task FS membrane around `argv` for an isolated reviewer-style
 *  spawn and wrap it. Returns the wrapped argv + the resolved backend (the caller needs the
 *  backend for apiKeyPassthroughEnv). Mirrors the #601 posture: an isolated worktree gets
 *  per-task binds (worktree + git common dir), not the whole repo; wrapArgv degrades to
 *  passthrough when no backend. */
export function resolveSpawnMembrane(args: {
  argv: string[];
  worktreePath: string;
  repoPath: string;
  worktree: { gitCommonDir(p: string): string };
  seams: MembraneSeams;
}): { wrapped: string[]; backend: SandboxBackend } {
  const backend = resolveBackend(args.seams);
  const env = resolveMembraneEnv(args.seams);
  const membrane: MembraneInputs = {
    worktreePath: args.worktreePath,
    gitCommonDir: args.worktree.gitCommonDir(args.worktreePath),
    isolated: true,
    repoPath: args.repoPath,
    claudeDir: env.claudeDir,
    home: env.home,
    nodeBinReal: env.nodeBinReal,
    extraEnv: env.extraEnv,
    // api-key mode: a bwrap-wrapped reviewer masks the OAuth credential + binds the helper.
    ...apiKeyMembraneFields(),
  };
  const wrapped = wrapArgv(args.argv, { profile: "standard", backend, membrane });
  return { wrapped, backend };
}
