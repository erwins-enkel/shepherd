import type { IssueFilterSettings } from "./types";
import { getSettings, putIssueFilter } from "./api";
import { toasts } from "./toasts.svelte";
import { m } from "./paraglide/messages.js";

/** The Up Next defaults (src/issue-filter.ts DEFAULT_ISSUE_FILTER) that "Reset" restores. The
 *  Backlog-only toggles (hideActive/hideSubIssues/hideBlocked) are not part of this reset. */
const UP_NEXT_FILTER_DEFAULTS: Pick<IssueFilterSettings, "scope" | "forks" | "hiddenLabels"> = {
  scope: "mine_unassigned",
  forks: "all",
  hiddenLabels: [],
};

/** The operator's server-persisted default issue filter (#3017), shared by every surface that
 *  shows issues. Reads /api/settings, follows the `settings:issue-filter` push, and writes
 *  optimistically — a failed write reverts and toasts. */
export class IssueFilterSettingsStore {
  /** null = not loaded yet, or a server without the setting (hosts hide their filter UI). */
  value = $state<IssueFilterSettings | null>(null);
  /** The last value the server confirmed — what a failed write reverts to, since `value` may
   *  still carry an earlier write's unsaved optimistic patch. */
  private confirmed: IssueFilterSettings | null = null;
  private loading: Promise<void> | null = null;
  private wanted = false;
  private seq = 0;

  constructor(
    private read = getSettings,
    private write = putIssueFilter,
  ) {}

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
      })
      .catch(() => {
        /* stays as is; retried on the next ensureLoaded/reconnect */
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
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
    return this.update({ ...UP_NEXT_FILTER_DEFAULTS, hiddenLabels: [] });
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
