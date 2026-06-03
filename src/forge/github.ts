import { execFileSync } from "node:child_process";
import { mapCheckState, rollupChecks } from "./checks";
import { CRITIC_REVIEW_MARKER } from "./types";
import type {
  CheckRun,
  ForgeConfig,
  GitForge,
  Issue,
  MergeInput,
  MergeMethod,
  OpenPrInput,
  PostReviewInput,
  PrComment,
  PrStatus,
  PullRequest,
  RedeployInput,
  WorkflowJob,
  WorkflowRun,
} from "./types";

/** Cap on distinct workflows fetched per repo: each kept run costs one extra
 *  `gh run view` subprocess, so bound the fan-out. */
const MAX_WORKFLOWS = 10;

/** Runs `gh` with the given args and returns stdout. Injected in tests. */
export type GhRunner = (args: string[]) => string;

const defaultRunner: GhRunner = (args) =>
  execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

interface GhReview {
  author?: { login?: string } | null;
  state?: string | null; // APPROVED | CHANGES_REQUESTED | COMMENTED | PENDING | DISMISSED
  body?: string | null;
  submittedAt?: string | null;
}

const REVIEW_STATE: Record<string, "approved" | "changes_requested" | "commented"> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
};

/** Newest human review (critic-marked + non-terminal states excluded). */
function latestHumanReview(reviews: GhReview[] | undefined): PrStatus["latestReview"] {
  let best: PrStatus["latestReview"];
  let bestTs = -Infinity;
  for (const r of reviews ?? []) {
    const state = REVIEW_STATE[r.state ?? ""];
    if (!state) continue; // skips PENDING / DISMISSED / unknown
    if ((r.body ?? "").includes(CRITIC_REVIEW_MARKER)) continue; // the critic's own review
    const ts = Date.parse(r.submittedAt ?? "");
    if (!Number.isFinite(ts) || ts <= bestTs) continue;
    bestTs = ts;
    best = { state, author: r.author?.login ?? "", submittedAt: ts };
  }
  return best;
}

interface GhPr {
  number: number;
  url: string;
  title: string;
  state: string; // OPEN | MERGED | CLOSED
  mergeable?: string; // MERGEABLE | CONFLICTING | UNKNOWN
  statusCheckRollup?: CheckRun[];
  headRefOid?: string;
  reviews?: GhReview[];
}

function mapMergeable(v: string | undefined): boolean | null {
  if (v === "MERGEABLE") return true;
  if (v === "CONFLICTING") return false;
  return null; // UNKNOWN / undefined
}

/** GitHub forge driven through the `gh` CLI (operator's existing auth). */
export class GithubForge implements GitForge {
  readonly kind = "github" as const;
  readonly mergeMethod: MergeMethod;
  readonly deployWorkflow: string | null;
  constructor(
    readonly slug: string,
    private readonly cfg: ForgeConfig,
    private readonly run: GhRunner = defaultRunner,
  ) {
    this.mergeMethod = cfg.mergeMethod ?? "squash";
    this.deployWorkflow = cfg.deployWorkflow ?? null;
  }

  async listIssues(): Promise<Issue[]> {
    const out = this.run([
      "issue",
      "list",
      "--repo",
      this.slug,
      "--state",
      "open",
      "--json",
      "number,title,body,url,labels,createdAt",
      // Cap matches listPullRequests; the count source (GraphQL totalCount) is
      // unbounded, so a repo with >200 open issues lists a truncated set under a
      // larger count. Raise this or paginate if such repos appear.
      "--limit",
      "200",
    ]);
    const raw = JSON.parse(out || "[]") as Array<{
      number: number;
      title: string;
      body?: string;
      url: string;
      labels?: Array<{ name: string }>;
      createdAt?: string;
    }>;
    return raw.map((i) => {
      const ts = Date.parse(i.createdAt ?? "");
      return {
        number: i.number,
        title: i.title,
        body: i.body ?? "",
        url: i.url,
        labels: (i.labels ?? []).map((l) => l.name),
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
      };
    });
  }

  async listPullRequests(): Promise<PullRequest[]> {
    const out = this.run([
      "pr",
      "list",
      "--repo",
      this.slug,
      "--state",
      "open",
      "--json",
      "number,title,url,author,createdAt,isDraft,mergeable,statusCheckRollup,reviews",
      // See listIssues: 200 cap vs unbounded PR count (pullRequests.totalCount).
      "--limit",
      "200",
    ]);
    const raw = JSON.parse(out || "[]") as Array<
      GhPr & {
        author?: { login?: string } | null;
        createdAt?: string;
        isDraft?: boolean;
      }
    >;
    return raw.map((p) => {
      const ts = Date.parse(p.createdAt ?? "");
      return {
        number: p.number,
        title: p.title,
        url: p.url,
        author: p.author?.login ?? "",
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
        isDraft: p.isDraft ?? false,
        mergeable: mapMergeable(p.mergeable),
        checks: rollupChecks(p.statusCheckRollup ?? []),
        latestReview: latestHumanReview(p.reviews),
      };
    });
  }

  async listWorkflowRuns(): Promise<WorkflowRun[]> {
    // Resolve the default branch; CI health is read from its runs, not PR branches.
    const repoOut = this.run(["repo", "view", this.slug, "--json", "defaultBranchRef"]);
    const branch = (JSON.parse(repoOut || "{}") as { defaultBranchRef?: { name?: string } })
      .defaultBranchRef?.name;
    if (!branch) return [];

    const listOut = this.run([
      "run",
      "list",
      "--repo",
      this.slug,
      "--branch",
      branch,
      "--limit",
      "50",
      "--json",
      "databaseId,workflowName,status,conclusion,headSha,createdAt,url",
    ]);
    const raw = JSON.parse(listOut || "[]") as Array<{
      databaseId: number;
      workflowName?: string;
      status?: string | null;
      conclusion?: string | null;
      headSha?: string;
      createdAt?: string;
      url?: string;
    }>;

    // `gh run list` is newest-first, so the first row per workflow is its latest run.
    const newest = new Map<string, (typeof raw)[number]>();
    for (const r of raw) {
      const wf = r.workflowName ?? "";
      if (!newest.has(wf)) newest.set(wf, r);
    }
    const selected = [...newest.values()].slice(0, MAX_WORKFLOWS);

    const runs = selected.map((r): WorkflowRun => {
      const jobsOut = this.run([
        "run",
        "view",
        String(r.databaseId),
        "--repo",
        this.slug,
        "--json",
        "jobs",
      ]);
      const parsed = JSON.parse(jobsOut || "{}") as {
        jobs?: Array<{
          name?: string;
          status?: string | null;
          conclusion?: string | null;
          url?: string;
        }>;
      };
      const jobs: WorkflowJob[] = (parsed.jobs ?? []).map((j) => ({
        name: j.name ?? "",
        state: mapCheckState(j.status, j.conclusion),
        url: j.url || undefined,
      }));
      const ts = Date.parse(r.createdAt ?? "");
      return {
        workflowName: r.workflowName ?? "",
        runUrl: r.url ?? "",
        headSha: r.headSha ?? "",
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
        state: mapCheckState(r.status, r.conclusion),
        jobs,
      };
    });

    // Newest workflow first.
    runs.sort((a, b) => b.createdAt - a.createdAt);
    return runs;
  }

  async prStatus(headBranch: string): Promise<PrStatus> {
    const deployConfigured = Boolean(this.cfg.deployWorkflow);
    const out = this.run([
      "pr",
      "list",
      "--repo",
      this.slug,
      "--head",
      headBranch,
      "--state",
      "all",
      "--json",
      "number,url,title,state,mergeable,statusCheckRollup,headRefOid,reviews",
      "--limit",
      "1",
    ]);
    const prs = JSON.parse(out || "[]") as GhPr[];
    const pr = prs[0];
    if (!pr) return { state: "none", checks: "none", deployConfigured };
    const state = pr.state.toLowerCase() as PrStatus["state"];
    return {
      state: state === "open" || state === "merged" || state === "closed" ? state : "none",
      number: pr.number,
      url: pr.url,
      title: pr.title,
      mergeable: mapMergeable(pr.mergeable),
      checks: rollupChecks(pr.statusCheckRollup ?? []),
      headSha: pr.headRefOid,
      latestReview: latestHumanReview(pr.reviews),
      deployConfigured,
    };
  }

  async openPr(o: OpenPrInput): Promise<PrStatus> {
    this.run([
      "pr",
      "create",
      "--repo",
      this.slug,
      "--head",
      o.head,
      "--base",
      o.base,
      "--title",
      o.title,
      "--body",
      o.body,
    ]);
    return this.prStatus(o.head);
  }

  async renameBranch(oldBranch: string, newBranch: string): Promise<void> {
    // GitHub's rename-branch endpoint moves the ref AND retargets every open PR and
    // branch-protection rule onto the new name, so a session's open PR follows along.
    this.run([
      "api",
      "--method",
      "POST",
      `repos/${this.slug}/branches/${oldBranch}/rename`,
      "-f",
      `new_name=${newBranch}`,
    ]);
  }

  async merge(prNumber: number, o: MergeInput): Promise<void> {
    const method =
      o.method === "rebase" ? "--rebase" : o.method === "merge" ? "--merge" : "--squash";
    const args = ["pr", "merge", String(prNumber), "--repo", this.slug, method];
    if (o.deleteBranch) args.push("--delete-branch");
    this.run(args);
  }

  async redeploy(o: RedeployInput): Promise<void> {
    this.run(["workflow", "run", o.workflow, "--repo", this.slug, "--ref", o.ref]);
  }

  async postReview(prNumber: number, o: PostReviewInput): Promise<{ url?: string }> {
    if (o.event === "REQUEST_CHANGES") {
      try {
        this.run([
          "pr",
          "review",
          String(prNumber),
          "--repo",
          this.slug,
          "--request-changes",
          "--body",
          o.body,
        ]);
        return {}; // gh pr review prints no machine-readable URL
      } catch {
        // GitHub forbids request-changes on a PR you authored, and the agent +
        // critic share one gh identity — so this 422s on self-authored PRs. Fall
        // back to a plain PR comment so the findings still land on the host.
        // `gh pr comment` echoes the new comment's URL on stdout.
        const url = this.run([
          "pr",
          "comment",
          String(prNumber),
          "--repo",
          this.slug,
          "--body",
          o.body,
        ]).trim();
        return { url: url || undefined };
      }
    }
    this.run([
      "pr",
      "review",
      String(prNumber),
      "--repo",
      this.slug,
      "--comment",
      "--body",
      o.body,
    ]);
    return {}; // gh pr review prints no machine-readable URL
  }

  async listPrComments(prNumber: number): Promise<PrComment[]> {
    const out = this.run([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      this.slug,
      "--json",
      "comments",
    ]);
    const parsed = JSON.parse(out || "{}") as {
      comments?: {
        author?: { login?: string } | null;
        body?: string | null;
        createdAt?: string | null;
      }[];
    };
    return (parsed.comments ?? []).map((c) => ({
      author: c.author?.login ?? "",
      body: c.body ?? "",
      createdAt: c.createdAt ? Date.parse(c.createdAt) : 0,
    }));
  }
}
