// Boot preflight: fail fast with one actionable banner when the `herdr` binary is not
// resolvable on PATH, instead of letting Shepherd spew stack traces trying to use it.
//
// Pure/side-effect-free at import time — the caller (src/index.ts) injects runVersion/
// log/exit so this module stays testable with fakes. Its only imports are LEAF modules
// (herdr-capabilities / herdr-install); pulling in remediations.ts would drag config.ts, which
// loads the forge config at import, into the boot preflight and its tests.

import { HERDR_LAST_SUPPORTED_VERSION } from "./herdr-capabilities";
import { herdrAssetKey, herdrReleaseTagUrl, herdrReleaseUrl } from "./herdr-install";

export const HERDR_MISSING_EXIT_CODE = 78; // EX_CONFIG

// The banner's distinctive line, exported so out-of-tree consumers (the onboarding
// harness's fail-fast probe) can match the fail-fast output without hardcoding a
// copy that a future reword would break silently.
export const HERDR_MISSING_MARKER = "herdr not found on PATH";

/** The fail-fast banner. A FUNCTION, not a const, so both platform branches are testable and
 *  neither can render `undefined`.
 *
 *  The install line is PINNED to the highest herdr Shepherd can drive (#1896) — pointing an
 *  operator at `herdr.dev/install.sh` would hand them whatever is newest, and on a herdr above the
 *  ceiling the driver refuses every agent spawn. Because preflight runs on the very host it is
 *  instructing, the platform is baked in for a short copy-pasteable line; when herdr publishes no
 *  binary for this platform (`assetKey` null — Windows, or an unsupported arch) it falls back to
 *  the release-tag page rather than printing a URL that cannot exist. */
export function herdrMissingBanner(assetKey: string | null = herdrAssetKey()): string {
  const install = assetKey
    ? `mkdir -p ~/.local/bin && curl -fsSL -o ~/.local/bin/herdr ${herdrReleaseUrl(HERDR_LAST_SUPPORTED_VERSION, assetKey)} && chmod +x ~/.local/bin/herdr`
    : `download herdr ${HERDR_LAST_SUPPORTED_VERSION} for your platform from ${herdrReleaseTagUrl(HERDR_LAST_SUPPORTED_VERSION)}`;
  return `⚠  ${HERDR_MISSING_MARKER} — Shepherd cannot run.
   herdr owns the interactive claude PTYs; nothing works without it.
   Shepherd supports herdr <= ${HERDR_LAST_SUPPORTED_VERSION}; newer releases break agent spawning.
   Install:  ${install}
   It installs to ~/.local/bin — ensure that's on PATH:
       export PATH="$HOME/.local/bin:$PATH"   (add to your shell profile)
   Then re-run: bun run start`;
}

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
}): string | null {
  const { runVersion, log, exit } = deps;
  try {
    // Returned so the caller can detect an unsupported herdr (see herdr-capabilities.ts) from the
    // same `herdr --version` read that gates presence — no second spawn.
    return runVersion();
  } catch (err) {
    if (isBinaryMissingError(err)) {
      log(herdrMissingBanner());
      exit(HERDR_MISSING_EXIT_CODE);
    }
    // Present but broken (e.g. permission error) — not our call to make; fail open.
    return null;
  }
}
