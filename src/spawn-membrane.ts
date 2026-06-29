import { existsSync } from "node:fs";
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
  /** The ACTIVE projects dir (config.claudeProjectsDir) — where Shepherd's usage/activity
   *  readback looks. A plugin-redirected aux spawn (#1213) binds THIS as the (pool)
   *  claudeDir's `projects` so the transcript still lands where readback reads it. */
  projectsDir?: string;
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
  /** Host path-existence probe (#1213). Default `fs.existsSync`; tests inject. Used to
   *  validate-and-skip a plugin's patched credentialDir that does not exist on host (the
   *  wrapped membrane hard `--ro-bind`s it — bwrap would crash on a missing source). */
  pathExists?: (p: string) => boolean;
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
    projectsDir: config.claudeProjectsDir,
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

  // #1213: a plugin can route the aux spawn onto a pool account by patching CLAUDE_CONFIG_DIR
  // (directly or via SpawnPatch.credentialDir). For the credential to actually EXIST inside the
  // bwrap sandbox it must be BOUND, not just --setenv'd: bind the patched dir AS the membrane's
  // claudeDir so buildMembraneFlags mounts it (+ masks/credential-binds + rw-binds its
  // .claude.json + re-sets CLAUDE_CONFIG_DIR from the bind at sandbox.ts:424). The patched dir's
  // existence is validated upstream (resolveAuxSpawn) so a missing dir never reaches the hard
  // --ro-bind here. To preserve readback, the (pool) claudeDir's `projects` is sourced from the
  // ACTIVE projects dir so the transcript lands where Shepherd's usage/activity readback looks.
  const extraEnv = { ...env.extraEnv, ...(args.extraEnv ?? {}) };
  const patchedDir = args.extraEnv?.CLAUDE_CONFIG_DIR;
  const redirecting = typeof patchedDir === "string" && patchedDir !== env.claudeDir;
  if (redirecting) {
    // buildMembraneFlags re-sets CLAUDE_CONFIG_DIR from the bound claudeDir; drop the duplicate.
    delete extraEnv.CLAUDE_CONFIG_DIR;
  }

  const membrane: MembraneInputs = {
    worktreePath: args.worktreePath,
    gitCommonDir: args.worktree.gitCommonDir(args.worktreePath),
    isolated: true,
    repoPath: args.repoPath,
    claudeDir: redirecting ? (patchedDir as string) : env.claudeDir,
    home: env.home,
    nodeBinReal: env.nodeBinReal,
    extraEnv,
    ...(redirecting ? { projectsBindSource: env.projectsDir ?? `${env.claudeDir}/projects` } : {}),
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

/** Run the plugin onSpawn hook (if wired), fold the returned patch, and validate-and-skip a
 *  routed credentialDir (#1213). Returns the folded `{ patchEnv, finalArgv }`, or `{ aborted }`
 *  when a hook calls ctx.abortSpawn. Extracted from resolveAuxSpawn to keep that tail flat. */
async function foldAuxPatch(
  args: {
    argv: string[];
    repoPath: string;
    seams: MembraneSeams;
    descriptor: {
      sessionId: string;
      kind: SpawnDescriptor["kind"];
      parentSessionId?: string;
      model?: string | null;
      agentProvider?: string;
    };
  },
  baseEnv: Record<string, string> | undefined,
): Promise<
  { patchEnv: Record<string, string>; finalArgv: string[] } | { aborted: PluginSpawnAborted }
> {
  if (!args.seams.runSpawnHooks) return { patchEnv: {}, finalArgv: args.argv };

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

  const { patchEnv, finalArgv } = foldSpawnPatch(args.argv, patch);

  // #1213 validate-and-skip: a routed credentialDir must EXIST on host. The wrapped membrane hard
  // `--ro-bind`s it (bwrap crashes on a missing source); the unwrapped path would create an empty
  // dir → unauthenticated. Either way, drop a non-existent dir and fall OPEN to the active account,
  // logging so the misconfig is visible (rather than an opaque crash or silent re-login).
  const routed = patchEnv.CLAUDE_CONFIG_DIR;
  const pathExists = args.seams.pathExists ?? existsSync;
  if (typeof routed === "string" && routed.length > 0 && !pathExists(routed)) {
    console.warn(
      `[spawn] plugin credentialDir not found on host; falling back to the active account: ${routed}`,
    );
    delete patchEnv.CLAUDE_CONFIG_DIR;
  }

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

  const folded = await foldAuxPatch(args, baseEnv);
  if ("aborted" in folded) return folded;
  const { patchEnv, finalArgv } = folded;

  const { wrapped } = resolveSpawnMembrane({
    argv: finalArgv,
    worktreePath: args.worktreePath,
    repoPath: args.repoPath,
    worktree: args.worktree,
    seams: args.seams,
    extraEnv: patchEnv,
  });

  // Merge order. Normally patchEnv LAST so a patched CLAUDE_CONFIG_DIR wins over
  // apiKeyPassthroughEnv's mirror. EXCEPTION (#1213): api-key + NO backend — baseEnv is truthy ONLY
  // then (the credential-less mirror) and there is NO sandbox to mask creds, so a pool
  // CLAUDE_CONFIG_DIR (real .credentials.json on host) would reintroduce the "Use custom API key?"
  // prompt / misbill the pool's OAuth subscription. There the mirror WINS; credential routing onto
  // a pool account requires a sandbox backend (which masks creds in place).
  const merged =
    backend === null && baseEnv ? { ...patchEnv, ...baseEnv } : { ...(baseEnv ?? {}), ...patchEnv };
  const spawnEnv = Object.keys(merged).length ? merged : undefined;
  return { wrapped, spawnEnv };
}
