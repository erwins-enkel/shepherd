import type { HeldResult, Session } from "./types";
import { toasts } from "./toasts.svelte";
import { m } from "./paraglide/messages";

/** Confirm a steer quick-launch from the Repos dialog, which stays open instead of jumping to
 *  the new session: a started session gets "Open session", a held one says it waits for the
 *  usage reset. Unkeyed, so two quick starts keep two toasts that each open their own session. */
export function confirmBacklogQuickStart(
  result: Session | HeldResult,
  issue: number,
  onopen: (id: string) => void,
): void {
  if ("held" in result) {
    toasts.info(m.upnext_held({ count: 1 }), { key: "upnext-held" });
    return;
  }
  const id = result.id;
  toasts.info(m.backlog_quick_started({ number: issue }), {
    action: { label: m.epic_run_open_session(), run: () => onopen(id) },
  });
}
