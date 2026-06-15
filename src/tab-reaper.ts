import type { HerdrDriver } from "./herdr";
import { PROBE_NAME } from "./usage-probe";
import { DISTILL_LABEL } from "./distiller";

export type ReapableHerdr = Pick<
  HerdrDriver,
  "list" | "tabs" | "closeTab" | "panes" | "paneForegroundProcs"
>;

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
 *  **Collision-proof markers** (space-prefix or underscore): {@link PROBE_NAME} and
 *  {@link DISTILL_LABEL} contain underscores; every other helper uses a space-prefixed
 *  label (`"review "`, `"name "`, `"plan-review "`, `"pr-critic "`, `"recap "`,
 *  `"autopilot "`) or a multi-word exact phrase (`"verify api key"`). User sessions use
 *  prompt-derived `[a-z0-9-]` slugs — no spaces, no underscores — so none of these labels
 *  is reachable by a slug. Exception: `"rundown"` (exact, no space) relies on the
 *  liveness gate instead.
 *
 *  Helpers covered:
 *  - `__usage_probe__`   — usage probe (PROBE_NAME)
 *  - `__distill__`       — distiller (DISTILL_LABEL)
 *  - `review <desig>`    — critic / code-review spawns
 *  - `name <desig>`      — background LLM namer
 *  - `plan-review <desig>` — plan-gate reviewer (plan-gate.ts)
 *  - `pr-critic <repo>#<n>` — standalone PR critic (standalone-critic.ts)
 *  - `recap <desig>`     — recap generator (recap.ts)
 *  - `rundown`           — herd-digest rundown (herd-digest.ts) — liveness-gated
 *  - `autopilot <id>`    — autopilot LLM (autopilot-llm.ts)
 *  - `verify api key`    — API-key verifier (verify-key.ts) */
export function isShepherdHelperLabel(label: string): boolean {
  return (
    label === PROBE_NAME ||
    label === DISTILL_LABEL ||
    label === "rundown" ||
    label === "verify api key" ||
    label.startsWith("review ") ||
    label.startsWith("name ") ||
    label.startsWith("plan-review ") ||
    label.startsWith("pr-critic ") ||
    label.startsWith("recap ") ||
    label.startsWith("autopilot ")
  );
}

/**
 * Parses the positional `workspace:N` index used by herdr **≤0.6**, where tab ids are
 * `"workspace:N"` with N a dense integer that re-numbers on close. Under herdr 0.7 stable
 * ids (e.g. `w1:t1`) the last `:`-segment is not numeric, so this returns `0` for every
 * tab — which is fine (see `reapOrphanTabs`). Retained until herdr 0.7 is the deployed
 * floor, at which point this helper and the `.sort()` in `reapOrphanTabs` can be removed.
 */
function tabNumber(tabId: string): number {
  const n = Number.parseInt(tabId.split(":").at(-1) ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/** Foreground process names that mean "just an idle shell" (a husk PTY). A helper pane
 *  whose foreground is *only* one of these has nothing running in it. */
const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash"]);

/** Breakdown of one reconciliation sweep. */
export interface ReapResult {
  /** Tab ids actually closed this sweep. */
  closed: string[];
  /** Helper panes spared because their foreground held a non-shell proc (claude/node/etc.). */
  sparedLive: number;
  /** Helper panes spared because process-info threw OR was empty/undeterminable (fail-closed). */
  sparedError: number;
  /** Tab ids that were shell-only THIS sweep — feed back as `prevShellOnly` next sweep to debounce. */
  shellOnly: Set<string>;
}

/**
 * Reconciliation sweep: close any usage-probe / review / namer / distill helper tab whose
 * pane is a husk — an idle shell with no agent process running in it. The teardown paths
 * (herdr.stop / start rollback) stop most leaks at the source; this is the durable safety
 * net for husks they can't reach — agents that crashed, or anything orphaned across a
 * shepherd restart (which clears in-memory review tracking). Returns a {@link ReapResult}.
 *
 * **Husk signal = per-pane process liveness (ground truth), not list-absence.** Under
 * herdr 0.7 an exited helper agent leaves its pane alive as an idle `zsh`, and that pane
 * STILL appears in `agent list` (#721) — so the old "absent from `agent list` ⇒ orphan"
 * signal never fires. Instead we ask herdr for each helper pane's foreground processes:
 *
 * - **non-shell proc present** (`claude` / `node` / `node-MainThread` / …) → live → spare
 *   (`sparedLive`).
 * - **process-info throws** (transient read failure / quirk) → spare (`sparedError`). A
 *   per-pane throw is NOT a capability miss and does NOT trigger the legacy fallback.
 * - **empty proc list** (undeterminable) → spare fail-closed (`sparedError`); we never
 *   reap on no evidence.
 * - **shell-only** (`procs.length > 0 && procs.every(SHELLS.has)`) → husk CANDIDATE this
 *   sweep.
 *
 * **Two-sweep debounce.** herdr's own PTY is a `zsh` that runs the agent command, so a
 * just-spawned agent is briefly shell-only during its pre-`exec` window. To avoid reaping
 * that, a husk candidate is only closed when it was *also* shell-only on the previous sweep
 * (its tabId was in `prevShellOnly`). A first-time shell-only sighting is recorded in the
 * returned `shellOnly` set (caller threads it back in) but not closed.
 *
 * **Capability fallback for old herdr (0.6).** If `herdr.panes()` itself throws — the
 * `pane`/`pane process-info` subcommands are absent — we fall back to
 * {@link reapOrphanTabsLegacy}, the list-absence signal, which is *correct* on 0.6 because
 * a finished helper there DOES drop out of `agent list`. Only a `panes()` throw triggers
 * the fallback; a per-pane `paneForegroundProcs` throw is `sparedError` (see above).
 *
 * Closes in descending tab-number order. The behaviour under each herdr version:
 *
 * - **herdr ≤0.6** (positional ids, e.g. `workspace:N`): ids re-densify on close, so
 *   closing highest-number-first keeps each remaining snapshotted target id valid — only
 *   already-closed, higher-numbered tabs shift. (Relevant on the legacy fallback path.)
 * - **herdr 0.7** (#569, stable ids e.g. `w1:t1`): closed ids don't retarget, so close
 *   order is irrelevant. `tabNumber()` returns `0` for every 0.7 id, making the sort a
 *   harmless no-op (order-preserving on ties). Kept pending the id-cleanup issue #714.
 */
export async function reapOrphanTabs(
  herdr: ReapableHerdr,
  prevShellOnly: Set<string> = new Set(),
): Promise<ReapResult> {
  let panes: ReturnType<ReapableHerdr["panes"]>;
  try {
    panes = herdr.panes();
  } catch {
    // herdr 0.6: no `pane` subcommand. List-absence IS the correct husk signal there.
    return {
      closed: reapOrphanTabsLegacy(herdr),
      sparedLive: 0,
      sparedError: 0,
      shellOnly: prevShellOnly,
    };
  }

  let sparedLive = 0;
  let sparedError = 0;
  const shellOnly = new Set<string>();
  const toReap = new Set<string>(); // tabIds, deduped (helper tab is single-pane, but be defensive)

  for (const p of panes) {
    if (!isShepherdHelperLabel(p.label)) continue;
    let procs: string[];
    try {
      procs = await herdr.paneForegroundProcs(p.paneId);
    } catch {
      sparedError++; // transient process-info failure — spare, do not fall back
      continue;
    }
    if (procs.length === 0) {
      sparedError++; // undeterminable — fail closed, never reap on no evidence
      continue;
    }
    if (!procs.every((n) => SHELLS.has(n))) {
      sparedLive++; // a non-shell proc is running — live agent
      continue;
    }
    // shell-only: husk candidate this sweep
    shellOnly.add(p.tabId);
    if (prevShellOnly.has(p.tabId)) toReap.add(p.tabId); // debounce: shell-only twice running
  }

  const orderedReap = [...toReap].sort((a, b) => tabNumber(b) - tabNumber(a));
  for (const tabId of orderedReap) herdr.closeTab(tabId);
  return { closed: orderedReap, sparedLive, sparedError, shellOnly };
}

/**
 * Legacy (herdr ≤0.6) husk signal: a helper-labeled tab absent from `agent list` is an
 * orphan. Correct only where a finished helper actually leaves `agent list` (pre-0.7);
 * reached via the capability fallback in {@link reapOrphanTabs} when `panes()` is absent.
 * Returns the ids it closed, in descending tab-number order (see {@link tabNumber}).
 */
export function reapOrphanTabsLegacy(herdr: ReapableHerdr): string[] {
  const liveTabIds = new Set(
    herdr
      .list()
      .map((a) => a.tabId)
      .filter(Boolean),
  );
  const orphans = herdr
    .tabs()
    .filter((t) => isShepherdHelperLabel(t.label) && !liveTabIds.has(t.tabId))
    .sort((a, b) => tabNumber(b.tabId) - tabNumber(a.tabId));
  for (const t of orphans) herdr.closeTab(t.tabId);
  return orphans.map((t) => t.tabId);
}
