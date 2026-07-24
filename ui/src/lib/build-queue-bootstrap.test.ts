import { afterEach, expect, it, vi } from "vitest";
import { bootstrapBuildQueues } from "./build-queue-bootstrap";
import { buildQueues } from "./buildQueues.svelte";
import { HerdStore } from "./store.svelte";
import type { BuildQueue } from "./types";

const queue: BuildQueue = {
  sessionId: "s1",
  approved: true,
  steps: [{ id: "s1", title: "Done", status: "done", position: 0 }],
};

afterEach(() => {
  buildQueues.map = {};
  vi.restoreAllMocks();
});

it("hydrates the HerdStore and badge singleton from the cold queue snapshot", async () => {
  const store = new HerdStore();
  const snapshot = { s1: queue };
  const getBuildQueues = vi.fn(async () => snapshot);
  const setBuildQueues = vi.spyOn(store, "setBuildQueues");

  await bootstrapBuildQueues({
    getBuildQueues,
    getBuildQueueRevision: () => store.getBuildQueueRevision(),
    setBuildQueues: (queues, revision) => store.setBuildQueues(queues, revision),
  });

  expect(getBuildQueues).toHaveBeenCalledOnce();
  expect(setBuildQueues).toHaveBeenCalledWith(snapshot, 0);
  expect(store.buildQueues).toEqual(snapshot);
  expect(buildQueues.map).toEqual(snapshot);
});

it("preserves a live queue update received while the snapshot is in flight", async () => {
  const store = new HerdStore();
  const staleQueue = { ...queue, approved: false };
  const liveQueue = {
    ...queue,
    steps: [{ ...queue.steps[0]!, title: "Live", status: "active" as const }],
  };
  const otherQueue = { ...queue, sessionId: "s2" };
  let resolveSnapshot!: (snapshot: Record<string, BuildQueue>) => void;
  const getBuildQueues = vi.fn(
    () =>
      new Promise<Record<string, BuildQueue>>((resolve) => {
        resolveSnapshot = resolve;
      }),
  );

  const hydration = bootstrapBuildQueues({
    getBuildQueues,
    getBuildQueueRevision: () => store.getBuildQueueRevision(),
    setBuildQueues: (snapshot, revision) => store.setBuildQueues(snapshot, revision),
  });
  store.setBuildQueue(liveQueue);
  resolveSnapshot({ s1: staleQueue, s2: otherQueue });
  await hydration;

  expect(store.buildQueues).toEqual({ s1: liveQueue, s2: otherQueue });
  expect(buildQueues.map).toEqual({ s1: liveQueue, s2: otherQueue });
});
