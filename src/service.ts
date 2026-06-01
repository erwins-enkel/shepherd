import { randomUUID } from "node:crypto";
import type { SessionStore } from "./store";
import type { WorktreeMgr } from "./worktree";
import type { HerdrDriver } from "./herdr";
import { config } from "./config";
import type { CreateSessionInput, Session } from "./types";
import { moveStagedIntoWorktree } from "./uploads";

export interface ServiceDeps {
  store: SessionStore;
  worktree: Pick<WorktreeMgr, "create" | "remove">;
  herdr: Pick<HerdrDriver, "start" | "list" | "stop" | "send">;
  namer: (prompt: string) => string | Promise<string>;
  /** Inject point for tests; defaults to the real fs move. */
  moveUploads?: (images: string[], worktreePath: string) => string[];
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
    const name = this.uniqueName(await this.deps.namer(input.prompt));
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
        promptArg = `${input.prompt}\n\nAttached images:\n${moved.join("\n")}`;
      }

      const argv = ["claude", "--dangerously-skip-permissions", "--session-id", claudeSessionId];
      argv.push("--settings", spawnSettingsOverlay());
      if (input.model) argv.push("--model", input.model);
      argv.push(promptArg);
      const agent = this.deps.herdr.start(name, wt.worktreePath, argv);
      return this.deps.store.create({
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
   */
  private uniqueName(base: string): string {
    const taken = new Set(
      this.deps.herdr
        .list()
        .map((a) => a.name)
        .filter(Boolean),
    );
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
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

  archive(id: string): void {
    const s = this.deps.store.get(id);
    if (!s) return;
    this.deps.herdr.stop(s.herdrAgentId); // stop the live claude agent so it doesn't leak
    if (s.isolated)
      this.deps.worktree.remove(s.worktreePath, { branch: s.branch, baseBranch: s.baseBranch });
    this.deps.store.archive(id);
  }
}
