import { repoConfigDefaults, type SessionStore, type RepoConfig } from "./store";
import {
  effectiveRepoConfig,
  isRepoRuleKey,
  repoConfigGitContext,
  repoRulesFromConfig,
  repoRuleValidationError,
  withRepoConfigLock,
  writeRepoConfigFile,
  readRepoConfigFile,
  type RepoConfigFile,
} from "./repo-config-file";
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
};

/** A partial repo-config edit. Every field is a RepoConfig field (the route's
 *  `automationConfirmed` metadata is passed separately, never here). */
export type RepoConfigPatch = Partial<RepoConfig>;

export type RepoConfigPatchResult =
  | { ok: true; config: RepoConfigView; previousLocal: RepoConfig }
  | { ok: false; error: string; code?: "repo_config_write_failed" };

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
  constructor(
    private store: RepoConfigStore,
    private defaultProfile: () => SandboxProfile = defaultSandboxProfile,
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
      fieldSources,
      repoConfigCommit: file?.commit ?? null,
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
    opts: {
      automationConfirmed?: boolean;
      defaultAgentProvider?: AgentProvider;
    } = {},
  ): Promise<RepoConfigPatchResult> {
    return withRepoConfigLock(dir, async () => {
      const local = this.store.getLocalRepoConfig(dir);
      // A mode switch to lightweight must be local even if this repo has an origin/file.
      const fileEnabled =
        (patch.repoMode ?? local.repoMode) !== "lightweight" && !!repoConfigGitContext(dir);
      const hasRulePatch = Object.entries(patch).some(
        ([key, value]) => value !== undefined && isRepoRuleKey(key),
      );
      const writeRules = fileEnabled && hasRulePatch;
      let localRunDefaults: RepoConfigPatch = {};
      try {
        if (writeRules) {
          await writeRepoConfigFile(dir, (file) => {
            const { config } = this.validatedPatch(
              this.store.getLocalRepoConfig(dir),
              file,
              patch,
              opts.defaultAgentProvider,
            );
            return repoRulesFromConfig(config);
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
        if (err instanceof ConfigValidationError) return { ok: false, error: err.message };
        if (!writeRules) throw err;
        return {
          ok: false,
          code: "repo_config_write_failed",
          error:
            "Could not save repository rules to the default branch. Check origin access and branch protection, then retry.",
        };
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
      return { ok: true, config: this.read(dir), previousLocal: local };
    });
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
