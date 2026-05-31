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
  namer: (prompt: string) => Promise<string>;
  /** Inject point for tests; defaults to the real fs move. */
  moveUploads?: (images: string[], worktreePath: string) => string[];
}

export class SessionService {
  constructor(private deps: ServiceDeps) {}

  async create(input: CreateSessionInput): Promise<Session> {
    const name = this.uniqueName(await this.deps.namer(input.prompt));
    const wt = this.deps.worktree.create(input.repoPath, input.baseBranch, name);
    const claudeSessionId = randomUUID();

    let promptArg = input.prompt;
    if (input.images.length > 0) {
      const move = this.deps.moveUploads ?? moveStagedIntoWorktree;
      const moved = move(input.images, wt.worktreePath);
      promptArg = `${input.prompt}\n\nAttached images:\n${moved.join("\n")}`;
    }

    const argv = ["claude", "--dangerously-skip-permissions", "--session-id", claudeSessionId];
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

  /** Type a reply into a session's live PTY (human-style steer). Returns false if unknown. */
  reply(id: string, text: string): boolean {
    const s = this.deps.store.get(id);
    if (!s) return false;
    this.deps.herdr.send(s.herdrAgentId, text + "\r");
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
