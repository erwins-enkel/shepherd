// security-watch poll: per watched repo, one list per enabled source. Every open alert is folded
// into its group BEFORE any filter, so whether alerts are gone never depends on the operator's
// settings. Filters and holds then pick candidates, the rules pick groups, and the worst go to
// triage. Every dependency is injected so tests drive it with scripted reads and in-memory state.

import type {
  PluginAlertList,
  PluginForgeSecurity,
  PluginLogger,
  PluginRepo,
  PluginRepoVisibility,
  PluginState,
} from "../../types";
import {
  alertFilter,
  alertHold,
  candidatesOf,
  compareUrgency,
  DAILY_CAP,
  evaluateGroup,
  groupCodeScanning,
  groupDependabot,
  MAX_TRIAGES_PER_POLL,
  needsAck,
  urgency,
  type GroupRead,
} from "./rules";
import {
  dayKey,
  deleteGroup,
  filedToday,
  readGroup,
  readGroups,
  readRepoConfig,
  readSettings,
  readStatus,
  writeAvailability,
  writeGroup,
  writeStatus,
  writeVisibility,
  type AlertRecord,
  type Availability,
  type GroupRecord,
  type RepoConfig,
  type Source,
} from "./state";

export interface PollerDeps {
  state: PluginState;
  security: PluginForgeSecurity;
  repos: () => PluginRepo[];
  /** Next stage (triage); returns the outcome counted in the poll status. */
  forward: (g: GroupRecord) => Promise<string>;
  /** Lifecycle sync; `complete` says which sources were read in full this poll. */
  sync: (complete: (repo: string, source: Source) => boolean) => Promise<Counts>;
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
type Count = (k: string) => void;
/** Reads that succeeded this poll: `<repo>::<source>`, value = truncated. */
type Reads = Map<string, boolean>;

const readId = (repo: string, source: Source) => `${repo}::${source}`;

/** A `truncated` read adds to what is known; a complete read replaces it. */
function mergeAlerts(prior: AlertRecord[], read: AlertRecord[], truncated: boolean): AlertRecord[] {
  if (!truncated) return read;
  const fresh = new Set(read.map((a) => a.number));
  return [...prior.filter((a) => !fresh.has(a.number)), ...read];
}

/** Mark a group resolved once its filed alerts are absent from a complete read. */
function withResolution(g: GroupRecord, now: number): GroupRecord {
  const f = g.filing;
  if (!f || (g.observedResolvedAt ?? 0) > f.filedAt) return g;
  if (g.openAlerts.some((a) => f.filedAlerts.includes(a.number))) return g;
  const next = { ...g, observedResolvedAt: now };
  // The same alerts may reopen: their old triage verdict no longer settles them.
  delete next.triage;
  return next;
}

/** Fold one source's read into state. Only a complete read can say an alert is gone. */
function foldRead(
  state: PluginState,
  repo: string,
  source: Source,
  groups: GroupRead[],
  truncated: boolean,
  now: number,
): void {
  const seen = new Set<string>();
  for (const read of groups) {
    seen.add(read.key);
    const prior = readGroup(state, read.key);
    const openAlerts = mergeAlerts(prior?.openAlerts ?? [], read.openAlerts, truncated);
    const next: GroupRecord = { ...prior, ...read, openAlerts };
    writeGroup(state, truncated ? next : withResolution(next, now));
  }
  if (truncated) return;
  for (const g of readGroups(state)) {
    if (g.repo !== repo || g.source !== source || seen.has(g.key)) continue;
    if (!g.filing) deleteGroup(state, g.key);
    else writeGroup(state, withResolution({ ...g, openAlerts: [] }, now));
  }
}

function countSkips(g: GroupRecord, cfg: RepoConfig, now: number, count: Count): void {
  for (const a of g.openAlerts) {
    const reason = alertFilter(a, cfg) ?? alertHold(g.source, a, now);
    if (reason) count(`skip-${reason}`);
  }
}

export function createPoller(deps: PollerDeps): Poller {
  const { state, log } = deps;
  let running = false;
  const nowMs = () => deps.now().getTime();

  /** One source of one repo. Errors stay local: the other source and repos still run. */
  async function readSource<T>(
    repo: string,
    source: Source,
    list: () => Promise<PluginAlertList<T>>,
    toGroups: (alerts: T[]) => GroupRead[],
    ctx: { reads: Reads; avail: Availability; count: Count; fail: (m: string) => void },
  ): Promise<void> {
    try {
      const res = await list();
      if (res.status === "unavailable") {
        ctx.avail[source] = res.reason;
        ctx.count(`unavailable-${res.reason}`);
        return;
      }
      foldRead(state, repo, source, toGroups(res.alerts), res.truncated, nowMs());
      ctx.reads.set(readId(repo, source), res.truncated);
      ctx.avail[source] = res.truncated ? "truncated" : "ok";
      if (res.truncated) ctx.count("truncated");
    } catch (e) {
      const err = e as Error & { code?: string };
      ctx.avail[source] = err.name === "PluginForgeError" && err.code ? err.code : "error";
      if (err.name === "PluginForgeError" && err.code) ctx.count(err.code);
      else ctx.fail(err.message);
      log.warn(`reading ${source} of ${repo} failed: ${err.message}`);
    }
  }

  async function readVisibilityOf(repo: string): Promise<PluginRepoVisibility> {
    try {
      return await deps.security.visibility(repo);
    } catch (e) {
      log.warn(`visibility of ${repo} unavailable: ${(e as Error).message}`);
      return "unknown";
    }
  }

  async function readRepo(
    repo: string,
    cfg: RepoConfig,
    ctx: { reads: Reads; count: Count; fail: (m: string) => void },
  ): Promise<PluginRepoVisibility> {
    const visibility = await readVisibilityOf(repo);
    writeVisibility(state, repo, visibility);
    const avail: Availability = {};
    const sub = { ...ctx, avail };
    if (cfg.codeScanning) {
      await readSource(
        repo,
        "cs",
        () => deps.security.listCodeScanningAlerts(repo),
        (alerts) => groupCodeScanning(repo, alerts),
        sub,
      );
    }
    if (cfg.dependabot) {
      await readSource(
        repo,
        "dep",
        () => deps.security.listDependabotAlerts(repo),
        (alerts) => groupDependabot(repo, alerts),
        sub,
      );
    }
    writeAvailability(state, repo, avail);
    return visibility;
  }

  /** Groups of `repo` to triage. Only sources read this poll count: a stale record may be gone. */
  function eligibleGroups(
    repo: string,
    cfg: RepoConfig,
    visibility: PluginRepoVisibility,
    reads: Reads,
    count: Count,
  ): GroupRecord[] {
    const now = nowMs();
    const blocked = needsAck(visibility, cfg);
    const day = dayKey(deps.now());
    const out: GroupRecord[] = [];
    for (const g of readGroups(state)) {
      if (g.repo !== repo || !reads.has(readId(repo, g.source))) continue;
      countSkips(g, cfg, now, count);
      const candidates = candidatesOf(g, cfg, now);
      if (candidates.length === 0) continue;
      if (blocked) {
        count("needs-ack");
        continue;
      }
      const skip = evaluateGroup(g, candidates, { filedToday: filedToday(state, repo, day) });
      if (skip) count(skip);
      else out.push(g);
    }
    return out;
  }

  /** Worst first, across repos, at most {@link MAX_TRIAGES_PER_POLL}. The rest wait for a later
   *  poll: nothing about them is recorded, so they stay eligible. */
  async function forwardWorst(groups: GroupRecord[], count: Count): Promise<void> {
    const cfgNow = nowMs();
    const ranked = groups
      .map((g) => ({ g, u: urgency(candidatesOf(g, readRepoConfig(state, g.repo), cfgNow)) }))
      .sort((a, b) => compareUrgency(a.u, b.u));
    let started = 0;
    for (const { g } of ranked) {
      if (started >= MAX_TRIAGES_PER_POLL) {
        count("throttled");
        continue;
      }
      if (filedToday(state, g.repo, dayKey(deps.now())) >= DAILY_CAP) {
        count("cap");
        continue;
      }
      started++;
      try {
        count(await deps.forward(g));
      } catch (e) {
        log.warn(`forwarding ${g.key} failed: ${(e as Error).message}`);
        count("forward-error");
      }
    }
  }

  async function runPoll(): Promise<void> {
    const counts: Counts = {};
    const count: Count = (k) => void (counts[k] = (counts[k] ?? 0) + 1);
    let lastError: string | null = null;
    const fail = (m: string) => void (lastError = m);
    const reads: Reads = new Map();
    const eligible: GroupRecord[] = [];
    for (const r of deps.repos()) {
      if (r.lightweight) continue;
      const cfg = readRepoConfig(state, r.path);
      if (!cfg.enabled) continue;
      const visibility = await readRepo(r.path, cfg, { reads, count, fail });
      eligible.push(...eligibleGroups(r.path, cfg, visibility, reads, count));
    }
    await forwardWorst(eligible, count);
    try {
      const complete = (repo: string, source: Source) => reads.get(readId(repo, source)) === false;
      Object.assign(counts, await deps.sync(complete));
    } catch (e) {
      lastError = (e as Error).message;
      log.warn(`sync failed: ${lastError}`);
    }
    writeStatus(state, { lastPollAt: nowMs(), lastError, lastResult: counts });
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
      if (nowMs() < readStatus(state).lastPollAt + s.pollMinutes * 60_000) return;
      await poll();
    },
  };
}
