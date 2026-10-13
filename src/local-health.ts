import { realpathSync } from "node:fs";
import { resolve } from "node:path";

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Headers a reverse proxy adds. `tailscale serve` always sets `X-Forwarded-Host` (and overwrites
 * any client copy), so a request it fronts can never pass as a direct loopback caller. */
const FORWARDED_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"];

/** Public health stays path-free unless this process explicitly opts in on loopback.
 * A loopback bind is not proof the caller is local: a proxy in front of it (the Mac app's opt-in
 * `tailscale serve`) delivers every tailnet request over loopback too, so forwarded requests
 * never see the identity. Use the actual working directory and database config, never a claimed
 * install path. */
export function localHealthIdentity(
  config: {
    host: string;
    dbPath: string;
    localSupervision: boolean;
    localInstanceID: string;
  },
  headers: Headers,
) {
  if (
    !config.localSupervision ||
    !config.localInstanceID ||
    !["127.0.0.1", "::1", "localhost"].includes(config.host) ||
    FORWARDED_HEADERS.some((name) => headers.has(name))
  ) {
    return {};
  }
  return {
    localInstall: {
      appDirectory: canonicalPath(process.cwd()),
      databasePath: canonicalPath(config.dbPath),
      instanceID: config.localInstanceID,
    },
  };
}
