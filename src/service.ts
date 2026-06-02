import { randomUUID } from "node:crypto";
import type { SessionStore } from "./store";
import type { EventHub } from "./events";
import type { WorktreeMgr } from "./worktree";
import type { HerdrDriver } from "./herdr";
import { config } from "./config";
import type { CreateSessionInput, Session } from "./types";
import { moveStagedIntoWorktree } from "./uploads";
import { slugifyManual } from "./namer";
import type { Leftover, ProcessReaper } from "./process-reaper";

export interface ServiceDeps {
  store: SessionStore;
  worktree: Pick<
    WorktreeMgr,
    "create" | "remove" | "renameBranch" | "branchExists" | "commitsAhead"
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

export class SessionService {
  constructor(private deps: ServiceDeps) {}

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

      const argv = ["claude", "--dangerously-skip-permissions", "--session-id", claudeSessionId];
      argv.push("--settings", spawnSettingsOverlay());
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
    const live = this.deps.herdr.list().some((a) => a.terminalId === s.herdrAgentId);
    if (live) return s;
    const argv = ["claude", "--dangerously-skip-permissions", "--resume", s.claudeSessionId];
    argv.push("--settings", spawnSettingsOverlay());
    if (s.model) argv.push("--model", s.model);
    const agent = this.deps.herdr.start(s.name, s.worktreePath, argv);
    this.deps.store.update(id, {
      herdrAgentId: agent.terminalId,
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
   * Steer a session's live PTY (human-style): type the text, then submit it with
   * a SEPARATE carriage return. The split is deliberate — herdr writes each `send`
   * as one PTY chunk, so a multi-line steer (e.g. a pasted-in code review) glued to
   * a trailing "\r" lands in Claude Code's input as a single paste-buffered blob and
   * the CR is absorbed as just another newline, leaving the message typed-but-unsent.
   * A discrete second write arrives as its own stdin chunk and registers as Enter, so
   * one click both delivers and submits. Returns false if unknown.
   */
  reply(id: string, text: string): boolean {
    const s = this.deps.store.get(id);
    if (!s) return false;
    this.deps.herdr.send(s.herdrAgentId, text);
    this.deps.herdr.send(s.herdrAgentId, "\r");
    return true;
  }

  /** Fan a steer out to many sessions (human-style). Skips unknown ids. */
  broadcast(ids: string[], text: string): { sent: number; total: number } {
    let sent = 0;
    for (const id of ids) if (this.reply(id, text)) sent++;
    return { sent, total: ids.length };
  }

  /**
   * Toggle the manual "ready to merge" flag (parked / done). Persists it and
   * pushes the change live so every client patches the row without a refetch.
   */
  setReadyToMerge(id: string, ready: boolean): void {
    this.deps.store.update(id, { readyToMerge: ready });
    this.deps.events?.emit("session:ready", { id, ready });
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
   * client selection can never make us kill an arbitrary pid.
   */
  archive(id: string, reapKeys?: string[]): void {
    const s = this.deps.store.get(id);
    if (!s) return;
    if (reapKeys?.length && this.deps.reaper) {
      const want = new Set(reapKeys);
      this.deps.reaper.reap(this.deps.reaper.detect(s).filter((l) => want.has(l.key)));
    }
    this.deps.herdr.stop(s.herdrAgentId); // stop the live claude agent so it doesn't leak
    if (s.isolated)
      this.deps.worktree.remove(s.worktreePath, { branch: s.branch, baseBranch: s.baseBranch });
    this.deps.store.archive(id);
  }
}
