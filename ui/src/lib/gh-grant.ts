// Answering a gh permission request and revoking a gh grant (#4119), shared by the Terminal
// banner and the header grant badge.
import { m } from "#lib/paraglide/messages.js";
import { ApiError, resolveGhPermissionRequest, revokeGhGrant as revokeGrantApi } from "#lib/api.js";
import type { GhOptInPermission } from "#lib/types.js";

export type GhGrantResult = { ok: true } | { ok: false; error: string };

/** The server's own `{error}` text when it sent one, else a generic localized line. */
function failure(e: unknown, fallback: string): GhGrantResult {
  return {
    ok: false,
    error: e instanceof ApiError && e.serverAuthored ? e.message : fallback,
  };
}

/** POST the operator's answer. A 404 means it was already answered (another client, or the
 *  session ended) — the store drops the request, so it counts as done. Never throws. */
export async function answerGhPermissionRequest(
  sessionId: string,
  outcome: "granted" | "denied",
): Promise<GhGrantResult> {
  try {
    await resolveGhPermissionRequest(sessionId, outcome);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && e.code === undefined) return { ok: true };
    return failure(e, m.gh_grant_answer_failed());
  }
}

/** DELETE the grant. Never throws. */
export async function revokeGhGrant(
  sessionId: string,
  permission: GhOptInPermission,
): Promise<GhGrantResult> {
  try {
    await revokeGrantApi(sessionId, permission);
    return { ok: true };
  } catch (e) {
    return failure(e, m.gh_grant_revoke_failed());
  }
}
