import { getContext, setContext } from "svelte";
import type { RepoSettingsSection } from "./sections";

// A link from one setting to another (#3444: Full-auto merge's "Go to Autopilot"). The window
// shows one section at a time, so it provides how to switch to the setting's section; the
// stacked surfaces (Backlog tab, first-task confirm) render every section and provide nothing —
// there the setting is already on the page.

type GoTo = (section: RepoSettingsSection, field: string) => void;

const KEY = Symbol("repo-settings-setting-link");

/** Focus the control of the setting row `field` names under `root`; false when it isn't there. */
export function focusSetting(root: ParentNode, field: string): boolean {
  const row = root.querySelector<HTMLElement>(`[data-field~="${field}"]`);
  if (!row) return false;
  // Prefer the setting's control to its explanation trigger; disabled rows remain readable.
  const controls = [
    ...row.querySelectorAll<HTMLElement>(
      '[role="switch"], select, input, textarea, button:not(.info)',
    ),
  ].filter((el) => !el.matches(":disabled") && el.getClientRects().length > 0);
  const control =
    controls.find((el) => el.matches('[role="switch"]')) ??
    controls.find((el) => el.matches(":checked")) ??
    controls.find((el) => el.matches("select, input, textarea")) ??
    controls[0];
  if (!control) row.tabIndex = -1;
  const target = control ?? row;
  target.scrollIntoView({ block: "nearest" });
  target.focus({ preventScroll: true });
  return true;
}

/** Scroll the row `field` names under `root` into view, waiting for it to render (a row that
 *  shows once its data loads) up to `timeoutMs`. Returns a cleanup that stops waiting. */
export function revealSetting(
  root: HTMLElement,
  field: string,
  timeoutMs = 5000,
  focus = false,
): () => void {
  const find = () => root.querySelector<HTMLElement>(`[data-field~="${field}"]`);
  const reveal = (row: HTMLElement) => {
    row.scrollIntoView({ block: "nearest" });
    if (focus) focusSetting(root, field);
  };
  const now = find();
  if (now) {
    // after the window's own open effects, which reset the pane's scroll
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) reveal(now);
    });
    return () => {
      cancelled = true;
    };
  }
  const observer = new MutationObserver(() => {
    const row = find();
    if (!row) return;
    stop();
    reveal(row);
  });
  const timer = setTimeout(() => stop(), timeoutMs);
  function stop() {
    observer.disconnect();
    clearTimeout(timer);
  }
  observer.observe(root, { childList: true, subtree: true });
  return stop;
}

/** The window's half: switch to `section`, then focus the row. */
export function provideSettingLink(goTo: GoTo) {
  setContext(KEY, goTo);
}

/** Call from component init; the returned function follows a link clicked at `from`. */
export function useSettingLink(): (
  from: HTMLElement,
  section: RepoSettingsSection,
  field: string,
) => void {
  const goTo = getContext<GoTo | undefined>(KEY);
  return (from, section, field) => {
    if (goTo) return goTo(section, field);
    // every section on one page: the row is a near relative of the link
    for (let el = from.parentElement; el; el = el.parentElement)
      if (focusSetting(el, field)) return;
  };
}
