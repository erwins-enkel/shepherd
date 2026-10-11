import type { ClearMergedResult } from "./types";

/**
 * What a clear-merged run did, for its toast: how many sessions were cleared, which connected
 * machines gave no usable answer (#2765), and the ids sent to those — the only ones worth retrying,
 * since everything else either cleared or was re-validated away by its own server.
 */
export function summarizeClearMerged(result: ClearMergedResult): {
  count: number;
  failedMachines: string[];
  retryIds: string[];
} {
  const failed = (result.machines ?? []).filter((machine) => !machine.ok);
  return {
    count: result.cleared.length,
    failedMachines: failed.map((machine) => machine.name),
    retryIds: failed.flatMap((machine) => machine.requested),
  };
}
