import type { BuildQueue } from "./types";

interface BuildQueueBootstrapDeps {
  getBuildQueues: () => Promise<Record<string, BuildQueue>>;
  getBuildQueueRevision: () => number;
  setBuildQueues: (queues: Record<string, BuildQueue>, preserveAfterRevision: number) => void;
}

export async function bootstrapBuildQueues(deps: BuildQueueBootstrapDeps): Promise<void> {
  const revision = deps.getBuildQueueRevision();
  deps.setBuildQueues(await deps.getBuildQueues(), revision);
}
