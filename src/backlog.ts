import { execFileSync } from "node:child_process";
import { parseRemote } from "./forge/remote";
import { detectForge } from "./forge";
import type { ForgeMap } from "./forge/types";

export interface RepoCounts {
  openIssues: number | null;
  openPRs: number | null;
}

/**
 * Runs `gh` and returns stdout. Sync or async — the background warmer passes an
 * async runner so handleBacklog's per-repo `Promise.all` actually fans out in
 * parallel instead of serializing on a blocking `execFileSync`.
 */
export type CountsRunner = (args: string[]) => string | Promise<string>;

interface CacheEntry {
  at: number;
  value: RepoCounts;
}

const TTL_MS = 60_000;

const NULL_COUNTS: RepoCounts = { openIssues: null, openPRs: null };

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

export class CountsService {
  /** Resolved forge per repoPath, null = not a supported forge. Immutable once set. */
  private readonly forgeCache = new Map<string, ReturnType<typeof detectForge>>();
  /** TTL read-through cache: repoPath → {at, value}. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Single-flight: repoPath → in-flight Promise. */
  private readonly inflight = new Map<string, Promise<RepoCounts>>();

  constructor(
    private readonly forges: ForgeMap,
    private readonly run: CountsRunner,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Read-through: serve a TTL-fresh cached value, else load it. */
  async counts(repoPath: string): Promise<RepoCounts> {
    const entry = this.cache.get(repoPath);
    if (entry && Date.now() - entry.at < TTL_MS) return entry.value;
    return this.load(repoPath);
  }

  /**
   * Force a refetch regardless of TTL — used by the background warmer to rewrite
   * the cached value on a cadence so the request path always finds a fresh
   * entry. Single-flight still dedupes against any in-flight load.
   */
  async refresh(repoPath: string): Promise<RepoCounts> {
    return this.load(repoPath);
  }

  private load(repoPath: string): Promise<RepoCounts> {
    const existing = this.inflight.get(repoPath);
    if (existing) return existing;

    const promise = this.fetch(repoPath).then(
      (v) => {
        this.cache.set(repoPath, { at: Date.now(), value: v });
        this.inflight.delete(repoPath);
        return v;
      },
      () => {
        this.inflight.delete(repoPath);
        this.cache.set(repoPath, { at: Date.now(), value: NULL_COUNTS });
        return NULL_COUNTS;
      },
    );
    this.inflight.set(repoPath, promise);
    return promise;
  }

  private resolveForge(repoPath: string): ReturnType<typeof detectForge> {
    if (!this.forgeCache.has(repoPath)) {
      this.forgeCache.set(repoPath, detectForge(repoPath, this.forges));
    }
    return this.forgeCache.get(repoPath)!;
  }

  private async fetch(repoPath: string): Promise<RepoCounts> {
    const forge = this.resolveForge(repoPath);
    if (!forge) return NULL_COUNTS;

    if (forge.kind === "github") {
      return this.fetchGitHub(forge.slug!);
    }
    return this.fetchGitea(forge.slug!, repoPath);
  }

  private async fetchGitHub(slug: string): Promise<RepoCounts> {
    const [owner, name] = slug.split("/");
    const out = await this.run([
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-f",
      "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(states:OPEN){totalCount} pullRequests(states:OPEN){totalCount}}}",
    ]);
    const json = JSON.parse(out) as {
      data?: {
        repository?: {
          issues?: { totalCount?: number };
          pullRequests?: { totalCount?: number };
        };
      };
    };
    const repo = json.data?.repository;
    const issues = repo?.issues?.totalCount;
    const prs = repo?.pullRequests?.totalCount;
    return {
      openIssues: typeof issues === "number" ? issues : null,
      openPRs: typeof prs === "number" ? prs : null,
    };
  }

  private async fetchGitea(slug: string, repoPath: string): Promise<RepoCounts> {
    const url = originUrl(repoPath);
    if (!url) return NULL_COUNTS;
    const remote = parseRemote(url);
    if (!remote) return NULL_COUNTS;

    const cfg = this.forges[remote.host] ?? {};
    const base = (cfg.baseUrl ?? "").replace(/\/+$/, "");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (cfg.token) headers.Authorization = `token ${cfg.token}`;

    const res = await this.fetchFn(`${base}/api/v1/repos/${slug}`, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`gitea GET /api/v1/repos/${slug} → ${res.status}: ${text}`);
    }
    const data = (await res.json()) as {
      open_issues_count?: number;
      open_pr_counter?: number;
    };
    return {
      openIssues: typeof data.open_issues_count === "number" ? data.open_issues_count : null,
      openPRs: typeof data.open_pr_counter === "number" ? data.open_pr_counter : null,
    };
  }
}
