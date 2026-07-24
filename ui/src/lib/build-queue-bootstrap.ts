import type { BuildQueue } from "./types";

interface BuildQueueBootstrapDeps {
  getBuildQueues: () => Promise<Record<string, BuildQueue>>;
  setBuildQueues: (queues: Record<string, BuildQueue>) => void;
}

export async function bootstrapBuildQueues(deps: BuildQueueBootstrapDeps): Promise<void> {
  deps.setBuildQueues(await deps.getBuildQueues());
}
