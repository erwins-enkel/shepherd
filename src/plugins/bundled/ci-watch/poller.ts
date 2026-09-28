// ci-watch poll orchestration (#2540): per enabled Forge repo, ONE `listDefaultBranchRuns` call
// per interval → run filters → per-key streaks → rules → the forward stage. Every dependency is
// injected so tests drive it with scripted runs and in-memory state.

import type {
  PluginForgeRuns,
  PluginLogger,
  PluginRepo,
  PluginRun,
  PluginState,
} from "../../types";
import { evaluateKey, observe, runSkip, thresholdFor } from "./rules";
import {
  dayKey,
  filedToday,
  mapKey,
  readCursor,
  readKey,
  readRepoConfig,
  readSettings,
  readStatus,
  writeCursor,
  writeKey,
  writeStatus,
  RECENT_MAX,
  type KeyRecord,
  type RepoConfig,
} from "./state";

/** Runs read per repo per poll (the API maximum); a larger backlog drains over later polls. */
const PAGE = 50;

/** A failing key that passed every deterministic rule. */
export interface Candidate {
  repo: string;
  /** The `map:` state key. */
  key: string;
  workflowName: string;
  workflowFile: string;
  job: string;
  streak: number;
  runId: number;
  /** Run attempt at observation — the flake probe waits for it to bump. */
  attempt: number;
  runUrl: string;
  headSha: string;
  event: string;
}

export interface PollerDeps {
  state: PluginState;
  runs: Pick<PluginForgeRuns, "listDefaultBranchRuns">;
  repos: () => PluginRepo[];
  /** Next stage (#2541); returns the outcome counted in the poll status. */
  forward: (c: Candidate) => Promise<string>;
  /** Lifecycle sync of filed issues (#2542), after the repos; returns counts for the status. */
  sync: () => Promise<Counts>;
  now: () => Date;
  log: PluginLogger;
}

export type PollOutcome = "disabled" | "busy" | "ok";

export interface Poller {
  /** Scheduled entry: polls when enabled and the configured interval has elapsed. */
  tick(): Promise<void>;
  /** Poll now (still honours the master switch). */
  poll(): Promise<PollOutcome>;
}

type Counts = Record<string, number>;

export function createPoller(deps: PollerDeps): Poller {
  const { state, log } = deps;
  let running = false;

  /** Fold one run's observations into key state; returns the keys that went red. */
  function apply(repo: string, run: PluginRun): Map<string, PluginRun> {
    const red = new Map<string, PluginRun>();
    for (const [job, conclusion] of observe(run)) {
      const key = mapKey(repo, run.workflowFile, job);
      const prev = readKey(state, key);
      const rec: KeyRecord = {
        ...prev,
        repo,
        workflowName: run.workflowName,
        workflowFile: run.workflowFile,
        job,
        streak: conclusion === "failure" ? (prev?.streak ?? 0) + 1 : 0,
        lastRunId: run.id,
        lastConclusion: conclusion,
        recent: [...(prev?.recent ?? []), conclusion].slice(-RECENT_MAX),
      };
      if (conclusion === "success") delete rec.classified;
      if (conclusion === "failure") {
        rec.lastFailedRunId = run.id;
        rec.lastFailedUrl = run.url;
        red.set(key, run);
      }
      writeKey(state, key, rec);
    }
    return red;
  }

  async function forwardKey(key: string, run: PluginRun, rec: KeyRecord): Promise<string> {
    try {
      const outcome = await deps.forward({
        repo: rec.repo,
        key,
        workflowName: rec.workflowName,
        workflowFile: rec.workflowFile,
        job: rec.job,
        streak: rec.streak,
        runId: run.id,
        attempt: run.attempt,
        runUrl: run.url,
        headSha: run.headSha,
        event: run.event,
      });
      writeKey(state, key, { ...(readKey(state, key) ?? rec), forwardedRunId: run.id });
      return outcome;
    } catch (e) {
      log.warn(`forwarding ${key} failed: ${(e as Error).message}`);
      return "forward-error";
    }
  }

  /** Evaluate the keys that went red in this batch (latest red run per key). */
  async function decide(
    repo: string,
    cfg: RepoConfig,
    red: Map<string, PluginRun>,
    count: (k: string) => void,
  ): Promise<void> {
    const day = dayKey(deps.now());
    for (const [key, run] of red) {
      const rec = readKey(state, key);
      if (!rec) continue;
      const skip = evaluateKey(rec, {
        threshold: thresholdFor(cfg, rec.workflowName),
        filedToday: filedToday(state, repo, day),
      });
      count(skip ?? (await forwardKey(key, run, rec)));
    }
  }

  /** One repo's batch: observe every run, then (once baselined) apply the key rules. The cursor
   *  moves only after the batch is fully applied. */
  async function pollRepo(repo: string, cfg: RepoConfig, count: (k: string) => void) {
    const cur = readCursor(state, repo);
    const { runs, cursor } = await deps.runs.listDefaultBranchRuns(repo, {
      sinceId: cur.sinceId,
      limit: PAGE,
    });
    const red = new Map<string, PluginRun>();
    for (const run of runs) {
      const skip = runSkip(run);
      if (skip) {
        count(skip);
        continue;
      }
      for (const [key, r] of apply(repo, run)) {
        red.delete(key); // keep insertion order = latest red run
        red.set(key, r);
      }
    }
    if (cur.baselined) await decide(repo, cfg, red, count);
    else if (red.size) count("baseline");
    writeCursor(state, repo, {
      sinceId: cursor,
      baselined: cur.baselined || runs.length < PAGE,
    });
  }

  async function runPoll(): Promise<void> {
    const counts: Counts = {};
    const count = (k: string) => void (counts[k] = (counts[k] ?? 0) + 1);
    let lastError: string | null = null;
    for (const r of deps.repos()) {
      if (r.lightweight) continue;
      const cfg = readRepoConfig(state, r.path);
      if (!cfg.enabled) continue;
      try {
        await pollRepo(r.path, cfg, count);
      } catch (e) {
        const err = e as Error & { code?: string };
        if (err.name === "PluginForgeError" && err.code) count(err.code);
        else lastError = err.message;
        log.warn(`polling ${r.path} failed: ${err.message}`);
      }
    }
    try {
      Object.assign(counts, await deps.sync());
    } catch (e) {
      lastError = (e as Error).message;
      log.warn(`sync failed: ${lastError}`);
    }
    writeStatus(state, { lastPollAt: deps.now().getTime(), lastError, lastResult: counts });
  }

  async function poll(): Promise<PollOutcome> {
    if (running) return "busy";
    if (!readSettings(state).enabled) return "disabled";
    running = true;
    try {
      await runPoll();
      return "ok";
    } finally {
      running = false;
    }
  }

  return {
    poll,
    async tick() {
      const s = readSettings(state);
      if (!s.enabled) return;
      const due = readStatus(state).lastPollAt + s.pollMinutes * 60_000;
      if (deps.now().getTime() < due) return;
      await poll();
    },
  };
}
