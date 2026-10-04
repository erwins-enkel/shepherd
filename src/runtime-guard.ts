// Keep in sync with deploy/install.sh and native LocalServerEnvironment.
export const MIN_BUN_VERSION = "1.3.2";

export function bunTooOld(version: string): boolean {
  return Bun.semver.order(version, MIN_BUN_VERSION) < 0;
}
