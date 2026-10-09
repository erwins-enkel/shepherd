import { ApiError } from "#lib/api.js";
import type { DecommissionStep } from "#lib/decommission-commit.js";
import { m } from "#lib/paraglide/messages.js";
import type { ToastDetail } from "#lib/toasts.svelte.js";

export interface DecommissionFailure {
  /** Reason line + "What happened" / "What you can do" / server-message sections for the toast. */
  detail: ToastDetail;
  /** False when replaying the same commit can only fail again — the toast then offers no Retry. */
  retryable: boolean;
}

/**
 * Turn a failed decommission run into something the operator can act on: why it stopped, what
 * that means for the session, and what to do next. `step` is the commit's step at the throw (see
 * `DecommissionCommit.step`). First matching rule wins:
 *  1. no response at all (fetch `TypeError`) — the server is unreachable;
 *  2. a merge whose PR is closed or gone — the work can no longer land, so a retry is pointless;
 *  3. a GitHub rate limit named in the message;
 *  4. otherwise the failed step itself, with the server's own message verbatim.
 */
export function describeDecommissionFailure(
  err: unknown,
  step: DecommissionStep,
): DecommissionFailure {
  const code = err instanceof ApiError ? err.code : undefined;
  const message = err instanceof Error ? err.message : "";
  // An ApiError's message is the bare "<label> failed: <status>" fallback unless the server wrote
  // it, and that fallback says nothing the reason line doesn't.
  const serverMessage = err instanceof ApiError && !err.serverAuthored ? "" : message;

  if (err instanceof TypeError) {
    // No server message to show: the browser's "Failed to fetch" is not one.
    return build(
      m.decommission_fail_network_reason(),
      m.decommission_fail_network_what(),
      m.decommission_fail_network_next(),
      "",
    );
  }
  if (step === "merge" && code === "pr_already_closed") {
    return build(
      m.decommission_fail_pr_closed_reason(),
      m.decommission_fail_pr_closed_what(),
      m.decommission_fail_pr_closed_next(),
      serverMessage,
      false,
    );
  }
  if (step === "merge" && code === "pr_not_found") {
    return build(
      m.decommission_fail_pr_missing_reason(),
      m.decommission_fail_pr_missing_what(),
      m.decommission_fail_pr_missing_next(),
      serverMessage,
      false,
    );
  }
  if (/rate limit/i.test(message)) {
    return build(
      m.decommission_fail_rate_limit_reason(),
      m.decommission_fail_rate_limit_what(),
      m.decommission_fail_rate_limit_next(),
      serverMessage,
    );
  }
  if (step === "merge") {
    return build(
      m.decommission_fail_merge_reason(),
      m.decommission_fail_merge_what(),
      m.decommission_fail_merge_next(),
      serverMessage,
    );
  }
  if (step === "close") {
    return build(
      m.decommission_fail_close_reason(),
      m.decommission_fail_close_what(),
      m.decommission_fail_retry_next(),
      serverMessage,
    );
  }
  return build(
    m.decommission_fail_archive_reason(),
    m.decommission_fail_archive_what(),
    m.decommission_fail_retry_next(),
    serverMessage,
  );
}

function build(
  reason: string,
  what: string,
  next: string,
  serverMessage: string,
  retryable = true,
): DecommissionFailure {
  const sections: ToastDetail["sections"] = [
    { label: m.decommission_fail_what(), text: what },
    { label: m.decommission_fail_next(), text: next },
  ];
  if (serverMessage) {
    sections.push({ label: m.decommission_fail_server(), text: serverMessage, mono: true });
  }
  return { detail: { reason: m.decommission_fail_reason({ reason }), sections }, retryable };
}
