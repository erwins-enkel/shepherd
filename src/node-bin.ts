import { existsSync } from "node:fs";

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
