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
  herdr: Pick<HerdrDriver, "start" | "list" | "stop">;
  namer: (prompt: string) => Promise<string>;
  /** Inject point for tests; defaults to the real fs move. */
  moveUploads?: (images: string[], worktreePath: string) => string[];
}

export class SessionService {
  constructor(private deps: ServiceDeps) {}

  async create(input: CreateSessionInput): Promise<Session> {
    const name = await this.deps.namer(input.prompt);
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
      prompt: input.prompt,
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

  archive(id: string): void {
    const s = this.deps.store.get(id);
    if (!s) return;
    this.deps.herdr.stop(s.herdrAgentId); // stop the live claude agent so it doesn't leak
    if (s.isolated)
      this.deps.worktree.remove(s.worktreePath, { branch: s.branch, baseBranch: s.baseBranch });
    this.deps.store.archive(id);
  }
}
