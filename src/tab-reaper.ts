import { join } from "node:path";
import type { HerdrDriver, HerdrPane } from "./herdr";
import { DOC_AGENT_LABEL } from "./doc-agent";
import { MAINTAIN_AGENT_LABEL } from "./maintain";
import { PROBE_NAME } from "./usage-probe";
import { DISTILL_LABEL } from "./distiller";
import { OPTIMIZE_LABEL } from "./optimizer";
import { MERGE_LABEL } from "./merge-suggest";
import { AUTOPILOT_LABEL } from "./autopilot";
import { NAMER_LABEL } from "./namer";
import { RECOMMEND_LABEL } from "./prompt-recommend";
import { SHAPE_LABEL } from "./task-shape";
import { VERIFY_KEY_LABEL } from "./verify-key";
import { SHELLS } from "./json-tolerant";

export type ReapableHerdr = Pick<
  HerdrDriver,
  "closeTab" | "tabsAsync" | "panes" | "paneForegroundProcs"
>;

/** Labels shepherd authors for its short-lived helper agents. A tab with one of these
 *  labels but no live agent is an orphaned husk (the probe/critic ended without its tab
 *  being closed — e.g. a shepherd restart cleared the in-memory tracking).
 *
 *  **Scope filter, not a safety gate.** This function is a first-pass scope filter; the
 *  caller's process-liveness check (a live agent in `herdr list`) is the actual safety gate.
 *
 *  **Collision-proof markers** (space-prefix or underscore): {@link PROBE_NAME},
 *  {@link DISTILL_LABEL} and {@link OPTIMIZE_LABEL} contain underscores; every other helper uses a space-prefixed
 *  label ({@link NAMER_LABEL}, {@link AUTOPILOT_LABEL}, and the still-inline `"review "`,
 *  `"plan-review "`, `"pr-critic "`, `"recap "`) or a multi-word exact phrase
 *  ({@link VERIFY_KEY_LABEL}). User sessions use prompt-derived `[a-z0-9-]` slugs — no spaces,
 *  no underscores — so none of these labels is reachable by a slug.
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
 *  - {@link SHAPE_LABEL}`<n>`        — New Task shaping round (task-shape.ts, #2158)
 *  - {@link DOC_AGENT_LABEL}`<hex>`  — doc agent (doc-agent.ts, #2029)
<<<<<<< HEAD
||||||| parent of a6c3d1b3 (fix(maintain): close the orphaned diagnosis tab on the restart path)
 *  - `rundown`           — herd-digest rundown (herd-digest.ts) — liveness-gated
=======
 *  - `rundown`           — herd-digest rundown (herd-digest.ts) — liveness-gated
 *  - {@link MAINTAIN_AGENT_LABEL}`<hex>` — maintain-loop diagnosis (maintain.ts, #2157)
>>>>>>> a6c3d1b3 (fix(maintain): close the orphaned diagnosis tab on the restart path)
 *
 *  **Read this against the TAB label, not a pane or agent label** (#2029). herdr 0.7.5 emits
 *  `label` on neither husk panes nor agent records; `tab.list` is the only surface that still
 *  carries it (and the generated schema marks `SuccessResponseTabInfo.label` required, while both
 *  of the others are optional-and-nullable). */
export function isShepherdHelperLabel(label: string): boolean {
  return (
    label === PROBE_NAME ||
    label.startsWith(DISTILL_LABEL) ||
    label.startsWith(DOC_AGENT_LABEL) ||
    label.startsWith(MAINTAIN_AGENT_LABEL) ||
    label.startsWith(OPTIMIZE_LABEL) ||
    label.startsWith(MERGE_LABEL) ||
    label === VERIFY_KEY_LABEL ||
    label.startsWith("review ") ||
    label.startsWith(NAMER_LABEL) ||
    label.startsWith("plan-review ") ||
    label.startsWith("pr-critic ") ||
    label.startsWith("recap ") ||
    label.startsWith(RECOMMEND_LABEL) ||
    label.startsWith(SHAPE_LABEL) ||
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
   *  (fail-closed) — counted only when no pane was outright live. Also covers a helper tab with
   *  no pane at all in `pane.list`: no evidence is never a reap. */
  sparedError: number;
  /** Tab ids whose EVERY pane was shell-only THIS sweep — feed back as `prevShellOnly`
   *  next sweep to debounce. */
  shellOnly: Set<string>;
  /** Helper TABS in scope this sweep (helper-labelled entries in `tab.list`). Reported so the
   *  caller can tell "no helper tabs exist" from "helper tabs found, all spared" — the two states
   *  the old counters-only result rendered as the same silence (#2029). Invariant when neither
   *  failure flag is set: `helperTabs === sparedLive + sparedError + shellOnly.size`. */
  helperTabs: number;
  /** True when `panes()` itself threw: the sweep did ZERO work (fail-closed) — the caller
   *  must surface this instead of reading it as "nothing to do" (#1852). */
  panesFailed: boolean;
  /** True when `tabsAsync()` threw: the sweep did ZERO work and the SCOPE is unknown, so
   *  `helperTabs` is 0 for want of a reading, not because none exist (#2029). */
  tabsFailed: boolean;
}

/**
 * Reconciliation sweep: close any usage-probe / review / namer / distill helper tab whose
 * pane is a husk — an idle shell with no agent process running in it. The teardown paths
 * (herdr.stop / start rollback) stop most leaks at the source; this is the durable safety
 * net for husks they can't reach — agents that crashed, or anything orphaned across a
 * shepherd restart (which clears in-memory review tracking). Returns a {@link ReapResult}.
 *
 * **Scope comes from `tab.list`, evidence from `pane.list` (#2029).** herdr 0.7.5 emits a pane
 * `label` for almost no pane and for NO helper pane — measured live: 0 of 325 helper panes — and
 * emits no `agent.name` at all. Filtering the pane list by label therefore selected the empty set
 * on exactly the panes that need reaping, and this whole function ran to completion doing nothing,
 * every hour, silently. The TAB label survives (required in the generated schema, present on
 * 508/508 live tabs), so the helper set is derived from `tabsAsync()` and panes are joined to it
 * by `tab_id` purely as process-liveness evidence.
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
 * - else **any pane errored/undeterminable** (process-info threw, or empty proc list), or the tab
 *   has NO pane in `pane.list` at all → spare the whole tab fail-closed (`sparedError`); we never
 *   reap on partial or absent evidence.
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
  /** Zero-work sweep: reap nothing, preserve the debounce set so no candidate is lost
   *  mid-debounce, and flag WHICH read failed so the caller can log it. */
  const zeroWork = (failed: "tabs" | "panes"): ReapResult => ({
    closed: [],
    sparedLive: 0,
    sparedError: 0,
    shellOnly: prevShellOnly,
    helperTabs: 0,
    panesFailed: failed === "panes",
    tabsFailed: failed === "tabs",
  });

  let helperTabIds: string[];
  try {
    helperTabIds = (await herdr.tabsAsync())
      .filter((t) => isShepherdHelperLabel(t.label))
      .map((t) => t.tabId);
  } catch {
    return zeroWork("tabs"); // transient herdr read failure — scope unknown, fail closed
  }
  // Nothing helper-labelled exists: skip the pane read entirely. This is a REAL "nothing to
  // do" — it reads the same surface an operator would check by hand (#2029).
  if (helperTabIds.length === 0) {
    return {
      closed: [],
      sparedLive: 0,
      sparedError: 0,
      shellOnly: new Set(),
      helperTabs: 0,
      panesFailed: false,
      tabsFailed: false,
    };
  }

  let panes: ReturnType<ReapableHerdr["panes"]>;
  try {
    panes = herdr.panes();
  } catch {
    return zeroWork("panes");
  }
  const byTab = panesByTab(panes);

  let sparedLive = 0;
  let sparedError = 0;
  const shellOnly = new Set<string>();
  const toReap: string[] = [];

  for (const tabId of helperTabIds) {
    const cls = await classifyHelperTab(herdr, byTab.get(tabId) ?? []);
    if (cls === "live") {
      sparedLive++;
      continue; // spared AND de-primed: not added to shellOnly
    }
    if (cls === "undetermined") {
      sparedError++;
      continue; // fail-closed spare, likewise de-primed
    }
    // Every pane of the tab positively shell-only: husk candidate this sweep.
    shellOnly.add(tabId);
    if (prevShellOnly.has(tabId)) toReap.push(tabId); // debounce: shell-only twice running
  }

  for (const tabId of toReap) await herdr.closeTab(tabId);
  return {
    closed: toReap,
    sparedLive,
    sparedError,
    shellOnly,
    helperTabs: helperTabIds.length,
    panesFailed: false,
    tabsFailed: false,
  };
}

/** Group panes by their owning tab — the reap unit is the TAB (#1852). Every pane is grouped;
 *  the helper SCOPE comes from the tab list, since 0.7.5 panes carry no label (#2029). */
function panesByTab(panes: HerdrPane[]): Map<string, HerdrPane[]> {
  const byTab = new Map<string, HerdrPane[]>();
  for (const p of panes) {
    const group = byTab.get(p.tabId);
    if (group) group.push(p);
    else byTab.set(p.tabId, [p]);
  }
  return byTab;
}

/** Classify one helper TAB from its panes' foreground processes, with the fail-safe
 *  precedence documented on {@link reapOrphanTabs}: any live pane wins (short-circuit),
 *  else any errored/empty pane makes the tab undetermined, else it is positively
 *  shell-only. An EMPTY group (the tab is in `tab.list` but owns no pane in `pane.list`) is
 *  undetermined, never shell-only: the two lists disagree, which is no evidence at all. That
 *  case only became reachable once the scope came from tabs (#2029) — an empty group would
 *  otherwise fall straight through the loop and read as "positively shell-only". */
async function classifyHelperTab(
  herdr: ReapableHerdr,
  group: HerdrPane[],
): Promise<"live" | "undetermined" | "shell-only"> {
  if (group.length === 0) return "undetermined";
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
      return "live"; // a non-shell proc runs here — remaining panes can't change this
    }
  }
  return undetermined ? "undetermined" : "shell-only";
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
 * spawns it still tracks) — it does not replace it. Runs off the boot + hourly
 * maintenance pass, not on the typing hot path. `reapStaleReviewWorktrees` itself
 * stays synchronous; its caller (`sweepStaleReviewWorktrees` in index.ts) awaits a
 * probe-snapshot refresh first, so the caller is async even though this is not.
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
  /** One-pass `/proc` liveness probe ({@link scanClaudeAliveByWorktree}). Returns
   *  `null` when the snapshot backend can't support a negative verdict (darwin,
   *  stale/none cell). This consumer is FAIL-OPEN — an absent map entry means
   *  "delete" — so `null` must skip the whole sweep, never default to an empty map,
   *  or a live-reviewer worktree would be removed on unknown data. */
  scanAlive: (paths: string[]) => Map<string, boolean> | null;
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
  /**
   * Set when the sweep did NOT run and nothing was classified — so the counters
   * above are all zero rather than mis-attributing the untouched candidates to a
   * sparing reason they don't match. `"liveness-unknown"` means `scanAlive`
   * returned null (the snapshot backend can't support a negative verdict), which
   * is indefinite on a host whose cell never goes fresh — so the CALLER should log
   * it, or the hourly sweep silently does nothing forever. This function stays
   * I/O-free (every effect is an injected dep), hence reporting rather than logging.
   */
  skipped?: "liveness-unknown";
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

  // `null` = liveness unknown (darwin, stale/none snapshot). This classifier is
  // FAIL-OPEN: below, a missing `aliveMap.get(path)` reaps the path. So on unknown
  // data we must SKIP the whole sweep and spare every candidate — reaping here
  // would delete review worktrees hosting a live reviewer we simply cannot see.
  if (aliveMap === null) {
    // Counters stay 0: nothing was classified, so attributing these candidates to
    // `sparedOwned` ("owned in memory / live session / recent spawn") would be a
    // reason that doesn't apply. `skipped` is the honest signal, and the caller
    // logs it — this skip is indefinite on a host whose cell never goes fresh.
    return { reaped: [], sparedOwned: 0, sparedLive: 0, skipped: "liveness-unknown" };
  }

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
