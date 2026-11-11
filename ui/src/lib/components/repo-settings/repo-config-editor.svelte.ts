import { getContext, setContext, untrack } from "svelte";
import {
  getRepoConfig,
  putRepoConfig,
  type RepoConfigPatch,
  type RepoConfigResponse,
} from "#lib/api.js";
import { repoConfig, RepoConfigStore } from "#lib/reviews.svelte.js";

import { RULE_FIELDS, isRuleField } from "#lib/repo-config-fields.js";

export type SettingsLayer = "repo" | "rechner";
const EDITOR = Symbol("repo-config-editor");
const LAYER = Symbol("repo-config-layer");
const LEAVE = Symbol("automation-leave");
export interface AutomationLeaveGuard {
  editor: RepoConfigEditor | null;
}
export function provideAutomationLeaveGuard(): AutomationLeaveGuard {
  const guard: AutomationLeaveGuard = { editor: null };
  setContext(LEAVE, guard);
  return guard;
}
export function useAutomationLeaveGuard(): AutomationLeaveGuard | undefined {
  return getContext(LEAVE);
}

export class RepoConfigEditor extends RepoConfigStore {
  view = $state<RepoConfigResponse | null>(null);
  draft = $state<RepoConfigPatch>({});
  saving = $state(false);
  localName = $state("");
  machineNames = $state<Record<string, string>>({});
  private reviewed: RepoConfigResponse | null = null;
  dirty = $derived(Object.keys(this.draft).length > 0);
  shareable = $derived(!!this.view?.repoConfigBranch && this.view.repoMode !== "lightweight");
  constructor(readonly repoPath: string) {
    super();
  }
  private sync(view: RepoConfigResponse) {
    this.view = view;
    this.ingest(this.repoPath, { ...view, ...this.draft });
  }
  override async ensure(repoPath: string) {
    const ok = await repoConfig.ensure(repoPath);
    const view = repoConfig.responses[repoPath];
    if (view) this.sync(view);
    return ok;
  }
  override async reload(repoPath: string) {
    const ok = await repoConfig.reload(repoPath);
    const view = repoConfig.responses[repoPath];
    if (view) this.sync(view);
    return ok;
  }
  override async write(repoPath: string, patch: RepoConfigPatch, opts: { rethrow?: boolean } = {}) {
    if (this.saving && Object.keys(patch).some(isRuleField)) return null;
    await this.ensure(repoPath);
    if (!this.view) {
      if (Object.keys(patch).some(isRuleField)) return null;
      return repoConfig.write(repoPath, patch, { ...opts, machineOnly: true });
    }
    if (this.view.repoConfigBranch === undefined && Object.keys(patch).some(isRuleField))
      return null;
    const local = this.stageRules(patch);
    if (Object.keys(local).length) {
      const response = await repoConfig.write(repoPath, local, { ...opts, machineOnly: true });
      if (!response) return null;
      this.sync(response);
      return response;
    }
    this.sync(this.view);
    return this.responses[repoPath];
  }
  /** Split one existing compound setter into staged rules and an immediate machine patch. */
  private stageRules(patch: RepoConfigPatch): RepoConfigPatch {
    const local: RepoConfigPatch = {};
    const staged = { ...this.draft };
    for (const [key, value] of Object.entries(patch)) {
      if (isRuleField(key) && this.shareable) {
        if (value === this.view![key]) delete staged[key];
        else Object.assign(staged, { [key]: value });
      } else Object.assign(local, { [key]: value });
    }
    this.draft = staged;
    return local;
  }
  async setLeader(value: string | null) {
    return this.write(this.repoPath, { leitrechner: value });
  }
  discard() {
    this.draft = {};
    if (this.view) this.sync(this.view);
  }
  /** Refresh the comparison immediately before opening the confirmation, keeping selected edits. */
  async prepare() {
    this.sync(await getRepoConfig(this.repoPath));
    this.reviewed = this.view;
  }
  get changes() {
    if (!this.view) return [];
    return RULE_FIELDS.filter(
      (key) => this.view?.repoConfigCommit == null || key in this.draft,
    ).map((key) => ({
      key,
      before: this.view![key],
      after: key in this.draft ? this.draft[key] : this.view![key],
    }));
  }
  async save() {
    if (this.saving || !this.shareable || !this.view) return false;
    this.saving = true;
    try {
      const previous = this.reviewed ?? this.view;
      const latest = await getRepoConfig(this.repoPath);
      const changed =
        latest.repoConfigBranch !== previous.repoConfigBranch ||
        (latest.repoConfigCommit == null) !== (previous.repoConfigCommit == null) ||
        (previous.repoConfigCommit == null ? RULE_FIELDS : Object.keys(this.draft)).some(
          (key) => isRuleField(key) && latest[key] !== previous[key],
        );
      this.sync(latest);
      if (changed) {
        this.reviewed = latest;
        return false;
      }
      const patch =
        this.view.repoConfigCommit == null
          ? Object.fromEntries(
              RULE_FIELDS.map((key) => [
                key,
                key in this.draft ? this.draft[key] : this.view![key],
              ]),
            )
          : { ...this.draft };
      if (!Object.keys(patch).length) return true;
      const saved = await putRepoConfig(this.repoPath, patch);
      const merged = repoConfig.adoptRules(this.repoPath, saved);
      this.draft = {};
      this.reviewed = null;
      this.sync(merged);
      // A rule response can be delayed by peer notification while immediate machine writes finish.
      // Re-read after the commit without turning a successful commit into a failed save.
      if (await repoConfig.reload(this.repoPath))
        this.sync({ ...repoConfig.responses[this.repoPath], notifications: saved.notifications });
      else this.sync({ ...merged, notifications: saved.notifications });
      return true;
    } finally {
      this.saving = false;
    }
  }
}
export function provideRepoEditor(editor: RepoConfigEditor) {
  setContext(EDITOR, editor);
  $effect(() => {
    // Observe authoritative changes, including existing callers' optimistic machine overlays.
    editor.copyStateFrom(repoConfig);
    const view = repoConfig.responses[editor.repoPath];
    untrack(() => {
      if (view) {
        editor.view = view;
        editor.overlay(editor.repoPath, editor.draft);
      }
    });
  });
}
export function useRepoEditor(): RepoConfigEditor | undefined {
  return getContext(EDITOR);
}
export function useRepoConfig(): RepoConfigStore {
  return useRepoEditor() ?? repoConfig;
}
export function provideSettingsLayer(layer: SettingsLayer) {
  setContext(LAYER, layer);
}
export function useSettingsLayer(): SettingsLayer | undefined {
  return getContext(LAYER);
}
export function fieldLayer(field: string): SettingsLayer {
  return field
    .split(" ")
    .some((key) => isRuleField(key) || key === "autonomyLevel" || key === "autonomyChain")
    ? "repo"
    : "rechner";
}
