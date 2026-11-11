import { repoConfigDefaults, type SessionStore, type RepoConfig } from "./store";
import {
  effectiveRepoConfig,
  isRepoRuleKey,
  repoConfigGitContext,
  repoRulesFromConfig,
  withRepoConfigLock,
  writeRepoConfigFile,
  readRepoConfigFile,
} from "./repo-config-file";
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
  | { ok: true; config: RepoConfigView }
  | { ok: false; error: string; code?: "repo_config_write_failed" };

/** Narrow store interface this service needs — the seam, kept small. */
type RepoConfigStore = Pick<
  SessionStore,
  | "getRepoConfig"
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
      localRunDefaults?: Partial<Pick<RepoConfig, "defaultModel" | "defaultEffort">>;
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
      if (fileEnabled && hasRulePatch) {
        try {
          await writeRepoConfigFile(dir, (file) => {
            const currentLocal = this.store.getLocalRepoConfig(dir);
            const current = effectiveRepoConfig(currentLocal, repoConfigDefaults(), file);
            const merged = this.merge(current, {
              ...patch,
              ...(!file ? opts.localRunDefaults : {}),
            });
            validate(merged);
            return repoRulesFromConfig(merged);
          });
        } catch (err) {
          if (err instanceof ConfigValidationError) return { ok: false, error: err.message };
          return {
            ok: false,
            code: "repo_config_write_failed",
            error:
              "Could not save repository rules to the default branch. Check origin access and branch protection, then retry.",
          };
        }
      } else {
        const file = fileEnabled ? readRepoConfigFile(dir) : null;
        const current = effectiveRepoConfig(local, repoConfigDefaults(), file);
        try {
          validate(this.merge(current, { ...patch, ...(!file ? opts.localRunDefaults : {}) }));
        } catch (err) {
          if (err instanceof ConfigValidationError) return { ok: false, error: err.message };
          throw err;
        }
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
          ...(!(fileEnabled && (hasRulePatch || readRepoConfigFile(dir)))
            ? opts.localRunDefaults
            : {}),
        }),
      );
      if (opts.automationConfirmed === true) this.store.markAutomationConfirmed(dir);
      return { ok: true, config: this.read(dir) };
    });
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

function validate(merged: RepoConfig): void {
  if (merged.draftMode && merged.autoMergeEnabled)
    throw new ConfigValidationError("draftMode and autoMergeEnabled are mutually exclusive");
  // A critic-reliant signoff with critic disabled would leave drafts stuck forever.
  if (merged.draftMode && !merged.criticEnabled && merged.signoffAuthority !== "human")
    throw new ConfigValidationError(
      `signoffAuthority "${merged.signoffAuthority}" requires criticEnabled — it would never sign off (use "human")`,
    );
}
