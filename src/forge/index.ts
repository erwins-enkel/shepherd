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

/** Read a named remote's URL for a repo dir, or null if the remote is absent. */
function remoteUrl(repoDir: string, remote: string): string | null {
  try {
    return execFileSync("git", ["-C", repoDir, "remote", "get-url", remote], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the forge for a repo directory.
 *
 * Default: the forge targets the `origin` remote's slug.
 *
 * Fork mode: when an `upstream` remote exists whose slug differs from `origin`,
 * and both resolve to GitHub, the forge targets the **upstream** slug (so issues,
 * PRs, checks, backlog and the PR base all point at the original repo a
 * contributor works against) while carrying the `origin` slug as `forkSlug` (the
 * write target — pushes, the `pr create --head` qualifier, and the `canPush`
 * probe). This is exactly the topology `gh repo fork --clone` produces.
 */
export function detectForge(repoDir: string, map: ForgeMap): GitForge | null {
  const origin = remoteUrl(repoDir, "origin");
  if (!origin) return null;

  const upstream = remoteUrl(repoDir, "upstream");
  if (upstream) {
    const originParsed = parseRemote(origin);
    const upstreamParsed = parseRemote(upstream);
    if (
      originParsed &&
      upstreamParsed &&
      upstreamParsed.slug !== originParsed.slug &&
      kindFor(upstreamParsed.host, map) === "github" &&
      kindFor(originParsed.host, map) === "github"
    ) {
      const cfg = map[upstreamParsed.host] ?? {};
      return new GithubForge(upstreamParsed.slug, cfg, undefined, originParsed.slug);
    }
  }

  return forgeFor(origin, map);
}
