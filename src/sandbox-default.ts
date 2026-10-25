import { homedir } from "node:os";
import { config } from "./config";
import {
  detectBackend,
  effectiveDefaultProfile,
  safeRealpath,
  type SandboxBackend,
  type SandboxProfile,
} from "./sandbox";

/** The real cached bwrap self-test with the same probe env every spawn path passes (the verdict is
 *  pinned per process, so whichever caller probes first must use the right node). */
function probeBackend(): SandboxBackend {
  return detectBackend({
    home: homedir(),
    claudeDir: config.claudeDir,
    nodeBinReal: safeRealpath(config.nodeBin),
  });
}

/**
 * The global default sandbox profile (#2100): SHEPHERD_SANDBOX_DEFAULT_PROFILE when set, else
 * `standard` where bwrap works and `trusted` where it doesn't. A repo set to `"inherit"` (or with
 * no repo_config row) resolves to this. `detect` is the caller's backend seam (tests).
 */
export function defaultSandboxProfile(detect: () => SandboxBackend = probeBackend): SandboxProfile {
  return effectiveDefaultProfile(config.sandboxDefaultProfileOverride, detect);
}
