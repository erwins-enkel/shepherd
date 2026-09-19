import type { MergeConfirmPayload } from "$lib/components/merge-confirm";

export type DecommissionPrAction = "keep" | "close" | "merge";

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
}

export function createDecommissionCommit(
  request: DecommissionRequest,
  actions: DecommissionActions,
): DecommissionCommit {
  let remaining = request.action;

  return {
    async run() {
      if (remaining === "close") {
        await actions.closePr(request.id);
        remaining = "keep";
      } else if (remaining === "merge") {
        await actions.mergePr(request.id, request.mergeConfirm);
        remaining = "keep";
      }
      await actions.archiveSession(request.id, request.reap);
    },
  };
}
