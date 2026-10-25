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
        if (seq === this.seq) this.value = s.issueFilter ?? null;
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
  }

  async update(patch: Partial<IssueFilterSettings>): Promise<void> {
    const prev = this.value;
    if (!prev) return;
    const seq = ++this.seq;
    this.value = { ...prev, ...patch };
    try {
      const r = await this.write(patch);
      if (seq === this.seq && this.value) this.value = { ...this.value, ...r.issueFilter };
    } catch {
      if (seq !== this.seq) return;
      this.value = prev;
      toasts.info(m.upnext_filter_save_failed(), { alert: true });
    }
  }

  reset(): Promise<void> {
    return this.update({ ...UP_NEXT_FILTER_DEFAULTS, hiddenLabels: [] });
  }

  clear() {
    this.seq++;
    this.value = null;
    this.loading = null;
    this.wanted = false;
  }
}

export const issueFilterSettings = new IssueFilterSettingsStore();
