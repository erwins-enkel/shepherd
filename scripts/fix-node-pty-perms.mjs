// Ensure node-pty's macOS `spawn-helper` is executable after `bun install`.
//
// node-pty 1.1.0 ships `spawn-helper` in its prebuild tarball WITHOUT the execute
// bit (microsoft/node-pty#850). npm silently chmods extracted files; Bun preserves
// tarball perms, so the helper lands 0644. On macOS node-pty launches it via
// `posix_spawn`, which then fails with EACCES — surfaced as the opaque
// "posix_spawnp failed." — and every session pane stays black. Re-set the exec bit.
//
// Scope: only the helper node-pty actually loads — `build/Release/spawn-helper`
// (source build) and `prebuilds/<platform>-<arch>/spawn-helper` (the same set
// node-pty's own loader resolves). So on Linux (no `linux-*` prebuild helper, and
// the forkpty path never uses one) this is a genuine silent no-op.
//
// Target dir is resolved from THIS script's location (repo root), never
// process.cwd(), so a caller's cwd can't turn the absent-tree guard into a silent
// failure to fix the very macOS box it targets.

import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `<repoRoot>/node_modules/node-pty`, resolved relative to this script (not cwd). */
export function resolveNodePtyDir() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return join(repoRoot, "node_modules", "node-pty");
}

/**
 * chmod +x the spawn-helper node-pty loads for `platformArch`, if present and not
 * already owner-executable. Returns the paths it flipped. Idempotent; no-op (no
 * throw) when the dir/files are absent.
 *
 * @param {string} nodePtyDir  path to the installed node-pty package
 * @param {string} platformArch  e.g. "darwin-arm64" (`${process.platform}-${process.arch}`)
 * @param {(msg: string) => void} [log]  called once per actual flip; silent otherwise
 * @returns {string[]} paths whose mode was changed
 */
export function fixNodePtyPerms(nodePtyDir, platformArch, log) {
  const candidates = [
    join(nodePtyDir, "build", "Release", "spawn-helper"),
    join(nodePtyDir, "build", "Debug", "spawn-helper"),
    join(nodePtyDir, "prebuilds", platformArch, "spawn-helper"),
  ];
  const flipped = [];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const mode = statSync(p).mode & 0o777;
    if (mode & 0o100) continue; // owner-executable already → leave it, stay silent
    const next = mode | 0o111; // restore ONLY the exec bits; keep existing r/w
    chmodSync(p, next);
    flipped.push(p);
    // Log ONLY on an actual flip, so a macOS fix is observable in the deploy log
    // while the Linux / no-helper no-op prints nothing.
    log?.(
      `fix-node-pty-perms: made ${p} executable (0${mode.toString(8)}→0${(next & 0o777).toString(8)})`,
    );
  }
  return flipped;
}

if (import.meta.main) {
  fixNodePtyPerms(resolveNodePtyDir(), `${process.platform}-${process.arch}`, (m) =>
    console.log(m),
  );
}
