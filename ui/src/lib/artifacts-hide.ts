import { ApiError, setArtifactsHidden } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";
import { toasts } from "#lib/toasts.svelte.js";

/** How long the hide's toast offers Undo: long enough to read it and reach the button. */
const UNDO_MS = 8000;

/**
 * "Hide for this session" for the artifact row (#3877). The server keeps it on the session's
 * artifact list, so the row disappears on every client through `session:artifacts`. The toast's
 * Undo reverses exactly this hide: it names the hide's stamp, and the server refuses it once a
 * later hide (on any client) overtook it.
 */
export async function hideSessionArtifacts(id: string): Promise<void> {
  const key = `artifacts-hidden:${id}`;
  let hiddenAt: number | null;
  try {
    ({ hiddenAt } = await setArtifactsHidden(id, { hidden: true }));
  } catch {
    toasts.info(m.artifactrow_hide_failed(), { alert: true, key });
    return;
  }
  if (hiddenAt === null) return;
  const stamp = hiddenAt;
  toasts.info(m.artifactrow_hidden_toast(), {
    key,
    duration: UNDO_MS,
    action: { label: m.common_undo(), run: () => void undoHide(id, stamp, key) },
  });
}

async function undoHide(id: string, hiddenAt: number, key: string): Promise<void> {
  try {
    await setArtifactsHidden(id, { hidden: false, hiddenAt });
  } catch (e) {
    if (e instanceof ApiError && e.code === "hide_superseded")
      toasts.info(m.artifactrow_unhide_superseded(), { key });
    else toasts.info(m.artifactrow_unhide_failed(), { alert: true, key });
  }
}
