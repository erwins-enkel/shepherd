// Boot preflight: fail fast with one actionable banner when the `herdr` binary is not
// resolvable on PATH, instead of letting Shepherd spew stack traces trying to use it.
//
// Pure/side-effect-free at import time — the caller (src/index.ts) injects runVersion/
// log/exit so this module stays testable with fakes.

export const HERDR_MISSING_EXIT_CODE = 78; // EX_CONFIG

const BANNER = `⚠  herdr not found on PATH — Shepherd cannot run.
   herdr owns the interactive claude PTYs; nothing works without it.
   Install:  curl -fsSL https://herdr.dev/install.sh | bash
   It installs to ~/.local/bin — ensure that's on PATH:
       export PATH="$HOME/.local/bin:$PATH"   (add to your shell profile)
   Then re-run: bun run start`;

// Defensively inspects an unknown error for the two shapes a missing binary throws as:
// Node's spawn/execFileSync ENOENT (`err.code === "ENOENT"`), and Bun's thrown
// `Os { code: 2, kind: NotFound }` (stringified). Mirrors isNameTakenError's style in
// src/herdr.ts: never throw on a weird error shape, just say no.
export function isBinaryMissingError(err: unknown): boolean {
  if (err == null) return false;
  if (typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (e.code === "ENOENT") return true;
  }
  const str = String(err);
  return str.includes("No such file or directory") || str.includes("NotFound");
}

export function preflightHerdr(deps: {
  runVersion: () => string;
  log: (msg: string) => void;
  exit: (code: number) => never;
}): void {
  const { runVersion, log, exit } = deps;
  try {
    runVersion();
  } catch (err) {
    if (isBinaryMissingError(err)) {
      log(BANNER);
      exit(HERDR_MISSING_EXIT_CODE);
    }
    // Present but broken (e.g. permission error) — not our call to make; fail open.
  }
}
