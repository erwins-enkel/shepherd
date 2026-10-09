// Answering a Login Request (#2882), shared by the Browser-tab banner and the Terminal bar (#2897).
import { m } from "#lib/paraglide/messages.js";
import { ApiError, resolveLoginRequest } from "#lib/api.js";
import { toasts } from "#lib/toasts.svelte.js";

/** POST the operator's answer. A 404 means it was already answered (another client, or the
 *  session ended) — the store drops the request, so the surface clears itself; anything else
 *  toasts. Never throws. */
export async function answerLoginRequest(
  sessionId: string,
  outcome: "done" | "cancelled",
): Promise<void> {
  try {
    await resolveLoginRequest(sessionId, outcome);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404))
      toasts.info(m.viewport_browser_login_answer_failed(), { alert: true });
  }
}
