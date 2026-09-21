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

/** Public health stays path-free unless this process explicitly opts in on loopback.
 * Use the actual working directory and database config, never a claimed install path. */
export function localHealthIdentity(config: {
  host: string;
  dbPath: string;
  localSupervision: boolean;
  localInstanceID: string;
}) {
  if (
    !config.localSupervision ||
    !config.localInstanceID ||
    !["127.0.0.1", "::1", "localhost"].includes(config.host)
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
