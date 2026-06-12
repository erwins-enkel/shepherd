import type { ReviewVerdict, PlanGate, RepoConfig, SandboxProfile } from "./types";
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
  // latest tool-use summary of the in-flight critic, keyed by session id; driven by
  // `session:critic-activity`. Surfaced in the badge tooltip; cleared when the run ends.
  activity = $state<Record<string, string>>({});

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
      this.clearActivity(id); // run ended → its live activity is stale
    }
  }

  /** Record the in-flight critic's latest tool-use summary; ignores an unchanged value
   *  so the server re-emitting the same line every tick causes no reactive churn. */
  setActivity(id: string, summary: string) {
    if (this.activity[id] === summary) return;
    this.activity = { ...this.activity, [id]: summary };
  }

  private clearActivity(id: string) {
    if (!(id in this.activity)) return;
    const copy = { ...this.activity };
    delete copy[id];
    this.activity = copy;
  }

  activityFor(id: string): string | null {
    return this.activity[id] ?? null;
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

/** Per-repo critic + auto-address + learnings + autopilot + drain + automerge + build-queue +
 *  plan-gate + draft-mode (+ sign-off authority) config, cached lazily by repoPath. */
class RepoConfigStore {
  enabled = $state<Record<string, boolean>>({}); // critic on/off (default on)
  autoAddress = $state<Record<string, boolean>>({}); // auto-address loop on/off (default off)
  learnings = $state<Record<string, boolean>>({}); // house-rule injection (default on)
  autopilot = $state<Record<string, boolean>>({}); // autopilot mode (default off)
  autoDrain = $state<Record<string, boolean>>({}); // auto-drain queue (default off)
  autoMerge = $state<Record<string, boolean>>({}); // full-auto merge (default off)
  buildQueue = $state<Record<string, boolean>>({}); // agent-authored build queue (default off)
  planGate = $state<Record<string, boolean>>({}); // pre-execution plan gate (default off)
  draftMode = $state<Record<string, boolean>>({}); // open PRs as drafts (default off; mutually exclusive with autoMerge)
  signoffAuthority = $state<Record<string, "human" | "critic" | "either">>({}); // who may promote draft PRs (default "human")
  sandboxProfile = $state<Record<string, SandboxProfile>>({}); // per-repo sandbox confinement (default "trusted")
  maxAuto = $state<Record<string, number>>({}); // max concurrent auto sessions (default 1)
  autoLabel = $state<Record<string, string>>({}); // label used to pick drain issues (default "shepherd:auto")
  usageCeiling = $state<Record<string, number>>({}); // usage % ceiling before pausing drain (default 80)

  /** Spread a fetched RepoConfig into every per-field $state map for `repoPath`. */
  private ingest(repoPath: string, c: RepoConfig) {
    this.enabled = { ...this.enabled, [repoPath]: c.criticEnabled };
    this.autoAddress = { ...this.autoAddress, [repoPath]: c.autoAddressEnabled };
    this.learnings = { ...this.learnings, [repoPath]: c.learningsEnabled };
    this.autopilot = { ...this.autopilot, [repoPath]: c.autopilotEnabled };
    this.autoDrain = { ...this.autoDrain, [repoPath]: c.autoDrainEnabled };
    this.autoMerge = { ...this.autoMerge, [repoPath]: c.autoMergeEnabled };
    this.buildQueue = { ...this.buildQueue, [repoPath]: c.buildQueueEnabled };
    this.planGate = { ...this.planGate, [repoPath]: c.planGateEnabled };
    this.draftMode = { ...this.draftMode, [repoPath]: c.draftMode };
    this.signoffAuthority = { ...this.signoffAuthority, [repoPath]: c.signoffAuthority };
    this.sandboxProfile = { ...this.sandboxProfile, [repoPath]: c.sandboxProfile };
    this.maxAuto = { ...this.maxAuto, [repoPath]: c.maxAuto };
    this.autoLabel = { ...this.autoLabel, [repoPath]: c.autoLabel };
    this.usageCeiling = { ...this.usageCeiling, [repoPath]: c.usageCeilingPct };
  }

  async ensure(repoPath: string) {
    if (repoPath in this.enabled) return;
    try {
      this.ingest(repoPath, await getRepoConfig(repoPath));
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
        | "draftMode"
        | "signoffAuthority"
        | "sandboxProfile"
        | "maxAuto"
        | "autoLabel"
        | "usageCeilingPct"
      >
    >,
    revert: () => void,
  ) {
    try {
      this.ingest(repoPath, await putRepoConfig(repoPath, patch));
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
    // mutual exclusivity: turning autoMerge ON forces draftMode OFF
    const prevDraft = this.draftMode[repoPath];
    if (next) this.draftMode = { ...this.draftMode, [repoPath]: false };
    await this.apply(
      repoPath,
      next ? { autoMergeEnabled: true, draftMode: false } : { autoMergeEnabled: false },
      () => {
        this.autoMerge = { ...this.autoMerge, [repoPath]: prev };
        if (next) this.draftMode = { ...this.draftMode, [repoPath]: prevDraft };
      },
    );
  }

  async toggleDraftMode(repoPath: string) {
    const prev = this.draftMode[repoPath];
    const next = !this.isDraftModeEnabled(repoPath);
    this.draftMode = { ...this.draftMode, [repoPath]: next }; // optimistic
    // mutual exclusivity: turning draftMode ON forces autoMerge OFF
    const prevAutoMerge = this.autoMerge[repoPath];
    if (next) this.autoMerge = { ...this.autoMerge, [repoPath]: false };
    await this.apply(
      repoPath,
      next ? { draftMode: true, autoMergeEnabled: false } : { draftMode: false },
      () => {
        this.draftMode = { ...this.draftMode, [repoPath]: prev };
        if (next) this.autoMerge = { ...this.autoMerge, [repoPath]: prevAutoMerge };
      },
    );
  }

  async setSignoffAuthority(repoPath: string, value: "human" | "critic" | "either") {
    const prev = this.signoffAuthority[repoPath];
    this.signoffAuthority = { ...this.signoffAuthority, [repoPath]: value }; // optimistic
    await this.apply(repoPath, { signoffAuthority: value }, () => {
      this.signoffAuthority = { ...this.signoffAuthority, [repoPath]: prev };
    });
  }

  async setSandboxProfile(repoPath: string, profile: SandboxProfile) {
    const prev = this.sandboxProfile[repoPath];
    this.sandboxProfile = { ...this.sandboxProfile, [repoPath]: profile }; // optimistic
    await this.apply(repoPath, { sandboxProfile: profile }, () => {
      this.sandboxProfile = { ...this.sandboxProfile, [repoPath]: prev };
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

  isDraftModeEnabled(repoPath: string): boolean {
    return this.draftMode[repoPath] ?? false;
  }

  signoffAuthorityFor(repoPath: string): "human" | "critic" | "either" {
    return this.signoffAuthority[repoPath] ?? "human";
  }

  sandboxProfileFor(repoPath: string): SandboxProfile {
    return this.sandboxProfile[repoPath] ?? "trusted";
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
      draftMode: this.isDraftModeEnabled(repoPath),
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
