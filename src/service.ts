import { randomUUID } from "node:crypto";
import type { SessionStore } from "./store";
import type { EventHub } from "./events";
import type { WorktreeMgr } from "./worktree";
import type { HerdrDriver } from "./herdr";
import { matchAgents } from "./herdr";
import { config } from "./config";
import type { CreateSessionInput, Session } from "./types";
import { moveStagedIntoWorktree } from "./uploads";
import { slugifyManual } from "./namer";
import type { Leftover, ProcessReaper } from "./process-reaper";
import { planHouseRulesInjection, renderHouseRulesBlock } from "./house-rules";

/** A merge-train mark older than this is treated as stale and swept, so a
 *  rejected/held-back PR (never merged, train never archived) can't stay
 *  "Merging" forever. Mirrored in ui/src/lib/components/merge-train.ts. */
export const MERGE_STALE_MS = 30 * 60_000;

/** Absolute backstop for a STILL-RUNNING merge-train completion-tracker entry: a
 *  train session that dies without ever emitting `session:archived` would orphan
 *  its live entry forever, so the sweep reclaims a live entry this long after launch.
 *  Set far beyond any realistic run (no merge train runs for a day) so it can only
 *  reclaim a genuinely dead train, never one still landing PRs. */
export const TRAIN_TRACKER_MAX_MS = 24 * 60 * 60_000;

export interface ServiceDeps {
  store: SessionStore;
  worktree: Pick<
    WorktreeMgr,
    "create" | "remove" | "renameBranch" | "branchExists" | "commitsAhead" | "currentBranch"
  >;
  herdr: Pick<HerdrDriver, "start" | "list" | "stop" | "send" | "relabel">;
  namer: (prompt: string) => string | Promise<string>;
  /** Background namer: comprehends the prompt into a slug (null = keep heuristic). Absent → no refine. */
  refineName?: (args: { taskText: string; label: string }) => Promise<string | null>;
  /** Event bus for live state pushes (e.g. session:ready); absent in tests that skip it. */
  events?: Pick<EventHub, "emit">;
  /** Inject point for tests; defaults to the real fs move. */
  moveUploads?: (images: string[], worktreePath: string) => string[];
  /** Detects/terminates leftover subprocesses at close; absent in tests that skip it. */
  reaper?: Pick<ProcessReaper, "detect" | "reap">;
  /** Fast-poll one session's PR (= prPoller.pollSession), to nudge merge detection
   *  when a merge train archives before the 120s sweep surfaces its members' merges.
   *  Fire-and-forget, debounced, no-ops on archived sessions. Absent → no nudge. */
  refreshPr?: (id: string) => void;
}

/**
 * Per-spawn `--settings` overlay merged on top of the user's settings files.
 * Pins `remoteControlAtStartup` so a global opt-in in ~/.claude/settings.json
 * doesn't auto-start Claude Code's Remote Control for every Shepherd session
 * (default false suppresses the notification noise); `/remote-control` in the
 * terminal still toggles it per-session.
 */
export function spawnSettingsOverlay(): string {
  return JSON.stringify({ remoteControlAtStartup: config.remoteControlAtStartup });
}

/**
 * Appended to every spawned session's system prompt. The async namer
 * (`refineNameInBackground`) can `git branch -m` the session branch 10–60s after
 * start — while the agent is already working — so an agent that inspects git state
 * mid-task would otherwise read the changed branch name as an error (cf. TASK-177).
 * Pre-warning it at spawn removes the surprise at the source. Not user-facing chrome
 * (it's an instruction to the agent), so no i18n.
 */
const BRANCH_RENAME_NOTICE =
  "Shepherd may rename this session's git branch shortly after startup to a clearer, " +
  "prompt-derived name (via `git branch -m`). This is expected: your working tree, " +
  "commits, and checked-out HEAD are unaffected — never treat a changed branch name as an error.";

/**
 * Universal engineering posture injected into every spawn (issue #349, adapted from the
 * MIT-licensed Karpathy-style Claude Code skills). Unlike the `<shepherd-house-rules>` block
 * — per-repo, learned, budget-limited and toggle-gated — this is fixed, repo-independent
 * standing posture, so it lives in source and rides every spawn unconditionally.
 *
 * It biases the agent *against over-building*, the classic unattended-overnight failure mode
 * the curated (defect-prevention) house rules don't cover. Scope notes baked into the wording:
 *  - "Think before coding" is deliberately scoped to PRE-EXECUTION. Once running autonomously,
 *    the autopilot don't-pause-to-ask rule still wins — the agent proceeds on stated assumptions.
 *  - The dead-code clause harmonizes with the curated "don't ship dead code" rule: remove only
 *    what YOUR change orphaned; surface (don't silently delete) pre-existing unrelated dead code.
 * Agent-facing prompt text (not operator UI), so fixed English — same precedent as
 * BRANCH_RENAME_NOTICE and the distiller/critic spawn prompts.
 */
const ENGINEERING_POSTURE =
  "Standing engineering posture for every change — adopt it regardless of the task.\n" +
  "- Think before coding (pre-execution only): before you start, state your key assumptions, " +
  "surface genuine ambiguity and any clearly simpler approach, and name what's unclear. Resolve " +
  "this up front — once you are executing autonomously, do NOT pause to ask; proceed on your stated assumptions.\n" +
  "- Simplicity first: write the minimum code that solves the stated problem, nothing speculative. " +
  "No features beyond what was asked, no abstractions for single-use code, no unrequested " +
  "flexibility/config, no error handling for genuinely impossible cases. Test: would a senior " +
  "engineer call this overcomplicated?\n" +
  "- Surgical changes: touch only what the task requires — every changed line should trace to the " +
  "request. Don't refactor working code, reformat, or polish adjacent code/comments; match existing " +
  "style. Delete only the imports/vars/functions YOUR change orphaned; for pre-existing unrelated " +
  "dead code, surface it rather than silently expanding the diff.\n" +
  "- Goal-driven execution: turn the task into explicit, verifiable success criteria up front, then " +
  "loop until they actually pass — never declare work done before verifying against them.";

/**
 * Fixed, repo-independent standing guidance injected into every spawn (issue #347, sourced from
 * the upstream Tank unattended prompt). Counterpart to ENGINEERING_POSTURE: that block stops the
 * agent *over-building*; this one stops it building against a *stale or assumed* external API. Left
 * uncorrected on an overnight/unattended run, the agent confidently scaffolds many files against a
 * library version or pattern that's no longer current, with no human to catch it early — a cheap
 * web search up front is high-leverage insurance against that.
 *
 * Deliberately scoped to non-trivial code against an external library/framework/API the agent isn't
 * sure is current, so it doesn't fire a search on every trivial edit or well-known pattern. WebSearch
 * is already allowed for task agents, so this adds no new permission prompt. Agent-facing prompt text
 * (not operator UI), so fixed English — same precedent as the other notices.
 */
const RESEARCH_FIRST_NOTICE =
  "Before writing non-trivial code against an external library, framework, or API — especially one " +
  "you're not certain is current — do a quick web search to confirm the present best approach, then " +
  "note in one or two lines what you found and why you chose it. Skip this for trivial edits and " +
  "well-established patterns you're already confident about; it exists to stop you scaffolding many " +
  "files against a stale or assumed API with no human to correct course.";

/**
 * Injected into the system prompt only for isolated sessions (worktree-backed). Non-isolated
 * sessions share the main repo directory and have no dedicated worktree, so the file would be
 * ambiguous and the hint would be misleading — it is intentionally omitted there.
 *
 * The hint is advisory and safe: Shepherd uses the declared port only when it is actually
 * listening (auto-detection still fires otherwise), and it explicitly never starts or stops the
 * dev server. Agent-facing prompt text (not operator UI), so fixed English — same precedent as
 * BRANCH_RENAME_NOTICE and the other spawn-constant notices. No i18n.
 */
const PREVIEW_HINT_NOTICE =
  "If you start a long-running dev server in this worktree and want Shepherd's live preview to " +
  "target a specific port, write that port — a bare number, nothing else — to a file named " +
  "`.shepherd-preview` in the repository root. Shepherd uses it only when that port is actually " +
  "listening; otherwise it auto-detects the port. This is optional: skip it if you have no dev " +
  "server or the default detection already targets the right port. Shepherd never starts or stops " +
  "your dev server.";

/**
 * Seeded into the system prompt at spawn when the repo has autopilot on, so the agent knows
 * up front it's running unattended. Without it autopilot is purely reactive — the agent stops
 * to ask "commit + open a PR?", and a steer only lands after a stop is detected and classified
 * (which the operator routinely beats by answering manually). Stating the contract up front
 * stops the procedural halt at the source. Deliberately conditional ("for a code change…") so a
 * research / issue-creation task isn't pushed to open a meaningless PR. Not user-facing chrome
 * (an instruction to the agent), so no i18n.
 */
const AUTOPILOT_DIRECTIVE =
  "You are running unattended in Shepherd autopilot. Do not stop to ask for permission on " +
  "procedural or workflow steps — writing a spec or plan, committing, pushing, or opening a " +
  "pull request. Make a reasonable decision and keep going until the task's deliverable is " +
  "complete; for a code change that means an open PR (`gh pr create`). Only stop to ask when " +
  "you hit a genuine product or requirements decision that only a human can make.";

/**
 * Build the build-queue directive injected at spawn when the repo has `buildQueueEnabled`.
 *
 * The build queue is a per-session, ordered, self-revising plan: the agent authors it via a
 * local REST API right after reading the task, a human (or autopilot) approves it, then the
 * agent executes it step-by-step IN THIS SAME SESSION so it retains full context throughout.
 *
 * Why bake the actual endpoint + session id at spawn time (rather than leaving the agent to
 * discover them)? Two reasons:
 *  1. Reliability: the agent doesn't have to guess the server address or its own session id
 *     under an unattended run — a misread would silently produce an unreachable URL.
 *  2. Curation gate: the autopilot/attended split is a policy decision that should be stated
 *     up front, not inferred mid-run. The agent knows BEFORE starting whether it must wait
 *     for human approval or may immediately execute after authoring.
 *
 * Token/auth: when `config.token` is set the server requires `Authorization: Bearer <token>`;
 * when null it's open to loopback callers — the curl lines must match exactly.
 *
 * SECURITY NOTE: baking the bearer token into the spawn prompt means it is persisted into the
 * agent's Claude Code transcript jsonl on disk (`~/.claude/projects/.../<session>.jsonl`). This
 * is an accepted exposure, not an oversight: the token is Shepherd's own loopback control-plane
 * secret, the transcript lives under the same user account on the same host, and the agent is
 * already spawned with `--dangerously-skip-permissions` (it can read that token from the running
 * server's env or config anyway). The exposure is also opt-in — most deployments leave
 * `config.token` null, so nothing is written. It is NOT a credential that reaches any third party.
 *
 * Agent-facing prompt text (not operator UI), so fixed English — same precedent as
 * AUTOPILOT_DIRECTIVE, BRANCH_RENAME_NOTICE, and the other spawn-constant notices.
 */
function buildQueueDirective(args: {
  sessionId: string;
  baseUrl: string;
  token: string | null;
  autopilot: boolean;
}): string {
  const { sessionId, baseUrl, token, autopilot } = args;
  const authHeader = token ? ` \\\n  -H "Authorization: Bearer ${token}"` : "";
  const queueUrl = `${baseUrl}/api/sessions/${sessionId}/queue`;

  const curationGate = autopilot
    ? "No human will gate this run — the queue is auto-approved for visibility and curation. " +
      "Author the queue, then immediately begin executing the steps in order without waiting."
    : "After you author the queue, STOP and wait. A human will review, edit, and approve it " +
      "in the UI; you will then receive a message telling you to begin. " +
      "Do NOT start executing steps until you get that go-ahead.";

  return (
    "This session has a build queue: an ordered, curatable, self-revising plan that you author " +
    "via the Shepherd API, then execute step-by-step IN THIS SAME SESSION. Each step builds on " +
    "the previous one and you retain full context throughout — no context loss between steps.\n\n" +
    "Build-queue API (use these exact curl commands):\n\n" +
    "1. Author / replace the whole plan (do this first, before starting any work):\n" +
    `   curl -s -X PUT${authHeader} \\\n` +
    `     -H "Content-Type: application/json" \\\n` +
    `     -d '{"steps":[{"title":"Step title","detail":"Optional detail"}]}' \\\n` +
    `     ${queueUrl}\n` +
    "   The response returns each step with a generated `id` and the queue's `approved` flag.\n\n" +
    "2. Mark a step's progress (use the `id` values from the PUT/GET response):\n" +
    `   curl -s -X POST${authHeader} \\\n` +
    `     -H "Content-Type: application/json" \\\n` +
    '     -d \'{"status":"active"}\' \\\n' +
    `     ${queueUrl}/steps/{stepId}     # when you start a step\n` +
    `   curl -s -X POST${authHeader} \\\n` +
    `     -H "Content-Type: application/json" \\\n` +
    '     -d \'{"status":"done"}\' \\\n' +
    `     ${queueUrl}/steps/{stepId}     # when you finish a step\n` +
    '   Use "skipped" if you decide to drop a step.\n\n' +
    "3. Inspect the current queue at any time:\n" +
    `   curl -s${authHeader} ${queueUrl}\n\n` +
    "Self-revision: if you discover a better approach mid-run, PUT an updated steps array. " +
    "Only add, change, or remove steps that are still PENDING. To preserve a completed step, " +
    "include it with its existing `id` (its status is kept server-side).\n\n" +
    "Runaway guard: keep the plan small and focused (a handful of steps). " +
    "Do not let self-revision loop indefinitely — each PUT should reflect a genuine course correction, " +
    "not iterative micro-adjustment.\n\n" +
    curationGate
  );
}

/**
 * Pre-execution PLAN GATE directives. When the plan gate is on for a session, one of these
 * REPLACES the autopilot directive during the planning phase — planning deliberately suppresses
 * autopilot so the agent stops to plan/grill instead of rushing to a PR. The interactive variant
 * grills a present human; the auto variant runs unattended (drain) and just writes the plan.
 * English, not i18n'd — agent-facing prompt text, same precedent as AUTOPILOT_DIRECTIVE.
 */
const PLAN_GATE_DIRECTIVE_INTERACTIVE =
  "You are in Shepherd's pre-execution PLAN GATE. Do NOT write or modify any product code yet.\n" +
  "1. Research the codebase enough to plan confidently.\n" +
  "2. Grill the user: ask sharp, specific clarifying questions until you and the user are genuinely " +
  "aligned on scope, approach, and success criteria. Misalignment now is the costliest failure.\n" +
  "3. When aligned, write the plan to `.shepherd-plan.md` at the repo root (goal, approach, files, " +
  "steps, risks, success criteria) and tell the user it's ready for review.\n" +
  "An adversarial reviewer will critique the plan; address its findings by revising `.shepherd-plan.md`. " +
  "Begin implementing ONLY after the plan is approved and you are told to execute.";
const PLAN_GATE_DIRECTIVE_AUTO =
  "You are in Shepherd's pre-execution PLAN GATE, running unattended (no human to ask). Do NOT write " +
  "or modify product code yet. Research the codebase, then write a concrete plan to `.shepherd-plan.md` " +
  "at the repo root (goal, approach, files, steps, risks, success criteria). An adversarial reviewer " +
  "will critique it; revise `.shepherd-plan.md` to address findings. Begin implementing ONLY after you " +
  "are told the plan is approved.";
export { PLAN_GATE_DIRECTIVE_INTERACTIVE, PLAN_GATE_DIRECTIVE_AUTO };

/** Steered into a planning session when its plan is approved and the operator hits Go (or an
 *  auto session auto-releases). Hands the agent from the grill/plan phase into execution. NOT i18n'd. */
const PLAN_GO_STEER =
  "Plan approved. Execute `.shepherd-plan.md` now, autonomously — implement it fully, commit, push, " +
  "and open a pull request (`gh pr create`). Don't re-litigate the plan; if you hit a genuine product " +
  "decision that only the user can make, ask, otherwise keep going.";

/**
 * Compose the spawn-time system prompt passed via a single `--append-system-prompt`
 * (the flag is last-wins, not repeatable, so all blocks must share one value).
 *
 * House rules used to be prepended to the human prompt, which let standing guidance bleed
 * into the task on every spawn. They now live in the system prompt, each block XML-wrapped
 * so the agent can cleanly separate persistent guidance from the task in its human turn.
 * `houseRules` is the already-wrapped `<shepherd-house-rules>` block, or null when there are
 * none / learnings are disabled; the engineering-posture, research-first, and branch-rename blocks
 * always ride. `autopilotActive` appends the autopilot directive (see above), UNLESS `opts.planGate`
 * is set: the plan gate and autopilot are mutually exclusive. During the planning phase the matching
 * plan-gate directive (interactive/auto) is appended INSTEAD of the autopilot directive, even when
 * `autopilotActive` is true — planning must suppress autopilot so the agent stops to plan/grill
 * rather than driving straight to a PR. `opts.buildQueue`, when set, appends the build-queue
 * directive — orthogonal to the plan-gate/autopilot choice, so it always rides. `opts.previewHint`,
 * when true, appends the preview-hint notice AFTER the build-queue block (or after the
 * plan-gate/autopilot block when no build-queue is present) — isolated-only, orthogonal to all
 * other options.
 */
export function composeSystemPrompt(
  houseRules: string | null,
  autopilotActive = false,
  opts: {
    planGate?: "interactive" | "auto";
    buildQueue?: string | null;
    previewHint?: boolean;
  } = {},
): string {
  const posture = `<engineering-posture>\n${ENGINEERING_POSTURE}\n</engineering-posture>`;
  const research = `<research-first-notice>\n${RESEARCH_FIRST_NOTICE}\n</research-first-notice>`;
  const branchNotice = `<branch-rename-notice>\n${BRANCH_RENAME_NOTICE}\n</branch-rename-notice>`;
  const blocks = houseRules
    ? [posture, research, houseRules, branchNotice]
    : [posture, research, branchNotice];
  if (opts.planGate) {
    const variant =
      opts.planGate === "auto" ? PLAN_GATE_DIRECTIVE_AUTO : PLAN_GATE_DIRECTIVE_INTERACTIVE;
    blocks.push(`<plan-gate-directive>\n${variant}\n</plan-gate-directive>`);
  } else if (autopilotActive) {
    blocks.push(`<autopilot-directive>\n${AUTOPILOT_DIRECTIVE}\n</autopilot-directive>`);
  }
  // Build queue rides independently of the plan-gate/autopilot directive (orthogonal repo config).
  if (opts.buildQueue != null) blocks.push(`<build-queue>\n${opts.buildQueue}\n</build-queue>`);
  // Preview hint rides last — isolated sessions only. Non-isolated sessions share the main repo dir
  // and have no dedicated worktree, so the hint would be misleading there.
  if (opts.previewHint) {
    blocks.push(`<preview-hint-notice>\n${PREVIEW_HINT_NOTICE}\n</preview-hint-notice>`);
  }
  return blocks.join("\n\n");
}

/**
 * Base URL an agent uses to reach Shepherd's own API from inside its worktree.
 * When the server binds to 0.0.0.0 (all interfaces) the loopback address is still
 * the right target — the agent always runs on the same machine and 0.0.0.0 isn't
 * a valid call target.
 */
function agentBaseUrl(): string {
  return `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
}

export class SessionService {
  constructor(private deps: ServiceDeps) {}

  /**
   * Merge-train completion tracker (issue #426). A train that lands ≥1 of its
   * queue PRs should offer a local-checkout fast-forward once, per repo. We track
   * each launched train so we can emit `mergetrain:landed` exactly when the run
   * COMPLETES (the train session archives) — not on the first member merge.
   *
   * `memberToTrain` is the crux of race-safety: a member's merge-credit is looked
   * up by THIS map, never by the session's `mergingTrainId` field, because
   * `clearMergingForTrain` nulls that field at train archive — so a member that
   * merges AFTER the train archived (the poller-gated race) would otherwise be
   * unmappable to its train and its credit lost.
   */
  #trainOffers = new Map<
    string,
    {
      repoPath: string;
      merged: boolean;
      archived: boolean;
      // null while the train is still running — a LIVE entry is never swept on the
      // normal path (however long the run / a slow first CI takes), only cleaned when
      // the train archives; the sole exception is the TRAIN_TRACKER_MAX_MS absolute
      // backstop below, for a train that died without a session:archived. Set to
      // archive time when the train archives awaiting a late credit; the sweep then
      // reclaims it once that post-archive window lapses.
      awaitingSince: number | null;
      launchedAt: number; // for the dead-train absolute backstop only
      members: Set<string>;
    }
  >();
  #memberToTrain = new Map<string, string>();

  /**
   * Build the human-turn prompt: the user's text plus any attached images and the
   * issue body, both appended out-of-band so they never count against the
   * 8000-char human-prompt guard (the same approach for each).
   */
  private composePromptArg(input: CreateSessionInput, worktreePath: string): string {
    let promptArg = input.prompt;
    if (input.images.length > 0) {
      const move = this.deps.moveUploads ?? moveStagedIntoWorktree;
      const moved = move(input.images, worktreePath);
      promptArg = `${promptArg}\n\nAttached images:\n${moved.join("\n")}`;
    }
    if (input.issueRef) {
      const r = input.issueRef;
      promptArg = `${promptArg}\n\nGitHub Issue #${r.number}: ${r.title}\n${r.url}\n\n${r.body}`;
    }
    return promptArg;
  }

  /** Active+promoted rules for the repo as an XML-wrapped block, or null when
   *  none / learnings disabled. Injected into every new agent's system prompt
   *  (via composeSystemPrompt), not the human turn. */
  private houseRules(repoPath: string): string | null {
    if (!this.deps.store.getRepoConfig(repoPath).learningsEnabled) return null;
    const { injected } = planHouseRulesInjection(
      this.deps.store.listActiveLearnings(repoPath),
      config.houseRulesBudgetChars,
    );
    return renderHouseRulesBlock(injected);
  }

  /** Assemble the spawn argv. Shepherd-curated house rules go into the system prompt (not the human
   *  turn) so every spawn (manual AND auto-spawned, e.g. the work-queue drain #222) inherits the
   *  repo's learned corrections without bleeding into the task text. The autopilot directive rides
   *  the same prompt when the repo has autopilot on; the plan-gate directive when planGateOn; the
   *  build-queue directive (baking the exact queue endpoint for `sessionId`) when buildQueueEnabled;
   *  and the preview-hint notice when the session is `isolated`. */
  private buildSpawnArgv(
    input: CreateSessionInput,
    claudeSessionId: string,
    sessionId: string,
    promptArg: string,
    planGateOn: boolean | undefined,
    isolated: boolean,
  ): string[] {
    const repoConfig = this.deps.store.getRepoConfig(input.repoPath);
    const houseRules = this.houseRules(input.repoPath);
    const autopilotActive = repoConfig.autopilotEnabled;
    const planGate = planGateOn ? (input.auto ? "auto" : "interactive") : undefined;
    const buildQueue = repoConfig.buildQueueEnabled
      ? buildQueueDirective({
          sessionId,
          baseUrl: agentBaseUrl(),
          token: config.token,
          autopilot: autopilotActive,
        })
      : null;
    const argv = ["claude", "--dangerously-skip-permissions", "--session-id", claudeSessionId];
    argv.push("--settings", spawnSettingsOverlay());
    argv.push(
      "--append-system-prompt",
      composeSystemPrompt(houseRules, autopilotActive, {
        planGate,
        buildQueue,
        previewHint: isolated,
      }),
    );
    if (input.model) argv.push("--model", input.model);
    argv.push(promptArg);
    return argv;
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const basename = input.repoPath.split("/").filter(Boolean).at(-1) ?? "";
    const herdSlug = basename ? slugifyManual(basename) : undefined;
    const name = this.uniqueName(await this.deps.namer(input.prompt), herdSlug);
    const wt = this.deps.worktree.create(input.repoPath, input.baseBranch, name);
    // The worktree is created before the agent can start, so any failure past this
    // point (e.g. herdr `tab create` rejecting) would otherwise leave an orphan
    // worktree with no session row. Roll it back so a failed create leaves nothing.
    try {
      const claudeSessionId = randomUUID();
      // Pre-generate the session id so we can bake the exact queue endpoint into the spawn prompt
      // before the store row exists — the store.create() call below receives this id explicitly.
      const sessionId = randomUUID();

      const promptArg = this.composePromptArg(input, wt.worktreePath);
      const repoConfig = this.deps.store.getRepoConfig(input.repoPath);
      // Plan gate (#348): when on, spawn into a PLANNING phase with a grill directive that
      // suppresses autopilot — interactive grills a present human, auto (drain) just writes the
      // plan. Session-level override wins over the repo default.
      const planGateOn = input.planGateEnabled ?? repoConfig.planGateEnabled;
      const argv = this.buildSpawnArgv(
        input,
        claudeSessionId,
        sessionId,
        promptArg,
        planGateOn,
        wt.isolated,
      );
      const agent = this.deps.herdr.start(name, wt.worktreePath, argv);
      const session = this.deps.store.create({
        id: sessionId,
        name,
        prompt: input.prompt, // store the original user text, not the argv-augmented version
        repoPath: input.repoPath,
        baseBranch: input.baseBranch,
        branch: wt.branch,
        worktreePath: wt.worktreePath,
        isolated: wt.isolated,
        herdrSession: config.herdrSession,
        herdrAgentId: agent.terminalId,
        claudeSessionId,
        model: input.model,
        auto: input.auto ?? false,
        issueNumber: input.issueRef?.number ?? null,
        planGateEnabled: input.planGateEnabled ?? null,
        planPhase: planGateOn ? "planning" : null,
      });
      // Attended sessions stay unapproved until a human clicks Approve in the UI.
      // Autopilot sessions are pre-approved so the agent can begin executing immediately
      // after authoring the queue without waiting for a human gate that will never come.
      if (repoConfig.buildQueueEnabled && repoConfig.autopilotEnabled)
        this.deps.store.setBuildQueueApproved(sessionId, true);
      this.scheduleRefine(session, herdSlug);
      return session;
    } catch (e) {
      // best-effort rollback; surface the original failure, not any cleanup error
      if (wt.isolated) {
        try {
          this.deps.worktree.remove(wt.worktreePath, {
            branch: wt.branch,
            baseBranch: input.baseBranch,
          });
        } catch {
          /* ignore */
        }
      }
      throw e;
    }
  }

  /**
   * Derive a herdr-unique agent name from `base`. The namer maps a prompt to a name
   * deterministically, so resubmitting a similar prompt yields the same base — and herdr
   * rejects a second agent with a name already in use (`agent_name_taken`), which would
   * otherwise surface as an opaque create 500. Suffixing past live agents avoids the clash;
   * the chosen name also drives the worktree path and branch, so they stay collision-free too.
   *
   * When a collision occurs and `herd` (the slugified repo basename) is provided, resolution
   * prefers a herd-qualified name (`${base}-${herd}`) before falling back to numeric suffixes.
   * This makes concurrent sessions on different repos self-distinguishing at a glance
   * (`fix-login-myapp` vs `fix-login-otherapp`) and keeps numeric suffixes as a last resort
   * for sessions inside the same herd. If no usable herd is given, the original numeric
   * linear scan (`${base}-2`, `-3`, …) is used unchanged.
   *
   * The composed `base-herd` string is capped at 60 characters (trimming any trailing dash)
   * to keep branch/worktree paths sane, matching the 60-char convention used by slugifyManual.
   */
  private uniqueName(base: string, herd?: string): string {
    const taken = new Set(
      this.deps.herdr
        .list()
        .map((a) => a.name)
        .filter(Boolean),
    );
    if (!taken.has(base)) return base;

    if (herd) {
      // Cap at 60 chars (matching slugifyManual's convention). If base is already 59–60 chars
      // the herd may be truncated away entirely; numeric fallback below still produces a valid name.
      const composed = `${base}-${herd}`.slice(0, 60).replace(/-+$/, "");
      if (!taken.has(composed)) return composed;
      for (let i = 2; ; i++) {
        const candidate = `${composed}-${i}`;
        if (!taken.has(candidate)) return candidate;
      }
    }

    // No usable herd — fall back to the original numeric scan.
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** Kick off the background name refine without blocking create(). No-op when disabled. */
  private scheduleRefine(session: Session, herd?: string): void {
    if (!config.llmNaming || !this.deps.refineName) return;
    void this.refineNameInBackground(session, herd).catch((err) =>
      console.warn(`[namer] refine failed for ${session.id}:`, err),
    );
  }

  /**
   * Ask the LLM namer to comprehend the prompt, then — if it yields a *different*,
   * collision-resolved slug — rename the session (display name always; local branch
   * only while nothing has been committed yet) and relabel the herdr agent/tab.
   * Emits session:renamed so every client patches the row live.
   */
  private async refineNameInBackground(session: Session, herd?: string): Promise<void> {
    const raw = await this.deps.refineName!({
      taskText: session.prompt,
      label: `name ${session.desig}`,
    });
    if (!raw) return;
    const slug = this.uniqueName(raw, herd);
    if (slug === session.name) return;
    // Don't clobber a manual rename that landed during the (up-to-60s) refine window:
    // re-read the row and bail if its name no longer matches the snapshot we started
    // from — a manual rename is the user's intent and outranks the background guess.
    const current = this.deps.store.get(session.id);
    if (!current || current.name !== session.name) return;
    // Move the git branch too, but only inside the "nothing committed yet" window AND
    // when `shepherd/<slug>` is free. `uniqueName` de-dupes against live herdr agent
    // names, not branches, so a leftover branch from an archived session could still
    // collide — and `git branch -m` onto an existing name throws. On collision (or a
    // committed branch) we fall back to a display-only rename: the comprehended name
    // still shows; the branch just stays on the heuristic slug.
    const safe =
      session.isolated &&
      !!session.branch &&
      !this.deps.worktree.branchExists(session.repoPath, `shepherd/${slug}`) &&
      this.deps.worktree.commitsAhead(session.repoPath, session.baseBranch, session.branch) === 0;
    // The branchExists pre-check narrows the window, but a branch can still appear
    // between it and `git branch -m` (concurrent create, archived-branch cleanup) —
    // rename() moves the branch before updating the row, so a throw would abandon the
    // refine and lose the better name. Retry display-only so the degradation is airtight.
    let updated: Session | null;
    try {
      updated = this.rename(session.id, slug, { renameLocalBranch: safe });
    } catch {
      updated = this.rename(session.id, slug, { renameLocalBranch: false });
    }
    if (!updated) return;
    this.deps.herdr.relabel(session.herdrAgentId, slug);
    this.deps.events?.emit("session:renamed", {
      id: updated.id,
      name: updated.name,
      branch: updated.branch,
    });
  }

  /**
   * Bring a finished session back: spawn a fresh `claude --resume <pinnedId>` in
   * its still-present worktree so the whole conversation is restored and steerable
   * again. Re-points the session at the new herdr agent and flips it back to running.
   *
   * Returns the updated session, or null when it can't be resumed:
   *  - unknown id, or archived (its worktree was already removed), or
   *  - a pre-feature session with no pinned claude session id to resume.
   * If the herdr agent is still live (a "done" session that's merely idle at the
   * prompt), there's nothing to respawn — the current session is handed back so the
   * caller just re-attaches, avoiding a duplicate claude process.
   *
   * `force` overrides that re-use: it tears down whatever agent currently backs the
   * worktree and spawns a fresh `claude --resume` regardless. This is the explicit
   * "bring claude back" action (header / card-menu button) for the case the re-use
   * path can't see — claude exited but its herdr tab survived as a bare shell, so the
   * agent still lists as live (idle) and a plain resume would only re-adopt the shell.
   *
   * We force unconditionally rather than only on a detected husk because herdr ≥0.6
   * `agent list` exposes no command/liveness field, so a husk shell and an idle
   * claude are indistinguishable here (see ui canResume). The tradeoff: if invoked on
   * a genuinely-live idle claude it respawns one needlessly, resetting that pane's
   * terminal scrollback — but `--resume` restores the FULL conversation, so no work is
   * lost, and the control is only surfaced/clicked when the user believes they're
   * stranded. Guaranteeing the husk case works (always respawn) beats preserving
   * scrollback in the rare misclick-on-live-claude case.
   */
  resume(id: string, opts: { force?: boolean } = {}): Session | null {
    const s = this.deps.store.get(id);
    if (!s || s.status === "archived" || !s.claudeSessionId) return null;
    const agent =
      matchAgents(this.deps.store.list({ activeOnly: true }), this.deps.herdr.list()).get(id) ??
      null;
    if (agent && !opts.force) {
      // Already live (idle at the prompt, or restored by a herdr restart under a new
      // terminalId). Adopt the fresh id if it drifted; never spawn a second claude.
      if (agent.terminalId !== s.herdrAgentId) {
        this.deps.store.update(id, { herdrAgentId: agent.terminalId });
        return this.deps.store.get(id);
      }
      return s;
    }
    // Forced respawn over a live agent: close the stale husk tab first so it doesn't
    // leak alongside the fresh one. (No-op when the agent is already gone.)
    if (agent) this.deps.herdr.stop(agent.terminalId);
    const argv = ["claude", "--dangerously-skip-permissions", "--resume", s.claudeSessionId];
    argv.push("--settings", spawnSettingsOverlay());
    if (s.model) argv.push("--model", s.model);
    const spawned = this.deps.herdr.start(s.name, s.worktreePath, argv);
    this.deps.store.update(id, {
      herdrAgentId: spawned.terminalId,
      status: "running",
      lastState: "idle",
    });
    return this.deps.store.get(id);
  }

  /**
   * Rename a session to `slug`. Always updates the display name. When
   * `renameLocalBranch` is set (and the session is isolated with a branch), also
   * runs `git branch -m shepherd/<old> shepherd/<slug>` and re-points `branch`.
   * The caller (server) decides `renameLocalBranch`: false for a display-only rename
   * when an open PR can't be retargeted, true otherwise. Returns the updated session,
   * or null for an unknown id. The git rename may throw on a name clash — the caller
   * pre-checks and surfaces that as a conflict.
   */
  /** Whether a local branch already exists — the server's pre-flight check before a rename. */
  branchExists(repoPath: string, branch: string): boolean {
    return this.deps.worktree.branchExists(repoPath, branch);
  }

  /**
   * Reconcile a session's stored branch with the one actually checked out in its
   * worktree. An agent that runs `git checkout -b` / `git branch -m` renames the
   * branch out from under us, so the stored `branch` goes stale and PR detection
   * (which queries `gh pr list --head <branch>`) silently misses the opened PR.
   * Called by the PR poller on a "no PR found" miss. When the live branch differs,
   * adopt it (re-point `branch`) — that alone is what restores PR recognition.
   * Returns the adopted branch (so the poller can re-query), or null when nothing
   * changed / it can't be determined.
   *
   * The display `name` follows only when it still trivially mirrors the *old* branch
   * (i.e. was auto-derived). A name that already diverged is a chosen name — a manual
   * rename or an LLM refine — and outranks a raw branch slug, the same precedence
   * `refineNameInBackground` enforces. When it does follow, it's de-duped through
   * `uniqueName` like the other automatic rename paths so it can't clash with a
   * sibling's tab label.
   */
  syncWorktreeBranch(id: string): string | null {
    const s = this.deps.store.get(id);
    if (!s || !s.isolated || !s.branch) return null;
    const live = this.deps.worktree.currentBranch(s.worktreePath);
    if (!live || live === s.branch) return null;
    const nameMirrorsBranch = s.name === s.branch.replace(/^shepherd\//, "");
    const label = nameMirrorsBranch ? this.uniqueName(live.replace(/^shepherd\//, "")) : null;
    this.deps.store.update(id, label ? { name: label, branch: live } : { branch: live });
    if (label) {
      try {
        this.deps.herdr.relabel(s.herdrAgentId, label);
      } catch {
        /* tab may be gone — branch adoption still stands */
      }
    }
    this.deps.events?.emit("session:renamed", { id, name: label ?? s.name, branch: live });
    return live;
  }

  rename(id: string, slug: string, opts: { renameLocalBranch: boolean }): Session | null {
    const s = this.deps.store.get(id);
    if (!s) return null;
    const willRenameBranch = opts.renameLocalBranch && s.isolated && !!s.branch;
    const newBranch = willRenameBranch ? `shepherd/${slug}` : s.branch;
    if (willRenameBranch && s.branch) {
      this.deps.worktree.renameBranch(s.repoPath, s.branch, newBranch as string);
    }
    this.deps.store.update(id, { name: slug, branch: newBranch });
    return this.deps.store.get(id);
  }

  /**
   * Steer a session's live PTY (human-style): deliver the text as a bracketed paste,
   * then submit it with a carriage return.
   *
   * The wrap is load-bearing for multi-line steers (e.g. a pasted-in critic review).
   * herdr does NOT bracket-wrap injected text, and back-to-back `send`s coalesce into a
   * single PTY read — so a multi-line blob with a trailing "\r" reaches Claude Code as
   * one chunk, trips its paste heuristic, and the CR is swallowed as just another
   * newline: message typed-but-unsent. (Single-line steers escaped this because no
   * embedded "\n" trips the heuristic — which is why short steers worked and reviews
   * didn't.) Wrapping the text in the bracketed-paste markers (ESC[200~ … ESC[201~)
   * gives an explicit paste-end, so the following CR is unambiguously Enter regardless
   * of read boundaries — deterministic, no timing guesswork. Strip any stray paste
   * markers from the payload first: a leaked end-marker would close the paste early
   * (turning the rest into live keystrokes), and a leaked start-marker is benign but
   * dropped for symmetry. Returns false when the session is unknown OR its pane is dead
   * (claude exited / terminal reaped) — a live store row can still back a dead pane,
   * which would make herdr.send throw. The up-front liveness check keeps reply an honest,
   * non-throwing boolean for human steers, and hands the auto-address loop a clean
   * "not delivered" instead of relying on it to catch the throw downstream.
   */
  reply(id: string, text: string): boolean {
    return this.replyToLive(id, text, this.liveTerminalIds());
  }

  /** Fan a steer out to many sessions (human-style). Skips unknown ids and dead panes.
   *  Lists herdr's live agents ONCE up front rather than per id, so a wide fan-out
   *  doesn't spawn one blocking `herdr agent list` per target. */
  broadcast(ids: string[], text: string): { sent: number; total: number } {
    const live = this.liveTerminalIds();
    let sent = 0;
    for (const id of ids) if (this.replyToLive(id, text, live)) sent++;
    return { sent, total: ids.length };
  }

  /**
   * Fleet-wide emergency stop: interrupt every live, actively-working agent at once.
   * Sends a single ESC — the Claude Code interrupt key — to each pane whose herdr
   * agent reports `working`, halting the current turn WITHOUT clearing its input or
   * quitting it (a lone ESC, no bracketed paste, no trailing CR — the opposite of a
   * steer). Idle / blocked / done agents, dead panes, archived sessions and the
   * ephemeral usage probe are all left untouched: only ACTIVE sessions are matched
   * against the live agent set (so the probe — never a stored session — and archived
   * rows fall out), and of those only the ones reporting `working` are hit. Auto-spawned
   * (drain) sessions are included BY DESIGN — a misfiring autopilot is exactly what this
   * stops. Lists herdr's agents ONCE up front (like broadcast) so a wide fan-out makes a
   * single `agent list` call, not one per target. Emits `halt:done {halted}` so every
   * connected operator sees the reach.
   *
   * Throws (→ HTTP 500 → the UI surfaces halt_failed + Retry) when herdr can't even be
   * listed: a swallowed failure would emit a success-looking `halt:done {halted:0}`,
   * indistinguishable from "nothing was working" — a silent no-op at the worst moment.
   */
  haltAll(): { halted: number } {
    const agents = this.deps.herdr.list(); // let a herdr-unreachable error propagate
    const sessions = this.deps.store.list({ activeOnly: true });
    let halted = 0;
    for (const agent of matchAgents(sessions, agents).values()) {
      if (agent?.agentStatus !== "working") continue;
      // Best-effort: a pane that died between `list` and `send` (or any single send
      // throwing) must NOT abort the sweep — keep interrupting the rest. Count only the
      // interrupts that actually landed; best-effort reach is the point of an e-stop.
      try {
        this.deps.herdr.send(agent.terminalId, "\x1b");
        halted++;
      } catch {
        /* dead / raced pane — skip it, the herd-wide stop carries on */
      }
    }
    const result = { halted };
    this.deps.events?.emit("halt:done", result);
    return result;
  }

  /** Terminal ids herdr currently lists as live. Empty when herdr can't be reached, so
   *  callers treat an unlisted agent as a dead pane (the steer won't land). */
  private liveTerminalIds(): Set<string> {
    try {
      return new Set(this.deps.herdr.list().map((a) => a.terminalId));
    } catch {
      return new Set();
    }
  }

  /** Steer one session against a pre-fetched live set. False on unknown id or dead pane. */
  private replyToLive(id: string, text: string, live: Set<string>): boolean {
    const s = this.deps.store.get(id);
    if (!s || !live.has(s.herdrAgentId)) return false; // unknown, or live-in-store / dead-pane
    this.deps.store.addSignal({
      repoPath: s.repoPath,
      sessionId: s.id,
      kind: "reply",
      payload: text,
    });
    const PASTE_START = "\x1b[200~";
    const PASTE_END = "\x1b[201~";
    const safe = text.replaceAll(PASTE_START, "").replaceAll(PASTE_END, "");
    this.deps.herdr.send(s.herdrAgentId, `${PASTE_START}${safe}${PASTE_END}`);
    this.deps.herdr.send(s.herdrAgentId, "\r");
    return true;
  }

  /**
   * Toggle the manual "ready to merge" flag (parked / done). Persists it and
   * pushes the change live so every client patches the row without a refetch.
   */
  setReadyToMerge(id: string, ready: boolean): void {
    this.deps.store.update(id, { readyToMerge: ready });
    this.deps.events?.emit("session:ready", { id, ready });
  }

  /**
   * Shared phase→executing transition: flip planPhase to "executing" and push the change live.
   * Used by both the Go release (releasePlanGate) and the PR auto-advance (advanceToExecutionOnPr).
   * Callers are responsible for their own guards before calling this.
   */
  #enterExecution(id: string): void {
    this.deps.store.setPlanPhase(id, "executing");
    this.deps.events?.emit("session:plangate", { id, planPhase: "executing" });
  }

  /**
   * The "Go" gate: release an APPROVED planning session into autonomous execution. Strict —
   * only transitions when the session is in the planning phase AND its plan gate is approved
   * (the reviewer signed off). Flips planPhase → "executing", steers the agent to implement the
   * approved plan, and emits session:plangate so clients update. Returns false (no-op) when the
   * session is unknown, not planning, or not yet approved. Used by the /go route (interactive)
   * and by PlanGateService for an auto session's auto-release on approval.
   */
  releasePlanGate(id: string): boolean {
    const s = this.deps.store.get(id);
    if (!s || s.planPhase !== "planning") return false;
    if (!this.deps.store.getPlanGate(id)?.approved) return false;
    this.#enterExecution(id);
    this.reply(id, PLAN_GO_STEER);
    return true;
  }

  /**
   * Auto-advance a manually-driven (or otherwise un-released) planning session into execution
   * once a PR appears. When the operator reviews the plan then steers the agent instead of
   * clicking Go, the agent writes code and opens a PR while planPhase is still "planning" —
   * leaving the plan-gate badge latched and making autopilot stand down (autopilot.ts eligible()
   * suppresses planning sessions). This method detects that case: called when a PR is observed
   * for a still-planning session, it flips planPhase → "executing" so the plan gate yields and
   * autopilot stops standing down.
   *
   * Critically, it does NOT send PLAN_GO_STEER — the agent already executed; steering it to
   * "implement the approved plan" would be wrong (the plan may not even be approved). Its caller
   * mirrors autopilot's hasPr non-"none" semantics (open/merged/closed) so the two don't drift.
   *
   * Returns true when a real transition occurred (planPhase was "planning" and is now "executing"),
   * false when the session is unknown or not in the planning phase (idempotent no-op).
   */
  advanceToExecutionOnPr(id: string): boolean {
    const s = this.deps.store.get(id);
    if (!s || s.planPhase !== "planning") return false;
    this.#enterExecution(id);
    return true;
  }

  /**
   * Mark each session as part of a launched merge train (the client passes the
   * scoped ready-PR ids). Stamps `mergingSince`/`mergingTrainId`, persists, and
   * pushes `session:merging` (carrying `trainId` so the live patch matches a
   * refetch — the field is server state mirrored on the client). Unknown ids are
   * skipped (best-effort: the set is cosmetic, never load-bearing).
   */
  setMerging(ids: string[], trainId: string): void {
    const since = Date.now();
    const members = new Set<string>();
    let repoPath: string | null = null;
    for (const id of ids) {
      const s = this.deps.store.get(id);
      if (!s) continue;
      this.deps.store.update(id, { mergingSince: since, mergingTrainId: trainId });
      this.deps.events?.emit("session:merging", { id, since, trainId });
      // Register the resolvable member for the completion tracker. repoPath is read
      // off the FIRST resolvable member (never a skipped id) — the train is per-repo.
      members.add(id);
      this.#memberToTrain.set(id, trainId);
      if (repoPath === null) repoPath = s.repoPath;
    }
    // No resolvable member → create no entry (so repoPath is never read off a skip).
    if (repoPath !== null) {
      this.#trainOffers.set(trainId, {
        repoPath,
        merged: false,
        archived: false,
        awaitingSince: null,
        launchedAt: since,
        members,
      });
    }
  }

  /** Clear one session's merge-train mark. No-op (no event) when not marked. */
  clearMerging(id: string): void {
    const s = this.deps.store.get(id);
    if (!s || s.mergingSince === null) return;
    this.deps.store.update(id, { mergingSince: null, mergingTrainId: null });
    this.deps.events?.emit("session:merging", { id, since: null, trainId: null });
  }

  /**
   * A queue member's PR resolved (`session:git` merged/closed). Replaces the bare
   * per-member `clearMerging` call: clears the UI mark exactly as before, then
   * credits the completion tracker. Credit is keyed by `#memberToTrain` (NOT the
   * session's `mergingTrainId`, which archive may already have nulled).
   *
   * A merge only counts toward the offer when the session is `isolated` — a
   * non-isolated session works in the canonical clone, so its fast-forward would
   * always report `wrong_branch` (mirrors the parent feature's guard). We read
   * `isolated`/`trainId` before clearing, since the mark must be cleared either way.
   * Emits only via the LATE-CREDIT path: if the train already archived awaiting a
   * merge, this credit completes it. A credit while the train is still live never
   * emits — the offer fires on run completion, not first merge.
   */
  resolveMerging(id: string, didMerge: boolean): void {
    const isolated = this.deps.store.get(id)?.isolated ?? false;
    this.clearMerging(id);
    const trainId = this.#memberToTrain.get(id);
    if (trainId === undefined) return; // untracked → behaves exactly like the old clearMerging
    const entry = this.#trainOffers.get(trainId);
    this.#memberToTrain.delete(id);
    if (!entry) return;
    entry.members.delete(id);
    entry.merged ||= didMerge && isolated;
    if (entry.archived && entry.merged) this.#finalizeTrain(trainId, entry.repoPath);
  }

  /**
   * The train session was archived (run complete). Clear any of its members still
   * marked (unchanged), then drive the offer. If a merge was already credited →
   * emit + finalize now. Else DEFER: mark the entry archived and fast-poll each
   * still-tracked member via `refreshPr` so a poller-gated merge surfaces within
   * seconds and routes through `resolveMerging` → late-credit emit. A deferred
   * entry whose late credit never arrives is reclaimed by `sweepStaleMerging` with
   * no emit, `MERGE_STALE_MS` after this archive — the await window starts HERE, so
   * it is independent of how long the run itself took (a slow/long run is never
   * reclaimed mid-flight; only the post-archive wait is bounded). `now` injectable.
   */
  clearMergingForTrain(trainId: string, now: number = Date.now()): void {
    for (const s of this.deps.store.list({ activeOnly: true })) {
      if (s.mergingTrainId === trainId) this.clearMerging(s.id);
    }
    const entry = this.#trainOffers.get(trainId);
    if (!entry || entry.archived) return; // untracked, or a repeat archive → keep the await window monotonic
    entry.archived = true;
    entry.awaitingSince = now; // start the post-archive await window (only awaiting entries are swept)
    if (entry.merged) {
      this.#finalizeTrain(trainId, entry.repoPath);
      return;
    }
    for (const id of entry.members) this.deps.refreshPr?.(id);
  }

  /** Emit `mergetrain:landed` once (caller has decided merged) and drop all tracker state. */
  #finalizeTrain(trainId: string, repoPath: string): void {
    this.deps.events?.emit("mergetrain:landed", { repoPath });
    const entry = this.#trainOffers.get(trainId);
    if (entry) for (const id of entry.members) this.#memberToTrain.delete(id);
    this.#trainOffers.delete(trainId);
  }

  /** Backstop: clear marks older than MERGE_STALE_MS. `now` injectable for tests. */
  sweepStaleMerging(now: number = Date.now()): void {
    for (const s of this.deps.store.list({ activeOnly: true })) {
      if (s.mergingSince !== null && now - s.mergingSince > MERGE_STALE_MS) {
        this.clearMerging(s.id);
      }
    }
    // Reclaim tracker entries directly (NOT via activeOnly, which excludes archived
    // trains). Two cases, both no-emit (fail-safe no-offer):
    //  - AWAITING (archived, awaiting a late credit): once the post-archive window lapses.
    //  - LIVE (awaitingSince null): NEVER on a normal run, however long it takes — only
    //    the TRAIN_TRACKER_MAX_MS absolute backstop, which bounds an entry orphaned by a
    //    train that died without a session:archived. Real runs finish far inside it.
    for (const [trainId, entry] of this.#trainOffers) {
      const awaitingStale =
        entry.awaitingSince !== null && now - entry.awaitingSince > MERGE_STALE_MS;
      const deadTrainOrphan =
        entry.awaitingSince === null && now - entry.launchedAt > TRAIN_TRACKER_MAX_MS;
      if (awaitingStale || deadTrainOrphan) {
        for (const id of entry.members) this.#memberToTrain.delete(id);
        this.#trainOffers.delete(trainId);
      }
    }
  }

  /** Leftover subprocesses/proxies that would survive this session's close; [] when none. */
  leftovers(id: string): Leftover[] {
    const s = this.deps.store.get(id);
    if (!s || !this.deps.reaper) return [];
    return this.deps.reaper.detect(s);
  }

  /**
   * Close a session: optionally terminate selected leftovers first, then stop the
   * agent, remove the worktree, and archive the row. `reapKeys` are leftover keys
   * the operator chose to kill; we re-detect and intersect by key so a stale/forged
   * client selection can never make us kill an arbitrary pid. Returns the number of
   * leftovers actually reaped (the intersection), so bulk callers can report a count
   * that reflects what was killed rather than what was requested.
   */
  archive(id: string, reapKeys?: string[]): number {
    const s = this.deps.store.get(id);
    if (!s) return 0;
    let reaped = 0;
    if (reapKeys?.length && this.deps.reaper) {
      const want = new Set(reapKeys);
      const hit = this.deps.reaper.detect(s).filter((l) => want.has(l.key));
      this.deps.reaper.reap(hit);
      reaped = hit.length;
    }
    this.deps.herdr.stop(s.herdrAgentId); // stop the live claude agent so it doesn't leak
    if (s.isolated)
      this.deps.worktree.remove(s.worktreePath, { branch: s.branch, baseBranch: s.baseBranch });
    this.deps.store.archive(id);
    return reaped;
  }

  /**
   * Bulk-close sessions ("clear all merged"). Each session's leftover subprocesses
   * are auto-detected and reaped before its teardown — unlike the single-session
   * close (which asks per-process), bulk clear terminates them all so a landed
   * session can't leave a dev server orphaned. Returns the ids actually archived
   * (missing ones are skipped) and the total leftovers terminated — counted from
   * what `archive` actually reaped, so the number never overstates. The caller must
   * restrict `ids` to a safe set (e.g. merged-only) — this archives what it's given.
   *
   * One session's teardown failing (e.g. `worktree.remove` throwing) must not abort
   * the rest, so each is isolated: a failed id is skipped and left out of `cleared`,
   * so the caller emits archived events for exactly the rows that really went away.
   */
  archiveMany(ids: string[]): { cleared: string[]; leftovers: number } {
    const cleared: string[] = [];
    let leftovers = 0;
    for (const id of ids) {
      const s = this.deps.store.get(id);
      if (!s) continue;
      const keys = this.deps.reaper?.detect(s).map((l) => l.key) ?? [];
      try {
        leftovers += this.archive(id, keys); // count what was reaped, not what was detected
        cleared.push(id);
      } catch {
        // skip this one; its row stays active and gets no archived event
      }
    }
    return { cleared, leftovers };
  }
}
