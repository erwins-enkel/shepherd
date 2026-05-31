import { execFileSync } from "node:child_process";
import { rollupChecks } from "./checks";
import type {
  CheckRun,
  ForgeConfig,
  GitForge,
  Issue,
  MergeInput,
  MergeMethod,
  OpenPrInput,
  PostReviewInput,
  PrStatus,
  RedeployInput,
} from "./types";

/** Runs `gh` with the given args and returns stdout. Injected in tests. */
export type GhRunner = (args: string[]) => string;

const defaultRunner: GhRunner = (args) =>
  execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

interface GhPr {
  number: number;
  url: string;
  title: string;
  state: string; // OPEN | MERGED | CLOSED
  mergeable?: string; // MERGEABLE | CONFLICTING | UNKNOWN
  statusCheckRollup?: CheckRun[];
  headRefOid?: string;
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
      "number,title,body,url,labels",
      "--limit",
      "50",
    ]);
    const raw = JSON.parse(out || "[]") as Array<{
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
      "number,url,title,state,mergeable,statusCheckRollup,headRefOid",
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
    const flag = o.event === "REQUEST_CHANGES" ? "--request-changes" : "--comment";
    this.run(["pr", "review", String(prNumber), "--repo", this.slug, flag, "--body", o.body]);
    return {}; // gh pr review prints no machine-readable URL
  }
}
