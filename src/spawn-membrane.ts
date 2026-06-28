import { homedir } from "node:os";
import { config } from "./config";
import { apiKeyMembraneFields, apiKeyPassthroughEnv } from "./spawn-auth";
import { PluginSpawnAborted, type SpawnDescriptor, type SpawnPatch } from "./plugins/types";
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
  /** Plugin onSpawn hook runner (issue #1124/#1205). Absent → no hooks run (tests / no
   *  plugins / loader not yet loaded). Wired to PluginRegistry.runSpawnHooks in index.ts. */
  runSpawnHooks?: (d: SpawnDescriptor) => Promise<SpawnPatch>;
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
  /** Plugin SpawnPatch env (issue #1205), merged LAST over the membrane's passthrough extraEnv
   *  so a patched CLAUDE_CONFIG_DIR rides the bwrap --setenv (carried THROUGH --clearenv), not
   *  just the outer env. */
  extraEnv?: Record<string, string>;
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
    extraEnv: { ...env.extraEnv, ...(args.extraEnv ?? {}) },
    // api-key mode: a bwrap-wrapped reviewer masks the OAuth credential + binds the helper.
    ...apiKeyMembraneFields(),
  };
  const wrapped = wrapArgv(args.argv, { profile: "standard", backend, membrane });
  return { wrapped, backend };
}

/** Fold a plugin SpawnPatch (issue #1124/#1205) into spawn inputs: patch.env plus
 *  credentialDir→CLAUDE_CONFIG_DIR (last — the sugar field wins over env.CLAUDE_CONFIG_DIR),
 *  and extraArgs appended to the inner argv. Single source for this merge so the session path
 *  (prepareSpawn) and the reviewer-style aux spawns can never drift. */
export function foldSpawnPatch(
  innerArgv: string[],
  patch: SpawnPatch,
): { patchEnv: Record<string, string>; finalArgv: string[] } {
  const patchEnv: Record<string, string> = {
    ...(patch.env ?? {}),
    ...(patch.credentialDir ? { CLAUDE_CONFIG_DIR: patch.credentialDir } : {}),
  };
  const finalArgv = patch.extraArgs?.length ? [...innerArgv, ...patch.extraArgs] : innerArgv;
  return { patchEnv, finalArgv };
}

/** Shared reviewer-style spawn tail (issue #937/#1205): fire plugin onSpawn hooks, fold the
 *  returned patch, and assemble the membrane — so review / plan-gate / doc-agent / standalone
 *  critic honor onSpawn exactly like a normal session spawn. The patched env is bound THROUGH
 *  the membrane: patchEnv is merged LAST into both the bwrap --setenv (via resolveSpawnMembrane's
 *  extraEnv) AND the herdr.start env, so a plugin's CLAUDE_CONFIG_DIR is not wiped by --clearenv.
 *
 *  Returns `{ aborted }` when a hook calls ctx.abortSpawn (the caller reaps the worktree + skips
 *  the spawn cleanly). The returned `spawnEnv` is `undefined` when empty (subscription + no patch)
 *  — NEVER an empty object — to preserve herdr.start's optional-env contract. */
export async function resolveAuxSpawn(args: {
  argv: string[];
  worktreePath: string;
  repoPath: string;
  worktree: { gitCommonDir(p: string): string };
  seams: MembraneSeams;
  descriptor: {
    sessionId: string;
    kind: SpawnDescriptor["kind"];
    parentSessionId?: string;
    model?: string | null;
    agentProvider?: string;
  };
}): Promise<
  | { wrapped: string[]; spawnEnv: Record<string, string> | undefined }
  | { aborted: PluginSpawnAborted }
> {
  const backend = resolveBackend(args.seams);
  // No backend → passthrough (no membrane) → apiKeyPassthroughEnv carries the credential-less
  // mirror dir; with a backend the membrane masks creds in place and this is undefined.
  const baseEnv = apiKeyPassthroughEnv(backend !== null);

  let patchEnv: Record<string, string> = {};
  let finalArgv = args.argv;
  if (args.seams.runSpawnHooks) {
    let patch: SpawnPatch;
    try {
      patch = await args.seams.runSpawnHooks({
        sessionId: args.descriptor.sessionId,
        kind: args.descriptor.kind,
        parentSessionId: args.descriptor.parentSessionId,
        repoRoot: args.repoPath,
        model: args.descriptor.model ?? null,
        agentProvider: args.descriptor.agentProvider ?? config.defaultAgentProvider,
        argv: [...args.argv],
        env: baseEnv ?? {},
        isolated: true,
      });
    } catch (e) {
      if (e instanceof PluginSpawnAborted) return { aborted: e };
      throw e;
    }
    ({ patchEnv, finalArgv } = foldSpawnPatch(args.argv, patch));
  }

  const { wrapped } = resolveSpawnMembrane({
    argv: finalArgv,
    worktreePath: args.worktreePath,
    repoPath: args.repoPath,
    worktree: args.worktree,
    seams: args.seams,
    extraEnv: patchEnv,
  });

  // patchEnv LAST so a patched CLAUDE_CONFIG_DIR wins over apiKeyPassthroughEnv's mirror.
  const merged = { ...(baseEnv ?? {}), ...patchEnv };
  const spawnEnv = Object.keys(merged).length ? merged : undefined;
  return { wrapped, spawnEnv };
}
