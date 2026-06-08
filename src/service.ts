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
 * Compose the spawn-time system prompt passed via a single `--append-system-prompt`
 * (the flag is last-wins, not repeatable, so all blocks must share one value).
 *
 * House rules used to be prepended to the human prompt, which let standing guidance bleed
 * into the task on every spawn. They now live in the system prompt, each block XML-wrapped
 * so the agent can cleanly separate persistent guidance from the task in its human turn.
 * `houseRules` is the already-wrapped `<shepherd-house-rules>` block, or null when there are
 * none / learnings are disabled; the engineering-posture and branch-rename blocks always ride.
 */
export function composeSystemPrompt(houseRules: string | null): string {
  const posture = `<engineering-posture>\n${ENGINEERING_POSTURE}\n</engineering-posture>`;
  const branchNotice = `<branch-rename-notice>\n${BRANCH_RENAME_NOTICE}\n</branch-rename-notice>`;
  const blocks = houseRules ? [posture, houseRules, branchNotice] : [posture, branchNotice];
  return blocks.join("\n\n");
}

export class SessionService {
  constructor(private deps: ServiceDeps) {}

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

      let promptArg = input.prompt;
      if (input.images.length > 0) {
        const move = this.deps.moveUploads ?? moveStagedIntoWorktree;
        const moved = move(input.images, wt.worktreePath);
        promptArg = `${promptArg}\n\nAttached images:\n${moved.join("\n")}`;
      }
      // Attach the issue body out-of-band so it never counts against the
      // 8000-char human-prompt guard — same approach as images above.
      if (input.issueRef) {
        const r = input.issueRef;
        promptArg = `${promptArg}\n\nGitHub Issue #${r.number}: ${r.title}\n${r.url}\n\n${r.body}`;
      }

      // Shepherd-curated house rules go into the system prompt (not the human turn) so every
      // spawn (manual AND auto-spawned, e.g. the work-queue drain #222) inherits the repo's
      // learned corrections without the rules bleeding into the task text.
      const houseRules = this.houseRules(input.repoPath);

      const argv = ["claude", "--dangerously-skip-permissions", "--session-id", claudeSessionId];
      argv.push("--settings", spawnSettingsOverlay());
      argv.push("--append-system-prompt", composeSystemPrompt(houseRules));
      if (input.model) argv.push("--model", input.model);
      argv.push(promptArg);
      const agent = this.deps.herdr.start(name, wt.worktreePath, argv);
      const session = this.deps.store.create({
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
      });
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
   */
  resume(id: string): Session | null {
    const s = this.deps.store.get(id);
    if (!s || s.status === "archived" || !s.claudeSessionId) return null;
    const agent =
      matchAgents(this.deps.store.list({ activeOnly: true }), this.deps.herdr.list()).get(id) ??
      null;
    if (agent) {
      // Already live (idle at the prompt, or restored by a herdr restart under a new
      // terminalId). Adopt the fresh id if it drifted; never spawn a second claude.
      if (agent.terminalId !== s.herdrAgentId) {
        this.deps.store.update(id, { herdrAgentId: agent.terminalId });
        return this.deps.store.get(id);
      }
      return s;
    }
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
   * Mark each session as part of a launched merge train (the client passes the
   * scoped ready-PR ids). Stamps `mergingSince`/`mergingTrainId`, persists, and
   * pushes `session:merging` so every client patches the row live. Unknown ids
   * are skipped (best-effort: the set is cosmetic, never load-bearing).
   */
  setMerging(ids: string[], trainId: string): void {
    const since = Date.now();
    for (const id of ids) {
      if (!this.deps.store.get(id)) continue;
      this.deps.store.update(id, { mergingSince: since, mergingTrainId: trainId });
      this.deps.events?.emit("session:merging", { id, since });
    }
  }

  /** Clear one session's merge-train mark. No-op (no event) when not marked. */
  clearMerging(id: string): void {
    const s = this.deps.store.get(id);
    if (!s || s.mergingSince === null) return;
    this.deps.store.update(id, { mergingSince: null, mergingTrainId: null });
    this.deps.events?.emit("session:merging", { id, since: null });
  }

  /** Clear every session marked by a given train (its session was archived). */
  clearMergingForTrain(trainId: string): void {
    for (const s of this.deps.store.list({ activeOnly: true })) {
      if (s.mergingTrainId === trainId) this.clearMerging(s.id);
    }
  }

  /** Backstop: clear marks older than MERGE_STALE_MS. `now` injectable for tests. */
  sweepStaleMerging(now: number = Date.now()): void {
    for (const s of this.deps.store.list({ activeOnly: true })) {
      if (s.mergingSince !== null && now - s.mergingSince > MERGE_STALE_MS) {
        this.clearMerging(s.id);
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
