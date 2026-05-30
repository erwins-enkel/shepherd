import type { SessionStore } from "./store";
import type { WorktreeMgr } from "./worktree";
import type { HerdrDriver } from "./herdr";
import { config } from "./config";
import type { CreateSessionInput, Session } from "./types";

export interface ServiceDeps {
  store: SessionStore;
  worktree: Pick<WorktreeMgr, "create" | "remove">;
  herdr: Pick<HerdrDriver, "start" | "list" | "stop">;
  namer: (prompt: string) => Promise<string>;
}

export class SessionService {
  constructor(private deps: ServiceDeps) {}

  async create(input: CreateSessionInput): Promise<Session> {
    const name = await this.deps.namer(input.prompt);
    const wt = this.deps.worktree.create(input.repoPath, input.baseBranch, name);
    const argv = ["claude", "--dangerously-skip-permissions"];
    if (input.model) argv.push("--model", input.model);
    argv.push(input.prompt);
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
      model: input.model,
    });
  }

  archive(id: string): void {
    const s = this.deps.store.get(id);
    if (!s) return;
    this.deps.herdr.stop(s.herdrAgentId); // stop the live claude agent so it doesn't leak
    if (s.isolated) this.deps.worktree.remove(s.worktreePath);
    this.deps.store.archive(id);
  }
}
