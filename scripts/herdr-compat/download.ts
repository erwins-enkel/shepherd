/**
 * Binary acquisition for the herdr compatibility check (SOP: .claude/rules/herdr-version-bump.md).
 *
 * Resolves candidate/baseline herdr binaries WITHOUT ever touching the operator's install:
 * downloads land in `~/.cache/shepherd/herdr-compat/<version>/herdr` and are verified by an
 * exact `--version` match (the same verification the in-app downgrade path uses; SHA-256 asset
 * digests are a deliberate non-goal here — see the design spec). The installed binary is reused
 * as baseline only when its version already equals the requested one.
 */

import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseHerdrVersion } from "../../src/herdr-capabilities";
import { herdrAssetKey, herdrReleaseUrl, sanitizeVersion } from "../../src/herdr-install";

export const COMPAT_CACHE_DIR = join(homedir(), ".cache", "shepherd", "herdr-compat");

/** `<bin> --version` → "x.y.z" or null (missing binary, non-zero exit, unparsable output). */
export async function probeVersion(bin: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    return parseHerdrVersion(out);
  } catch {
    return null;
  }
}

/**
 * Return a binary path for `version`, downloading the GitHub release asset if the cache misses.
 * Throws when the platform has no published asset, the download fails, or the downloaded (or
 * cached) binary does not report exactly `version`.
 */
export async function ensureBinary(version: string): Promise<string> {
  const clean = sanitizeVersion(version);
  if (clean === "unknown") throw new Error(`not a version: ${JSON.stringify(version)}`);
  const dest = join(COMPAT_CACHE_DIR, clean, "herdr");

  if ((await probeVersion(dest)) === clean) return dest;

  const assetKey = herdrAssetKey();
  if (!assetKey) {
    throw new Error(`no herdr release asset for ${process.platform}/${process.arch}`);
  }
  const url = herdrReleaseUrl(clean, assetKey);
  console.log(`[herdr-compat] downloading herdr ${clean} from ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  await mkdir(join(COMPAT_CACHE_DIR, clean), { recursive: true });
  await Bun.write(dest, res);
  await chmod(dest, 0o755);

  const got = await probeVersion(dest);
  if (got !== clean) {
    throw new Error(`downloaded binary reports "${got ?? "nothing"}", expected ${clean}`);
  }
  return dest;
}
