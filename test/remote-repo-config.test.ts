import { expect, test } from "bun:test";
import { compareRepoConfigs } from "../src/remote-instances/repo-config";
import { RepoConfigService } from "../src/repo-config-service";
import { SessionStore } from "../src/store";

function machine(id: string, criticAllPrs: boolean) {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/missing", {
    ...store.getLocalRepoConfig("/missing"),
    criticAllPrs,
    autoDrainEnabled: true,
  });
  return {
    instanceId: id,
    name: id,
    membership: "present" as const,
    reachable: true,
    config: new RepoConfigService(store).read("/missing"),
    reason: null,
  };
}
test("comparison names each differing machine field and multiple backlog owners", () => {
  const diff = compareRepoConfigs([machine("a", true), machine("b", false)]);
  expect(diff.complete).toBe(true);
  expect(diff.fields).toEqual([
    { instanceId: "a", fields: { criticAllPrs: true } },
    { instanceId: "b", fields: { criticAllPrs: false } },
  ]);
  expect(diff.multipleAutoDrain).toEqual(["a", "b"]);
});
test("offline and file-backed machines cannot yield a clean migration comparison", () => {
  const a = machine("a", true);
  expect(
    compareRepoConfigs([
      a,
      { ...machine("b", false), reachable: false, config: null, reason: "network" },
    ]),
  ).toMatchObject({ complete: false, unavailableInstanceIds: ["b"] });
  a.config.repoConfigCommit = "abc";
  expect(compareRepoConfigs([a, machine("b", false)])).toMatchObject({
    applicable: false,
    complete: false,
    fields: [],
  });
  expect(compareRepoConfigs([machine("a", true)])).toMatchObject({ complete: false });
});

import { RepoConfigCoordinator, type RepoPeer } from "../src/remote-instances/repo-config";
const peer: RepoPeer = {
  instanceId: "remote",
  name: "Remote",
  membership: "present",
  target: { url: "http://peer.test", token: "private-token" },
};
for (const [status, body, reason] of [
  [401, { error: "denied" }, "token_rejected"],
  [403, { error: "denied" }, "token_scope"],
  [302, {}, "redirect"],
  [404, { error: "not found" }, "api_missing"],
  [200, { not: "a config view" }, "bad_response"],
] as const) {
  test(`peer ${status} ${reason} remains an unavailable comparison, without secrets`, async () => {
    const coordinator = new RepoConfigCoordinator({
      self: { instanceId: "self", name: "Self" },
      local: () => machine("self", false).config,
      peers: () => [peer],
      refreshLocal: async () => {},
      fetch: async () => Response.json(body, { status }),
    });
    const result = await coordinator.read("acme/project");
    expect(result.differences.complete).toBe(false);
    expect(result.machines[1]).toMatchObject({ reachable: false, reason, membership: "present" });
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
}
test("a missing repo is distinguished from a peer without the settings API", async () => {
  const coordinator = new RepoConfigCoordinator({
    self: { instanceId: "self", name: "Self" },
    local: () => null,
    peers: () => [peer],
    refreshLocal: async () => {},
    fetch: async () =>
      Response.json({ error: "repository not found", code: "repo_not_found" }, { status: 404 }),
  });
  expect((await coordinator.read("absent/repo")).machines[1]).toMatchObject({
    membership: "absent",
    reachable: true,
  });
});

test("string rule differences are reported with each machine's actual value", () => {
  const a = machine("a", false),
    b = machine("b", false);
  a.config.autoLabel = "ready";
  b.config.autoLabel = "queue";
  expect(compareRepoConfigs([a, b]).fields).toEqual([
    { instanceId: "a", fields: { autoLabel: "ready" } },
    { instanceId: "b", fields: { autoLabel: "queue" } },
  ]);
});
test("a peer that last reported absence but now fails remains unknown", async () => {
  const coordinator = new RepoConfigCoordinator({
    self: { instanceId: "self", name: "Self" },
    local: () => null,
    peers: () => [{ ...peer, membership: "absent" }],
    refreshLocal: async () => {},
    fetch: async () => {
      throw new Error("offline");
    },
  });
  expect((await coordinator.read("acme/project")).machines[1]).toMatchObject({
    membership: "unknown",
    reachable: false,
  });
});
test("a peer stalled after headers is cancelled and reported unavailable", async () => {
  let cancelled = false;
  const coordinator = new RepoConfigCoordinator({
    self: { instanceId: "self", name: "Self" },
    local: () => null,
    peers: () => [peer],
    refreshLocal: async () => {},
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  expect((await coordinator.read("acme/project")).machines[1]).toMatchObject({
    reachable: false,
    reason: "bad_response",
  });
  expect(cancelled).toBe(true);
}, 10_000);
