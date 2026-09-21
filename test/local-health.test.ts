import { afterEach, expect, test } from "bun:test";
import { config } from "../src/config";
import { makeApp, type AppDeps } from "../src/server";
import { validateResponse } from "./contract/harness";

const original = { ...config };
afterEach(() => Object.assign(config, original));
// Health is public and uses no session/service dependency. No listener or daemon is started.
const app = makeApp({} as AppDeps);
async function health(method = "GET") {
  return app.fetch(new Request("http://localhost/api/health", { method }));
}

test("health omits local paths unless explicitly opted in on loopback", async () => {
  Object.assign(config, { localSupervision: false, localInstanceID: "marker" });
  expect(await (await health()).json()).not.toHaveProperty("localInstall");
  Object.assign(config, { localSupervision: true, host: "0.0.0.0" });
  expect(await (await health()).json()).not.toHaveProperty("localInstall");
  Object.assign(config, { host: "example.com" });
  expect(await (await health()).json()).not.toHaveProperty("localInstall");
});

test("opted-in health reports actual runtime directory and configured database", async () => {
  Object.assign(config, {
    host: "127.0.0.1",
    localSupervision: true,
    localInstanceID: "launch-marker",
    dbPath: "/tmp/state/shepherd.db",
  });
  const response = await health();
  const body = (await validateResponse("get", "/api/health", response)) as {
    localInstall?: unknown;
  };
  expect(body.localInstall).toEqual({
    appDirectory: process.cwd(),
    databasePath: "/tmp/state/shepherd.db",
    instanceID: "launch-marker",
  });
  const head = await health("HEAD");
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
});

test("loopback opt-in without a launch marker does not disclose paths", async () => {
  Object.assign(config, { host: "::1", localSupervision: true, localInstanceID: "" });
  expect(await (await health()).json()).not.toHaveProperty("localInstall");
});
