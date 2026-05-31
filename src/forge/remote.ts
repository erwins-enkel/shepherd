export interface ParsedRemote {
  host: string;
  slug: string; // "owner/repo"
}

// scp-style: git@host:owner/repo(.git)
const SCP_RE = /^[^@]+@([^:/]+):(.+?)(?:\.git)?\/?$/;
// url-style: scheme://[user@]host[:port]/owner/repo(.git)
const URL_RE = /^[a-z]+:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i;

/** Parse a git remote URL into its host and owner/repo slug, or null if unrecognized. */
export function parseRemote(url: string): ParsedRemote | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  const scp = SCP_RE.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    return { host: scp[1]!, slug: scp[2]! };
  }

  const m = URL_RE.exec(trimmed);
  if (m && m[2]!.includes("/")) {
    return { host: m[1]!, slug: m[2]! };
  }

  return null;
}
