// GitHub links pasted into the New Task prompt name the repo the task is about; these map
// them back to a local repo by its forge identity (`owner/name`).
import type { RepoEntry } from "./types";

export interface GithubLink {
  /** `owner/name` exactly as written in the link. */
  slug: string;
  /** Issue number for an `/issues/<n>` link, else null (PRs, root, blob, …). */
  issue: number | null;
}

const LINK =
  /\bhttps?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[/?#\s)\]>,'"]|$)(?:\/issues\/(\d+))?/gi;

/** Every GitHub repo link in `text`, in order. */
export function parseGithubLinks(text: string): GithubLink[] {
  return [...text.matchAll(LINK)].map(([, owner, name, issue]) => ({
    slug: `${owner}/${name}`,
    issue: issue ? Number(issue) : null,
  }));
}

/** The repo named by the first link in `text` that matches a repo's `remoteSlug` or (for a
 *  fork) its `upstreamSlug`, compared case-insensitively. `viaUpstream` tells the caller
 *  the link pointed at the fork's upstream — where a fork's issues live. */
export function matchRepoForLinks(
  repos: RepoEntry[],
  text: string,
): { repo: RepoEntry; issue: number | null; viaUpstream: boolean } | null {
  for (const link of parseGithubLinks(text)) {
    const slug = link.slug.toLowerCase();
    // An exact clone of the linked repo beats a fork of it, whatever the list order.
    const own = repos.find((r) => r.remoteSlug?.toLowerCase() === slug);
    if (own) return { repo: own, issue: link.issue, viaUpstream: false };
    const fork = repos.find((r) => r.upstreamSlug?.toLowerCase() === slug);
    if (fork) return { repo: fork, issue: link.issue, viaUpstream: true };
  }
  return null;
}
