export type DecommissionPrAction = "keep" | "close" | "merge";

export interface DecommissionRequest {
  id: string;
  reap?: string[];
  action: DecommissionPrAction;
}

interface DecommissionActions {
  closePr: (id: string) => Promise<unknown>;
  mergePr: (id: string) => Promise<unknown>;
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
        await actions.mergePr(request.id);
        remaining = "keep";
      }
      await actions.archiveSession(request.id, request.reap);
    },
  };
}
