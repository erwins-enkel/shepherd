import type { MergeConfirmPayload } from "$lib/components/merge-confirm";

export type DecommissionPrAction = "keep" | "close" | "merge";

/** The step a decommission run starts with: its PR step, or the teardown once that is done. */
export type DecommissionStep = "close" | "merge" | "archive";

export interface DecommissionRequest {
  id: string;
  reap?: string[];
  action: DecommissionPrAction;
  /** What the operator confirmed when they chose "merge" (#2299) — the decommission dialog is
   *  itself the confirmation here, so it echoes the PR's revision and responsibility back to the
   *  server. Absent for the keep/close actions, and on a repo the gate does not apply to. */
  mergeConfirm?: MergeConfirmPayload;
}

interface DecommissionActions {
  closePr: (id: string) => Promise<unknown>;
  mergePr: (id: string, confirm?: MergeConfirmPayload) => Promise<unknown>;
  archiveSession: (id: string, reap?: string[]) => Promise<unknown>;
}

export interface DecommissionCommit {
  run: () => Promise<void>;
  /** The step the next `run()` starts with — after a rejected run, the step that failed. */
  readonly step: DecommissionStep;
}

/** The server's "no open PR" codes that mean a PR step already holds. A step that took effect on
 *  the host but still answered an error is replayed into exactly these 409s, so without this a
 *  retry could never reach the teardown. A merge holds only once the PR merged — a PR closed
 *  without merging means the work never landed, and that must not tear the session down. */
const STEP_ALREADY_DONE: Record<"close" | "merge", readonly string[]> = {
  merge: ["pr_already_merged"],
  close: ["pr_already_closed", "pr_already_merged", "pr_not_found"],
};

export function createDecommissionCommit(
  request: DecommissionRequest,
  actions: DecommissionActions,
): DecommissionCommit {
  let remaining = request.action;

  return {
    get step() {
      return remaining === "keep" ? "archive" : remaining;
    },
    async run() {
      if (remaining === "close" || remaining === "merge") {
        try {
          if (remaining === "close") await actions.closePr(request.id);
          else await actions.mergePr(request.id, request.mergeConfirm);
        } catch (err) {
          const code = (err as { code?: unknown } | null)?.code;
          if (typeof code !== "string" || !STEP_ALREADY_DONE[remaining].includes(code)) throw err;
        }
        remaining = "keep";
      }
      await actions.archiveSession(request.id, request.reap);
    },
  };
}
