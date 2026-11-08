import { getContext, setContext } from "svelte";
import { infoTips } from "#lib/info-tips.svelte.js";

// Which row's long-form "ⓘ" explanation is expanded — one at a time across a whole settings
// surface (the window, the Backlog tab, the first-task confirm), so a single open detail keeps it
// readable. The surface provides it; each RepoSettingRow reads it.

const KEY = Symbol("repo-settings-open-detail");

class OpenDetail {
  id = $state<string | null>(null);

  toggle(id: string) {
    this.id = this.id === id ? null : id;
  }
}

/** Call from a settings surface's component init. Collapses any expanded explanation when the
 *  operator hides info tips, so re-enabling them later returns a cleanly collapsed surface rather
 *  than a stale expansion. */
export function provideOpenDetail(): OpenDetail {
  const detail = new OpenDetail();
  setContext(KEY, detail);
  $effect(() => {
    if (infoTips.hidden) detail.id = null;
  });
  return detail;
}

/** The surface's shared state; a row rendered on its own keeps a private one. */
export function useOpenDetail(): OpenDetail {
  return getContext<OpenDetail | undefined>(KEY) ?? new OpenDetail();
}
