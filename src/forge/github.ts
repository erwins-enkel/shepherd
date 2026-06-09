import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { timedAsync } from "../instrument";
import { jobsFromRollup, mapCheckState, rollupChecks } from "./checks";
import { CRITIC_REVIEW_MARKER } from "./types";
import type {
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
  RollupEntry,
  WorkflowJob,
  WorkflowRun,
} from "./types";

/** Cap on distinct workflows fetched per repo: each kept run costs one extra
 *  `gh run view` subprocess, so bound the fan-out. */
const MAX_WORKFLOWS = 10;

/** Runs `gh` with the given args and returns stdout. Injected in tests. */
export type GhRunner = (args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

const defaultRunner: GhRunner = (args) =>
  timedAsync(`gh ${args[0]}`, async () => {
    const { stdout } = await execFileAsync("gh", args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout.toString();
  });

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
  statusCheckRollup?: RollupEntry[];
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
    const out = await this.run([
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

  async getIssue(issueNumber: number): Promise<Issue | null> {
    // Fresh, uncached single-issue read for the drain's pre-spawn claim re-check
    // (see GitForge.getIssue). Best-effort: a gone/closed issue or a transient gh
    // error yields null so the caller falls back to spawning, never loses the issue.
    // COST: one synchronous `gh issue view` subprocess per spawn candidate per pump
    // (this.run is execFileSync). The drain spawns at most maxAuto per pump, so the
    // fan-out is bounded and small; not worth caching/batching for the claim re-check.
    try {
      const out = this.run([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        this.slug,
        "--json",
        "number,title,body,url,labels,createdAt",
      ]);
      const i = JSON.parse(out || "null") as {
        number: number;
        title: string;
        body?: string;
        url: string;
        labels?: Array<{ name: string }>;
        createdAt?: string;
      } | null;
      if (!i) return null;
      const ts = Date.parse(i.createdAt ?? "");
      return {
        number: i.number,
        title: i.title,
        body: i.body ?? "",
        url: i.url,
        labels: (i.labels ?? []).map((l) => l.name),
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
      };
    } catch {
      return null;
    }
  }

  async listPullRequests(): Promise<PullRequest[]> {
    const out = await this.run([
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
        jobs: jobsFromRollup(p.statusCheckRollup ?? []),
        latestReview: latestHumanReview(p.reviews),
      };
    });
  }

  async listWorkflowRuns(): Promise<WorkflowRun[]> {
    // Resolve the default branch; CI health is read from its runs, not PR branches.
    const repoOut = await this.run(["repo", "view", this.slug, "--json", "defaultBranchRef"]);
    const branch = (JSON.parse(repoOut || "{}") as { defaultBranchRef?: { name?: string } })
      .defaultBranchRef?.name;
    if (!branch) return [];

    const listOut = await this.run([
      "run",
      "list",
      "--repo",
      this.slug,
      "--branch",
      branch,
      "--limit",
      "50",
      "--json",
      "databaseId,workflowName,workflowDatabaseId,status,conclusion,headSha,createdAt,url",
    ]);
    const raw = JSON.parse(listOut || "[]") as Array<{
      databaseId: number;
      workflowName?: string;
      workflowDatabaseId?: number;
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

    // Fan out the per-run job fetches in parallel now that `this.run` is async.
    // Serial was the old behaviour (execFileSync); the Promise.all here now truly
    // parallelises the `gh run view` subprocess calls across the selected runs.
    const runs = await Promise.all(
      selected.map(async (r): Promise<WorkflowRun> => {
        const jobs = await this.listRunJobs(r.databaseId);
        const ts = Date.parse(r.createdAt ?? "");
        return {
          runId: r.databaseId,
          workflowId: r.workflowDatabaseId ?? 0,
          workflowName: r.workflowName ?? "",
          runUrl: r.url ?? "",
          headSha: r.headSha ?? "",
          createdAt: Number.isFinite(ts) ? ts : Date.now(),
          state: mapCheckState(r.status, r.conclusion),
          jobs,
        };
      }),
    );

    // Newest workflow first.
    runs.sort((a, b) => b.createdAt - a.createdAt);
    return runs;
  }

  /** Per-job breakdown for a single run (`gh run view --json jobs`), mapped to
   *  the four-light CI vocab. Shared by the latest-run listing and history-row
   *  expansion. */
  async listRunJobs(runId: number): Promise<WorkflowJob[]> {
    const jobsOut = await this.run([
      "run",
      "view",
      String(runId),
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
    return (parsed.jobs ?? []).map((j) => ({
      name: j.name ?? "",
      state: mapCheckState(j.status, j.conclusion),
      url: j.url || undefined,
    }));
  }

  /** Prior runs of one workflow on the default branch, newest-first, capped by
   *  `limit`. Summary rows only — `jobs` is empty; callers lazy-load per-run
   *  jobs via {@link listRunJobs}. */
  async listWorkflowRunHistory(workflowId: number, o: { limit: number }): Promise<WorkflowRun[]> {
    const branch = await this.defaultBranch().catch(() => null);
    if (!branch) return [];
    const listOut = await this.run([
      "run",
      "list",
      "--repo",
      this.slug,
      "--branch",
      branch,
      "--workflow",
      String(workflowId),
      "--limit",
      String(o.limit),
      "--json",
      "databaseId,workflowName,workflowDatabaseId,status,conclusion,headSha,createdAt,url",
    ]);
    const raw = JSON.parse(listOut || "[]") as Array<{
      databaseId: number;
      workflowName?: string;
      workflowDatabaseId?: number;
      status?: string | null;
      conclusion?: string | null;
      headSha?: string;
      createdAt?: string;
      url?: string;
    }>;
    const runs = raw.map((r): WorkflowRun => {
      const ts = Date.parse(r.createdAt ?? "");
      return {
        runId: r.databaseId,
        workflowId: r.workflowDatabaseId ?? workflowId,
        workflowName: r.workflowName ?? "",
        runUrl: r.url ?? "",
        headSha: r.headSha ?? "",
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
        state: mapCheckState(r.status, r.conclusion),
        jobs: [],
      };
    });
    runs.sort((a, b) => b.createdAt - a.createdAt);
    return runs;
  }

  async rerunWorkflowRun(runId: number, o: { failedOnly: boolean }): Promise<void> {
    const args = ["run", "rerun", String(runId), "--repo", this.slug];
    // `--failed` retries only the failed jobs (+ their dependents) of a failed run;
    // a fully green run has none, so the caller passes failedOnly:false there.
    if (o.failedOnly) args.push("--failed");
    await this.run(args);
  }

  async cancelWorkflowRun(runId: number): Promise<void> {
    await this.run(["run", "cancel", String(runId), "--repo", this.slug]);
  }

  async prStatus(headBranch: string): Promise<PrStatus> {
    const deployConfigured = Boolean(this.cfg.deployWorkflow);
    const out = await this.run([
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

  async defaultBranch(): Promise<string> {
    const out = await this.run(["repo", "view", this.slug, "--json", "defaultBranchRef"]);
    const name = (JSON.parse(out || "{}") as { defaultBranchRef?: { name?: string } })
      .defaultBranchRef?.name;
    if (!name) throw new Error("could not resolve default branch");
    return name;
  }

  async openPr(o: OpenPrInput): Promise<PrStatus> {
    await this.run([
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

  async createIssue(o: { title: string; body: string }): Promise<{ number: number; url: string }> {
    // `gh issue create` echoes the new issue's URL on stdout (…/issues/<n>).
    const url = (
      await this.run(["issue", "create", "--repo", this.slug, "--title", o.title, "--body", o.body])
    ).trim();
    const n = Number(url.match(/\/(\d+)\s*$/)?.[1]);
    if (!Number.isInteger(n)) throw new Error(`could not parse issue number from URL: ${url}`);
    return { number: n, url };
  }

  async renameBranch(oldBranch: string, newBranch: string): Promise<void> {
    // GitHub's rename-branch endpoint moves the ref AND retargets every open PR and
    // branch-protection rule onto the new name, so a session's open PR follows along.
    await this.run([
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
    await this.run(args);
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.run(["issue", "close", String(issueNumber), "--repo", this.slug]);
  }

  async comment(prNumber: number, body: string): Promise<void> {
    await this.run(["pr", "comment", String(prNumber), "--repo", this.slug, "--body", body]);
  }

  async ensureIssueLink(prNumber: number, issueNumber: number): Promise<void> {
    const body = (
      await this.run([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        this.slug,
        "--json",
        "body",
        "-q",
        ".body // empty",
      ])
    ).trim();
    const pattern = new RegExp(
      `\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`,
      "i",
    );
    if (pattern.test(body)) return;
    const newBody = body ? `${body}\n\nCloses #${issueNumber}` : `Closes #${issueNumber}`;
    await this.run(["pr", "edit", String(prNumber), "--repo", this.slug, "--body", newBody]);
  }

  async addIssueLabel(issueNumber: number, label: string): Promise<void> {
    // `gh issue edit --add-label` 422s on a label the repo hasn't defined. The
    // operator creates the opt-in label, but the claim label is ours — create it
    // first (ignoring "already exists") so the claim doesn't fail on a fresh repo.
    await this.ensureLabel(label);
    await this.run([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      this.slug,
      "--add-label",
      label,
    ]);
  }

  async removeIssueLabel(issueNumber: number, label: string): Promise<void> {
    await this.run([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      this.slug,
      "--remove-label",
      label,
    ]);
  }

  /** Best-effort create-if-missing for a repo label. No `--force`, so an existing
   *  label the operator may have recolored is left untouched; the throw on "already
   *  exists" is swallowed and a real failure surfaces on the subsequent --add-label. */
  private async ensureLabel(label: string): Promise<void> {
    try {
      await this.run([
        "label",
        "create",
        label,
        "--repo",
        this.slug,
        "--color",
        "5319e7",
        "--description",
        "Claimed by a Shepherd session (auto-drain or linked issue)",
      ]);
    } catch {
      // already exists (or a transient gh error) — ignore.
    }
  }

  async redeploy(o: RedeployInput): Promise<void> {
    await this.run(["workflow", "run", o.workflow, "--repo", this.slug, "--ref", o.ref]);
  }

  async postReview(prNumber: number, o: PostReviewInput): Promise<{ url?: string }> {
    if (o.event === "REQUEST_CHANGES") {
      try {
        await this.run([
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
        const url = (
          await this.run(["pr", "comment", String(prNumber), "--repo", this.slug, "--body", o.body])
        ).trim();
        return { url: url || undefined };
      }
    }
    await this.run([
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
    const out = await this.run([
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
        id?: string | null;
        url?: string | null;
        author?: { login?: string } | null;
        body?: string | null;
        createdAt?: string | null;
      }[];
    };
    return (parsed.comments ?? []).map((c) => ({
      // gh exposes a node `id`; fall back to the comment url (also unique) so the
      // per-round dedup always has a stable key even if one field is absent.
      id: c.id ?? c.url ?? "",
      author: c.author?.login ?? "",
      body: c.body ?? "",
      createdAt: c.createdAt ? Date.parse(c.createdAt) : 0,
    }));
  }
}
