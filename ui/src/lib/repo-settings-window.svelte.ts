import type { RepoSettingsSection } from "#lib/components/repo-settings/sections.js";
import type { DrainStatus, Settings } from "#lib/types.js";

// The one repo settings window (#3443). Any surface opens it for a repo — the repo tab's and the
// session row's context menus, the ⚙ pill, New Task's guard timeline, an epic's landing CI — and
// the page mounts it once (AppOverlays), so no entry point threads a callback to the page.

interface RepoSettingsTarget {
  repoPath: string;
  /** The section to show first; absent = the first one that needs attention, else Autonomy. */
  section?: RepoSettingsSection;
  /** The task it was opened from: its review pulse and its plan gate show in the window. */
  sessionId?: string;
  /** Takes the focus back when the window closes. */
  opener?: HTMLElement | null;
}

/** The page's live inputs to every repo-settings surface (#3445): a repo's drain and the global
 *  settings an "inherit" follows. */
interface RepoSettingsInputs {
  drain(repoPath: string): DrainStatus | null;
  globals(): Settings | null;
}

class RepoSettingsWindow {
  target = $state<RepoSettingsTarget | null>(null);
  #inputs: RepoSettingsInputs = { drain: () => null, globals: () => null };

  /** The page (AppOverlays) hands over what it feeds the window, so the context menus' short
   *  status reads the very same drain and global CLI without every row threading them. */
  provide(inputs: RepoSettingsInputs) {
    this.#inputs = inputs;
  }

  drainFor(repoPath: string): DrainStatus | null {
    return this.#inputs.drain(repoPath);
  }

  globals(): Settings | null {
    return this.#inputs.globals();
  }

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
