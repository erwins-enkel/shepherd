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
    for (const repo of repos) {
      if (repo.remoteSlug?.toLowerCase() === slug)
        return { repo, issue: link.issue, viaUpstream: false };
      if (repo.upstreamSlug?.toLowerCase() === slug)
        return { repo, issue: link.issue, viaUpstream: true };
    }
  }
  return null;
}
