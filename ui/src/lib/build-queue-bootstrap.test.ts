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
    setBuildQueues: (queues) => store.setBuildQueues(queues),
  });

  expect(getBuildQueues).toHaveBeenCalledOnce();
  expect(setBuildQueues).toHaveBeenCalledWith(snapshot);
  expect(store.buildQueues).toEqual(snapshot);
  expect(buildQueues.map).toEqual(snapshot);
});
