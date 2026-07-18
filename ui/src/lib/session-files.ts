import type { Session } from "$lib/types";

/**
 * Reserved top-level segment under which the Scratchpad view overlays the session's operator
 * attachments (#1717). Mirrors `ATTACHMENTS_DIR` in `src/scratchpad.ts` — the server emits paths
 * under this segment and marks the synthetic folder entry with `attachments: true`; the UI keys on
 * that marker for the label and on this constant for breadcrumb/upload-gate detection.
 */
export const ATTACHMENTS_DIR = "attachments";

/**
 * Whether a session's Files tab should be shown (#1717). True for any live Claude session (it has
 * a scratchpad) OR any live session that has at least one non-dropped operator attachment — the
 * latter makes attachment visibility provider-agnostic, so a non-Claude session (blank
 * `claudeSessionId`, no scratchpad) still surfaces its attachments. Archived sessions never qualify.
 */
export function computeHasFiles(session: Session): boolean {
  const hasAttachments = (session.launchMetadata?.attachments ?? []).some((a) => !a.dropped);
  return session.status !== "archived" && (session.claudeSessionId !== "" || hasAttachments);
}
