import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionStore } from "./store";
import type { HerdrDriver } from "./herdr";
import type { Signal } from "./types";

const PROPOSALS_FILE = ".shepherd-learnings.json";

interface RawRule {
  rule?: unknown;
  rationale?: unknown;
  evidence?: unknown;
}
interface RawProposals {
  rules?: unknown;
  ineffective?: unknown;
}

interface InFlight {
  repoPath: string;
  dir: string;
  terminalId: string;
  startedAt: number;
  finalizing?: boolean;
}

export interface DistillerDeps {
  store: Pick<
    SessionStore,
    | "listSignals"
    | "addLearning"
    | "listLearnings"
    | "listActiveLearnings"
    | "getRepoConfig"
    | "incrementLearningIneffective"
  >;
  herdr: Pick<HerdrDriver, "start" | "stop">;
  scratch: { create: () => { dir: string }; remove: (dir: string) => void };
  onChange: () => void;
  model?: string | null;
  now?: () => number;
  timeoutMs?: number;
  windowMs?: number; // how far back to read signals (default 60d)
  minSignals?: number; // threshold for consider() (default 5)
  writeSignals?: (
    dir: string,
    signals: Signal[],
    existingRules: string[],
    activeRules: { id: string; rule: string }[],
  ) => void;
  readProposals?: (dir: string) => RawProposals | null;
}

export class DistillerService {
  private inflight = new Map<string, InFlight>();
  private now: () => number;
  private timeoutMs: number;
  private windowMs: number;
  private minSignals: number;
  private writeSignals: NonNullable<DistillerDeps["writeSignals"]>;
  private readProposals: (dir: string) => RawProposals | null;

  constructor(private deps: DistillerDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000;
    this.windowMs = deps.windowMs ?? 60 * 24 * 60 * 60 * 1000;
    this.minSignals = deps.minSignals ?? 5;
    this.writeSignals = deps.writeSignals ?? defaultWriteSignals;
    this.readProposals = deps.readProposals ?? defaultReadProposals;
  }

  /** Start a distill run for `repoPath` if enough recent signals exist and none is in flight. */
  consider(repoPath: string): void {
    if (this.inflight.has(repoPath)) return;
    if (!this.deps.store.getRepoConfig(repoPath).learningsEnabled) return;
    const since = this.now() - this.windowMs;
    const signals = this.deps.store.listSignals(repoPath, { sinceTs: since });
    if (signals.length < this.minSignals) return;
    this.begin(repoPath, signals);
  }

  /** Force a distill run regardless of the signal threshold (manual trigger).
   *  Still requires at least one signal — nothing to distill from otherwise. */
  distillNow(repoPath: string): void {
    if (this.inflight.has(repoPath)) return;
    const since = this.now() - this.windowMs;
    const signals = this.deps.store.listSignals(repoPath, { sinceTs: since });
    if (signals.length === 0) return;
    this.begin(repoPath, signals);
  }

  private begin(repoPath: string, signals: Signal[]): void {
    const { dir } = this.deps.scratch.create();
    // Include dismissed rules in the "do NOT repeat" list: finalize() drops any
    // re-proposal of a known rule anyway, so omitting dismissed ones just wastes
    // a proposal slot + tokens re-suggesting something the operator already rejected.
    const existing = this.deps.store.listLearnings(repoPath).map((l) => l.rule);
    const activeRules = this.deps.store
      .listActiveLearnings(repoPath)
      .map((l) => ({ id: l.id, rule: l.rule }));
    try {
      this.writeSignals(dir, signals, existing, activeRules);
    } catch (err) {
      console.warn(`[distill] write signals failed for ${repoPath}:`, err);
      this.deps.scratch.remove(dir);
      return;
    }
    // Read-only distiller — same hard-won spawn contract as the critic
    // (src/review.ts:begin). NOT --dangerously-skip-permissions: it reads
    // untrusted agent/repo text. dontAsk MUST be last (after the variadic
    // --allowedTools) so the trailing prompt isn't swallowed. Bare Write only.
    const argv = [
      "claude",
      "--session-id",
      randomUUID(),
      "--settings",
      '{"disableAllHooks":true}',
      "--disable-slash-commands",
      "--allowedTools",
      "Read",
      "Grep",
      "Glob",
      "Write",
    ];
    if (this.deps.model) argv.push("--model", this.deps.model);
    argv.push("--permission-mode", "dontAsk");
    argv.push(distillPrompt());
    let terminalId: string;
    try {
      terminalId = this.deps.herdr.start("distill", dir, argv).terminalId;
    } catch (err) {
      console.warn(`[distill] spawn failed for ${repoPath}:`, err);
      this.deps.scratch.remove(dir);
      return;
    }
    this.inflight.set(repoPath, { repoPath, dir, terminalId, startedAt: this.now() });
  }

  /** Finalize any run whose proposals file is ready or that timed out. */
  async tick(): Promise<void> {
    for (const f of [...this.inflight.values()]) {
      if (f.finalizing) continue;
      const raw = this.readProposals(f.dir);
      const timedOut = this.now() - f.startedAt > this.timeoutMs;
      if (!raw && !timedOut) continue;
      f.finalizing = true;
      this.finalize(f, raw);
      this.inflight.delete(f.repoPath);
    }
  }

  private finalize(f: InFlight, raw: RawProposals | null): void {
    const added = this.applyProposals(f.repoPath, raw);
    const flagged = this.applyIneffective(f.repoPath, raw);
    this.deps.herdr.stop(f.terminalId);
    this.deps.scratch.remove(f.dir);
    if (added > 0 || flagged > 0) this.deps.onChange();
  }

  /** Persist new (deduped) proposed rules from the distiller's output. Returns the count added. */
  private applyProposals(repoPath: string, raw: RawProposals | null): number {
    let added = 0;
    const have = new Set(this.deps.store.listLearnings(repoPath).map((l) => normalizeRule(l.rule)));
    const rules = Array.isArray(raw?.rules) ? (raw!.rules as RawRule[]) : [];
    for (const r of rules) {
      if (typeof r?.rule !== "string" || !r.rule.trim()) continue;
      const key = normalizeRule(r.rule);
      if (have.has(key)) continue;
      have.add(key);
      this.deps.store.addLearning({
        repoPath,
        rule: r.rule.trim().slice(0, 240),
        rationale: typeof r.rationale === "string" ? r.rationale : "",
        evidence: Array.isArray(r.evidence)
          ? r.evidence.filter((e): e is string => typeof e === "string")
          : [],
      });
      added++;
    }
    return added;
  }

  /** Bump ineffectiveCount for any active rule the distiller cited as not working. Returns the count flagged. */
  private applyIneffective(repoPath: string, raw: RawProposals | null): number {
    let flagged = 0;
    const activeIds = new Set(this.deps.store.listActiveLearnings(repoPath).map((l) => l.id));
    const ineffective = Array.isArray(raw?.ineffective) ? raw!.ineffective : [];
    for (const id of ineffective) {
      if (typeof id !== "string" || !activeIds.has(id)) continue;
      if (this.deps.store.incrementLearningIneffective(id)) flagged++;
    }
    return flagged;
  }
}

function normalizeRule(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function distillPrompt(): string {
  return [
    "You are a code-review pattern analyst. Read `signals.json` in this directory.",
    "It is a JSON object with three fields: `signals` — an array of past corrections, blocks,",
    "stalls, and critic findings for one repository; `existingRules` — an array of rules",
    "already recorded or previously dismissed (do NOT repeat any of these);",
    "and `activeRules` — an array of currently-active house rules as {id, rule} objects.",
    "If a NEW signal shows an activeRule was violated or did not prevent the mistake,",
    "add its id to an `ineffective` array (the rule is not working — flag it).",
    "Identify RECURRING, actionable mistakes worth a standing house rule for future agents.",
    "Ignore one-off noise. Write at most 5 crisp imperative rules.",
    `Write your output as JSON to \`${PROPOSALS_FILE}\` in this directory, shaped exactly:`,
    '{"rules": [{"rule": "<=160 char imperative", "rationale": "why", "evidence": ["signalId", ...]}], "ineffective": ["activeRuleId", ...]}',
    'If nothing recurs, write {"rules": [], "ineffective": []}. Do not write anything else.',
  ].join("\n");
}

function defaultWriteSignals(
  dir: string,
  signals: Signal[],
  existingRules: string[],
  activeRules: { id: string; rule: string }[],
): void {
  const payload = {
    signals: signals.map((s) => ({ kind: s.kind, payload: s.payload, ts: s.ts, id: s.id })),
    existingRules,
    activeRules,
  };
  writeFileSync(join(dir, "signals.json"), JSON.stringify(payload, null, 2));
}

function defaultReadProposals(dir: string): RawProposals | null {
  const p = join(dir, PROPOSALS_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RawProposals;
  } catch {
    return null; // partial write; retry next tick
  }
}

/** Default scratch dir: a throwaway temp dir (the distiller needs no git, only Read/Write). */
export const defaultScratch = {
  create: () => ({ dir: mkdtempSync(join(tmpdir(), "shepherd-distill-")) }),
  remove: (dir: string) => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  },
};
