const KEY = "shepherd:assistant-layout";

/** How the desktop grid splits its width while the Operator Assistant is docked. "standard" is
 *  the panel's original ~30% column; "half" and "wide" give it 1/2 and 2/3 of what the herd
 *  leaves; "talk" folds the session column into a strip so the panel takes all of it. The grid
 *  rules live in +page.svelte (`.grid.assistant[data-layout]`). */
export const ASSISTANT_LAYOUTS = ["standard", "half", "wide", "talk"] as const;
export type AssistantLayout = (typeof ASSISTANT_LAYOUTS)[number];

/** Pure: a stored value as a layout; anything unknown falls back to "standard". */
export function parseAssistantLayout(v: string | null): AssistantLayout {
  return ASSISTANT_LAYOUTS.find((l) => l === v) ?? "standard";
}

function read(): AssistantLayout {
  try {
    return parseAssistantLayout(localStorage.getItem(KEY));
  } catch {
    return "standard";
  }
}

/** The operator's pick, remembered per device. Mirrors the localStorage pattern of
 *  `herd-width.svelte.ts`: "standard" is the default and clears the stored value. */
class AssistantLayoutPref {
  layout = $state<AssistantLayout>(read());
  // What unfold() returns to: the layout picked before "talk" during this page load.
  #unfoldTo: AssistantLayout = "standard";

  set(next: AssistantLayout) {
    if (next === this.layout) return;
    if (this.layout !== "talk") this.#unfoldTo = this.layout;
    this.layout = next;
    try {
      if (next === "standard") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }

  /** Leave "talk" for the layout picked before it. */
  unfold() {
    if (this.layout === "talk") this.set(this.#unfoldTo);
  }
}

export const assistantLayout = new AssistantLayoutPref();
