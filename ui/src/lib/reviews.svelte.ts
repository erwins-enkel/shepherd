import type { ReviewVerdict, PlanGate, RepoConfig } from "./types";
import type { AutomationFlags } from "./components/git-rail-automation";
import {
  getReviews,
  getReviewingIds,
  getPlanGates,
  getPlanGatesInflight,
  getRepoConfig,
  putRepoConfig,
} from "./api";

/** Client cache of critic verdicts keyed by session id. Loaded once on app start;
 *  live updates arrive via the `session:review` WS event (see store.svelte.ts). */
class ReviewsStore {
  map = $state<Record<string, ReviewVerdict>>({});
  // session ids with a critic run currently in flight; driven by `session:reviewing`
  reviewing = $state<Record<string, boolean>>({});

  async load() {
    try {
      this.map = await getReviews();
    } catch {
      /* best-effort; live events still populate it */
    }
    try {
      // bootstrap in-flight runs so a reload mid-review still shows the indicator
      this.reviewing = Object.fromEntries((await getReviewingIds()).map((id) => [id, true]));
    } catch {
      /* best-effort; `session:reviewing` events still populate it */
    }
  }

  apply(d: { id: string; review: ReviewVerdict | null }) {
    if (d.review) this.map = { ...this.map, [d.id]: d.review };
    else {
      const copy = { ...this.map };
      delete copy[d.id];
      this.map = copy;
    }
    // a verdict (or its removal) means the run is no longer in flight
    this.setReviewing(d.id, false);
  }

  setReviewing(id: string, on: boolean) {
    if (!!this.reviewing[id] === on) return;
    if (on) this.reviewing = { ...this.reviewing, [id]: true };
    else {
      const copy = { ...this.reviewing };
      delete copy[id];
      this.reviewing = copy;
    }
  }

  isReviewing(id: string): boolean {
    return !!this.reviewing[id];
  }

  drop(id: string) {
    this.setReviewing(id, false);
    if (!(id in this.map)) return;
    const copy = { ...this.map };
    delete copy[id];
    this.map = copy;
  }
}
export const reviews = new ReviewsStore();

/** Client cache of pre-execution plan-gate verdicts keyed by session id. Bootstrapped
 *  once on app start; live updates arrive via the `session:plangate` WS event, and the
 *  in-flight indicator via `session:plangate-reviewing` (see store.svelte.ts). Mirrors
 *  ReviewsStore — a landing verdict clears the reviewing flag for that id. */
export class PlanGateStore {
  map = $state<Record<string, PlanGate>>({});
  // session ids whose plan reviewer is currently in flight; driven by `session:plangate-reviewing`
  reviewing = $state<Record<string, boolean>>({});

  /** Bootstrap from a GET /api/plan-gates snapshot + GET /api/plan-gates/inflight ids,
   *  so a reload mid-review still shows verdicts and the in-flight indicator. */
  bootstrap(map: Record<string, PlanGate>, inflightIds: string[]) {
    this.map = map;
    this.reviewing = Object.fromEntries(inflightIds.map((id) => [id, true]));
  }

  /** Re-fetch the snapshot + in-flight ids from the server (best-effort). */
  async load() {
    let map: Record<string, PlanGate> = {};
    let inflight: string[] = [];
    try {
      map = await getPlanGates();
    } catch {
      /* best-effort; live events still populate it */
    }
    try {
      inflight = await getPlanGatesInflight();
    } catch {
      /* best-effort; `session:plangate-reviewing` events still populate it */
    }
    this.bootstrap(map, inflight);
  }

  apply(id: string, gate: PlanGate) {
    this.map = { ...this.map, [id]: gate };
    // a landing verdict means the review is no longer in flight
    this.applyReviewing(id, false);
  }

  applyReviewing(id: string, on: boolean) {
    if (!!this.reviewing[id] === on) return;
    if (on) this.reviewing = { ...this.reviewing, [id]: true };
    else {
      const copy = { ...this.reviewing };
      delete copy[id];
      this.reviewing = copy;
    }
  }

  isReviewing(id: string): boolean {
    return !!this.reviewing[id];
  }

  drop(id: string) {
    this.applyReviewing(id, false);
    if (!(id in this.map)) return;
    const copy = { ...this.map };
    delete copy[id];
    this.map = copy;
  }
}
export const planGates = new PlanGateStore();

/** Per-repo critic + auto-address + learnings + autopilot + drain + automerge + build-queue + plan-gate on/off, cached lazily by repoPath. */
class RepoConfigStore {
  enabled = $state<Record<string, boolean>>({}); // critic on/off (default on)
  autoAddress = $state<Record<string, boolean>>({}); // auto-address loop on/off (default off)
  learnings = $state<Record<string, boolean>>({}); // house-rule injection (default on)
  autopilot = $state<Record<string, boolean>>({}); // autopilot mode (default off)
  autoDrain = $state<Record<string, boolean>>({}); // auto-drain queue (default off)
  autoMerge = $state<Record<string, boolean>>({}); // full-auto merge (default off)
  buildQueue = $state<Record<string, boolean>>({}); // agent-authored build queue (default off)
  planGate = $state<Record<string, boolean>>({}); // pre-execution plan gate (default off)
  maxAuto = $state<Record<string, number>>({}); // max concurrent auto sessions (default 1)
  autoLabel = $state<Record<string, string>>({}); // label used to pick drain issues (default "shepherd:auto")
  usageCeiling = $state<Record<string, number>>({}); // usage % ceiling before pausing drain (default 80)

  async ensure(repoPath: string) {
    if (repoPath in this.enabled) return;
    try {
      const c = await getRepoConfig(repoPath);
      this.enabled = { ...this.enabled, [repoPath]: c.criticEnabled };
      this.autoAddress = { ...this.autoAddress, [repoPath]: c.autoAddressEnabled };
      this.learnings = { ...this.learnings, [repoPath]: c.learningsEnabled };
      this.autopilot = { ...this.autopilot, [repoPath]: c.autopilotEnabled };
      this.autoDrain = { ...this.autoDrain, [repoPath]: c.autoDrainEnabled };
      this.autoMerge = { ...this.autoMerge, [repoPath]: c.autoMergeEnabled };
      this.buildQueue = { ...this.buildQueue, [repoPath]: c.buildQueueEnabled };
      this.planGate = { ...this.planGate, [repoPath]: c.planGateEnabled };
      this.maxAuto = { ...this.maxAuto, [repoPath]: c.maxAuto };
      this.autoLabel = { ...this.autoLabel, [repoPath]: c.autoLabel };
      this.usageCeiling = { ...this.usageCeiling, [repoPath]: c.usageCeilingPct };
    } catch {
      /* leave unset; UI shows defaults optimistically */
    }
  }

  /** Optimistically apply a patch, then reconcile from the server (or revert on error). */
  private async apply(
    repoPath: string,
    patch: Partial<
      Pick<
        RepoConfig,
        | "criticEnabled"
        | "autoAddressEnabled"
        | "learningsEnabled"
        | "autopilotEnabled"
        | "autoDrainEnabled"
        | "autoMergeEnabled"
        | "buildQueueEnabled"
        | "planGateEnabled"
        | "maxAuto"
        | "autoLabel"
        | "usageCeilingPct"
      >
    >,
    revert: () => void,
  ) {
    try {
      const c = await putRepoConfig(repoPath, patch);
      this.enabled = { ...this.enabled, [repoPath]: c.criticEnabled };
      this.autoAddress = { ...this.autoAddress, [repoPath]: c.autoAddressEnabled };
      this.learnings = { ...this.learnings, [repoPath]: c.learningsEnabled };
      this.autopilot = { ...this.autopilot, [repoPath]: c.autopilotEnabled };
      this.autoDrain = { ...this.autoDrain, [repoPath]: c.autoDrainEnabled };
      this.autoMerge = { ...this.autoMerge, [repoPath]: c.autoMergeEnabled };
      this.buildQueue = { ...this.buildQueue, [repoPath]: c.buildQueueEnabled };
      this.planGate = { ...this.planGate, [repoPath]: c.planGateEnabled };
      this.maxAuto = { ...this.maxAuto, [repoPath]: c.maxAuto };
      this.autoLabel = { ...this.autoLabel, [repoPath]: c.autoLabel };
      this.usageCeiling = { ...this.usageCeiling, [repoPath]: c.usageCeilingPct };
    } catch {
      revert();
    }
  }

  async toggle(repoPath: string) {
    const prev = this.enabled[repoPath];
    const next = !this.isEnabled(repoPath);
    this.enabled = { ...this.enabled, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { criticEnabled: next }, () => {
      this.enabled = { ...this.enabled, [repoPath]: prev };
    });
  }

  async toggleAutoAddress(repoPath: string) {
    const prev = this.autoAddress[repoPath];
    const next = !this.isAutoAddressEnabled(repoPath);
    this.autoAddress = { ...this.autoAddress, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { autoAddressEnabled: next }, () => {
      this.autoAddress = { ...this.autoAddress, [repoPath]: prev };
    });
  }

  async toggleLearnings(repoPath: string) {
    const prev = this.learnings[repoPath];
    const next = !this.learningsOn(repoPath);
    this.learnings = { ...this.learnings, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { learningsEnabled: next }, () => {
      this.learnings = { ...this.learnings, [repoPath]: prev };
    });
  }

  async toggleAutopilot(repoPath: string) {
    const prev = this.autopilot[repoPath];
    const next = !this.isAutopilotEnabled(repoPath);
    this.autopilot = { ...this.autopilot, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { autopilotEnabled: next }, () => {
      this.autopilot = { ...this.autopilot, [repoPath]: prev };
    });
  }

  async toggleAutoDrain(repoPath: string) {
    const prev = this.autoDrain[repoPath];
    const next = !this.isAutoDrainEnabled(repoPath);
    this.autoDrain = { ...this.autoDrain, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { autoDrainEnabled: next }, () => {
      this.autoDrain = { ...this.autoDrain, [repoPath]: prev };
    });
  }

  async toggleAutoMerge(repoPath: string) {
    const prev = this.autoMerge[repoPath];
    const next = !this.isAutoMergeEnabled(repoPath);
    this.autoMerge = { ...this.autoMerge, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { autoMergeEnabled: next }, () => {
      this.autoMerge = { ...this.autoMerge, [repoPath]: prev };
    });
  }

  async toggleBuildQueue(repoPath: string) {
    const prev = this.buildQueue[repoPath];
    const next = !this.isBuildQueueEnabled(repoPath);
    this.buildQueue = { ...this.buildQueue, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { buildQueueEnabled: next }, () => {
      this.buildQueue = { ...this.buildQueue, [repoPath]: prev };
    });
  }

  async togglePlanGate(repoPath: string) {
    const prev = this.planGate[repoPath];
    const next = !this.isPlanGateEnabled(repoPath);
    this.planGate = { ...this.planGate, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { planGateEnabled: next }, () => {
      this.planGate = { ...this.planGate, [repoPath]: prev };
    });
  }

  async setMaxAuto(repoPath: string, n: number) {
    const prev = this.maxAuto[repoPath];
    this.maxAuto = { ...this.maxAuto, [repoPath]: n }; // optimistic
    await this.apply(repoPath, { maxAuto: n }, () => {
      this.maxAuto = { ...this.maxAuto, [repoPath]: prev };
    });
  }

  async setAutoLabel(repoPath: string, s: string) {
    const prev = this.autoLabel[repoPath];
    this.autoLabel = { ...this.autoLabel, [repoPath]: s }; // optimistic
    await this.apply(repoPath, { autoLabel: s }, () => {
      this.autoLabel = { ...this.autoLabel, [repoPath]: prev };
    });
  }

  async setUsageCeiling(repoPath: string, n: number) {
    const prev = this.usageCeiling[repoPath];
    this.usageCeiling = { ...this.usageCeiling, [repoPath]: n }; // optimistic
    await this.apply(repoPath, { usageCeilingPct: n }, () => {
      this.usageCeiling = { ...this.usageCeiling, [repoPath]: prev };
    });
  }

  isEnabled(repoPath: string): boolean {
    return this.enabled[repoPath] ?? true;
  }

  isAutoAddressEnabled(repoPath: string): boolean {
    return this.autoAddress[repoPath] ?? false;
  }

  learningsOn(repoPath: string): boolean {
    return this.learnings[repoPath] ?? true;
  }

  isAutopilotEnabled(repoPath: string): boolean {
    return this.autopilot[repoPath] ?? false;
  }

  isAutoDrainEnabled(repoPath: string): boolean {
    return this.autoDrain[repoPath] ?? false;
  }

  isAutoMergeEnabled(repoPath: string): boolean {
    return this.autoMerge[repoPath] ?? false;
  }

  isBuildQueueEnabled(repoPath: string): boolean {
    return this.buildQueue[repoPath] ?? false;
  }

  isPlanGateEnabled(repoPath: string): boolean {
    return this.planGate[repoPath] ?? false;
  }

  /** All automation on/off flags for a repo, in one read — shared by the pill's
   *  count (GitRail) and the panel's switch rows (AutomationPanel). */
  flags(repoPath: string): AutomationFlags {
    return {
      critic: this.isEnabled(repoPath),
      autoAddress: this.isAutoAddressEnabled(repoPath),
      learnings: this.learningsOn(repoPath),
      autopilot: this.isAutopilotEnabled(repoPath),
      autoDrain: this.isAutoDrainEnabled(repoPath),
      autoMerge: this.isAutoMergeEnabled(repoPath),
      buildQueue: this.isBuildQueueEnabled(repoPath),
      planGate: this.isPlanGateEnabled(repoPath),
    };
  }

  maxAutoFor(repoPath: string): number {
    return this.maxAuto[repoPath] ?? 1;
  }

  autoLabelFor(repoPath: string): string {
    return this.autoLabel[repoPath] ?? "shepherd:auto";
  }

  usageCeilingFor(repoPath: string): number {
    return this.usageCeiling[repoPath] ?? 80;
  }
}
export const repoConfig = new RepoConfigStore();
