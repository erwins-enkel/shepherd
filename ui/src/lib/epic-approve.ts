import { ApiError, approveEpicDraft, isPreviewBlocked } from "./api";
import { epicDrafts } from "./epic-draft.svelte";
import { toasts } from "./toasts.svelte";
import { m } from "./paraglide/messages";

/**
 * Approving an epic draft, and reporting what it actually did.
 *
 * This lives OUTSIDE the component tree on purpose. Materializing an epic runs ~25 sequential GitHub
 * calls, so the request routinely outlives the UI that started it: EpicDraftModal is mounted under an
 * `{#if}` and Viewport closes it on a session switch, so any state held there dies exactly when the
 * outcome finally lands. A module-level singleton outlives the modal, the panel, and the session
 * selection — so an approve is always reported to the operator, wherever they happen to be looking.
 *
 * Every path is keyed by an explicitly-passed session id, never a reactive prop read after an await.
 */

/** One toast key per session, so each outcome supersedes the last IN PLACE. Without it the failure
 *  toast — which is sticky, so it never auto-dismisses — stays pinned beside the success toast of the
 *  retry that fixed it. */
const toastKey = (sessionId: string) => `epicdraft-approve-${sessionId}`;

const succeeded = (sessionId: string, n: number) =>
  toasts.info(m.epicdraft_approve_success({ n }), { key: toastKey(sessionId) });

const failed = (sessionId: string, message?: string) =>
  toasts.info(message ?? m.epicdraft_approve_failed(), {
    key: toastKey(sessionId),
    sticky: true,
    alert: true,
  });

/** Sessions whose approve is materializing server-side with its response lost — see {@link watch}. */
const awaiting = new Set<string>();

/** Resolve an approve whose response we never got. The handler keeps running, and its terminal state
 *  arrives over WS (`session:epic-draft`): `approved`, or `draft` again — the server reverts a failed
 *  materialize rather than leaving it stuck. The store only upserts that event, so without this a
 *  failure AFTER the reconcile would be entirely silent: the operator would be left with a pinned
 *  "still creating…" and no word of what went wrong — the exact hole this reconcile exists to close.
 *
 *  A plain store observer, deliberately not an `$effect`: this must keep watching after the modal
 *  that started the approve has closed and the operator has moved to another session, so it cannot be
 *  owned by any component's lifecycle. */
let unsubscribe: (() => void) | null = null;
function watch(sessionId: string) {
  awaiting.add(sessionId);
  unsubscribe ??= epicDrafts.onUpsert((draft) => {
    const sid = draft.sessionId;
    if (!awaiting.has(sid)) return;

    if (draft.status === "approved" && draft.parentNumber != null) {
      succeeded(sid, draft.parentNumber);
      awaiting.delete(sid);
    } else if (draft.status === "draft") {
      // Reverted ⇒ the materialize failed. The response that carried the server's reason died with
      // the connection, so the generic message is all we honestly have.
      failed(sid);
      awaiting.delete(sid);
    }
  });
}

/** A thrown approve does NOT mean the approve failed — the request can lose its connection (a severed
 *  socket surfaces as a bodyless proxy 502 in dev, a `fetch` TypeError in prod) while the handler runs
 *  on and commits the whole epic. Re-GET the draft and report what the SERVER did, not what the throw
 *  implied. */
async function reconcile(sessionId: string, e: unknown) {
  const fresh = await epicDrafts.refresh(sessionId).catch(() => undefined);

  if (fresh?.status === "approved" && fresh.parentNumber != null) {
    succeeded(sessionId, fresh.parentNumber); // it landed after all
    return;
  }
  if (fresh?.status === "materializing") {
    // Still running. Sticky, because the outcome is still unknown — a self-dismissing toast would
    // leave the operator believing all is well if it then fails. The watcher replaces it once the WS
    // event reports how it ended.
    toasts.info(m.epicdraft_approve_in_progress(), { key: toastKey(sessionId), sticky: true });
    watch(sessionId);
    return;
  }

  // A genuine failure (or we couldn't find out). Surface the thrown message ONLY when the server
  // authored it — a bodyless response leaves `apiError` holding its "<label> failed: <status>"
  // fallback, and a network drop throws a TypeError; neither is fit for a human to read.
  const authored =
    e instanceof Error && (isPreviewBlocked(e) || (e instanceof ApiError && e.serverAuthored));
  failed(sessionId, authored ? e.message : undefined);
}

/** Approve a session's epic draft and toast the outcome. Never throws. */
export async function approveEpic(sessionId: string): Promise<void> {
  try {
    const r = await approveEpicDraft(sessionId);
    succeeded(sessionId, r.parentNumber);
  } catch (e) {
    await reconcile(sessionId, e);
  }
}

/** Test seam: forget any pending materialize watch. */
export function __resetAwaiting() {
  awaiting.clear();
}
