import type { BuildQueue } from "./types";
import { setKey } from "./safe-keys";

/** Module-level reactive build-queue map keyed by sessionId.
 *  Driven by two sources:
 *  - WS `queue:update` events (via HerdStore.apply → upsertBuildQueue)
 *  - Cold-start and resync GET /api/queues snapshots (via seed)
 *  Components (e.g. BuildQueueBadge) read from this directly by sessionId
 *  without needing the page-local HerdStore instance as a prop. */
class BuildQueuesStore {
  map = $state<Record<string, BuildQueue>>({});

  upsert(q: BuildQueue) {
    this.map = setKey(this.map, q.sessionId, q);
  }

  seed(queues: Record<string, BuildQueue>) {
    this.map = queues;
  }
}

export const buildQueues = new BuildQueuesStore();
