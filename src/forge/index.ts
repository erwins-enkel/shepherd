import { execFileSync } from "../instrument";
import { GithubForge } from "./github";
import { GiteaForge } from "./gitea";
import { parseRemote } from "./remote";
import type { ForgeKind, ForgeMap, GitForge } from "./types";

/** Decide the forge kind for a host: explicit config wins, else github.com is github. */
function kindFor(host: string, map: ForgeMap): ForgeKind | null {
  const cfg = map[host];
  if (cfg?.type) return cfg.type;
  if (host === "github.com") return "github";
  if (cfg) return "gitea"; // configured host with a baseUrl/token but no explicit type
  return null;
}

/** Build a GitForge from a remote URL + forge config map, or null if unsupported. */
export function forgeFor(remoteUrl: string, map: ForgeMap): GitForge | null {
  const parsed = parseRemote(remoteUrl);
  if (!parsed) return null;
  const kind = kindFor(parsed.host, map);
  if (!kind) return null;
  const cfg = map[parsed.host] ?? {};
  if (kind === "github") return new GithubForge(parsed.slug, cfg);
  return new GiteaForge(parsed.slug, cfg);
}

/** Read `origin` remote URL for a repo dir, or null. */
function originUrl(repoDir: string): string | null {
  try {
    return execFileSync("git", ["-C", repoDir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Resolve the forge for a repo directory using its origin remote + config map. */
export function detectForge(repoDir: string, map: ForgeMap): GitForge | null {
  const url = originUrl(repoDir);
  return url ? forgeFor(url, map) : null;
}
