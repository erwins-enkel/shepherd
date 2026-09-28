// `ctx.forge.runs` (#2539): default-branch CI runs for plugins. Validates plugin input, resolves
// the repo's forge per call, applies the in-flight cursor barrier, and tails + masks failed-step
// logs (still untrusted — the caller fences them).

import type { ForgeRun, GitForge } from "../forge/types";
import { redactSecretText } from "../redact";
import { safeRepoDir } from "../validate";
import {
  PluginForgeError,
  type PluginFailedStepLog,
  type PluginForgeRuns,
  type PluginRun,
} from "./types";

/** Core seams backing `ctx.forge`. Absent (e.g. a test registry) → every call is `no-forge`. */
export interface PluginForgeDeps {
  repoRoot: string;
  resolveForge(dir: string): GitForge | null;
  /** Clock for the stale in-flight guard; default `Date.now`. */
  now?: () => number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_LINES = 200;
const MAX_LINES = 500;
const MAX_LINE_CHARS = 2000;
/** An in-flight run older than this no longer holds the cursor (GitHub's queue/job ceiling). */
const STALE_IN_FLIGHT_MS = 24 * 60 * 60 * 1000;

type ForgeMethod =
  "listDefaultBranchRuns" | "getRunDetail" | "failedRunStepLogs" | "rerunWorkflowRun";

function invalid(message: string): never {
  throw new PluginForgeError("invalid-input", message);
}

function checkInt(n: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    invalid(`${name} must be an integer in ${min}..${max}`);
  }
  return n;
}

/** Resolve `repo` to a forge implementing `method`, or throw the typed refusal. */
function forgeFor(
  deps: PluginForgeDeps | undefined,
  repo: string,
  method: ForgeMethod,
): Required<Pick<GitForge, ForgeMethod>> & GitForge {
  if (!deps) throw new PluginForgeError("no-forge", "forge runs are not available in this core");
  const dir = typeof repo === "string" ? safeRepoDir(repo, deps.repoRoot) : null;
  if (!dir) {
    throw new PluginForgeError("invalid-repo", "repo must be a directory under the repo root");
  }
  const forge = deps.resolveForge(dir);
  if (!forge) throw new PluginForgeError("no-forge", "no forge for repo");
  if (forge.isLightweight === true) {
    throw new PluginForgeError("lightweight", "lightweight repos have no CI runs");
  }
  if (typeof forge[method] !== "function") {
    throw new PluginForgeError("unsupported", `host does not support ${method}`);
  }
  return forge as Required<Pick<GitForge, ForgeMethod>> & GitForge;
}

/** Completed runs above `sinceId` and below the lowest fresh in-flight run, ascending, capped;
 *  the cursor is the last returned id (or `sinceId` when none). */
function selectRuns(
  rows: ForgeRun[],
  sinceId: number,
  limit: number,
  now: number,
): { runs: ForgeRun[]; cursor: number } {
  const fresh = rows.filter((r) => r.id > sinceId);
  let barrier = Infinity;
  for (const r of fresh) {
    if (r.status !== "completed" && now - r.createdAt < STALE_IN_FLIGHT_MS) {
      barrier = Math.min(barrier, r.id);
    }
  }
  const runs = fresh
    .filter((r) => r.status === "completed" && r.id < barrier)
    .sort((a, b) => a.id - b.id)
    .slice(0, limit);
  return { runs, cursor: runs.at(-1)?.id ?? sinceId };
}

function toPluginRun(r: ForgeRun): PluginRun {
  return {
    id: r.id,
    workflowName: r.workflowName,
    workflowFile: r.workflowFile,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    attempt: r.attempt,
    headSha: r.headSha,
    createdAt: r.createdAt,
    url: r.url,
    jobs: (r.jobs ?? []).map((j) => ({ id: j.id, name: j.name, conclusion: j.conclusion })),
  };
}

// eslint-disable-next-line no-control-regex -- stripping terminal escapes is the point
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const TIMESTAMP_RE = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

function cleanLogLine(line: string): string {
  // Bound the regex work on a pathological line before redacting; headroom keeps a secret that
  // straddles the final cap intact for the redactor.
  const raw = line
    .slice(0, MAX_LINE_CHARS * 2)
    .replace(ANSI_RE, "")
    .replace(TIMESTAMP_RE, "");
  const s = redactSecretText(raw);
  return s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS - 1)}…` : s;
}

/** Build the `ctx.forge.runs` surface for one plugin. */
export function makePluginForgeRuns(deps: PluginForgeDeps | undefined): PluginForgeRuns {
  return {
    listDefaultBranchRuns: async (repo, o = {}) => {
      const sinceId = o.sinceId === undefined ? 0 : checkInt(o.sinceId, "sinceId", 0);
      const limit =
        o.limit === undefined ? DEFAULT_LIMIT : checkInt(o.limit, "limit", 1, MAX_LIMIT);
      const forge = forgeFor(deps, repo, "listDefaultBranchRuns");
      const rows = await forge.listDefaultBranchRuns({ sinceId });
      const { runs, cursor } = selectRuns(rows, sinceId, limit, (deps?.now ?? Date.now)());
      const filled = await Promise.all(
        runs.map(async (r) =>
          r.jobs || !forge.runJobs ? r : { ...r, jobs: await forge.runJobs(r.id) },
        ),
      );
      return { runs: filled.map(toPluginRun), cursor };
    },
    getRun: async (repo, runId) => {
      const id = checkInt(runId, "runId", 1);
      const run = await forgeFor(deps, repo, "getRunDetail").getRunDetail(id);
      return run ? toPluginRun(run) : null;
    },
    failedJobLogs: async (repo, runId, o = {}) => {
      const id = checkInt(runId, "runId", 1);
      const max =
        o.maxLinesPerStep === undefined
          ? DEFAULT_LINES
          : checkInt(o.maxLinesPerStep, "maxLinesPerStep", 1, MAX_LINES);
      const steps = await forgeFor(deps, repo, "failedRunStepLogs").failedRunStepLogs(id);
      return steps.map((s): PluginFailedStepLog => ({
        job: cleanLogLine(s.job),
        step: cleanLogLine(s.step),
        lines: s.lines.slice(-max).map(cleanLogLine),
        truncated: s.lines.length > max,
      }));
    },
    rerunFailed: async (repo, runId) => {
      const id = checkInt(runId, "runId", 1);
      await forgeFor(deps, repo, "rerunWorkflowRun").rerunWorkflowRun(id, { failedOnly: true });
    },
  };
}
