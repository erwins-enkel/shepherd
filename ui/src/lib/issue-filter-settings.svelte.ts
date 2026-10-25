import type { IssueFilterSettings } from "./types";
import { getSettings, putIssueFilter } from "./api";
import { toasts } from "./toasts.svelte";
import { m } from "./paraglide/messages.js";
import {
  DEFAULT_ISSUE_FILTER,
  browserStorage,
  clearLegacy,
  isDefaultIssueFilter,
  legacyPatch,
} from "./issue-filter-migration";

/** The operator's server-persisted default issue filter (#3017), shared by every surface that
 *  shows issues. Reads /api/settings, follows the `settings:issue-filter` push, and writes
 *  optimistically — a failed write reverts and toasts. The first load also migrates the old
 *  localStorage toggles (#3019, see issue-filter-migration.ts). */
export class IssueFilterSettingsStore {
  /** null = not loaded yet, or a server without the setting (hosts hide their filter UI). */
  value = $state<IssueFilterSettings | null>(null);
  /** The last value the server confirmed — what a failed write reverts to, since `value` may
   *  still carry an earlier write's unsaved optimistic patch. */
  private confirmed: IssueFilterSettings | null = null;
  private loading: Promise<void> | null = null;
  private wanted = false;
  private seq = 0;
  private migrated = false;

  constructor(
    private read = getSettings,
    private write = putIssueFilter,
    private storage = browserStorage,
  ) {}

  /** What the issue lists filter by: the server value, or the defaults until it loads. */
  get effective(): IssueFilterSettings {
    return this.value ?? DEFAULT_ISSUE_FILTER;
  }

  /** Load once; a failed read stays null and retries on the next call. */
  ensureLoaded(): Promise<void> {
    this.wanted = true;
    if (this.value || this.loading) return this.loading ?? Promise.resolve();
    return this.load();
  }

  /** Re-read after a WS reconnect (a push may have been missed), if anyone asked for it. */
  reconnected() {
    if (this.wanted && !this.loading) void this.load();
  }

  private load(): Promise<void> {
    const seq = this.seq;
    this.loading = this.read()
      .then((s) => {
        // A write started meanwhile owns the value until it settles.
        if (seq !== this.seq) return;
        this.value = s.issueFilter ?? null;
        this.confirmed = this.value;
        void this.migrateLegacy();
      })
      .catch(() => {
        /* stays as is; retried on the next ensureLoaded/reconnect */
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /** PATCH the old localStorage choices once, only onto a still-default server value, then drop
   *  the keys. A failed write keeps them for the next load; no toast — nothing the operator did. */
  private async migrateLegacy() {
    const storage = this.storage();
    if (this.migrated || !this.value || !storage) return;
    this.migrated = true;
    try {
      const patch = legacyPatch(storage);
      if (Object.keys(patch).length > 0 && isDefaultIssueFilter(this.value)) {
        const seq = ++this.seq;
        const r = await this.write(patch);
        this.confirmed = r.issueFilter;
        if (seq === this.seq) this.value = r.issueFilter;
      }
      clearLegacy(storage);
    } catch {
      this.migrated = false;
    }
  }

  apply(value: IssueFilterSettings) {
    this.value = value;
    this.confirmed = value;
  }

  async update(patch: Partial<IssueFilterSettings>): Promise<void> {
    if (!this.value) return;
    const seq = ++this.seq;
    this.value = { ...this.value, ...patch };
    try {
      const r = await this.write(patch);
      // The server answers its full merged value; spread anyway for a partial (demo) echo.
      this.confirmed = { ...(this.confirmed ?? this.value), ...r.issueFilter };
      if (seq === this.seq) this.value = this.confirmed;
    } catch {
      // A superseded write leaves the outcome to the latest one.
      if (seq !== this.seq) return;
      this.value = this.confirmed;
      toasts.info(m.upnext_filter_save_failed(), { alert: true });
    }
  }

  reset(): Promise<void> {
    // Up Next's rules only; the Backlog-only toggles (hideActive/…) are not part of this reset.
    const { scope, forks } = DEFAULT_ISSUE_FILTER;
    return this.update({ scope, forks, hiddenLabels: [] });
  }

  clear() {
    this.seq++;
    this.value = null;
    this.confirmed = null;
    this.loading = null;
    this.wanted = false;
  }
}

export const issueFilterSettings = new IssueFilterSettingsStore();
