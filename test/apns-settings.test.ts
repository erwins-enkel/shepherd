import { test, expect, beforeEach, afterEach } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApnsSender, apnsEndpoint, type ApnsResult, type ApnsTransport } from "../src/apns";
import { ApnsSettings, type ApnsEnv, type ApnsStatus } from "../src/apns-settings";
import { PushService, pushDeviceId } from "../src/push";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { config } from "../src/config";
import { signCookie, SESSION_COOKIE } from "../src/operator-auth";

const TOKEN = "cd".repeat(32);
const p256 = () =>
  generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
const NO_ENV: ApnsEnv = { key: null, keyId: null, teamId: null, topic: null };

function harness(env: ApnsEnv = NO_ENV, result: ApnsResult = { status: 200 }) {
  const dir = mkdtempSync(join(tmpdir(), "apns-settings-"));
  const path = join(dir, "apns.json");
  const sent: Record<string, string>[] = [];
  const transport: ApnsTransport = async (_origin, headers) => {
    sent.push(headers);
    return result;
  };
  const sender = new ApnsSender({ key: null, keyId: null, teamId: null, topic: "" }, transport);
  const settings = new ApnsSettings(path, env, sender, () => 5_000);
  settings.load();
  return { path, sender, settings, sent };
}

const complete = (key = p256()) => ({ key, keyId: "abc1234567", teamId: "TEAM123456" });

test("a fresh server is unconfigured and the sender stays off", () => {
  const { settings, sender } = harness();
  expect(settings.status()).toMatchObject({ state: "unconfigured", hasKey: false, keyId: null });
  expect(sender.enabled).toBe(false);
});

test("saving a valid key turns the sender on without a restart and never echoes the key", async () => {
  const { settings, sender, path, sent } = harness();
  const key = p256();
  const status = (await settings.save(complete(key))) as ApnsStatus;
  expect(status).toMatchObject({
    state: "configured",
    hasKey: true,
    keyId: "ABC1234567", // normalized to Apple's upper case
    teamId: "TEAM123456",
    topic: "run.shepherd.ios",
    keySavedAt: 5_000,
  });
  expect(JSON.stringify(status)).not.toContain("PRIVATE KEY");
  expect(sender.enabled).toBe(true);
  // Stored beside the db, readable by the owner only — mode and content read through one fd.
  const fd = openSync(path, "r");
  try {
    expect(fstatSync(fd).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(fd, "utf8")).key).toBe(key.trim() + "\n");
  } finally {
    closeSync(fd);
  }

  await sender.send("production", TOKEN, {
    title: "T",
    body: "B",
    sessionId: "",
    kind: "test",
    tag: "t",
  });
  expect(sent[0]!["apns-topic"]).toBe("run.shepherd.ios");
});

test("validation explains what is wrong and writes nothing", async () => {
  const { settings, path } = harness();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  expect(await settings.save({ keyId: "ABC1234567", teamId: "TEAM123456" })).toEqual({
    error: "key_required",
    field: "key",
  });
  expect(await settings.save(complete("not a key"))).toEqual({ error: "invalid", field: "key" });
  expect(await settings.save(complete(rsa))).toEqual({ error: "not_p256", field: "key" });
  expect(await settings.save(complete(p384))).toEqual({ error: "not_p256", field: "key" });
  expect(await settings.save({ ...complete(), keyId: "SHORT" })).toEqual({
    error: "key_id_invalid",
    field: "keyId",
  });
  expect(await settings.save({ ...complete(), teamId: "TEAM-12345" })).toEqual({
    error: "team_id_invalid",
    field: "teamId",
  });
  expect(await settings.save({ ...complete(), topic: "not a bundle id" })).toEqual({
    error: "topic_invalid",
    field: "topic",
  });
  // A path is never read on the API's behalf: only PEM text counts as a key.
  expect(await settings.save(complete("/etc/hostname"))).toEqual({
    error: "invalid",
    field: "key",
  });
  expect(existsSync(path)).toBe(false);
});

test("fields left out keep their stored value; the key can be replaced and removed", async () => {
  const { settings, sender, path } = harness();
  await settings.save(complete());
  const renamed = (await settings.save({
    keyId: "NEWKEY1234",
    topic: "com.example.app",
  })) as ApnsStatus;
  expect(renamed).toMatchObject({ keyId: "NEWKEY1234", hasKey: true, topic: "com.example.app" });
  expect(sender.enabled).toBe(true);

  const removed = await settings.remove();
  expect(removed).toMatchObject({ state: "unconfigured", hasKey: false, keyId: null });
  expect(sender.enabled).toBe(false);
  expect(existsSync(path)).toBe(false);
});

test("the stored file is read back at boot; a broken one is ignored", async () => {
  const first = harness();
  await first.settings.save(complete());
  const sender = new ApnsSender({ key: null, keyId: null, teamId: null, topic: "" });
  new ApnsSettings(first.path, NO_ENV, sender).load();
  expect(sender.enabled).toBe(true);

  writeFileSync(first.path, "{ nope");
  const broken = new ApnsSender({ key: null, keyId: null, teamId: null, topic: "" });
  const settings = new ApnsSettings(first.path, NO_ENV, broken);
  settings.load();
  expect(settings.status().state).toBe("unconfigured");
});

test("the environment wins field by field and locks those fields", async () => {
  const { settings, sender } = harness({ ...NO_ENV, key: p256(), teamId: "ENVTEAM123" });
  expect(settings.status()).toMatchObject({
    state: "unconfigured",
    hasKey: true,
    keySavedAt: null,
    env: { key: true, keyId: false, teamId: true, topic: false },
  });
  expect(await settings.save({ key: p256() })).toEqual({ error: "env_locked", field: "key" });
  expect(await settings.save({ teamId: "OTHER12345" })).toEqual({
    error: "env_locked",
    field: "teamId",
  });
  const ok = (await settings.save({ keyId: "KEY1234567" })) as ApnsStatus;
  expect(ok).toMatchObject({ state: "configured", teamId: "ENVTEAM123", keyId: "KEY1234567" });
  expect(sender.enabled).toBe(true);
  // Removing the stored part leaves the environment's values in force.
  expect(await settings.remove()).toMatchObject({
    hasKey: true,
    teamId: "ENVTEAM123",
    keyId: null,
  });
});

test("an unreadable key from the environment shows as an error", () => {
  const { settings } = harness({
    key: "/nonexistent/AuthKey_ABC1234567.p8",
    keyId: "ABC1234567",
    teamId: "TEAM123456",
    topic: null,
  });
  expect(settings.status()).toMatchObject({ state: "error", keyError: "unreadable" });
});

test("an APNs refusal after the last delivery reads as an error until the next delivery", async () => {
  let status = 200;
  let reason: string | undefined = undefined;
  const dir = mkdtempSync(join(tmpdir(), "apns-settings-"));
  let now = 100;
  const sender = new ApnsSender(
    { key: null, keyId: null, teamId: null, topic: "" },
    async () => ({ status, reason }),
    () => now,
  );
  const settings = new ApnsSettings(join(dir, "apns.json"), NO_ENV, sender);
  settings.load();
  await settings.save(complete());
  const payload = { title: "T", body: "B", sessionId: "", kind: "test" as const, tag: "t" };

  await sender.send("production", TOKEN, payload);
  expect(settings.status()).toMatchObject({ state: "configured", lastDeliveredAt: 100_000 });
  now = 200;
  status = 403;
  reason = "InvalidProviderToken";
  await sender.send("production", TOKEN, payload);
  expect(settings.status()).toMatchObject({
    state: "error",
    lastError: { status: 403, reason: "InvalidProviderToken", at: 200_000 },
  });
  now = 300;
  status = 200;
  await sender.send("production", TOKEN, payload);
  expect(settings.status().state).toBe("configured");
});

// ── routes ─────────────────────────────────────────────────────────────────

const SECRET = "apns-settings-cookie-secret";
let prevSecret: string | null;
let prevToken: string | null;
beforeEach(() => {
  prevSecret = config.cookieSecret;
  prevToken = config.token;
  config.cookieSecret = SECRET;
  config.token = "env-bearer-token";
});
afterEach(() => {
  config.cookieSecret = prevSecret;
  config.token = prevToken;
});

const operator = {
  "content-type": "application/json",
  Cookie: `${SESSION_COOKIE}=${signCookie(SECRET)}`,
};
const bearer = { "content-type": "application/json", Authorization: "Bearer env-bearer-token" };

function appWith(result: ApnsResult = { status: 200 }) {
  const { settings, sender } = harness(NO_ENV, result);
  const store = new SessionStore(":memory:");
  const webSends: string[] = [];
  const push = new PushService(
    store,
    async (sub) => {
      webSends.push(sub.endpoint);
      return { statusCode: 201 };
    },
    () => ({ publicKey: "PUB", privateKey: "PRIV" }),
    undefined,
    () => true, // in active use: a real notify() would be suppressed — a test send is not
    sender,
  );
  const deps: AppDeps = {
    store,
    events: new EventHub(),
    service: {} as never,
    usageLimits: { limits: () => ({}) } as never,
    push,
    apnsSettings: settings,
  };
  const app = makeApp(deps);
  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = operator,
  ) =>
    app.fetch(
      new Request(`http://x${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { call, store, webSends };
}

test("every push admin route needs an operator session, not just any credential", async () => {
  const { call } = appWith();
  const routes: [string, string, unknown?][] = [
    ["GET", "/api/push/apns/config"],
    ["PUT", "/api/push/apns/config", complete()],
    ["DELETE", "/api/push/apns/config"],
    ["GET", "/api/push/devices"],
    ["PATCH", "/api/push/devices/0123456789abcdef", { categories: {} }],
    ["DELETE", "/api/push/devices/0123456789abcdef"],
    ["POST", "/api/push/devices/0123456789abcdef/test"],
  ];
  for (const [method, path, body] of routes) {
    expect((await call(method, path, body, bearer)).status).toBe(403);
    expect((await call(method, path, body, { "content-type": "application/json" })).status).toBe(
      401,
    );
  }
});

test("config routes: save, read without the key, remove", async () => {
  const { call } = appWith();
  const key = p256();
  const bad = await call("PUT", "/api/push/apns/config", { ...complete(key), teamId: "x" });
  expect(bad.status).toBe(422);
  expect(await bad.json()).toEqual({ error: "team_id_invalid", field: "teamId" });
  expect((await call("PUT", "/api/push/apns/config", { keyId: 7 })).status).toBe(400);

  const saved = await call("PUT", "/api/push/apns/config", complete(key));
  expect(saved.status).toBe(200);
  const read = await call("GET", "/api/push/apns/config");
  const text = await read.text();
  expect(JSON.parse(text)).toMatchObject({ state: "configured", hasKey: true });
  expect(text).not.toContain(key.split("\n")[1]!);

  const removed = await call("DELETE", "/api/push/apns/config");
  expect(((await removed.json()) as ApnsStatus).hasKey).toBe(false);
});

test("device routes list, retarget categories, test past presence, and remove", async () => {
  const { call, store, webSends } = appWith({ status: 400, reason: "BadDeviceToken" });
  await call("PUT", "/api/push/apns/config", complete());
  const ios = apnsEndpoint("sandbox", TOKEN);
  store.putPushSub(
    { endpoint: ios, keys: { p256dh: "", auth: "" }, locale: "de" },
    "Shepherd/1 iOS",
  );
  store.putPushSub(
    { endpoint: "https://push.example/sub", keys: { p256dh: "p", auth: "a" } },
    "Firefox",
  );

  const list = (await (await call("GET", "/api/push/devices")).json()) as {
    devices: { id: string; kind: string; environment: string | null; locale: string }[];
  };
  expect(list.devices.map((d) => [d.kind, d.environment, d.locale]).sort()).toEqual([
    ["ios", "sandbox", "de"],
    ["web", null, "en"],
  ]);
  expect(JSON.stringify(list)).not.toContain("push.example");
  const iosId = pushDeviceId(ios);
  const webId = pushDeviceId("https://push.example/sub");

  const patched = await call("PATCH", `/api/push/devices/${iosId}`, {
    categories: { agent: false, reviews: true, ci: true },
  });
  expect(((await patched.json()) as { categories: unknown }).categories).toEqual({
    agent: false,
    reviews: true,
    ci: true,
  });
  expect(store.getPushPrefs(ios)).toEqual({ agent: false, reviews: true, ci: true });
  expect((await call("PATCH", `/api/push/devices/${iosId}`, { categories: {} })).status).toBe(400);

  // Presence says "in use" and the device muted "agent" — the test goes out anyway, and a dead
  // token is reported, not pruned.
  const iosTest = await call("POST", `/api/push/devices/${iosId}/test`);
  expect(await iosTest.json()).toEqual({ delivered: false, status: 400, reason: "BadDeviceToken" });
  expect(store.listPushSubs()).toHaveLength(2);
  const webTest = await call("POST", `/api/push/devices/${webId}/test`);
  expect(await webTest.json()).toEqual({ delivered: true, status: 201, reason: null });
  expect(webSends).toEqual(["https://push.example/sub"]);

  expect((await call("DELETE", `/api/push/devices/${webId}`)).status).toBe(200);
  expect((await call("DELETE", `/api/push/devices/${webId}`)).status).toBe(404);
  expect((await call("POST", `/api/push/devices/${webId}/test`)).status).toBe(404);
  expect(store.listPushSubs().map((r) => r.endpoint)).toEqual([ios]);
});

test("a re-registration moves the device's registeredAt, not its createdAt", async () => {
  const store = new SessionStore(":memory:");
  const sub = { endpoint: apnsEndpoint("production", TOKEN), keys: { p256dh: "", auth: "" } };
  store.putPushSub(sub, "");
  const first = store.listPushSubs()[0]!;
  await Bun.sleep(5);
  store.putPushSub(sub, "");
  const again = store.listPushSubs()[0]!;
  expect(again.createdAt).toBe(first.createdAt);
  expect(again.registeredAt).toBeGreaterThan(first.registeredAt);
});
