import { expect, test } from "bun:test";
import { makeApp, makeAgentIngressApp, type AppDeps } from "../src/server";
import { HerdrUpdateService } from "../src/herdr-update";

function appFixture() {
  let stops = 0;
  const updates = new HerdrUpdateService({
    probeRuntime: async () => ({
      state: "restart_required",
      installedVersion: "0.9.0",
      serverVersion: "0.8.2",
    }),
    runRecovery: async () => {
      stops++;
    },
    maintenance: { begin() {}, end() {} },
  });
  const app = makeApp({ herdrUpdates: updates } as unknown as AppDeps);
  return { app, updates, stops: () => stops };
}

function restartRequest(body: unknown) {
  return new Request("http://localhost/api/herdr-update/restart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("herdr restart route requires explicit confirmation and both observed versions", async () => {
  const { app, stops } = appFixture();
  for (const body of [
    {},
    { confirmed: false },
    { confirmed: true },
    { confirmed: true, installedVersion: "0.9.0" },
  ]) {
    expect((await app.fetch(restartRequest(body))).status).toBe(400);
  }
  expect(stops()).toBe(0);
});

test("herdr restart route starts local repair without an available download", async () => {
  const { app } = appFixture();
  const res = await app.fetch(
    restartRequest({ confirmed: true, installedVersion: "0.9.0", serverVersion: "0.8.2" }),
  );
  expect(res.status).toBe(202);
});

test("herdr GET describes an already installed but incomplete update", async () => {
  const { app, stops } = appFixture();
  const res = await app.fetch(new Request("http://localhost/api/herdr-update"));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    current: "0.9.0",
    updateAvailable: false,
    runtime: { state: "restart_required", serverVersion: "0.8.2" },
  });
  expect(stops()).toBe(0);
});

test("herdr restart route rejects unsupported and unknown runtimes without mutation", async () => {
  for (const runtime of [
    { state: "ready" as const, installedVersion: "0.9.1", serverVersion: "0.9.1" },
    { state: "restart_required" as const, installedVersion: "0.9.1", serverVersion: "0.9.0" },
    { state: "unknown" as const, installedVersion: "0.9.0", serverVersion: null },
  ]) {
    let mutations = 0;
    const updates = new HerdrUpdateService({
      probeRuntime: async () => runtime,
      runRecovery: async () => {
        mutations++;
      },
      maintenance: { begin() {}, end() {} },
    });
    const app = makeApp({ herdrUpdates: updates } as unknown as AppDeps);
    const response = await app.fetch(restartRequest({ confirmed: true, ...runtime }));
    expect(response.status).toBe(409);
    expect(mutations).toBe(0);
  }
});

test("herdr restart route is unavailable without its service and forbidden on agent ingress", async () => {
  const body = { confirmed: true, installedVersion: "0.9.0", serverVersion: "0.8.2" };
  expect((await makeApp({} as AppDeps).fetch(restartRequest(body))).status).toBe(503);
  const { updates, stops } = appFixture();
  const ingress = makeAgentIngressApp({ herdrUpdates: updates } as unknown as AppDeps);
  expect((await ingress.fetch(restartRequest(body))).status).toBe(404);
  expect(stops()).toBe(0);
});

test("herdr restart route rejects a duplicate POST while the first probe is pending", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mutations = 0;
  const runtime = {
    state: "restart_required" as const,
    installedVersion: "0.9.0",
    serverVersion: "0.8.2",
  };
  const updates = new HerdrUpdateService({
    probeRuntime: async () => {
      await pending;
      return runtime;
    },
    runRecovery: async () => {
      mutations++;
    },
    maintenance: { begin() {}, end() {} },
  });
  const app = makeApp({ herdrUpdates: updates } as unknown as AppDeps);
  const body = { confirmed: true, ...runtime };
  const first = app.fetch(restartRequest(body));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await app.fetch(restartRequest(body))).status).toBe(409);
  release();
  expect((await first).status).toBe(202);
  expect(mutations).toBe(1);
});
