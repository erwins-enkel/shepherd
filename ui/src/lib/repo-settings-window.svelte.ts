import type { RepoSettingsSection } from "#lib/components/repo-settings/sections.js";

// The one repo settings window (#3443). Any surface opens it for a repo — the repo tab's and the
// session row's context menus, the ⚙ pill, New Task's guard timeline, an epic's landing CI — and
// the page mounts it once (AppOverlays), so no entry point threads a callback to the page.

export interface RepoSettingsTarget {
  repoPath: string;
  /** The section to show first; absent = the first one that needs attention, else the agent's. */
  section?: RepoSettingsSection;
  /** The task it was opened from: its review pulse and its plan gate show in the window. */
  sessionId?: string;
  /** Takes the focus back when the window closes. */
  opener?: HTMLElement | null;
}

class RepoSettingsWindow {
  target = $state<RepoSettingsTarget | null>(null);

  open(repoPath: string, opts: Omit<RepoSettingsTarget, "repoPath"> = {}) {
    this.target = { repoPath, ...opts };
  }

  /** Whether the window shows `repoPath` — an entry point's aria-expanded. */
  isOpenFor(repoPath: string): boolean {
    return this.target?.repoPath === repoPath;
  }

  close() {
    const opener = this.target?.opener;
    this.target = null;
    // After the window's own focus restore, so the entry that opened it wins.
    queueMicrotask(() => {
      if (opener?.isConnected) opener.focus();
    });
  }
}

export const repoSettingsWindow = new RepoSettingsWindow();
