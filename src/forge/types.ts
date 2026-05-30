export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

export type ForgeKind = "github" | "gitea";
export type MergeMethod = "merge" | "squash" | "rebase";

/** Worst-of CI rollup: failure dominates, then pending, then success. */
export type ChecksState = "none" | "pending" | "success" | "failure";

export interface PrStatus {
  state: "none" | "open" | "merged" | "closed";
  number?: number;
  url?: string;
  title?: string;
  /** null = host still computing mergeability. */
  mergeable?: boolean | null;
  checks: ChecksState;
  /** A deploy workflow is configured for this host. */
  deployConfigured: boolean;
}

export interface OpenPrInput {
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface MergeInput {
  method: MergeMethod;
  deleteBranch: boolean;
}

export interface RedeployInput {
  workflow: string;
  ref: string;
}

export interface GitForge {
  readonly kind: ForgeKind;
  readonly slug: string | null;
  listIssues(): Promise<Issue[]>;
  prStatus(headBranch: string): Promise<PrStatus>;
  openPr(o: OpenPrInput): Promise<PrStatus>;
  merge(prNumber: number, o: MergeInput): Promise<void>;
  redeploy(o: RedeployInput): Promise<void>;
}

/** Per-host configuration loaded from ~/.shepherd/forges.json. */
export interface ForgeConfig {
  type?: ForgeKind;
  baseUrl?: string;
  token?: string;
  deployWorkflow?: string;
  mergeMethod?: MergeMethod;
}

export type ForgeMap = Record<string, ForgeConfig>;

/** One forge-reported check run: a lifecycle status + (when complete) a conclusion. */
export interface CheckRun {
  status?: string | null;
  conclusion?: string | null;
}
