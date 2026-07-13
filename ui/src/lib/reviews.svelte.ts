import type { ReviewVerdict, PlanGate, ReviewerEnv, RepoConfig, SandboxProfile } from "./types";
import type { AutomationFlags } from "./components/git-rail-automation";
import { handsOffPatch } from "./components/epic-handsoff";
import type { RepoConfigResponse } from "./api";
import {
  getReviews,
  getReviewingIds,
  getPlanGates,
  getPlanGatesInflight,
  getRepoConfig,
  putRepoConfig,
} from "./api";

/** Max lines kept in a review's rolling live-activity feed (the terminal preview shows these,
 *  newest at the bottom). Bounded so the ephemeral tail can't grow without limit. Also the
 *  banner's reserved preview-row count (--rb-pv-rows) — kept small (2) so the in-flight banner
 *  stays short and can't bury the terminal prompt in a short pane (see ReviewInFlightBanner). */
export const MAX_ACTIVITY_LINES = 2;

/** Append `summary` to a bounded rolling feed, deduping against the last line (the server
 *  re-emits the same summary every tick → no churn). Returns the SAME array reference when
 *  nothing changed so callers can skip a reactive write. */
function pushActivity(cur: string[] | undefined, summary: string): string[] {
  const feed = cur ?? [];
  if (feed[feed.length - 1] === summary) return feed; // unchanged → signal no-op to caller
  return [...feed, summary].slice(-MAX_ACTIVITY_LINES);
}

/** Client cache of critic verdicts keyed by session id. Loaded once on app start;
 *  live updates arrive via the `session:review` WS event (see store.svelte.ts). */
class ReviewsStore {
  map = $state<Record<string, ReviewVerdict>>({});
  // session ids with a critic run currently in flight; driven by `session:reviewing`
  reviewing = $state<Record<string, boolean>>({});
  // rolling live-activity feed (last MAX_ACTIVITY_LINES tool-use summaries) of the in-flight
  // critic, keyed by session id; driven by `session:critic-activity`. Surfaced in the badge
  // tooltip (latest line) and the review-in-flight banner preview (full feed). RESET on both
  // ends of a reviewing transition (start + end) and wiped on bootstrap — see the staleness
  // invariant: no line from a prior run or from before a reconnect may leak into a later preview.
  activity = $state<Record<string, string[]>>({});

  async load() {
    try {
      this.map = await getReviews();
    } catch {
      /* best-effort; live events still populate it */
    }
    try {
      // bootstrap in-flight runs so a reload mid-review still shows the indicator
      this.reviewing = Object.fromEntries((await getReviewingIds()).map((id) => [id, true]));
      // Snapshot carries no historical activity → any pre-existing feed is stale after a resync.
      // Wipe it; the live feed rebuilds from `session:critic-activity` within ~1 tick.
      this.activity = {};
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
    // Any genuine transition resets the feed: on START a new run must begin empty (defensive
    // against a missed end-clear), on END the finished run's live tail is stale. Guarded by the
    // early return above so a repeated same-state call doesn't clear.
    this.clearActivity(id);
    if (on) this.reviewing = { ...this.reviewing, [id]: true };
    else {
      const copy = { ...this.reviewing };
      delete copy[id];
      this.reviewing = copy;
    }
  }

  /** Append the in-flight critic's latest tool-use summary to its bounded rolling feed
   *  (last MAX_ACTIVITY_LINES). Dedups against the last line so the server re-emitting the
   *  same line every tick causes no reactive churn. No `reviewing` gate needed: the preview
   *  only renders in-flight and every run starts empty, so a straggler tick after the end can
   *  never surface (see staleness invariant). */
  setActivity(id: string, summary: string) {
    const next = pushActivity(this.activity[id], summary);
    if (next === this.activity[id]) return; // unchanged reference → no churn
    this.activity = { ...this.activity, [id]: next };
  }

  private clearActivity(id: string) {
    if (!(id in this.activity)) return;
    const copy = { ...this.activity };
    delete copy[id];
    this.activity = copy;
  }

  /** Latest feed line (for the badge tooltip); null when the feed is empty/absent. */
  activityFor(id: string): string | null {
    const feed = this.activity[id];
    return feed && feed.length ? feed[feed.length - 1]! : null;
  }

  /** The full rolling feed (oldest→newest) for the banner preview; [] when absent. */
  activityFeed(id: string): string[] {
    return this.activity[id] ?? [];
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
  // reviewer env (CLI + model + effort) of the in-flight plan reviewer, keyed by session id; carried
  // on the `session:plangate-reviewing` start signal (+ bootstrap). Surfaced on the in-flight
  // "Reviewing…" button so the operator sees which coding CLI/model is doing the review — even on
  // the FIRST review, before a gate (and thus its reviewer* fields) exists.
  reviewerEnv = $state<Record<string, ReviewerEnv>>({});
  // rolling live-activity feed (last MAX_ACTIVITY_LINES) of the in-flight plan reviewer; driven
  // by `session:plangate-activity`, surfaced in the review-in-flight banner preview. Same
  // staleness invariant as ReviewsStore: reset on both ends of a reviewing transition and wiped
  // on bootstrap so no line from a prior run or from before a reconnect leaks into a later preview.
  activity = $state<Record<string, string[]>>({});

  /** Bootstrap from a GET /api/plan-gates snapshot + GET /api/plan-gates/inflight,
   *  so a reload mid-review still shows verdicts, the in-flight indicator, AND which
   *  CLI/model is doing each review. */
  bootstrap(map: Record<string, PlanGate>, inflight: Array<{ id: string } & ReviewerEnv>) {
    this.map = map;
    this.reviewing = Object.fromEntries(inflight.map(({ id }) => [id, true]));
    this.reviewerEnv = Object.fromEntries(
      inflight.map(({ id, provider, model, effort }) => [id, { provider, model, effort }]),
    );
    // Snapshot carries no historical activity → wipe any stale feed; it rebuilds from
    // `session:plangate-activity` within ~1 tick. Covers load() (which calls through here).
    this.activity = {};
  }

  /** Re-fetch the snapshot + in-flight ids from the server (best-effort). */
  async load() {
    let map: Record<string, PlanGate> = {};
    let inflight: Array<{ id: string } & ReviewerEnv> = [];
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

  applyReviewing(id: string, on: boolean, env?: ReviewerEnv) {
    // Env cache write runs BEFORE the transition guard below: a redundant `true` (bootstrap-then-WS
    // interleave on reload, or a re-emitted signal) doesn't transition `reviewing`, but must still
    // refresh the identity. On end (`false`) drop it so a stale env can't linger past the run.
    if (on) {
      if (env) this.reviewerEnv = { ...this.reviewerEnv, [id]: env };
    } else if (id in this.reviewerEnv) {
      const copy = { ...this.reviewerEnv };
      delete copy[id];
      this.reviewerEnv = copy;
    }
    if (!!this.reviewing[id] === on) return;
    // Reset the feed on both ends of a transition (start = fresh empty run, end = stale tail).
    this.clearActivity(id);
    if (on) this.reviewing = { ...this.reviewing, [id]: true };
    else {
      const copy = { ...this.reviewing };
      delete copy[id];
      this.reviewing = copy;
    }
  }

  /** The in-flight reviewer's env (CLI + model + effort) for a session, or null when none is
   *  known (no review running, or a run whose env hasn't arrived yet). */
  reviewerEnvFor(id: string): ReviewerEnv | null {
    return this.reviewerEnv[id] ?? null;
  }

  /** Append the in-flight plan reviewer's latest tool-use summary to its bounded rolling feed
   *  (last MAX_ACTIVITY_LINES), deduping against the last line. Mirrors ReviewsStore.setActivity. */
  setActivity(id: string, summary: string) {
    const next = pushActivity(this.activity[id], summary);
    if (next === this.activity[id]) return; // unchanged reference → no churn
    this.activity = { ...this.activity, [id]: next };
  }

  private clearActivity(id: string) {
    if (!(id in this.activity)) return;
    const copy = { ...this.activity };
    delete copy[id];
    this.activity = copy;
  }

  /** The full rolling feed (oldest→newest) for the banner preview; [] when absent. */
  activityFeed(id: string): string[] {
    return this.activity[id] ?? [];
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
  allPrs = $state<Record<string, boolean>>({}); // standalone repo-wide PR critic on/off (default off)
  autoAddress = $state<Record<string, boolean>>({}); // auto-address loop on/off (default off)
  learnings = $state<Record<string, boolean>>({}); // house-rule injection (default on)
  autopilot = $state<Record<string, boolean>>({}); // autopilot mode (default off)
  autoDrain = $state<Record<string, boolean>>({}); // auto-drain queue (default off)
  autoMerge = $state<Record<string, boolean>>({}); // full-auto merge (default off)
  buildQueue = $state<Record<string, boolean>>({}); // agent-authored build queue (default off)
  autoOptimize = $state<Record<string, boolean>>({}); // auto-optimize flagged rules (default off)
  manualStepsIssue = $state<Record<string, boolean>>({}); // GitHub tracking issue on merge (default off, #1061)
  preWarmEpicLandingCi = $state<Record<string, boolean>>({}); // pre-warm epic landing CI via early draft PR (default off, #1664)
  hidden = $state<Record<string, boolean>>({}); // hidden from the Backlog repos panel (optimistic overlay over payload; default off)
  planGate = $state<Record<string, boolean>>({}); // pre-execution plan gate (default off)
  draftMode = $state<Record<string, boolean>>({}); // open PRs as drafts (default off; mutually exclusive with autoMerge)
  signoffAuthority = $state<Record<string, "human" | "critic" | "either">>({}); // who may promote draft PRs (default "human")
  repoMode = $state<Record<string, "forge" | "lightweight">>({}); // forge vs lightweight local mode (default "forge")
  sandboxProfile = $state<Record<string, SandboxProfile>>({}); // per-repo sandbox confinement (default "trusted")
  defaultModel = $state<Record<string, string>>({}); // per-repo default-model override (default "inherit")
  defaultEffort = $state<Record<string, string>>({}); // per-repo default-effort override (default "inherit")
  previewOpenMode = $state<Record<string, RepoConfig["previewOpenMode"]>>({}); // Preview chip action (default ask)
  maxAuto = $state<Record<string, number>>({}); // max concurrent auto sessions (default 1)
  autoLabel = $state<Record<string, string>>({}); // label used to pick drain issues (default "shepherd:auto")
  usageCeiling = $state<Record<string, number>>({}); // usage % ceiling before pausing drain (default 80)
  confirmed = $state<Record<string, boolean>>({}); // automation reviewed+confirmed for this repo (issue #1025)
  rowExists = $state<Record<string, boolean>>({}); // a repo_config row exists server-side
  // repoPaths whose ensure() fetch has resolved (success OR failure). Distinct from
  // "has a value": a failed fetch leaves the per-field maps unset yet must count as
  // settled so the UI stops showing a loading state and falls back to defaults.
  settled = $state<Record<string, boolean>>({});
  // repoPaths whose config has been successfully loaded from an authoritative
  // server response. Unlike settled, failed fetches never mark loaded.
  loaded = $state<Record<string, boolean>>({});
  private ensureInflight = new Map<string, Promise<boolean>>();

  /** Spread a fetched RepoConfigResponse into every per-field $state map for `repoPath`. */
  private ingest(repoPath: string, c: RepoConfigResponse) {
    this.enabled = { ...this.enabled, [repoPath]: c.criticEnabled };
    this.allPrs = { ...this.allPrs, [repoPath]: c.criticAllPrs };
    this.autoAddress = { ...this.autoAddress, [repoPath]: c.autoAddressEnabled };
    this.learnings = { ...this.learnings, [repoPath]: c.learningsEnabled };
    this.autopilot = { ...this.autopilot, [repoPath]: c.autopilotEnabled };
    this.autoDrain = { ...this.autoDrain, [repoPath]: c.autoDrainEnabled };
    this.autoMerge = { ...this.autoMerge, [repoPath]: c.autoMergeEnabled };
    this.buildQueue = { ...this.buildQueue, [repoPath]: c.buildQueueEnabled };
    this.autoOptimize = { ...this.autoOptimize, [repoPath]: c.autoOptimizeFlagged };
    this.manualStepsIssue = { ...this.manualStepsIssue, [repoPath]: c.manualStepsIssueEnabled };
    this.preWarmEpicLandingCi = {
      ...this.preWarmEpicLandingCi,
      [repoPath]: c.preWarmEpicLandingCi,
    };
    this.hidden = { ...this.hidden, [repoPath]: c.hidden };
    this.planGate = { ...this.planGate, [repoPath]: c.planGateEnabled };
    this.draftMode = { ...this.draftMode, [repoPath]: c.draftMode };
    this.signoffAuthority = { ...this.signoffAuthority, [repoPath]: c.signoffAuthority };
    this.repoMode = { ...this.repoMode, [repoPath]: c.repoMode };
    this.sandboxProfile = { ...this.sandboxProfile, [repoPath]: c.sandboxProfile };
    this.defaultModel = { ...this.defaultModel, [repoPath]: c.defaultModel };
    this.defaultEffort = { ...this.defaultEffort, [repoPath]: c.defaultEffort };
    this.previewOpenMode = { ...this.previewOpenMode, [repoPath]: c.previewOpenMode };
    this.maxAuto = { ...this.maxAuto, [repoPath]: c.maxAuto };
    this.autoLabel = { ...this.autoLabel, [repoPath]: c.autoLabel };
    this.usageCeiling = { ...this.usageCeiling, [repoPath]: c.usageCeilingPct };
    if (c.automationConfirmed !== undefined)
      this.confirmed = { ...this.confirmed, [repoPath]: c.automationConfirmed };
    if (c.automationRowExists !== undefined)
      this.rowExists = { ...this.rowExists, [repoPath]: c.automationRowExists };
    this.markSettled(repoPath);
    if (!this.loaded[repoPath]) this.loaded = { ...this.loaded, [repoPath]: true };
  }

  /** Idempotently mark a repo's config as settled; no-op (no reactive write) if it
   *  already is, so calling it from an effect can't self-trigger an update loop. */
  private markSettled(repoPath: string) {
    if (this.settled[repoPath]) return;
    this.settled = { ...this.settled, [repoPath]: true };
  }

  /** Returns whether the config is actually available (loaded now or already cached).
   *  False means the fetch FAILED and the per-repo maps are unset — callers that act on
   *  confirmed/rowExists (e.g. the first-task seed/confirm gate) must NOT treat that as a
   *  genuine "new repo", or a transient GET failure would mis-seed an existing repo. */
  async ensure(repoPath: string): Promise<boolean> {
    if (this.loaded[repoPath]) {
      this.markSettled(repoPath); // already-loaded ⇒ settled
      return true;
    }
    const existing = this.ensureInflight.get(repoPath);
    if (existing) return existing;
    const pending = this.load(repoPath);
    this.ensureInflight.set(repoPath, pending);
    try {
      return await pending;
    } finally {
      this.ensureInflight.delete(repoPath);
    }
  }

  private async load(repoPath: string): Promise<boolean> {
    try {
      this.ingest(repoPath, await getRepoConfig(repoPath));
      return true;
    } catch {
      /* leave unset; UI shows defaults optimistically */
      return false;
    } finally {
      // mark settled on every exit (success AND failure) so a failed fetch never
      // wedges the UI in a loading state — it falls back to defaults instead.
      this.markSettled(repoPath);
    }
  }

  /** Whether ensure() for this repo has resolved (success or failure). False until the
   *  fetch lands; the new-task composer reads this to avoid showing the plan-gate box
   *  as "off" while its repo default is still loading. */
  isConfigSettled(repoPath: string): boolean {
    return this.settled[repoPath] ?? false;
  }

  isConfigLoaded(repoPath: string): boolean {
    return this.loaded[repoPath] ?? false;
  }

  /** Optimistically apply a patch, then reconcile from the server (or revert on error). */
  private async apply(
    repoPath: string,
    patch: Partial<
      Pick<
        RepoConfig,
        | "criticEnabled"
        | "criticAllPrs"
        | "autoAddressEnabled"
        | "learningsEnabled"
        | "autopilotEnabled"
        | "autoDrainEnabled"
        | "autoMergeEnabled"
        | "buildQueueEnabled"
        | "autoOptimizeFlagged"
        | "manualStepsIssueEnabled"
        | "preWarmEpicLandingCi"
        | "hidden"
        | "planGateEnabled"
        | "draftMode"
        | "signoffAuthority"
        | "sandboxProfile"
        | "defaultModel"
        | "defaultEffort"
        | "previewOpenMode"
        | "maxAuto"
        | "autoLabel"
        | "usageCeilingPct"
        | "repoMode"
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

  async toggleAllPrs(repoPath: string) {
    const prev = this.allPrs[repoPath];
    const next = !this.isAllPrsEnabled(repoPath);
    this.allPrs = { ...this.allPrs, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { criticAllPrs: next }, () => {
      this.allPrs = { ...this.allPrs, [repoPath]: prev };
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

  /** Effective hidden state for a repo: the optimistic overlay if this client has
   *  toggled it, else the server-provided baseline (`fallback`, from the backlog payload). */
  isHidden(repoPath: string, fallback: boolean): boolean {
    return this.hidden[repoPath] ?? fallback;
  }

  /** Hide/unhide a repo from the Backlog panel. `current` is the effective state being
   *  flipped (overlay or payload baseline). Optimistic, reverts on a failed PUT. */
  async toggleHidden(repoPath: string, current: boolean) {
    const prev = this.hidden[repoPath];
    const next = !current;
    this.hidden = { ...this.hidden, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { hidden: next }, () => {
      this.hidden = { ...this.hidden, [repoPath]: prev };
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

  /** Apply the recommended "hands-off epic" repo defaults in one atomic PUT: Autopilot on,
   *  Full-auto merge on (forces Draft off), Critic on, Auto-Address on. Deliberately does NOT
   *  touch planGateEnabled — Plan gate is recommended ON (the seeded default) and is hands-off-safe
   *  (see components/epic-handsoff.ts). Optimistic; on a failed PUT it reverts every field AND
   *  rethrows (unlike the fire-and-forget toggles) so the caller can surface the failure and NOT
   *  latch the intro as done — mirrors confirmAutomation(). */
  async applyHandsOffDefaults(repoPath: string) {
    const prev = {
      autopilot: this.autopilot[repoPath],
      autoMerge: this.autoMerge[repoPath],
      draftMode: this.draftMode[repoPath],
      critic: this.enabled[repoPath],
      autoAddress: this.autoAddress[repoPath],
    };
    // optimistic
    this.autopilot = { ...this.autopilot, [repoPath]: true };
    this.autoMerge = { ...this.autoMerge, [repoPath]: true };
    this.draftMode = { ...this.draftMode, [repoPath]: false };
    this.enabled = { ...this.enabled, [repoPath]: true };
    this.autoAddress = { ...this.autoAddress, [repoPath]: true };
    try {
      this.ingest(repoPath, await putRepoConfig(repoPath, handsOffPatch()));
    } catch (e) {
      this.autopilot = { ...this.autopilot, [repoPath]: prev.autopilot };
      this.autoMerge = { ...this.autoMerge, [repoPath]: prev.autoMerge };
      this.draftMode = { ...this.draftMode, [repoPath]: prev.draftMode };
      this.enabled = { ...this.enabled, [repoPath]: prev.critic };
      this.autoAddress = { ...this.autoAddress, [repoPath]: prev.autoAddress };
      throw e; // surface to the caller so the intro shows the failure toast and stays open
    }
  }

  async setSignoffAuthority(repoPath: string, value: "human" | "critic" | "either") {
    const prev = this.signoffAuthority[repoPath];
    this.signoffAuthority = { ...this.signoffAuthority, [repoPath]: value }; // optimistic
    await this.apply(repoPath, { signoffAuthority: value }, () => {
      this.signoffAuthority = { ...this.signoffAuthority, [repoPath]: prev };
    });
  }

  async setRepoMode(repoPath: string, mode: "forge" | "lightweight") {
    const prev = this.repoMode[repoPath];
    this.repoMode = { ...this.repoMode, [repoPath]: mode }; // optimistic
    await this.apply(repoPath, { repoMode: mode }, () => {
      this.repoMode = { ...this.repoMode, [repoPath]: prev };
    });
  }

  async setSandboxProfile(repoPath: string, profile: SandboxProfile) {
    const prev = this.sandboxProfile[repoPath];
    this.sandboxProfile = { ...this.sandboxProfile, [repoPath]: profile }; // optimistic
    await this.apply(repoPath, { sandboxProfile: profile }, () => {
      this.sandboxProfile = { ...this.sandboxProfile, [repoPath]: prev };
    });
  }

  async setDefaultModel(repoPath: string, value: string) {
    const prev = this.defaultModel[repoPath];
    this.defaultModel = { ...this.defaultModel, [repoPath]: value }; // optimistic
    await this.apply(repoPath, { defaultModel: value }, () => {
      this.defaultModel = { ...this.defaultModel, [repoPath]: prev };
    });
  }

  async setDefaultEffort(repoPath: string, value: string) {
    const prev = this.defaultEffort[repoPath];
    this.defaultEffort = { ...this.defaultEffort, [repoPath]: value }; // optimistic
    await this.apply(repoPath, { defaultEffort: value }, () => {
      this.defaultEffort = { ...this.defaultEffort, [repoPath]: prev };
    });
  }

  async setPreviewOpenMode(repoPath: string, value: RepoConfig["previewOpenMode"]) {
    const prev = this.previewOpenMode[repoPath];
    this.previewOpenMode = { ...this.previewOpenMode, [repoPath]: value }; // optimistic
    await this.apply(repoPath, { previewOpenMode: value }, () => {
      this.previewOpenMode = { ...this.previewOpenMode, [repoPath]: prev };
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

  async toggleAutoOptimize(repoPath: string) {
    const prev = this.autoOptimize[repoPath];
    const next = !this.autoOptimizeOn(repoPath);
    this.autoOptimize = { ...this.autoOptimize, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { autoOptimizeFlagged: next }, () => {
      this.autoOptimize = { ...this.autoOptimize, [repoPath]: prev };
    });
  }

  async toggleManualStepsIssue(repoPath: string) {
    const prev = this.manualStepsIssue[repoPath];
    const next = !this.manualStepsIssueOn(repoPath);
    this.manualStepsIssue = { ...this.manualStepsIssue, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { manualStepsIssueEnabled: next }, () => {
      this.manualStepsIssue = { ...this.manualStepsIssue, [repoPath]: prev };
    });
  }

  async togglePreWarmEpicLandingCi(repoPath: string) {
    const prev = this.preWarmEpicLandingCi[repoPath];
    const next = !this.preWarmEpicLandingCiOn(repoPath);
    this.preWarmEpicLandingCi = { ...this.preWarmEpicLandingCi, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { preWarmEpicLandingCi: next }, () => {
      this.preWarmEpicLandingCi = { ...this.preWarmEpicLandingCi, [repoPath]: prev };
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

  isAllPrsEnabled(repoPath: string): boolean {
    return this.allPrs[repoPath] ?? false;
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

  manualStepsIssueOn(repoPath: string): boolean {
    return this.manualStepsIssue[repoPath] ?? false;
  }

  preWarmEpicLandingCiOn(repoPath: string): boolean {
    return this.preWarmEpicLandingCi[repoPath] ?? false;
  }

  autoOptimizeOn(repoPath: string): boolean {
    return this.autoOptimize[repoPath] ?? false;
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

  repoModeFor(repoPath: string): "forge" | "lightweight" {
    return this.repoMode[repoPath] ?? "forge";
  }

  sandboxProfileFor(repoPath: string): SandboxProfile {
    return this.sandboxProfile[repoPath] ?? "trusted";
  }

  /** The repo's default-model override SETTING ("inherit" | "auto" | "default" | <model>). */
  defaultModelFor(repoPath: string): string {
    return this.defaultModel[repoPath] ?? "inherit";
  }

  /** The repo's default-effort override SETTING ("inherit" | "default" | <tier>). */
  defaultEffortFor(repoPath: string): string {
    return this.defaultEffort[repoPath] ?? "inherit";
  }

  previewOpenModeFor(repoPath: string): RepoConfig["previewOpenMode"] {
    return this.previewOpenMode[repoPath] ?? "ask";
  }

  previewOpenModeForLoaded(repoPath: string): RepoConfig["previewOpenMode"] | null {
    if (this.isConfigLoaded(repoPath)) return this.previewOpenModeFor(repoPath);
    return this.isConfigSettled(repoPath) ? "ask" : null;
  }

  /** All automation on/off flags for a repo, in one read — shared by the pill's
   *  count (GitRail) and the panel's switch rows (AutomationPanel). */
  flags(repoPath: string): AutomationFlags {
    return {
      critic: this.isEnabled(repoPath),
      criticAllPrs: this.isAllPrsEnabled(repoPath),
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

  isAutomationConfirmed(repoPath: string): boolean {
    return this.confirmed[repoPath] ?? false;
  }

  automationRowExists(repoPath: string): boolean {
    return this.rowExists[repoPath] ?? false;
  }

  /** Seed a brand-new repo with the raised default posture (plan-gate ON). Only call when no
   *  repo_config row exists yet — guarded by automationRowExists() at the call site (Task 3) — so it
   *  never clobbers an existing repo's planGate choice. */
  async seedNewRepoDefaults(repoPath: string) {
    const prev = this.planGate[repoPath];
    this.planGate = { ...this.planGate, [repoPath]: true }; // optimistic
    await this.apply(repoPath, { planGateEnabled: true }, () => {
      this.planGate = { ...this.planGate, [repoPath]: prev };
    });
  }

  /** Mark this repo's automation as reviewed+confirmed (issue #1025). PUT returns the wrapped
   *  response; ingest() updates the confirmed/rowExists maps from it. */
  async confirmAutomation(repoPath: string) {
    const prev = this.confirmed[repoPath];
    this.confirmed = { ...this.confirmed, [repoPath]: true }; // optimistic
    try {
      this.ingest(repoPath, await putRepoConfig(repoPath, { automationConfirmed: true }));
    } catch (e) {
      this.confirmed = { ...this.confirmed, [repoPath]: prev };
      throw e; // surface to the caller so the spawn doesn't proceed on a failed confirm
    }
  }
}
export const repoConfig = new RepoConfigStore();
