import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionStore } from "./store";
import type { HerdrDriver } from "./herdr";
import { HerdrUnavailableError } from "./herdr";
import type { Promoter } from "./promote";
import {
  isApiKeyMode,
  isApiKeyConfigured,
  apiKeySettingsFragment,
  apiKeyPassthroughEnv,
} from "./spawn-auth";

const INPUT_FILE = "input.json";
const OUTPUT_FILE = "optimized.json";

/**
 * Prefix for ephemeral optimizer agent names. Each run appends the first 8 chars of its
 * session UUID so concurrent runs for different repos never collide on the same herdr name
 * (`agent_name_taken`). The underscores are load-bearing: prompt-derived session slugs are
 * `[a-z0-9-]` only (see namer.ts), so no real session can collide. The orphan-tab reaper
 * matches tabs whose name starts with this prefix — a bare "optimize" would NOT be safe.
 * Mirrors `DISTILL_LABEL` in distiller.ts.
 */
export const OPTIMIZE_LABEL = "__optimize__";

const HEALTH_FAILURE_THRESHOLD = 3;

/** One flagged rule handed to the optimizer agent, with its failure evidence. */
export interface OptimizerTarget {
  id: string;
  rule: string;
  rationale: string;
  failures: { kind: string; payload: string }[];
}

/** Raw shape of the agent's `optimized.json` (all fields untrusted). */
export interface RawOptimized {
  revisions?: { id?: unknown; rule?: unknown; rationale?: unknown }[];
}

interface InFlight {
  repoPath: string;
  dir: string;
  terminalId: string;
  startedAt: number;
  finalizing?: boolean;
  /** Rule ids this run may revise — any revision with an id outside this set is ignored. */
  targetIds: Set<string>;
  /** Subset of targetIds whose status was `promoted` at enqueue time — drives resyncPromoted. */
  promotedIds: Set<string>;
}

export interface OptimizerDeps {
  store: Pick<
    SessionStore,
    "getLearning" | "listActiveLearnings" | "ineffectiveSignalsFor" | "reviseLearning"
  >;
  herdr: Pick<HerdrDriver, "start" | "stop" | "list" | "closeTab">;
  scratch: { create: () => { dir: string }; remove: (dir: string) => void };
  promoter: Pick<Promoter, "resyncPromoted">;
  onChange: () => void;
  model?: string | null;
  now?: () => number;
  timeoutMs?: number; // default 10*60*1000 (match distiller)
  maxConcurrent?: number; // default 3
  writeInput?: (dir: string, targets: OptimizerTarget[]) => void;
  readOutput?: (dir: string) => RawOptimized | null;
}

/**
 * Operator-triggered LLM pass that rewrites flagged ("not working") house rules using
 * their failure evidence, applies the rewrites in place (clearing the flag), and opens a
 * CLAUDE.md sync PR for any revised *promoted* rule. A faithful sibling of
 * {@link DistillerService} — same inflight/queue/tick/finalize/health shape and the same
 * hard-won read-only claude spawn contract. NEVER runs on a timer inside the service.
 */
export class OptimizerService {
  private inflight = new Map<string, InFlight>();
  private queue: { repoPath: string; ids: string[] }[] = [];
  private queued = new Set<string>();
  private maxConcurrent: number;
  private now: () => number;
  private timeoutMs: number;
  private writeInput: NonNullable<OptimizerDeps["writeInput"]>;
  private readOutput: (dir: string) => RawOptimized | null;
  private healthFailures = 0;
  private lastFailure: { reason: string; at: number; repoPath: string } | null = null;

  constructor(private deps: OptimizerDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000;
    this.maxConcurrent = deps.maxConcurrent ?? 3;
    this.writeInput = deps.writeInput ?? defaultWriteInput;
    this.readOutput = deps.readOutput ?? defaultReadOutput;
  }

  health(): {
    ok: boolean;
    consecutiveFailures: number;
    lastFailure: { reason: string; at: number; repoPath: string } | null;
  } {
    return {
      ok: this.healthOk(),
      consecutiveFailures: this.healthFailures,
      lastFailure: this.lastFailure,
    };
  }

  private healthOk(): boolean {
    return this.healthFailures < HEALTH_FAILURE_THRESHOLD;
  }

  private recordHealthFailure(repoPath: string, reason: string): void {
    this.healthFailures++;
    this.lastFailure = { reason, at: this.now(), repoPath };
    // Emit on the ok→unhealthy transition AND on every further failure while unhealthy,
    // so an already-open drawer keeps a fresh consecutiveFailures count.
    if (!this.healthOk()) this.deps.onChange();
  }

  private recordHealthSuccess(): void {
    const wasUnhealthy = !this.healthOk();
    this.healthFailures = 0;
    this.lastFailure = null;
    if (wasUnhealthy) this.deps.onChange();
  }

  /** Optimize a single flagged rule by id. No-op when missing, not active/promoted, or
   *  not actually flagged. Scopes the input + applied revisions to JUST this id. */
  optimizeOne(id: string): void {
    const l = this.deps.store.getLearning(id);
    if (!l) return;
    if (l.status !== "active" && l.status !== "promoted") return;
    if (l.ineffectiveCount <= 0) return;
    this.enqueueOrBegin(l.repoPath, [id]);
  }

  /** Optimize every flagged (ineffectiveCount > 0) active/promoted rule in a repo. */
  optimizeAllFlagged(repoPath: string): void {
    const flagged = this.deps.store
      .listActiveLearnings(repoPath)
      .filter((l) => l.ineffectiveCount > 0)
      .map((l) => l.id);
    if (flagged.length === 0) return;
    this.enqueueOrBegin(repoPath, flagged);
  }

  private enqueueOrBegin(repoPath: string, ids: string[]): void {
    if (this.inflight.has(repoPath) || this.queued.has(repoPath)) return;
    if (this.inflight.size < this.maxConcurrent) {
      this.begin(repoPath, ids);
    } else {
      this.queue.push({ repoPath, ids });
      this.queued.add(repoPath);
    }
  }

  /** Resolve the target rules for a run: only rules still active/promoted AND still flagged
   *  survive. Returns the agent-input targets plus the id-guard sets. */
  private resolveTargets(ids: string[]): {
    targets: OptimizerTarget[];
    targetIds: Set<string>;
    promotedIds: Set<string>;
  } {
    const targets: OptimizerTarget[] = [];
    const targetIds = new Set<string>();
    const promotedIds = new Set<string>();
    for (const id of ids) {
      const l = this.deps.store.getLearning(id);
      if (!l || (l.status !== "active" && l.status !== "promoted")) continue;
      if (l.ineffectiveCount <= 0) continue;
      targets.push({
        id: l.id,
        rule: l.rule,
        rationale: l.rationale,
        failures: this.deps.store
          .ineffectiveSignalsFor(id)
          .map((s) => ({ kind: s.kind, payload: s.payload })),
      });
      targetIds.add(l.id);
      if (l.status === "promoted") promotedIds.add(l.id);
    }
    return { targets, targetIds, promotedIds };
  }

  /** Build the read-only claude argv (same hard-won contract as the critic/distiller).
   *  Read-only optimizer (src/review.ts:begin, src/distiller.ts:begin). NOT
   *  --dangerously-skip-permissions: it reads untrusted agent/repo text. dontAsk MUST be
   *  last (after the variadic --allowedTools) so the trailing prompt isn't swallowed. Bare
   *  Write only. Subscription OAuth (NOT --bare); in api-key auth mode the key arrives via
   *  apiKeyHelper in --settings (folded in) + a credential-less CLAUDE_CONFIG_DIR. */
  private buildArgv(sessionId: string): string[] {
    const argv = [
      "claude",
      "--session-id",
      sessionId,
      "--settings",
      // subscription → byte-identical `{"disableAllHooks":true}`; api-key folds in apiKeyHelper.
      JSON.stringify({ disableAllHooks: true, ...apiKeySettingsFragment() }),
      "--disable-slash-commands",
      "--allowedTools",
      "Read",
      "Grep",
      "Glob",
      "Write",
    ];
    if (this.deps.model) argv.push("--model", this.deps.model);
    argv.push("--permission-mode", "dontAsk");
    argv.push(optimizePrompt());
    return argv;
  }

  private begin(repoPath: string, ids: string[]): void {
    const { dir } = this.deps.scratch.create();
    // Fail closed: api-key mode without a configured key must NOT bill the subscription.
    if (isApiKeyMode() && !isApiKeyConfigured()) {
      console.warn(
        "[optimize] api-key mode enabled but no API key configured — skipping (fail closed, not billing subscription)",
      );
      this.deps.scratch.remove(dir);
      return;
    }
    const { targets, targetIds, promotedIds } = this.resolveTargets(ids);
    if (targets.length === 0) {
      this.deps.scratch.remove(dir);
      return;
    }
    try {
      this.writeInput(dir, targets);
    } catch (err) {
      console.warn(`[optimize] write input failed for ${repoPath}:`, err);
      this.deps.scratch.remove(dir);
      this.recordHealthFailure(repoPath, "write");
      return;
    }
    const sessionId = randomUUID();
    const agentName = OPTIMIZE_LABEL + sessionId.slice(0, 8);
    const argv = this.buildArgv(sessionId);
    let terminalId: string;
    try {
      terminalId = this.deps.herdr.start(
        agentName,
        dir,
        argv,
        apiKeyPassthroughEnv(false),
      ).terminalId;
    } catch (err) {
      if (err instanceof HerdrUnavailableError) {
        console.warn(`[optimize] herdr unavailable for ${repoPath}:`, err);
      } else {
        console.warn(`[optimize] spawn failed for ${repoPath}:`, err);
        this.recordHealthFailure(repoPath, "spawn");
      }
      this.deps.scratch.remove(dir);
      return;
    }
    this.inflight.set(repoPath, {
      repoPath,
      dir,
      terminalId,
      startedAt: this.now(),
      targetIds,
      promotedIds,
    });
  }

  /** Boot reconcile (issue #1135): close orphaned optimizer tabs left by a PRIOR server
   *  lifetime. `inflight` is memory-only, so a restart loses tracking of live runs; the
   *  spawned interactive `claude` idles at the prompt forever after writing its output
   *  (agent_status "done" = finished-turn, pane alive), and the husk-only tab reaper
   *  (tab-reaper.ts) spares it as an alive (non-shell) `claude`. Scan herdr once for agents
   *  whose name starts with OPTIMIZE_LABEL and are NOT owned by a current-process inflight
   *  run, and close their tabs. Name-based — no persisted state (the issue's preferred
   *  approach); the prefix's underscores can't appear in a real session slug. */
  reapOrphans(): void {
    const ownedTerms = new Set(
      [...this.inflight.values()].map((f) => f.terminalId).filter(Boolean),
    );
    let reaped = 0;
    try {
      for (const a of this.deps.herdr.list()) {
        if (!a.name.startsWith(OPTIMIZE_LABEL)) continue;
        if (ownedTerms.has(a.terminalId)) continue; // spare a live run started by THIS process
        this.deps.herdr.closeTab(a.tabId);
        reaped++;
      }
    } catch (err) {
      console.warn("[optimize] reapOrphans:", err); // herdr may be unavailable at boot — no-op
    }
    if (reaped > 0) console.warn(`[optimize] reapOrphans: closed ${reaped} orphan tab(s)`);
  }

  /** Finalize any run whose output file is ready or that timed out, then drain queue. */
  async tick(): Promise<void> {
    for (const f of [...this.inflight.values()]) {
      if (f.finalizing) continue;
      const raw = this.readOutput(f.dir);
      const timedOut = this.now() - f.startedAt > this.timeoutMs;
      if (!raw && !timedOut) continue;
      f.finalizing = true;
      this.finalize(f, raw);
      this.inflight.delete(f.repoPath);
    }
    // Drain queue: each finalized run frees a slot.
    while (this.inflight.size < this.maxConcurrent && this.queue.length) {
      const e = this.queue.shift()!;
      this.queued.delete(e.repoPath);
      this.begin(e.repoPath, e.ids);
    }
  }

  private finalize(f: InFlight, raw: RawOptimized | null): void {
    const { revised, promotedRevised } = this.applyRevisions(f, raw);
    this.deps.herdr.stop(f.terminalId);
    this.deps.scratch.remove(f.dir);
    if (raw !== null) {
      this.recordHealthSuccess();
    } else {
      this.recordHealthFailure(f.repoPath, "timeout-no-output");
    }
    // A revised promoted rule changes CLAUDE.md → open a sync PR, but never block the
    // tick on it (and a sync failure must not crash the loop).
    if (promotedRevised) {
      void this.deps.promoter
        .resyncPromoted(f.repoPath)
        .catch((err) => console.warn("[optimize] resync failed for", f.repoPath, err));
    }
    if (revised > 0) this.deps.onChange();
  }

  /** Apply the agent's revisions in place (clearing the flag). Honors the id-guard:
   *  only ids in `f.targetIds` are touched; a non-empty `rule` string is required.
   *  Returns the applied count and whether any revised id was promoted. */
  private applyRevisions(
    f: InFlight,
    raw: RawOptimized | null,
  ): { revised: number; promotedRevised: boolean } {
    const entries = Array.isArray(raw?.revisions) ? raw!.revisions : [];
    let revised = 0;
    let promotedRevised = false;
    for (const e of entries) {
      const r = coerceRevision(e);
      if (!r || !f.targetIds.has(r.id)) continue;
      if (this.deps.store.reviseLearning(r.id, r.rule, r.rationale)) {
        revised++;
        if (f.promotedIds.has(r.id)) promotedRevised = true;
      }
    }
    return { revised, promotedRevised };
  }
}

/** Validate one raw revision entry → {id, rule, rationale} or null (bad shape / blank rule). */
function coerceRevision(e: {
  id?: unknown;
  rule?: unknown;
  rationale?: unknown;
}): { id: string; rule: string; rationale?: string } | null {
  const id = typeof e?.id === "string" ? e.id : undefined;
  if (!id) return null;
  if (typeof e.rule !== "string" || !e.rule.trim()) return null;
  const rationale = typeof e.rationale === "string" ? e.rationale : undefined;
  return { id, rule: e.rule, rationale };
}

function optimizePrompt(): string {
  return [
    `You are a house-rule editor. Read \`${INPUT_FILE}\` in this directory.`,
    'It is a JSON object `{ "targets": [{ "id", "rule", "rationale", "failures": [{ "kind", "payload" }] }] }`.',
    "Each target is a standing house rule for one repository that FAILED to prevent a mistake;",
    "`failures` are the signals (critic findings / blocks / corrections) showing it failing.",
    "For each target, produce a STRONGER, more specific imperative rewrite (<=160 chars) that",
    "would have prevented those failures — keep the same intent, make it concrete and actionable.",
    "Optionally refine the rationale. Preserve each target's `id` EXACTLY; do not invent ids or",
    "add targets. If a rule genuinely cannot be improved, omit it.",
    `Write your output as JSON to \`${OUTPUT_FILE}\` in this directory, shaped exactly:`,
    '{"revisions": [{"id": "<id>", "rule": "<=160 char imperative", "rationale": "why (optional)"}]}',
    "Write nothing else.",
  ].join("\n");
}

function defaultWriteInput(dir: string, targets: OptimizerTarget[]): void {
  writeFileSync(join(dir, INPUT_FILE), JSON.stringify({ targets }, null, 2));
}

function defaultReadOutput(dir: string): RawOptimized | null {
  const p = join(dir, OUTPUT_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RawOptimized;
  } catch {
    return null; // partial write; retry next tick
  }
}

/** Default scratch dir: a throwaway temp dir (the optimizer needs no git, only Read/Write). */
export const defaultOptimizerScratch = {
  create: () => ({ dir: mkdtempSync(join(tmpdir(), "shepherd-optimize-")) }),
  remove: (dir: string) => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  },
};
