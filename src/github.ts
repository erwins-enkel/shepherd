import { execFileSync } from "node:child_process";

export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

const SLUG_RE = /github\.com[:/]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/;

export function githubSlug(repoDir: string): string | null {
  try {
    const url = execFileSync("git", ["-C", repoDir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(SLUG_RE);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

export function parseIssues(stdout: string): Issue[] {
  const raw = JSON.parse(stdout) as Array<{
    number: number;
    title: string;
    body?: string;
    url: string;
    labels?: Array<{ name: string }>;
  }>;
  return raw.map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    url: i.url,
    labels: (i.labels ?? []).map((l) => l.name),
  }));
}

export function listIssues(
  repoDir: string,
  run: (slug: string) => string = (slug) =>
    execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        slug,
        "--state",
        "open",
        "--json",
        "number,title,body,url,labels",
        "--limit",
        "50",
      ],
      { encoding: "utf8" },
    ),
): { slug: string | null; issues: Issue[] } {
  const slug = githubSlug(repoDir);
  if (!slug) return { slug: null, issues: [] };
  try {
    return { slug, issues: parseIssues(run(slug)) };
  } catch {
    return { slug, issues: [] };
  }
}
