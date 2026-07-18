import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionStore } from "./store";
import type { HerdrDriver } from "./herdr";
import { HerdrUnavailableError } from "./herdr";
import type { Learning, MergeSuggestionKind } from "./types";
import { normalizeRule } from "./learning-rule";
import { apiKeyFailClosed, apiKeyPassthroughEnv } from "./spawn-auth";
import { buildTransientAgentArgv } from "./transient-agent-argv";
import { reapTransientByLabel } from "./transient-tab-reaper";
import type { RoleEnvironment } from "./default-model";

const RULES_FILE = "rules.json";
const OUTPUT_FILE = ".shepherd-merge.json";

/** Marker prefix for the merge-suggestion pass's ephemeral agents. Each run appends the
 *  first 8 hex of its session UUID so concurrent runs never collide on the herdr name.
 *  The underscores keep it collision-proof against `[a-z0-9-]` prompt slugs, and the
 *  orphan-tab reaper matches this prefix (see tab-reaper.ts). */
export const MERGE_LABEL = "__merge__";

/** Scope key for the global cross-repo pass (intra passes key on repoPath). */
const CROSS_KEY = "__cross__";

const HEALTH_FAILURE_THRESHOLD = 3;

/** Per-run caps so one pass can't flood the drawer. */
const MAX_GROUPS_PER_RUN = 8;

interface RawGroup {
  memberIds?: unknown;
  anchorId?: unknown;
  mergedRule?: unknown;
  mergedRationale?: unknown;
  canonicalRule?: unknown;
}
interface RawOutput {
  groups?: unknown;
}

interface InFlight {
  key: string;
  kind: MergeSuggestionKind;
  repoPath: string | null;
  dir: string;
  terminalId: string;
  startedAt: number;
  finalizing?: boolean;
  /** Rule ids handed to this run — the only ids a group may cite (blocks hallucinations). */
  members: Map<string, Learning>;
  /** Signature of the active set this run processed, stamped on success to skip re-runs. */
  sig: string;
}

export interface MergeSuggestionDeps {
  store: Pick<
    SessionStore,
    | "getRepoConfig"
    | "listLearnings"
    | "listAllActiveLearnings"
    | "getLearning"
    | "addMergeSuggestion"
    | "mergeSuggestionSignatures"
    | "getMergePassSignature"
    | "setMergePassSignature"
  >;
  herdr: Pick<HerdrDriver, "start" | "stop" | "list" | "closeTab">;
  scratch: { create: () => { dir: string }; remove: (dir: string) => void };
  onChange: () => void;
  model?: string | null;
  environment?: () => RoleEnvironment;
  now?: () => number;
  timeoutMs?: number;
  /** Min active rules in a repo before an intra pass runs (default 8). */
  minRules?: number;
  /** Min distinct repos a rule must span for the cross pass to run (default 3). */
  crossMinRepos?: number;
  /** Hard cap on rules handed to the cross spawn after pre-filtering (default 150). */
  crossMaxRules?: number;
  maxConcurrent?: number;
  writeRules?: (dir: string, rules: { id: string; repo: string; rule: string }[]) => void;
  readOutput?: (dir: string) => RawOutput | null;
  log?: (msg: string) => void;
}

export class MergeSuggestionService {
  private inflight = new Map<string, InFlight>();
  private queue: { key: string; kind: MergeSuggestionKind; repoPath: string | null }[] = [];
  private queued = new Set<string>();
  private maxConcurrent: number;
  private now: () => number;
  private timeoutMs: number;
  private minRules: number;
  private crossMinRepos: number;
  private crossMaxRules: number;
  private writeRules: NonNullable<MergeSuggestionDeps["writeRules"]>;
  private readOutput: (dir: string) => RawOutput | null;
  private log: (msg: string) => void;
  private healthFailures = 0;
  private lastFailure: { reason: string; at: number; key: string } | null = null;

  constructor(private deps: MergeSuggestionDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000;
    this.minRules = deps.minRules ?? 8;
    this.crossMinRepos = deps.crossMinRepos ?? 3;
    this.crossMaxRules = deps.crossMaxRules ?? 150;
    this.maxConcurrent = deps.maxConcurrent ?? 2;
    this.writeRules = deps.writeRules ?? defaultWriteRules;
    this.readOutput = deps.readOutput ?? defaultReadOutput;
    this.log = deps.log ?? ((m) => console.warn(`[merge] ${m}`));
  }

  health(): {
    ok: boolean;
    consecutiveFailures: number;
    lastFailure: { reason: string; at: number; key: string } | null;
  } {
    return {
      ok: this.healthFailures < HEALTH_FAILURE_THRESHOLD,
      consecutiveFailures: this.healthFailures,
      lastFailure: this.lastFailure,
    };
  }

  private recordHealthFailure(key: string, reason: string): void {
    this.healthFailures++;
    this.lastFailure = { reason, at: this.now(), key };
    if (this.healthFailures >= HEALTH_FAILURE_THRESHOLD) this.deps.onChange();
  }

  private recordHealthSuccess(): void {
    const wasUnhealthy = this.healthFailures >= HEALTH_FAILURE_THRESHOLD;
    this.healthFailures = 0;
    this.lastFailure = null;
    if (wasUnhealthy) this.deps.onChange();
  }

  /** Stable hash of a set of rule ids (order-independent). */
  private sigOf(ids: string[]): string {
    return createHash("sha1")
      .update([...ids].sort().join(","))
      .digest("hex");
  }

  // ── triggers (synchronous, non-blocking — safe to call from the daily sweep) ──

  /** Intra-repo: propose merge groups when a repo has enough active rules and its active
   *  set changed since the last pass. No-op otherwise. Never awaits the spawn. */
  async consider(repoPath: string): Promise<void> {
    if (!this.deps.store.getRepoConfig(repoPath).learningsEnabled) return;
    const active = this.deps.store.listLearnings(repoPath, { status: "active" });
    if (active.length < this.minRules) return;
    const sig = this.sigOf(active.map((l) => l.id));
    if (this.deps.store.getMergePassSignature(repoPath) === sig) return;
    await this.enqueueOrBegin(repoPath, "intra", repoPath, sig, active);
  }

  /** Cross-repo: propose promote-to-global suggestions for rules recurring across repos.
   *  Runs once per sweep globally; gated on repo span + a changed global signature. */
  async considerCrossRepo(): Promise<void> {
    const all = this.deps.store.listAllActiveLearnings();
    const repos = new Set(all.map((l) => l.repoPath));
    if (repos.size < this.crossMinRepos) return;
    const sig = this.sigOf(all.map((l) => l.id));
    if (this.deps.store.getMergePassSignature(CROSS_KEY) === sig) return;
    await this.enqueueOrBegin(CROSS_KEY, "cross", null, sig, all);
  }

  /** Manual trigger for a repo's intra pass — bypasses the active-count + signature gates
   *  (still needs ≥2 active rules to have anything to merge). Subject to the concurrency cap. */
  async mergeNow(repoPath: string): Promise<void> {
    const active = this.deps.store.listLearnings(repoPath, { status: "active" });
    if (active.length < 2) return;
    const sig = this.sigOf(active.map((l) => l.id));
    await this.enqueueOrBegin(repoPath, "intra", repoPath, sig, active);
  }

  private async enqueueOrBegin(
    key: string,
    kind: MergeSuggestionKind,
    repoPath: string | null,
    sig: string,
    rules: Learning[],
  ): Promise<void> {
    if (this.inflight.has(key) || this.queued.has(key)) return;
    if (this.inflight.size < this.maxConcurrent) {
      // begin() reserves its inflight slot synchronously (before its first await), so this
      // size check + the has() guard above hold even under a fire-and-forget fan-out. The
      // await here additionally lets awaiting callers (tests, the tick() drain) observe the
      // spawn's completion; it is NOT what enforces the cap.
      await this.begin(key, kind, repoPath, sig, rules);
    } else {
      this.queue.push({ key, kind, repoPath });
      this.queued.add(key);
    }
  }

  private async begin(
    key: string,
    kind: MergeSuggestionKind,
    repoPath: string | null,
    sig: string,
    rules: Learning[],
  ): Promise<void> {
    // Cross pass: cheap programmatic pre-filter + cap BEFORE the LLM sees anything, so a
    // large install can't blow context/timeout and silently degrade detection.
    let input = rules;
    if (kind === "cross") {
      const { shortlist, dropped } = crossRepoShortlist(rules, this.crossMaxRules);
      if (shortlist.length < 2) return; // nothing recurs across repos
      if (dropped > 0)
        this.log(`cross pre-filter dropped ${dropped} rule(s) over cap ${this.crossMaxRules}`);
      input = shortlist;
    }

    const { dir } = this.deps.scratch.create();
    const environment = this.deps.environment?.() ?? {
      provider: "claude" as const,
      model: this.deps.model ?? null,
      effort: null,
    };
    // Fail closed: api-key mode without a configured key must NOT bill the subscription.
    if (apiKeyFailClosed(environment.provider)) {
      console.warn(
        "[merge] api-key mode enabled but no API key configured — skipping (fail closed)",
      );
      this.deps.scratch.remove(dir);
      return;
    }
    try {
      this.writeRules(
        dir,
        input.map((l) => ({ id: l.id, repo: l.repoPath, rule: l.rule })),
      );
    } catch (err) {
      this.log(`write rules failed for ${key}: ${String(err)}`);
      this.deps.scratch.remove(dir);
      this.recordHealthFailure(key, "write");
      return;
    }
    // Read-only merge suggester — the shared `writer-ro` transient-agent shape (untrusted
    // agent-authored rule text); see buildTransientAgentArgv for the flag-order + isolation rationale.
    const { argv, sessionId } = buildTransientAgentArgv("writer-ro", {
      provider: environment.provider,
      model: environment.model,
      effort: environment.effort,
      prompt: kind === "cross" ? crossPrompt() : intraPrompt(),
    });
    const agentName = MERGE_LABEL + sessionId.slice(0, 8);
    // Reserve the inflight slot SYNCHRONOUSLY — before the async spawn yields — so the daily
    // sweep's fire-and-forget fan-out over repos + cross can't let more than maxConcurrent keys
    // pass the `inflight.size < maxConcurrent` check before any reserves, exceeding the cap.
    // The blocking sync path reserved implicitly by never yielding. terminalId is backfilled
    // once herdr.start resolves; the slot is released if the spawn fails. (tick() skips a
    // reserved run until it has output, so terminalId="" is never observed by finalize.)
    const entry: InFlight = {
      key,
      kind,
      repoPath,
      dir,
      terminalId: "",
      startedAt: this.now(),
      members: new Map(input.map((l) => [l.id, l])),
      sig,
    };
    this.inflight.set(key, entry);
    try {
      entry.terminalId = (
        await this.deps.herdr.start(
          agentName,
          dir,
          argv,
          environment.provider === "claude" ? apiKeyPassthroughEnv(false) : undefined,
        )
      ).terminalId;
    } catch (err) {
      this.inflight.delete(key); // release the reservation
      if (err instanceof HerdrUnavailableError) {
        this.log(`herdr unavailable for ${key}: ${String(err)}`);
      } else {
        this.log(`spawn failed for ${key}: ${String(err)}`);
        this.recordHealthFailure(key, "spawn");
      }
      this.deps.scratch.remove(dir);
      return;
    }
  }

  /** Boot reconcile (issue #1135): close orphaned merge-suggestion tabs left by a PRIOR
   *  server lifetime. `inflight` is memory-only, so a restart loses tracking of live runs;
   *  the spawned interactive `claude` idles at the prompt forever after writing its output
   *  (agent_status "done" = finished-turn, pane alive), and the husk-only tab reaper
   *  (tab-reaper.ts) spares it as an alive (non-shell) `claude`. Scan herdr once for agents
   *  whose name starts with MERGE_LABEL and are NOT owned by a current-process inflight run,
   *  and close their tabs. Name-based — no persisted state (the issue's preferred approach);
   *  the prefix's underscores can't appear in a real session slug. */
  reapOrphans(): void {
    const ownedTerms = new Set(
      [...this.inflight.values()].map((f) => f.terminalId).filter(Boolean),
    );
    void reapTransientByLabel(this.deps.herdr, MERGE_LABEL, ownedTerms, "[merge]");
  }

  /** Finalize any run whose output file is ready or that timed out, then drain the queue. */
  async tick(): Promise<void> {
    for (const f of [...this.inflight.values()]) {
      if (f.finalizing) continue;
      const raw = this.readOutput(f.dir);
      const timedOut = this.now() - f.startedAt > this.timeoutMs;
      if (!raw && !timedOut) continue;
      f.finalizing = true;
      this.finalize(f, raw);
      this.inflight.delete(f.key);
    }
    while (this.inflight.size < this.maxConcurrent && this.queue.length) {
      const e = this.queue.shift()!;
      this.queued.delete(e.key);
      // Re-read the current active set for the queued scope so a stale snapshot isn't used.
      // Await so the spawn + its inflight slot land before the loop re-checks capacity.
      if (e.kind === "cross") await this.considerCrossRepo();
      else if (e.repoPath) await this.mergeNow(e.repoPath);
    }
  }

  private finalize(f: InFlight, raw: RawOutput | null): void {
    let created = 0;
    if (raw !== null) {
      created = f.kind === "cross" ? this.applyCross(f, raw) : this.applyIntra(f, raw);
      this.recordHealthSuccess();
      // Stamp the processed signature so we don't re-spawn until the active set changes.
      this.deps.store.setMergePassSignature(f.key, f.sig);
    } else {
      this.recordHealthFailure(f.key, "timeout-no-output");
    }
    void this.deps.herdr.stop(f.terminalId).catch(() => {});
    this.deps.scratch.remove(f.dir);
    if (created > 0) this.deps.onChange();
  }

  private rawGroups(raw: RawOutput): RawGroup[] {
    return Array.isArray(raw.groups) ? (raw.groups as RawGroup[]) : [];
  }

  /** Member ids cited by a group that are present in this run AND still active. */
  private validMembers(f: InFlight, g: RawGroup): Learning[] {
    const ids = Array.isArray(g.memberIds)
      ? g.memberIds.filter((x): x is string => typeof x === "string")
      : [];
    const seen = new Set<string>();
    const out: Learning[] = [];
    for (const id of ids) {
      if (seen.has(id) || !f.members.has(id)) continue;
      seen.add(id);
      const cur = this.deps.store.getLearning(id);
      if (cur && cur.status === "active") out.push(cur);
    }
    return out;
  }

  private applyIntra(f: InFlight, raw: RawOutput): number {
    const repoPath = f.repoPath!;
    const seen = this.deps.store.mergeSuggestionSignatures({ kind: "intra", repoPath });
    let created = 0;
    for (const g of this.rawGroups(raw)) {
      if (created >= MAX_GROUPS_PER_RUN) break;
      if (this.addIntraGroup(f, g, repoPath, seen)) created++;
    }
    return created;
  }

  /** Validate + persist one intra group; returns true when a suggestion was added. */
  private addIntraGroup(f: InFlight, g: RawGroup, repoPath: string, seen: Set<string>): boolean {
    const members = this.validMembers(f, g);
    if (members.length < 2) return false;
    const mergedRule = typeof g.mergedRule === "string" ? g.mergedRule.trim().slice(0, 240) : "";
    if (!mergedRule) return false;
    const survivor = pickSurvivor(members, typeof g.anchorId === "string" ? g.anchorId : undefined);
    const sources = members.filter((m) => m.id !== survivor.id).map((m) => m.id);
    if (sources.length === 0) return false;
    const sig = this.sigOf([survivor.id, ...sources]);
    if (seen.has(sig)) return false;
    seen.add(sig);
    this.deps.store.addMergeSuggestion({
      kind: "intra",
      repoPath,
      targetId: survivor.id,
      sourceIds: sources,
      mergedRule,
      mergedRationale:
        typeof g.mergedRationale === "string" ? g.mergedRationale.trim().slice(0, 500) : "",
      repoPaths: null,
      signature: sig,
    });
    return true;
  }

  private applyCross(f: InFlight, raw: RawOutput): number {
    const seen = this.deps.store.mergeSuggestionSignatures({ kind: "cross" });
    let created = 0;
    for (const g of this.rawGroups(raw)) {
      if (created >= MAX_GROUPS_PER_RUN) break;
      const members = this.validMembers(f, g);
      const repos = new Set(members.map((m) => m.repoPath));
      if (members.length < 2 || repos.size < 2) continue; // must recur across ≥2 repos
      const canonical =
        typeof g.canonicalRule === "string" && g.canonicalRule.trim()
          ? g.canonicalRule.trim().slice(0, 240)
          : members[0]!.rule;
      const sig = this.sigOf(members.map((m) => m.id));
      if (seen.has(sig)) continue;
      seen.add(sig);
      this.deps.store.addMergeSuggestion({
        kind: "cross",
        repoPath: null,
        targetId: null,
        sourceIds: members.map((m) => m.id),
        mergedRule: canonical,
        mergedRationale: "",
        repoPaths: [...repos],
        signature: sig,
      });
      created++;
    }
    return created;
  }
}

/** Deterministic survivor: the LLM's anchor if it is a member, else the most-established
 *  member (highest injectedCount), tie-broken by earliest createdAt. Since the merge resets
 *  nothing (counters are preserved by mergeLearning), keeping the most-exercised member as the
 *  survivor makes the carried-forward record the most representative one. */
export function pickSurvivor(members: Learning[], anchorId?: string): Learning {
  if (anchorId) {
    const anchor = members.find((m) => m.id === anchorId);
    if (anchor) return anchor;
  }
  return [...members].sort(
    (a, b) => b.injectedCount - a.injectedCount || a.createdAt - b.createdAt,
  )[0]!;
}

/** Cheap programmatic shortlist for the cross-repo pass: keep only rules that have a
 *  near-twin in a DIFFERENT repo (a recurrence is impossible for a rule unique to one repo).
 *  Exact normalized-text match OR token-set Jaccard ≥ 0.6 across repos qualifies. Caps the
 *  result at `max`, reporting how many were dropped (no silent truncation). */
export function crossRepoShortlist(
  rules: Learning[],
  max: number,
): { shortlist: Learning[]; dropped: number } {
  const tokens = (s: string): Set<string> =>
    new Set(
      normalizeRule(s)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4),
    );
  const toks = rules.map((r) => tokens(r.rule));
  const norm = rules.map((r) => normalizeRule(r.rule));
  const keep: boolean[] = new Array(rules.length).fill(false);
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      if (rules[i]!.repoPath === rules[j]!.repoPath) continue; // need a CROSS-repo twin
      const twin = norm[i]! === norm[j]! || jaccard(toks[i]!, toks[j]!) >= 0.6;
      if (twin) {
        keep[i] = true;
        keep[j] = true;
      }
    }
  }
  const shortlist = rules.filter((_, i) => keep[i]);
  if (shortlist.length <= max) return { shortlist, dropped: 0 };
  return { shortlist: shortlist.slice(0, max), dropped: shortlist.length - max };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function intraPrompt(): string {
  return [
    "You are a house-rules librarian. Read `rules.json` in this directory: an array of",
    "active rules, each `{id, repo, rule}`, all from ONE repository.",
    "",
    "Find groups of rules that are near-duplicates or where one SUBSUMES another — i.e. they",
    "give the SAME guidance about the SAME target, just worded differently or at different",
    "detail. Propose consolidating each such group into a single richer rule.",
    "",
    "MULTI-VALUED GUARD: never group rules whose target (file / category / object) DIFFERS,",
    "even if the topic is similar. A UI rule and a migration rule about the same feature must",
    "stay separate. Only TRULY redundant rules belong in one group. When unsure, do not group.",
    "",
    "For each group emit `{memberIds:[ids], anchorId, mergedRule, mergedRationale}` where:",
    "  memberIds — 2+ ids from rules.json that should consolidate;",
    "  anchorId  — the member whose phrasing/scope best anchors the merged rule;",
    "  mergedRule — the consolidated rule, an imperative ≤240 chars covering all members;",
    "  mergedRationale — one sentence on why they are the same guidance.",
    "Cite only ids present in rules.json — never invent ids. At most 8 groups.",
    "",
    `Write JSON to \`${OUTPUT_FILE}\` shaped exactly:`,
    '{"groups":[{"memberIds":["id1","id2"],"anchorId":"id1","mergedRule":"...","mergedRationale":"..."}]}',
    'If no rules should merge, write {"groups":[]}. Do not write anything else.',
  ].join("\n");
}

function crossPrompt(): string {
  return [
    "You are a house-rules librarian. Read `rules.json` in this directory: an array of",
    "active rules, each `{id, repo, rule}`, drawn from MANY repositories.",
    "",
    "Find rules that recur across DIFFERENT repositories — the SAME guidance appearing in",
    "two or more repos (worded the same or nearly so). These are candidates to promote to a",
    "user-global rule. Only group rules that genuinely say the same thing AND come from at",
    "least two distinct `repo` values. When unsure, do not group.",
    "",
    "For each recurring rule emit `{memberIds:[ids], canonicalRule}` where memberIds are the",
    "2+ ids (across different repos) and canonicalRule is the best single phrasing (≤240 chars).",
    "Cite only ids present in rules.json — never invent ids. At most 8 groups.",
    "",
    `Write JSON to \`${OUTPUT_FILE}\` shaped exactly:`,
    '{"groups":[{"memberIds":["id1","id2"],"canonicalRule":"..."}]}',
    'If nothing recurs across repos, write {"groups":[]}. Do not write anything else.',
  ].join("\n");
}

function defaultWriteRules(dir: string, rules: { id: string; repo: string; rule: string }[]): void {
  writeFileSync(join(dir, RULES_FILE), JSON.stringify(rules, null, 2));
}

function defaultReadOutput(dir: string): RawOutput | null {
  const p = join(dir, OUTPUT_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RawOutput;
  } catch {
    return null; // partial write; retry next tick
  }
}

/** Throwaway temp dir (the pass needs no git, only Read/Write). */
export const defaultMergeScratch = {
  create: () => ({ dir: mkdtempSync(join(tmpdir(), "shepherd-merge-")) }),
  remove: (dir: string) => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  },
};
