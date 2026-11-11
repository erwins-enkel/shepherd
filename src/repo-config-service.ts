import type { RepoLeitrechnerService, RepoLeitrechnerStatus } from "./repo-leitrechner";
import { repoConfigDefaults, type SessionStore, type RepoConfig } from "./store";
import {
  effectiveRepoConfig,
  isRepoRuleKey,
  repoConfigGitContext,
  repoConfigGit,
  repoRulesFromConfig,
  repoRuleValidationError,
  withRepoConfigLock,
  fetchRepoConfigDefault,
  writeRepoConfigFile,
  readRepoConfigFile,
  isLeitrechner,
  type RepoConfigFile,
} from "./repo-config-file";
import type { GitForge } from "./forge/types";
import {
  saveRepoConfigRules,
  readRepoConfigProposal,
  pendingRepoConfig,
  rebaseRepoConfigProposal,
  REPO_CONFIG_PR_BRANCH,
  type PendingRepoConfig,
} from "./repo-config-pr";
import { clampRunDefaultsToCli } from "./agent-provider";
import type { AgentProvider } from "./types";
import type { SandboxProfile } from "./sandbox";
import { defaultSandboxProfile } from "./sandbox-default";

/** The read-shape the repo-config route returns: the stored config plus the two
 *  automation-metadata flags that live OUTSIDE RepoConfig (a deliberate split —
 *  `markAutomationConfirmed` is metadata, never a config field), plus the global default
 *  sandbox profile a `sandboxProfile: "inherit"` resolves to (#2100). */
export type RepoConfigView = RepoConfig & {
  automationConfirmed: boolean;
  automationRowExists: boolean;
  sandboxDefaultProfile: SandboxProfile;
  fieldSources: Record<keyof RepoConfig, "repo" | "rechner">;
  repoConfigCommit: string | null;
  repoConfigBranch: string | null;
  leitrechner: string | null;
  leitrechnerStatus: RepoLeitrechnerStatus;
  pendingRepoConfig?: PendingRepoConfig | null;
};

/** A partial repo-config edit. Every field is a RepoConfig field (the route's
 *  `automationConfirmed` metadata is passed separately, never here). */
export type RepoConfigPatch = Partial<RepoConfig>;

export type RepoConfigPatchResult =
  | {
      ok: true;
      config: RepoConfigView;
      previousLocal: RepoConfig;
      rulesCommitted: boolean;
      effectiveRulesChanged: boolean;
    }
  | { ok: false; error: string; code?: "repo_config_write_failed" };

type PatchOptions = {
  automationConfirmed?: boolean;
  leitrechner?: string | null;
  defaultAgentProvider?: AgentProvider;
};
type ProposalCache = {
  dir: string;
  pending: PendingRepoConfig | null;
  checkedAt: number;
  failed?: true;
};

/** Narrow store interface this service needs — the seam, kept small. */
type RepoConfigStore = Pick<
  SessionStore,
  | "getLocalRepoConfig"
  | "setRepoConfig"
  | "markAutomationConfirmed"
  | "isAutomationConfirmed"
  | "automationRowExists"
>;

/**
 * Deep module owning the repo-config read-modify-write (#1092). It absorbs the
 * route's inline merge + cross-field validation + atomic write + automation-
 * confirmation bookkeeping, so the handler shrinks to validate-and-delegate and
 * the store stops leaking the read→merge→write ordering to the caller.
 *
 * HTTP-agnostic: returns domain values (a discriminated result / a view DTO),
 * never a Response or status code — so it's testable without booting makeApp.
 */
export class RepoConfigService {
  private proposals = new Map<string, ProposalCache>();
  private proposalKey(dir: string) {
    return repoConfigGitContext(dir)?.key ?? dir;
  }

  pendingDirectories(): string[] {
    return [...this.proposals.values()].filter((entry) => entry.pending).map((entry) => entry.dir);
  }

  private hasFreshProposal(key: string): boolean {
    const cached = this.proposals.get(key);
    return !!cached && Date.now() - cached.checkedAt < 60_000;
  }

  /** Cached reads never wait for Git writes; stale checks serialize with those writes. */
  async refreshPending(dir: string, force = false): Promise<boolean> {
    const key = this.proposalKey(dir);
    if (!force && this.hasFreshProposal(key)) return false;
    return withRepoConfigLock(dir, async () => {
      // Another queued read may have checked this repo while we waited for the lock.
      if (!force && this.hasFreshProposal(key)) return false;
      const cached = this.proposals.get(key);
      try {
        const forge = this.ruleForge(dir, this.store.getLocalRepoConfig(dir).repoMode);
        if (!forge || forge.isFork) return false;
        const before = readRepoConfigFile(dir)?.commit;
        const { pending, merged } = await this.reconcileProposal(
          dir,
          forge,
          cached?.pending ?? null,
        );
        this.proposals.set(key, { dir, pending, checkedAt: Date.now() });
        return (
          before !== readRepoConfigFile(dir)?.commit ||
          (merged && (!cached || cached.failed || !!cached.pending))
        );
      } catch {
        // Failed checks consume the same freshness window without discarding verified state.
        this.proposals.set(key, {
          dir,
          pending: cached?.pending ?? null,
          checkedAt: Date.now(),
          failed: true,
        });
        return false;
      }
    });
  }

  private ruleForge(dir: string, mode: RepoConfig["repoMode"]): GitForge | null {
    if (mode === "lightweight" || !repoConfigGitContext(dir)) return null;
    const forge = this.resolveForge(dir);
    return forge?.kind === "local" ? null : forge;
  }

  private async reconcileProposal(
    dir: string,
    forge: GitForge,
    previous: PendingRepoConfig | null,
  ) {
    const proposal = await readRepoConfigProposal(dir, forge);
    const pr = proposal?.pr ?? (previous ? await forge.prStatus(REPO_CONFIG_PR_BRANCH) : null);
    if (pr?.state === "merged") {
      await fetchRepoConfigDefault(dir);
      return { pending: null, merged: true };
    }
    if (pr?.state === "closed") return { pending: null, merged: false };
    if (pr?.state !== "open" || !proposal) return { pending: previous, merged: false };
    const file = await fetchRepoConfigDefault(dir);
    const base = await repoConfigGit(dir, [
      "rev-parse",
      `refs/remotes/origin/${repoConfigGitContext(dir)!.branch}`,
    ]);
    const pending = pendingRepoConfig(
      pr,
      file,
      await rebaseRepoConfigProposal(dir, base, file, proposal),
      repoRulesFromConfig(this.store.getLocalRepoConfig(dir)),
    );
    return { pending, merged: false };
  }

  private async saveRules(
    dir: string,
    forge: GitForge | null,
    patch: RepoConfigPatch,
    opts: PatchOptions,
  ) {
    const update = (file: RepoConfigFile | null) => {
      const { config } = this.validatedPatch(
        this.store.getLocalRepoConfig(dir),
        file,
        patch,
        opts.defaultAgentProvider,
      );
      return {
        ...repoRulesFromConfig(config),
        ...(opts.leitrechner === undefined ? {} : { leitrechner: opts.leitrechner }),
      };
    };
    if (!forge) {
      await writeRepoConfigFile(dir, update);
      this.proposals.delete(this.proposalKey(dir));
      return true;
    }
    const saved = await saveRepoConfigRules(
      dir,
      forge,
      update,
      repoRulesFromConfig(this.store.getLocalRepoConfig(dir)),
    );
    this.proposals.set(this.proposalKey(dir), {
      dir,
      pending: saved.kind === "pr" ? saved.pending : null,
      checkedAt: Date.now(),
    });
    return saved.kind === "pushed";
  }

  constructor(
    private store: RepoConfigStore,
    private defaultProfile: () => SandboxProfile = defaultSandboxProfile,
    private leitrechner?: Pick<RepoLeitrechnerService, "status" | "invalidate">,
    private resolveForge: (dir: string) => GitForge | null = () => null,
  ) {}

  /** The stored config plus its automation-metadata flags (the route response shape). */
  read(dir: string): RepoConfigView {
    const local = this.store.getLocalRepoConfig(dir);
    const file = local.repoMode === "lightweight" ? null : readRepoConfigFile(dir);
    const config = effectiveRepoConfig(local, repoConfigDefaults(), file);
    const fieldSources = Object.fromEntries(
      Object.keys(config).map((key) => [key, file && isRepoRuleKey(key) ? "repo" : "rechner"]),
    ) as RepoConfigView["fieldSources"];
    return {
      ...config,
      leitrechnerStatus: this.leitrechner?.status(dir) ?? {
        instanceId: config.leitrechner ?? null,
        name: null,
        role: config.leitrechner ? "unknown" : "unassigned",
        reachable: null,
        allowed: true,
        pauseReason: null,
      },
      fieldSources,
      repoConfigCommit: file?.commit ?? null,
      repoConfigBranch:
        local.repoMode === "lightweight" ? null : (repoConfigGitContext(dir)?.branch ?? null),
      leitrechner: file?.leitrechner ?? null,
      pendingRepoConfig:
        local.repoMode === "lightweight"
          ? null
          : (this.proposals.get(this.proposalKey(dir))?.pending ?? null),
      automationConfirmed: this.store.isAutomationConfirmed(dir),
      automationRowExists: this.store.automationRowExists(dir),
      sandboxDefaultProfile: this.defaultProfile(),
    };
  }

  /**
   * Atomically apply a partial config edit: merge the patch over the current
   * config, enforce the cross-field invariants, persist, then (when the operator
   * confirmed automation) mark the row confirmed. Returns the fresh view on
   * success or a validation error message on rejection — the route maps the error
   * to a 400.
   */
  async patch(
    dir: string,
    patch: RepoConfigPatch,
    opts: PatchOptions = {},
  ): Promise<RepoConfigPatchResult> {
    const leader = opts.leitrechner === undefined ? patch.leitrechner : opts.leitrechner;
    return withRepoConfigLock(dir, async () => {
      const local = this.store.getLocalRepoConfig(dir);
      // A mode switch to lightweight must be local even if this repo has an origin/file.
      const forge = this.ruleForge(dir, patch.repoMode ?? local.repoMode);
      const fileEnabled =
        (patch.repoMode ?? local.repoMode) !== "lightweight" &&
        (!!forge || readRepoConfigFile(dir) !== null);
      const hasRulePatch = Object.entries(patch).some(
        ([key, value]) => value !== undefined && isRepoRuleKey(key),
      );
      const leaderError = this.leaderPatchError(fileEnabled, leader);
      if (leaderError) return { ok: false, error: leaderError };
      const writeRules = fileEnabled && (hasRulePatch || leader !== undefined);
      let localRunDefaults: RepoConfigPatch = {};
      let rulesCommitted = false;
      const previousCommit = writeRules ? readRepoConfigFile(dir)?.commit : undefined;
      try {
        if (writeRules) {
          rulesCommitted = await this.saveRules(dir, forge, patch, {
            ...opts,
            leitrechner: leader,
          });
        } else {
          const file = fileEnabled ? readRepoConfigFile(dir) : null;
          localRunDefaults = this.validatedPatch(
            local,
            file,
            patch,
            opts.defaultAgentProvider,
          ).localRunDefaults;
        }
      } catch (err) {
        return this.patchError(err, writeRules);
      }
      // Re-read after network awaits. Never copy effective repo rules into their DB fallback.
      const localPatch = Object.fromEntries(
        Object.entries(patch).filter(
          ([key, value]) => value !== undefined && (!fileEnabled || !isRepoRuleKey(key)),
        ),
      );
      this.store.setRepoConfig(
        dir,
        this.merge(this.store.getLocalRepoConfig(dir), {
          ...localPatch,
          ...localRunDefaults,
        }),
      );
      if (opts.automationConfirmed === true) this.store.markAutomationConfirmed(dir);
      this.leitrechner?.invalidate(dir);
      return {
        ok: true,
        config: this.read(dir),
        previousLocal: local,
        rulesCommitted,
        effectiveRulesChanged: writeRules && previousCommit !== readRepoConfigFile(dir)?.commit,
      };
    });
  }

  private patchError(
    err: unknown,
    writeRules: boolean,
  ): Extract<RepoConfigPatchResult, { ok: false }> {
    if (err instanceof ConfigValidationError) return { ok: false, error: err.message };
    if (!writeRules) throw err;
    return {
      ok: false,
      code: "repo_config_write_failed",
      error:
        "Could not save repository rules to the default branch or its PR. Check origin and forge write access, then retry; another machine may have updated the proposal.",
    };
  }

  private leaderPatchError(fileEnabled: boolean, leader: unknown): string | null {
    if (leader === undefined) return null;
    return fileEnabled && isLeitrechner(leader)
      ? null
      : "leitrechner requires a forge repository and a valid instance ID or null";
  }

  /** Derive CLI defaults only from the serialized, freshly read view. Shared rules stay intact. */
  private validatedPatch(
    local: RepoConfig,
    file: RepoConfigFile | null,
    patch: RepoConfigPatch,
    provider?: AgentProvider,
  ) {
    const current = effectiveRepoConfig(local, repoConfigDefaults(), file);
    const localRunDefaults =
      file || !provider ? {} : clampRunDefaultsToCli(current, patch, provider);
    const config = this.merge(current, { ...patch, ...localRunDefaults });
    const error = repoRuleValidationError(config);
    if (error) throw new ConfigValidationError(error);
    return { config, localRunDefaults };
  }

  /** Overlay the defined patch fields onto the current config (undefined = leave as-is). */
  private merge(cur: RepoConfig, patch: RepoConfigPatch): RepoConfig {
    const out: RepoConfig = { ...cur };
    const writable = out as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) writable[k] = v;
    }
    return out;
  }
}

class ConfigValidationError extends Error {}
