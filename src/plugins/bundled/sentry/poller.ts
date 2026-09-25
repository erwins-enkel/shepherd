// Sentry poll orchestration (#2464): ONE org-wide issues call per interval → rules → latest
// event → in-app-frame check → triage (#2465) → file a GitHub issue. Every dependency is
// injected so tests drive it with a fake fetch and in-memory state.

import type {
  PluginAgents,
  PluginIssues,
  PluginLogger,
  PluginRepo,
  PluginSecrets,
  PluginSessions,
  PluginState,
} from "../../types";
import {
  nextBackoff,
  parseEvent,
  parseIssues,
  parseRegressedAt,
  sentryGet,
  sentryPost,
  type Backoff,
  type Fetch,
  type SentryIssue,
} from "./api";
import { buildCandidate, issueBody } from "./body";
import { isRepoFile, resolveInAppFrames, type IsFile } from "./frames";
import {
  detectFromFiles,
  matchCodeMappings,
  originUrl,
  readText,
  repoSlugFromUrl,
  type ReadText,
} from "./mapping";
import { DAILY_CAP, evaluateIssue, MAX_AUTO_ATTEMPTS, projectIndex, regressedSince } from "./rules";
import {
  bumpDaily,
  dayKey,
  filedToday,
  readFiled,
  readMappings,
  readMeta,
  readSettings,
  readStatus,
  writeFiled,
  writeMeta,
  writeStatus,
  writeSuggestions,
  type PollStatus,
  type Settings,
  type Suggestion,
} from "./state";
import { claimingSession, fixPr, syncFiled } from "./sync";
import { createTriageStage, triageSettled, type TriageFileFn, type TriageStage } from "./triage";

/** Latest-event fetches per poll — bounds API use when many issues become eligible at once. */
const MAX_EVENT_FETCHES = 10;
const SUBSTATUS_GROUP = "(is:new OR is:escalating OR is:regressed)";

export interface PollerDeps {
  state: PluginState;
  secrets: Pick<PluginSecrets, "get">;
  /** Fallback token (`SHEPHERD_SENTRY_TOKEN`) when none is saved in the secret store. */
  envToken: () => string | undefined;
  issues: Pick<PluginIssues, "create" | "get" | "close">;
  /** Read-only: the lifecycle sync looks up the session that claimed a filed issue. */
  sessions: Pick<PluginSessions, "list">;
  agents: Pick<PluginAgents, "runReadonly">;
  repos: () => PluginRepo[];
  fetch: Fetch;
  now: () => Date;
  log: PluginLogger;
  isFile?: IsFile;
  readText?: ReadText;
}

export type PollOutcome =
  "disabled" | "not-configured" | "backoff" | "no-mapping" | "capped" | "busy" | "error" | "ok";

export interface Poller {
  stage: TriageStage;
  /** Scheduled entry: polls when enabled and the configured interval has elapsed. */
  tick(): Promise<void>;
  /** Poll now (still honours enabled, config, backoff and caps). */
  poll(): Promise<PollOutcome>;
  /** Refresh mapping suggestions (repo files, then code-mappings). */
  detect(): Promise<Suggestion[]>;
  /** Whether a token is configured (secret, else env). The token itself is never exposed. */
  hasToken(): boolean;
}

export function pollQuery(minTimesSeen: number, grouped = true): string {
  return [
    "is:unresolved",
    "issue.priority:high",
    ...(grouped ? [SUBSTATUS_GROUP] : []),
    `times_seen:>${minTimesSeen}`,
  ].join(" ");
}

export function createPoller(deps: PollerDeps): Poller {
  const { state, log } = deps;
  const isFile = deps.isFile ?? isRepoFile;
  const read = deps.readText ?? readText;
  let running = false;

  const token = (): string | null => deps.secrets.get("token") || deps.envToken() || null;

  /** Forge-backed repo paths currently under the repo root. */
  function usableRepos(): PluginRepo[] {
    return deps.repos().filter((r) => !r.lightweight);
  }

  const file: TriageFileFn = async (candidate, extra) => {
    const repo = deps.repos().find((r) => r.path === candidate.repo);
    const mapping = readMappings(state)[candidate.repo];
    const prev = readFiled(state, candidate.sentryId);
    const humanOnly = (prev?.attempts ?? 0) >= MAX_AUTO_ATTEMPTS;
    const labels = ["sentry"];
    if (mapping?.autoDrain && repo?.autoLabel && !humanOnly) labels.push(repo.autoLabel);
    // The sync may never have seen the PR (e.g. the issue closed between visits): fall back to
    // the session that worked the previous issue.
    const prevPr = prev ? (prev.pr ?? fixPr(claimingSession(deps.sessions, prev))) : null;
    const prior = prev ? { url: prev.url, prUrl: prevPr?.url ?? null, humanOnly } : null;
    const res = await deps.issues.create(candidate.repo, {
      title: candidate.title,
      body: issueBody(candidate, readMeta(state, candidate.sentryId), extra.overridden, prior),
      labels,
      untrusted: [...candidate.untrusted, ...extra.untrusted],
    });
    const now = deps.now();
    writeFiled(state, candidate.sentryId, {
      repo: candidate.repo,
      number: res.number,
      url: res.url,
      attempts: (prev?.attempts ?? 0) + 1,
      filedAt: now.toISOString(),
    });
    bumpDaily(state, candidate.repo, dayKey(now));
    log.log(`filed ${candidate.shortId} as #${res.number} in ${candidate.repo}`);
    return res;
  };

  const stage = createTriageStage({ agents: deps.agents, state, file, log });

  /** A Sentry client that folds every response into `backoff`. */
  function client(s: Settings, tok: string, backoff: { b: Backoff }) {
    return async (path: string, query: Record<string, string> = {}) => {
      const r = await sentryGet({ fetch: deps.fetch, host: s.host, token: tok }, path, query);
      backoff.b = nextBackoff(r.status, r.headers, deps.now().getTime(), backoff.b);
      return r;
    };
  }

  /** A Sentry POST folding into the same `backoff` as `client`. */
  function poster(s: Settings, tok: string, backoff: { b: Backoff }) {
    return async (path: string, body: unknown) => {
      const r = await sentryPost({ fetch: deps.fetch, host: s.host, token: tok }, path, body);
      backoff.b = nextBackoff(r.status, r.headers, deps.now().getTime(), backoff.b);
      return r;
    };
  }

  /** Is the previously filed GitHub issue closed (the precondition for a re-filing)? */
  async function previousClosed(sentryId: string): Promise<boolean> {
    const f = readFiled(state, sentryId);
    if (!f) return true;
    const gh = await deps.issues.get(f.repo, f.number).catch(() => null);
    return gh?.state === "closed";
  }

  /** List eligible Sentry issues and file what passes; outcome counts, or the list error. */
  async function fileNew(
    s: Settings,
    get: ReturnType<typeof client>,
    repoForProject: Map<string, string>,
    day: string,
  ): Promise<{ counts: Record<string, number> } | { error: string }> {
    const org = encodeURIComponent(s.org);
    const base = { project: "-1", sort: "new", limit: "100" };
    let list = await get(`organizations/${org}/issues/`, {
      ...base,
      query: pollQuery(s.minTimesSeen),
    });
    if (!list.ok && list.status === 400) {
      log.warn("issues query rejected (400); retrying without the substatus group");
      list = await get(`organizations/${org}/issues/`, {
        ...base,
        query: pollQuery(s.minTimesSeen, false),
      });
    }
    if (!list.ok) return { error: list.error };

    const counts: Record<string, number> = {};
    const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
    let fetches = 0;
    for (const issue of parseIssues(list.data)) {
      const outcome = await consider(issue, {
        s,
        day,
        get,
        repoForProject,
        fetches: () => fetches++,
      });
      count(outcome);
      if (outcome === "rate-limited") break;
    }
    return { counts };
  }

  /** One poll: file new issues (unless every mapped repo is capped today), then the lifecycle
   *  sync over already-filed ones (#2466) unless Sentry asked us to back off. */
  async function runPoll(
    s: Settings,
    tok: string,
    st: PollStatus,
    repoForProject: Map<string, string>,
    capped: boolean,
  ): Promise<PollOutcome> {
    const now = deps.now();
    const backoff = { b: { until: 0, strikes: st.strikes } };
    const get = client(s, tok, backoff);
    const done = (patch: Partial<PollStatus>) =>
      writeStatus(state, {
        ...st,
        lastPollAt: now.getTime(),
        backoffUntil: backoff.b.until,
        strikes: backoff.b.strikes,
        ...patch,
      });
    let counts: Record<string, number> = {};
    if (!capped) {
      const filed = await fileNew(s, get, repoForProject, dayKey(now));
      if ("error" in filed) {
        done({ lastError: filed.error });
        return "error";
      }
      counts = filed.counts;
    }
    if (backoff.b.until <= deps.now().getTime()) {
      Object.assign(
        counts,
        await syncFiled({
          state,
          issues: deps.issues,
          sessions: deps.sessions,
          get,
          post: poster(s, tok, backoff),
          org: s.org,
          now: deps.now,
          log,
        }),
      );
    }
    done({ lastError: null, lastResult: counts });
    return capped ? "capped" : "ok";
  }

  interface ConsiderCtx {
    s: Settings;
    day: string;
    get: ReturnType<typeof client>;
    repoForProject: Map<string, string>;
    /** Returns the fetch count BEFORE incrementing. */
    fetches: () => number;
  }

  /** For a regressed issue, when Sentry last recorded the regression (the triage
   *  `regressionKey`), or a skip reason. Non-regressed → `{ key: null }`. */
  async function regression(
    issue: SentryIssue,
    regressed: boolean,
    c: ConsiderCtx,
  ): Promise<{ key: string | null } | { skip: string }> {
    if (!regressed) return { key: null };
    if (c.fetches() >= MAX_EVENT_FETCHES) return { skip: "deferred" };
    const res = await c.get(`organizations/${encodeURIComponent(c.s.org)}/issues/${issue.id}/`);
    if (!res.ok) return { skip: res.status === 429 ? "rate-limited" : "event-error" };
    return { key: parseRegressedAt(res.data) };
  }

  /** Decide one Sentry issue; returns the outcome/skip reason counted in the poll status. */
  async function consider(issue: SentryIssue, c: ConsiderCtx): Promise<string> {
    const filed = readFiled(state, issue.id);
    const v = evaluateIssue(issue, {
      repoForProject: c.repoForProject,
      filed,
      filedToday: (repo) => filedToday(state, repo, c.day),
    });
    if (!v.ok) return v.reason;
    if (v.refile && !(await previousClosed(issue.id))) return "filed";
    const reg = await regression(issue, v.regressed, c);
    if ("skip" in reg) return reg.skip;
    if (filed && !regressedSince(reg.key, filed.filedAt)) return "filed";
    if (triageSettled(state, issue.id, reg.key)) return "triaged";
    if (c.fetches() >= MAX_EVENT_FETCHES) return "deferred";

    const org = encodeURIComponent(c.s.org);
    const res = await c.get(`organizations/${org}/issues/${issue.id}/events/latest/`);
    if (!res.ok) return res.status === 429 ? "rate-limited" : "event-error";
    const ev = parseEvent(res.data);
    if (!ev) return "event-error";
    const frames = await resolveInAppFrames(
      v.repo,
      ev.exceptions.flatMap((e) => e.frames),
      isFile,
    );
    if (frames.length === 0) return "not-in-repo";

    const built = buildCandidate(issue, ev, frames, v.repo, c.s.host, reg.key);
    writeMeta(state, issue.id, built.meta);
    try {
      return (await stage.process(built.candidate)).outcome;
    } catch (e) {
      log.warn(`filing ${issue.shortId} failed: ${(e as Error).message}`);
      return "file-error";
    }
  }

  async function poll(): Promise<PollOutcome> {
    if (running) return "busy";
    const s = readSettings(state);
    if (!s.enabled) return "disabled";
    const st = readStatus(state);
    const now = deps.now().getTime();
    const tok = token();
    if (!s.org || !tok) {
      writeStatus(state, { ...st, lastPollAt: now, lastError: "not-configured" });
      return "not-configured";
    }
    if (st.backoffUntil > now) return "backoff";
    const usable = new Set(usableRepos().map((r) => r.path));
    const repoForProject = projectIndex(readMappings(state), (r) => usable.has(r));
    const day = dayKey(deps.now());
    const mapped = [...new Set(repoForProject.values())];
    const skip = (why: PollOutcome) => {
      writeStatus(state, { ...st, lastPollAt: now, lastError: null, lastResult: {} });
      return why;
    };
    if (mapped.length === 0) return skip("no-mapping");
    const capped = mapped.every((r) => filedToday(state, r, day) >= DAILY_CAP);
    running = true;
    try {
      return await runPoll(s, tok, st, repoForProject, capped);
    } finally {
      running = false;
    }
  }

  /** `owner/repo` slugs from each repo's `origin` remote (unreadable/unparseable skipped). */
  async function originSlugs(repos: PluginRepo[]): Promise<Array<{ path: string; slug: string }>> {
    const out: Array<{ path: string; slug: string }> = [];
    for (const r of repos) {
      const url = await originUrl(r.path, read);
      const slug = url ? repoSlugFromUrl(url) : null;
      if (slug) out.push({ path: r.path, slug });
    }
    return out;
  }

  /** Suggestions from Sentry's private code-mappings endpoint for `repos`; `[]` when not
   *  configured, backing off, or the endpoint fails (it is undocumented — never fatal). */
  async function codeMappingSuggestions(repos: PluginRepo[]): Promise<Suggestion[]> {
    const s = readSettings(state);
    const tok = token();
    const st = readStatus(state);
    if (!s.org || !tok || st.backoffUntil > deps.now().getTime()) return [];
    const backoff = { b: { until: 0, strikes: st.strikes } };
    const res = await client(
      s,
      tok,
      backoff,
    )(`organizations/${encodeURIComponent(s.org)}/code-mappings/`, { project: "-1" });
    writeStatus(state, {
      ...readStatus(state),
      backoffUntil: backoff.b.until,
      strikes: backoff.b.strikes,
    });
    if (!res.ok) {
      log.warn(`code-mappings unavailable (${res.error}) — ignored`);
      return [];
    }
    return matchCodeMappings(res.data, await originSlugs(repos));
  }

  async function detect(): Promise<Suggestion[]> {
    const repos = usableRepos();
    const found: Suggestion[] = [];
    for (const r of repos) {
      const hit = await detectFromFiles(r.path, read);
      if (hit) found.push(hit);
    }
    found.push(
      ...(await codeMappingSuggestions(repos.filter((r) => !found.some((f) => f.repo === r.path)))),
    );
    const mappings = readMappings(state);
    const suggestions = found.filter((x) => !mappings[x.repo]);
    writeSuggestions(state, suggestions);
    return suggestions;
  }

  return {
    stage,
    poll,
    detect,
    hasToken: () => token() !== null,
    async tick() {
      const s = readSettings(state);
      if (!s.enabled) return;
      const due = readStatus(state).lastPollAt + s.pollMinutes * 60_000;
      if (deps.now().getTime() < due) return;
      await poll();
    },
  };
}
