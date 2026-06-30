import type { SessionStore, RepoConfig } from "./store";

/** The read-shape the repo-config route returns: the stored config plus the two
 *  automation-metadata flags that live OUTSIDE RepoConfig (a deliberate split —
 *  `markAutomationConfirmed` is metadata, never a config field). */
export type RepoConfigView = RepoConfig & {
  automationConfirmed: boolean;
  automationRowExists: boolean;
};

/** A partial repo-config edit. Every field is a RepoConfig field (the route's
 *  `automationConfirmed` metadata is passed separately, never here). */
export type RepoConfigPatch = Partial<RepoConfig>;

export type RepoConfigPatchResult =
  { ok: true; config: RepoConfigView } | { ok: false; error: string };

/** Narrow store interface this service needs — the seam, kept small. */
type RepoConfigStore = Pick<
  SessionStore,
  | "getRepoConfig"
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
  constructor(private store: RepoConfigStore) {}

  /** The stored config plus its automation-metadata flags (the route response shape). */
  read(dir: string): RepoConfigView {
    return {
      ...this.store.getRepoConfig(dir),
      automationConfirmed: this.store.isAutomationConfirmed(dir),
      automationRowExists: this.store.automationRowExists(dir),
    };
  }

  /**
   * Atomically apply a partial config edit: merge the patch over the current
   * config, enforce the cross-field invariants, persist, then (when the operator
   * confirmed automation) mark the row confirmed. Returns the fresh view on
   * success or a validation error message on rejection — the route maps the error
   * to a 400.
   */
  patch(
    dir: string,
    patch: RepoConfigPatch,
    opts: { automationConfirmed?: boolean } = {},
  ): RepoConfigPatchResult {
    const merged = this.merge(this.store.getRepoConfig(dir), patch);
    if (merged.draftMode && merged.autoMergeEnabled) {
      return { ok: false, error: "draftMode and autoMergeEnabled are mutually exclusive" };
    }
    // A critic-reliant sign-off authority with the critic OFF can never promote a draft → it
    // would deadlock as a permanent draft. (With the critic off, "either" also reduces to the
    // human check, so it's equivalent to "human" anyway.) Force an explicit "human" authority.
    if (merged.draftMode && !merged.criticEnabled && merged.signoffAuthority !== "human") {
      return {
        ok: false,
        error: `signoffAuthority "${merged.signoffAuthority}" requires criticEnabled — it would never sign off (use "human")`,
      };
    }
    this.store.setRepoConfig(dir, merged);
    if (opts.automationConfirmed === true) this.store.markAutomationConfirmed(dir);
    return { ok: true, config: this.read(dir) };
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
