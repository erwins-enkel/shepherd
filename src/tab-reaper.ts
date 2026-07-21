import { join } from "node:path";
import type { HerdrDriver } from "./herdr";
import { PROBE_NAME } from "./usage-probe";
import { DISTILL_LABEL } from "./distiller";
import { OPTIMIZE_LABEL } from "./optimizer";
import { MERGE_LABEL } from "./merge-suggest";
import { AUTOPILOT_LABEL } from "./autopilot";
import { NAMER_LABEL } from "./namer";
import { RECOMMEND_LABEL } from "./prompt-recommend";
import { VERIFY_KEY_LABEL } from "./verify-key";
import { SHELLS } from "./json-tolerant";

export type ReapableHerdr = Pick<HerdrDriver, "closeTab" | "panes" | "paneForegroundProcs">;

/** Labels shepherd authors for its short-lived helper agents. A tab with one of these
 *  labels but no live agent is an orphaned husk (the probe/critic ended without its tab
 *  being closed — e.g. a shepherd restart cleared the in-memory tracking).
 *
 *  **Scope filter, not a safety gate.** This function is a first-pass scope filter; the
 *  caller's process-liveness check (a live agent in `herdr list`) is the actual safety gate.
 *  This matters for the one exact match with no space — `"rundown"` — which IS a producible
 *  user slug. It is safe only because `reapOrphanTabs` never reaps a tab that has a live
 *  backing agent; a running user "rundown" session is therefore never touched.
 *
 *  **Collision-proof markers** (space-prefix or underscore): {@link PROBE_NAME},
 *  {@link DISTILL_LABEL} and {@link OPTIMIZE_LABEL} contain underscores; every other helper uses a space-prefixed
 *  label ({@link NAMER_LABEL}, {@link AUTOPILOT_LABEL}, and the still-inline `"review "`,
 *  `"plan-review "`, `"pr-critic "`, `"recap "`) or a multi-word exact phrase
 *  ({@link VERIFY_KEY_LABEL}). User sessions use prompt-derived `[a-z0-9-]` slugs — no spaces,
 *  no underscores — so none of these labels is reachable by a slug. Exception: `"rundown"`
 *  (exact, no space) relies on the liveness gate instead.
 *
 *  Labels are named by CONSTANT wherever one exists, never spelled out as a string here: a
 *  renamed label would otherwise leave this comment describing a dead value — the same
 *  producer↔consumer desync the constants themselves exist to prevent (#1147). The remaining
 *  quoted literals above/below are the labels still inlined at their spawn sites; if one of
 *  those gains a constant, reference it here too.
 *
 *  The distiller and optimizer each spawn under a UNIQUE per-run name of the form
 *  `__distill__<8hex>` / `__optimize__<8hex>` (prefixes `DISTILL_LABEL` / `OPTIMIZE_LABEL`),
 *  matched here by prefix. The prefix ends in `__`, which `[a-z0-9-]` slugs can never
 *  produce, so the prefix match stays collision-proof. The per-pane liveness check remains
 *  the actual safety gate.
 *
 *  Helpers covered (named by constant where one exists — see the note above):
 *  - {@link PROBE_NAME}        — usage probe
 *  - {@link DISTILL_LABEL}`<hex>`  — distiller (prefix match, unique per run)
 *  - {@link OPTIMIZE_LABEL}`<hex>` — rule optimizer (prefix match, unique per run)
 *  - {@link MERGE_LABEL}`<hex>`    — background merge-suggestion pass (prefix, unique per run)
 *  - {@link NAMER_LABEL}`<desig>`  — background LLM namer (namer.ts)
 *  - {@link AUTOPILOT_LABEL}`<id>` — autopilot stop-classifier (autopilot-llm.ts)
 *  - {@link VERIFY_KEY_LABEL}      — API-key verifier (verify-key.ts)
 *  - `review <desig>`    — critic / code-review spawns
 *  - `plan-review <desig>` — plan-gate reviewer (plan-gate.ts)
 *  - `pr-critic <repo>#<n>` — standalone PR critic (standalone-critic.ts)
 *  - `recap <desig>`     — recap generator (recap.ts)
 *  - {@link RECOMMEND_LABEL}`<desig>` — prompt recommender (prompt-recommend.ts, #1852)
 *  - `rundown`           — herd-digest rundown (herd-digest.ts) — liveness-gated */
export function isShepherdHelperLabel(label: string): boolean {
  return (
    label === PROBE_NAME ||
    label.startsWith(DISTILL_LABEL) ||
    label.startsWith(OPTIMIZE_LABEL) ||
    label.startsWith(MERGE_LABEL) ||
    label === "rundown" ||
    label === VERIFY_KEY_LABEL ||
    label.startsWith("review ") ||
    label.startsWith(NAMER_LABEL) ||
    label.startsWith("plan-review ") ||
    label.startsWith("pr-critic ") ||
    label.startsWith("recap ") ||
    label.startsWith(RECOMMEND_LABEL) ||
    label.startsWith(AUTOPILOT_LABEL)
  );
}

// SHELLS is defined in json-tolerant.ts and imported above — single source of truth.

/** Breakdown of one reconciliation sweep. */
export interface ReapResult {
  /** Tab ids actually closed this sweep. */
  closed: string[];
  /** Helper TABS spared because a pane's foreground held a non-shell proc (claude/node/etc.). */
  sparedLive: number;
  /** Helper TABS spared because a pane's process-info threw OR was empty/undeterminable
   *  (fail-closed) — counted only when no pane was outright live. */
  sparedError: number;
  /** Tab ids whose EVERY pane was shell-only THIS sweep — feed back as `prevShellOnly`
   *  next sweep to debounce. */
  shellOnly: Set<string>;
  /** True when `panes()` itself threw: the sweep did ZERO work (fail-closed) — the caller
   *  must surface this instead of reading it as "nothing to do" (#1852). */
  panesFailed: boolean;
}

/**
 * Reconciliation sweep: close any usage-probe / review / namer / distill helper tab whose
 * pane is a husk — an idle shell with no agent process running in it. The teardown paths
 * (herdr.stop / start rollback) stop most leaks at the source; this is the durable safety
 * net for husks they can't reach — agents that crashed, or anything orphaned across a
 * shepherd restart (which clears in-memory review tracking). Returns a {@link ReapResult}.
 *
 * **Husk signal = process liveness (ground truth), not list-absence.** Under
 * herdr 0.7 an exited helper agent leaves its pane alive as an idle `zsh`, and that pane
 * STILL appears in `agent list` (#721) — so the old "absent from `agent list` ⇒ orphan"
 * signal never fires. Instead we ask herdr for each helper pane's foreground processes.
 *
 * **Classification is per TAB, not per pane (#1852).** Reaping closes whole tabs, and a
 * helper tab can hold MORE than one pane: a headless codex-exec role deliberately retains
 * its root shell pane (`isHeadlessCodexExec`), and a failed best-effort root-pane close
 * leaves a shell pane beside the agent pane. Judging panes independently let a sibling
 * shell pane mark such a tab reap-eligible while its live pane merely counted as spared —
 * two sweeps later the tab was closed WITH the live helper inside. So helper panes are
 * grouped by tabId and the TAB is classified with fail-safe precedence:
 *
 * - **any pane live** (a non-shell proc: `claude` / `node` / …) → spare the whole tab
 *   (`sparedLive`); remaining panes aren't inspected.
 * - else **any pane errored/undeterminable** (process-info threw, or empty proc list) →
 *   spare the whole tab fail-closed (`sparedError`); we never reap on partial evidence.
 * - else — **every pane positively shell-only** (`procs.length > 0 && all in SHELLS`) →
 *   husk CANDIDATE this sweep.
 *
 * A spared tab is NOT added to the returned `shellOnly` set, so a liveness/error spare
 * also CLEARS any prior first-sighting — a tab hosting a live pane can never sit primed
 * in the debounce waiting for its shell pane to be seen once more.
 *
 * **Two-sweep debounce.** herdr's own PTY is a `zsh` that runs the agent command, so a
 * just-spawned agent is briefly shell-only during its pre-`exec` window. To avoid reaping
 * that, a husk candidate is only closed when it was *also* shell-only on the previous sweep
 * (its tabId was in `prevShellOnly`). A first-time shell-only sighting is recorded in the
 * returned `shellOnly` set (caller threads it back in) but not closed.
 *
 * **`panes()` throw is fail-closed AND flagged.** If `herdr.panes()` itself throws it's a
 * transient herdr read failure on a supported herdr — we reap nothing this sweep and
 * preserve the debounce set (return `prevShellOnly` unchanged) so a candidate isn't lost
 * mid-debounce, and set `panesFailed` so the caller can log the zero-work sweep instead of
 * mistaking it for "no husks" (#1852). (A per-pane `paneForegroundProcs` throw spares its
 * tab as `sparedError`, see above.)
 *
 * Closed tabs are closed in arbitrary order — herdr 0.7 stable ids (#569, e.g. `w1:t1`)
 * don't retarget on close, so close order is irrelevant.
 */
export async function reapOrphanTabs(
  herdr: ReapableHerdr,
  prevShellOnly: Set<string> = new Set(),
): Promise<ReapResult> {
  let panes: ReturnType<ReapableHerdr["panes"]>;
  try {
    panes = herdr.panes();
  } catch {
    // Transient herdr read failure on a supported herdr — fail closed: reap nothing this
    // sweep, preserve the debounce set, and flag the zero-work sweep for the caller.
    return {
      closed: [],
      sparedLive: 0,
      sparedError: 0,
      shellOnly: prevShellOnly,
      panesFailed: true,
    };
  }

  // Group helper panes by their owning tab — the reap unit is the TAB (#1852).
  const byTab = new Map<string, typeof panes>();
  for (const p of panes) {
    if (!isShepherdHelperLabel(p.label)) continue;
    const group = byTab.get(p.tabId);
    if (group) group.push(p);
    else byTab.set(p.tabId, [p]);
  }

  let sparedLive = 0;
  let sparedError = 0;
  const shellOnly = new Set<string>();
  const toReap: string[] = [];

  for (const [tabId, group] of byTab) {
    let live = false;
    let undetermined = false;
    for (const p of group) {
      let procs: string[];
      try {
        procs = await herdr.paneForegroundProcs(p.paneId);
      } catch {
        undetermined = true; // transient process-info failure — no evidence for this pane
        continue;
      }
      if (procs.length === 0) {
        undetermined = true; // undeterminable — never reap on no evidence
        continue;
      }
      if (!procs.every((n) => SHELLS.has(n))) {
        live = true; // a non-shell proc is running — the tab hosts a live agent
        break; // short-circuit: remaining panes can't change the classification
      }
    }
    if (live) {
      sparedLive++;
      continue; // spared AND de-primed: not added to shellOnly
    }
    if (undetermined) {
      sparedError++;
      continue; // fail-closed spare, likewise de-primed
    }
    // Every pane of the tab positively shell-only: husk candidate this sweep.
    shellOnly.add(tabId);
    if (prevShellOnly.has(tabId)) toReap.push(tabId); // debounce: shell-only twice running
  }

  for (const tabId of toReap) await herdr.closeTab(tabId);
  return { closed: toReap, sparedLive, sparedError, shellOnly, panesFailed: false };
}

// ── Orphan-tab sweep orchestration (#1852) ───────────────────────────────────

export interface OrphanTabSweeperDeps {
  /** One reconciliation pass — the caller binds `reapOrphanTabs(herdr, prev)`. */
  reap: (prevShellOnly: Set<string>) => Promise<ReapResult>;
  /** Timer seam (production: `setTimeout`); injectable so tests drive time by hand. */
  schedule: (fn: () => void, ms: number) => void;
  /** Skip triggers while a herdr update is in flight (production: `maintenance.active`). */
  maintenanceActive: () => boolean;
  /** Observability tap — every completed pass, including `panesFailed` zero-work ones. */
  onResult?: (r: ReapResult) => void;
  onError?: (err: unknown) => void;
  /** Delay before a self-scheduled confirming pass. Must comfortably exceed the pre-`exec`
   *  shell-only window the two-sweep debounce guards (production: 30s). */
  confirmDelayMs: number;
}

/**
 * Serialized, self-confirming orchestrator around {@link reapOrphanTabs} (#1852). The old
 * wiring fired boot sweeps at 5s/45s as independent `void` calls: on a large inventory the
 * 5s pass (which awaits per-pane process-info sequentially) could still be running at 45s,
 * both passes then started from the SAME debounce set, and neither was guaranteed to be
 * the confirming pass — while the in-memory debounce also reset on every restart.
 *
 * Contract:
 * - **Serialized + coalesced:** at most one pass in flight and at most one queued. A
 *   trigger during a running pass queues exactly one follow-up, which starts only after
 *   the current pass completes — and receives its predecessor's `shellOnly` set, so a
 *   queued pass is always a REAL confirming pass, never a same-set replay.
 * - **Self-confirming:** whenever a pass records NEW first-sightings (tabs shell-only now
 *   but not in the previous set), one confirming pass is scheduled `confirmDelayMs` later.
 *   Convergence therefore does not depend on WHICH external trigger sighted a husk (boot,
 *   hourly, or queued): any husk is closed ~confirmDelayMs after its first sighting, any
 *   single stable window after any restart converges, and a skipped boot sweep merely
 *   defers to the next trigger instead of losing an hour. Steady state schedules nothing:
 *   a pass whose sightings are all repeats (or that reaps them) sights nothing new.
 * - `maintenanceActive` skips triggers outright (matching the old wiring) and drains a
 *   queued follow-up without running it — the next scheduled trigger re-enters.
 */
export function createOrphanTabSweeper(deps: OrphanTabSweeperDeps): { trigger: () => void } {
  let running = false;
  let queued = false;
  let prev = new Set<string>();

  const run = async (): Promise<void> => {
    running = true;
    try {
      do {
        queued = false;
        if (deps.maintenanceActive()) break;
        const before = prev;
        let r: ReapResult;
        try {
          r = await deps.reap(before);
        } catch (err) {
          deps.onError?.(err);
          break;
        }
        prev = r.shellOnly;
        deps.onResult?.(r);
        for (const tabId of r.shellOnly) {
          if (!before.has(tabId)) {
            deps.schedule(trigger, deps.confirmDelayMs);
            break; // one confirming pass per sighting pass
          }
        }
      } while (queued);
    } finally {
      running = false;
    }
  };

  const trigger = (): void => {
    if (deps.maintenanceActive()) return;
    if (running) {
      queued = true;
      return;
    }
    void run();
  };

  return { trigger };
}

// ── Stranded review-worktree disk sweep (#721) ───────────────────────────────

/**
 * Reviewer/critic disposable checkouts (`{basename}-review-{tag}`, created by
 * `worktree.ts:createDetached`) whose teardown was missed — a crash, a shepherd
 * restart that cleared in-memory review tracking, or a foreign-era basename whose
 * repo is no longer configured — accumulate as dead dirs under `.shepherd-worktrees`.
 * This is a disk-driven sweep that reaps them; it COMPLEMENTS plan-gate's
 * {@link gcStaleReviewWorktrees} (which is store-driven and only knows plan_gate
 * spawns it still tracks) — it does not replace it. Runs SYNC (a boot + hourly
 * maintenance pass, not on the typing hot path), consistent with that sibling.
 *
 * **Tag-shape match, basename-agnostic (guard d).** Selection keys off the reviewer
 * TAG SHAPE — a name ending in `-review-(<8hex> | <uuid>-<8hex>)` — NOT the basename.
 * This is deliberate: a worktree minted under a now-defunct basename (`tank-review-…`,
 * `flowagent-review-…`, `pulse-review-…`) whose repo is no longer configured would be
 * invisible to any basename- or repo-scoped filter, yet is exactly the kind of orphan
 * that strands forever. Matching the tag suffix alone catches those. The flip side
 * (guards below) is that a USER prompt slugging to `review-*` yields `{basename}-review-*`
 * too — so a hex-shaped suffix could in principle alias real user work; (d)'s strict
 * hex/uuid shape plus the session-path spare (e) keep that from being reaped.
 *
 * **Full spare/reap coverage matrix** (an unowned candidate is reaped only if it survives
 * every spare below):
 *  - **pre-`inflight` begin() window** — a reviewer worktree may exist before in-memory ownership.
 *    Plan-gate persists its `reviewer_spawns` row before launch, so the recent-row grace covers
 *    that starting window; other reviewer services can still have no row yet. The independent
 *    **directory-age guard** therefore remains required: a candidate younger than `graceMs` (or
 *    that can't be stat'd → fail-closed) is spared. Checked BEFORE the `scanAlive` probe so a
 *    not-yet-running spawn is held by age alone.
 *  - **owned in memory (`protectedPaths`)** — paths a reviewer service currently holds.
 *    Spared REGARDLESS of age or `/proc` liveness. This is the #631 regression guard: a
 *    re-adopted plan-gate orphan has a DEAD reviewer `claude` AND an OLD uncompleted
 *    `reviewer_spawns` row, yet `tick()` still needs its worktree — age/proc heuristics
 *    alone would wrongly reap it. The caller unions the three reviewer services'
 *    `inflightWorktrees()` into this set.
 *  - **live store session (`sessionWorktreePaths`, guard e)** — any path backing a live
 *    user session is spared even if its name happens to match the tag shape.
 *  - **live `claude` under the dir (`scanAlive`)** — one cheap `/proc` pass; a candidate
 *    hosting a live `claude` is spared (`sparedLive`).
 *  - **recent uncompleted spawn (the `graceMs` grace)** — a `reviewer_spawns` row with
 *    `completedAt == null` whose `spawnedAt` is within `graceMs`. It covers plan-gate's durable
 *    pre-launch ownership window and also spares a recently-spawned reviewer whose path is not
 *    (yet/any longer) in `inflight`, e.g. across a restart before re-adoption, or a review/critic
 *    spawn that isn't re-adopted.
 *  - **old + ownerless** — survives every spare above → reaped.
 *
 * Too-young/unstattable and live-session spares are counted under `sparedOwned`.
 *
 * Fully dependency-injected (no direct fs/proc/store calls) so it is unit-testable
 * without a real filesystem, `/proc`, or store. The real wiring into `index.ts` is a
 * separate task.
 */
export interface ReapWorktreesDeps {
  /** Distinct `.shepherd-worktrees` dirs to sweep. */
  parents: string[];
  /** Entry NAMES under a parent (default in caller = readdirSync); `[]` if unreadable. */
  listDir: (parent: string) => string[];
  /** In-memory reviewer-owned paths — spare regardless of age/proc (#631 guard). */
  protectedPaths: Set<string>;
  /** Live store session worktreePaths — spare (user-work guard e). */
  sessionWorktreePaths: Set<string>;
  /** One-pass `/proc` liveness probe ({@link scanClaudeAliveByWorktree}). */
  scanAlive: (paths: string[]) => Map<string, boolean>;
  /** Append-only reviewer-spawn rows (subset of {@link ReviewerSpawnRow} fields). */
  listReviewerSpawns: () => Array<{
    worktreePath: string;
    completedAt: number | null;
    spawnedAt: number;
  }>;
  now: () => number;
  /** Grace window for a recent uncompleted spawn (spare if `spawnedAt > now()-graceMs`).
   *  Also the dir-age threshold: a candidate dir younger than `graceMs` is spared. */
  graceMs: number;
  /** Dir mtime in epoch-ms, or `null` if it can't be stat'd (→ fail-closed spare). Injected
   *  so the function stays I/O-free + unit-testable; the caller wraps `statSync(p).mtimeMs`. */
  dirMtime: (path: string) => number | null;
  /** Worktree removal wrapper (`worktree.remove`). */
  remove: (worktreePath: string) => void;
}

export interface ReapWorktreesResult {
  /** Worktree paths actually removed this sweep. */
  reaped: string[];
  /** Spared because owned in memory / live session / recent uncompleted spawn. */
  sparedOwned: number;
  /** Spared because a live `claude` was running in them. */
  sparedLive: number;
}

/** Reviewer disposable-worktree tag shape: `-review-` followed by an `sha8` or a
 *  `randomUUID-sha8` (lowercase hex; `i` flag tolerates upper). Validated against every
 *  on-disk `*-review-*` dir; matches the suffix produced by `worktree.ts:createDetached`. */
const REVIEW_TAG_RE =
  /-review-([0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8})$/i;

/** Collects de-duped tag-shape-matched worktree paths across all parent dirs. */
function gatherReviewCandidates(parents: string[], listDir: (p: string) => string[]): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const parent of parents) {
    for (const name of listDir(parent)) {
      if (!REVIEW_TAG_RE.test(name)) continue;
      const path = join(parent, name);
      if (seen.has(path)) continue;
      seen.add(path);
      candidates.push(path);
    }
  }
  return candidates;
}

/** Builds the set of worktree paths for recent uncompleted spawns within `graceMs`. */
function recentSpawnPaths(
  rows: Array<{ worktreePath: string; completedAt: number | null; spawnedAt: number }>,
  now: number,
  graceMs: number,
): Set<string> {
  const cutoff = now - graceMs;
  const recent = new Set<string>();
  for (const sp of rows) {
    if (sp.completedAt == null && sp.spawnedAt > cutoff) recent.add(sp.worktreePath);
  }
  return recent;
}

/** A candidate too young to reap (or unstattable): spares a mid-begin checkout in the
 *  pre-`inflight` begin() window. Fail-closed — `null` mtime (can't stat) is spared. */
function isTooYoung(path: string, deps: ReapWorktreesDeps): boolean {
  const mtime = deps.dirMtime(path);
  return mtime === null || deps.now() - mtime < deps.graceMs;
}

export function reapStaleReviewWorktrees(deps: ReapWorktreesDeps): ReapWorktreesResult {
  // 1. Candidate paths: tag-shape matches under every parent, de-duped.
  const candidates = gatherReviewCandidates(deps.parents, deps.listDir);

  // 2. owned(path): in-memory-owned, live session, or recent uncompleted spawn.
  const recent = recentSpawnPaths(deps.listReviewerSpawns(), deps.now(), deps.graceMs);
  const owned = (path: string): boolean =>
    deps.protectedPaths.has(path) || deps.sessionWorktreePaths.has(path) || recent.has(path);

  // 3. One /proc pass over the non-owned candidates only.
  const aliveMap = deps.scanAlive(candidates.filter((p) => !owned(p)));

  // 4. Classify each candidate.
  const reaped: string[] = [];
  let sparedOwned = 0;
  let sparedLive = 0;
  for (const path of candidates) {
    // owned → too-young (spare a mid-begin dir before the alive check) → alive → else reap.
    if (owned(path) || isTooYoung(path, deps)) {
      sparedOwned++;
      continue;
    }
    if (aliveMap.get(path)) {
      sparedLive++;
      continue;
    }
    deps.remove(path);
    reaped.push(path);
  }

  return { reaped, sparedOwned, sparedLive };
}
