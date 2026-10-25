import { existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";

export interface ResolveNodeOpts {
  /** Explicit override (SHEPHERD_NODE_BIN); wins over everything when non-empty. */
  override?: string | null;
  /** PATH lookup; defaults to Bun.which. Injectable for tests. */
  which?: (cmd: string) => string | null;
  /** Existence probe; defaults to fs.existsSync. Injectable for tests. */
  exists?: (p: string) => boolean;
  /** Home dir; defaults to $HOME. Injectable for tests. */
  home?: string;
}

/**
 * Resolve a `node` binary for spawning the PTY attach helper (pty-attach.mjs).
 *
 * The server itself runs under Bun, but the helper needs Node (node-pty is a
 * native Node addon). When Shepherd runs under systemd or another launcher whose
 * PATH excludes a version-manager-managed node (mise/nvm/fnm), spawning bare
 * "node" fails — and every session pane silently stays black. Resolution order:
 *   1. explicit override (SHEPHERD_NODE_BIN)
 *   2. node on PATH
 *   3. known install locations (mise shims, common bin dirs)
 *   4. bare "node" as a last resort, so the spawn error is at least legible
 */
export function resolveNodeBin(opts: ResolveNodeOpts = {}): string {
  const override = opts.override;
  if (typeof override === "string" && override.trim()) return override.trim();

  const which = opts.which ?? ((c) => Bun.which(c));
  const onPath = which("node");
  if (onPath) return onPath;

  const exists = opts.exists ?? existsSync;
  const home = opts.home ?? process.env.HOME ?? "";
  const candidates = [
    home && `${home}/.local/share/mise/shims/node`, // mise (managed node)
    home && `${home}/.local/bin/node`,
    "/usr/local/bin/node",
    "/usr/bin/node",
    "/bin/node",
  ].filter((c): c is string => Boolean(c));

  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return "node"; // surfaces a clear ENOENT instead of a silent black pane
}

export interface ResolveBunOpts {
  /** The running binary; defaults to process.execPath. Injectable for tests. */
  execPath?: string;
  /** PATH lookup; defaults to Bun.which. Injectable for tests. */
  which?: (cmd: string) => string | null;
  /** realpath; defaults to fs.realpathSync (throws on a missing path). Injectable for tests. */
  realpath?: (p: string) => string;
}

/**
 * Resolve the REAL bun binary the membrane binds + puts on PATH (#3351), or null when there is none.
 *
 * Prefers the server's own bun (it always runs on bun). The PATH lookup is only a fallback, and
 * both candidates are accepted only when their realpath is literally `bun`: a mise shim (e.g.
 * `~/.bun/bin/bun` -> `mise/shims/bun`) resolves to the `mise` binary, and the shims dir is a tmpfs
 * inside the membrane anyway.
 */
export function resolveBunBin(opts: ResolveBunOpts = {}): string | null {
  const realpath = opts.realpath ?? realpathSync;
  const which = opts.which ?? ((c) => Bun.which(c));
  for (const candidate of [opts.execPath ?? process.execPath, which("bun")]) {
    if (!candidate) continue;
    try {
      const real = realpath(candidate);
      if (basename(real) === "bun") return real;
    } catch {
      // missing/broken path: try the next candidate
    }
  }
  return null;
}
