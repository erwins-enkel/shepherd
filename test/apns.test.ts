import { test, expect } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { PushService, attachBadgePush, type NotifyInput } from "../src/push";
import {
  ApnsSender,
  apnsBody,
  apnsEndpoint,
  apnsJwt,
  collapseId,
  isDeadToken,
  parseApnsEndpoint,
  type ApnsResult,
  type ApnsTransport,
} from "../src/apns";

const TOKEN = "ab".repeat(32);
const keypair = () => generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = () => keypair().privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const keys = () => ({ publicKey: "PUB", privateKey: "PRIV" });

type Call = { origin: string; headers: Record<string, string>; body: string };
function recording(result: ApnsResult = { status: 200 }) {
  const calls: Call[] = [];
  const transport: ApnsTransport = async (origin, headers, body) => {
    calls.push({ origin, headers, body });
    return result;
  };
  return { calls, transport };
}

const cfg = (key: string | null = pem()) => ({
  key,
  keyId: "KEY1234567",
  teamId: "TEAM123456",
  topic: "run.shepherd.ios",
});

test("endpoints round-trip and reject anything that is not a device token", () => {
  const endpoint = apnsEndpoint("production", TOKEN.toUpperCase());
  expect(endpoint).toBe(`apns:production:${TOKEN}`);
  expect(parseApnsEndpoint(endpoint)).toEqual({ environment: "production", token: TOKEN });
  expect(parseApnsEndpoint("https://push.example/abc")).toBeNull();
  expect(parseApnsEndpoint(`apns:staging:${TOKEN}`)).toBeNull();
  expect(parseApnsEndpoint("apns:sandbox:../../etc")).toBeNull();
});

test("the provider token is an ES256 JWT that verifies against the key", () => {
  const { privateKey, publicKey } = keypair();
  const jwt = apnsJwt("KEY1234567", "TEAM123456", privateKey, 1_700_000_000);
  const [head, claims, sig] = jwt.split(".");
  expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({
    alg: "ES256",
    kid: "KEY1234567",
  });
  expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
    iss: "TEAM123456",
    iat: 1_700_000_000,
  });
  const ok = verify(
    "sha256",
    Buffer.from(`${head}.${claims}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(sig!, "base64url"),
  );
  expect(ok).toBe(true);
});

test("the body carries the alert, the session thread and what the app needs to open it", () => {
  const body = JSON.parse(
    apnsBody({
      title: "T",
      body: "B",
      sessionId: "s1",
      kind: "blocked",
      tag: "s1",
      instanceId: "i",
    }),
  );
  expect(body).toEqual({
    aps: { alert: { title: "T", body: "B" }, sound: "default", "thread-id": "s1" },
    sessionId: "s1",
    kind: "blocked",
    instanceId: "i",
  });
  const host = JSON.parse(
    apnsBody({
      title: "T",
      body: "B",
      sessionId: "",
      kind: "usage_limit",
      tag: "u",
      instanceId: "i",
    }),
  );
  expect(host.aps["thread-id"]).toBe("host");
});

test("collapse ids are capped at 64 bytes without splitting a character", () => {
  expect(collapseId("s1")).toBe("s1");
  const cut = collapseId("ä".repeat(40));
  expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(64);
  expect(cut).toBe("ä".repeat(32));
});

test("alert bodies carry an optional badge, including zero to clear it", () => {
  for (const badge of [0, 3]) {
    expect(JSON.parse(apnsBody({ ...payload(), badge })).aps.badge).toBe(badge);
  }
  expect(JSON.parse(apnsBody(payload())).aps).not.toHaveProperty("badge");
});

test("badge-only sends use alert type, low priority, one-hour expiry and shared authentication", async () => {
  const { calls, transport } = recording();
  const sender = new ApnsSender(cfg(), transport, () => 1_000);
  await sender.send("sandbox", TOKEN, payload());
  await sender.sendBadge("sandbox", TOKEN, 4);
  await sender.sendBadge("production", TOKEN, 0);
  const call = calls[1]!;
  expect(JSON.parse(call.body)).toEqual({ aps: { badge: 4 } });
  expect(call.headers).toMatchObject({
    ":path": `/3/device/${TOKEN}`,
    "apns-topic": "run.shepherd.ios",
    "apns-push-type": "alert",
    "apns-priority": "5",
    "apns-expiration": "4600",
    "apns-collapse-id": "shepherd-badge",
  });
  expect(call.headers.authorization).toBe(calls[0]!.headers.authorization);
  expect(calls[2]!.origin).toBe("https://api.push.apple.com");
  expect(JSON.parse(calls[2]!.body)).toEqual({ aps: { badge: 0 } });
  expect(sender.lastDeliveredAt).toBe(1_000_000);
});

test("badge sends reuse disabled, failure and thrown-transport handling", async () => {
  const { calls, transport } = recording({ status: 403, reason: "InvalidProviderToken" });
  const sender = new ApnsSender(cfg(), transport, () => 1_000);
  await sender.sendBadge("sandbox", TOKEN, 1);
  expect(sender.lastError).toEqual({ status: 403, reason: "InvalidProviderToken", at: 1_000_000 });
  await sender.sendBadge("sandbox", TOKEN, 2);
  expect(calls[1]!.headers.authorization).not.toBe(calls[0]!.headers.authorization);
  expect(await new ApnsSender(cfg(null), transport).sendBadge("sandbox", TOKEN, 0)).toEqual({
    status: 0,
    reason: "disabled",
  });
  const throwing = new ApnsSender(
    cfg(),
    async () => {
      throw new Error("offline");
    },
    () => 1_000,
  );
  await expect(throwing.sendBadge("sandbox", TOKEN, 0)).rejects.toThrow("offline");
  expect(throwing.lastError).toEqual({ status: 0, reason: "offline", at: 1_000_000 });
});

test("only gone or foreign tokens count as dead", () => {
  expect(isDeadToken({ status: 410, reason: "Unregistered" })).toBe(true);
  expect(isDeadToken({ status: 400, reason: "BadDeviceToken" })).toBe(true);
  expect(isDeadToken({ status: 400, reason: "DeviceTokenNotForTopic" })).toBe(true);
  expect(isDeadToken({ status: 400, reason: "PayloadTooLarge" })).toBe(false);
  expect(isDeadToken({ status: 403, reason: "InvalidProviderToken" })).toBe(false);
  expect(isDeadToken({ status: 429 })).toBe(false);
});

test("the sender stays off without a complete configuration", async () => {
  const { calls, transport } = recording();
  expect(new ApnsSender(cfg(null), transport).enabled).toBe(false);
  expect(new ApnsSender({ ...cfg(), keyId: null }, transport).enabled).toBe(false);
  expect(new ApnsSender(cfg("/nonexistent/key.p8"), transport).enabled).toBe(false);
  const off = new ApnsSender(cfg(null), transport);
  expect(await off.send("sandbox", TOKEN, payload())).toEqual({ status: 0, reason: "disabled" });
  expect(calls).toHaveLength(0);
});

const payload = () => ({
  title: "T",
  body: "B",
  sessionId: "s1",
  kind: "done" as const,
  tag: "s1",
  instanceId: "",
});

test("the sender picks the host by environment and sets the APNs headers", async () => {
  const { calls, transport } = recording();
  const sender = new ApnsSender(cfg(), transport, () => 1_000);
  await sender.send("production", TOKEN, payload());
  await sender.send("sandbox", TOKEN, payload());
  expect(calls.map((c) => c.origin)).toEqual([
    "https://api.push.apple.com",
    "https://api.sandbox.push.apple.com",
  ]);
  const h = calls[0]!.headers;
  expect(h[":path"]).toBe(`/3/device/${TOKEN}`);
  expect(h["apns-topic"]).toBe("run.shepherd.ios");
  expect(h["apns-push-type"]).toBe("alert");
  expect(h["apns-collapse-id"]).toBe("s1");
  expect(h.authorization).toStartWith("bearer ");
});

test("the provider token is reused, renewed after 40 minutes and dropped after a 403", async () => {
  let now = 1_000;
  let status = 200;
  const seen: string[] = [];
  const transport: ApnsTransport = async (_o, headers) => {
    seen.push(headers.authorization!);
    return { status };
  };
  const sender = new ApnsSender(cfg(), transport, () => now);
  await sender.send("sandbox", TOKEN, payload());
  now += 60;
  await sender.send("sandbox", TOKEN, payload());
  expect(seen[1]).toBe(seen[0]);
  now += 40 * 60;
  await sender.send("sandbox", TOKEN, payload());
  expect(seen[2]).not.toBe(seen[1]);
  status = 403;
  await sender.send("sandbox", TOKEN, payload());
  status = 200;
  await sender.send("sandbox", TOKEN, payload());
  // Same second, but the rejected token was not reused.
  expect(seen[4]).not.toBe(seen[3]);
});

function pushWith(result: ApnsResult) {
  const store = new SessionStore(":memory:");
  const webSends: string[] = [];
  const { calls, transport } = recording(result);
  const push = new PushService(
    store,
    async (sub) => {
      webSends.push(sub.endpoint);
      return {};
    },
    keys,
    undefined,
    undefined,
    new ApnsSender(cfg(), transport),
  );
  return { store, push, calls, webSends };
}

const done = (sessionId = "s1"): NotifyInput => ({
  kind: "done",
  sessionId,
  tag: sessionId,
  name: "naechster-schritt-tun",
});

test("iOS devices go through APNs in their own locale, browsers through Web Push", async () => {
  const { store, push, calls, webSends } = pushWith({ status: 200 });
  store.putPushSub(
    { endpoint: apnsEndpoint("production", TOKEN), keys: { p256dh: "", auth: "" }, locale: "de" },
    "",
  );
  store.putPushSub({ endpoint: "https://push/web", keys: { p256dh: "p", auth: "a" } }, "");
  push.setBadgeSource(() => 3);
  expect(await push.notify(done())).toBe(true);
  expect(webSends).toEqual(["https://push/web"]);
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0]!.body).aps.alert.title).toBe("naechster-schritt-tun — wartet");
  expect(JSON.parse(calls[0]!.body).aps.badge).toBe(3);
  await push.testSend(store.listPushSubs().find((s) => s.endpoint.startsWith("apns:"))!);
  expect(JSON.parse(calls[1]!.body).aps.badge).toBe(3);
});

test("a dead iOS token is pruned; a transient APNs error keeps it", async () => {
  const endpoint = apnsEndpoint("sandbox", TOKEN);
  const gone = pushWith({ status: 410, reason: "Unregistered" });
  gone.store.putPushSub({ endpoint, keys: { p256dh: "", auth: "" } }, "");
  expect(await gone.push.notify(done())).toBe(false);
  expect(gone.store.listPushSubs()).toHaveLength(0);

  const busy = pushWith({ status: 429, reason: "TooManyRequests" });
  busy.store.putPushSub({ endpoint, keys: { p256dh: "", auth: "" } }, "");
  expect(await busy.push.notify(done())).toBe(false);
  expect(busy.store.listPushSubs()).toHaveLength(1);
});

test("iOS devices honour category toggles like any other device", async () => {
  const { store, push, calls } = pushWith({ status: 200 });
  const endpoint = apnsEndpoint("production", TOKEN);
  store.putPushSub({ endpoint, keys: { p256dh: "", auth: "" } }, "");
  store.setPushPrefs(endpoint, { agent: false, reviews: true, ci: true });
  expect(await push.notify(done())).toBe(false);
  expect(calls).toHaveLength(0);
});

function appWith(apns: ApnsSender | null) {
  const store = new SessionStore(":memory:");
  const push = new PushService(store, async () => ({}), keys, undefined, undefined, apns);
  const deps: AppDeps = {
    store,
    events: new EventHub(),
    service: {} as any,
    usageLimits: { limits: () => ({}) } as any,
    push,
  };
  return { app: makeApp(deps), store, push, events: deps.events };
}

const register = (app: ReturnType<typeof makeApp>, body: unknown) =>
  app.fetch(
    new Request("http://x/api/push/apns", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify(body),
    }),
  );

test("POST /api/push/apns resets the unchanged startup badge for the registered phone", async () => {
  const { calls, transport } = recording();
  const { app, push, events } = appWith(new ApnsSender(cfg(), transport));
  let reads = 0;
  const detach = attachBadgePush(
    events,
    {
      list: () => {
        reads++;
        return [];
      },
    },
    push,
    10,
  );
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error("registration badge did not arrive");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  try {
    await until(() => reads === 1); // startup has no device yet
    expect(calls).toHaveLength(0);
    expect((await register(app, { token: TOKEN, environment: "sandbox" })).status).toBe(200);
    await until(() => calls.length === 1);
    expect(JSON.parse(calls[0]!.body)).toEqual({ aps: { badge: 0 } });
  } finally {
    detach();
  }
});

test("POST /api/push/apns registers a device once and keeps its categories", async () => {
  const { app, store } = appWith(new ApnsSender(cfg(), recording().transport));
  const res = await register(app, { token: TOKEN, environment: "production", locale: "de" });
  expect(res.status).toBe(200);
  const { endpoint } = (await res.json()) as { endpoint: string };
  expect(endpoint).toBe(`apns:production:${TOKEN}`);
  store.setPushPrefs(endpoint, { agent: true, reviews: false, ci: true });
  await register(app, { token: TOKEN, environment: "production", locale: "en" });
  const rows = store.listPushSubs();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.locale).toBe("en");
  expect(rows[0]!.cats).toEqual({ agent: true, reviews: false, ci: true });
});

test("POST /api/push/apns rejects malformed bodies and answers 503 when APNs is off", async () => {
  const { app } = appWith(new ApnsSender(cfg(), recording().transport));
  expect((await register(app, { token: "xyz", environment: "production" })).status).toBe(400);
  expect((await register(app, { token: TOKEN, environment: "staging" })).status).toBe(400);
  const off = appWith(null);
  expect((await register(off.app, { token: TOKEN, environment: "production" })).status).toBe(503);
});

test("POST /api/push/apns stores the relay fields and rejects malformed ones (#3058)", async () => {
  const { app, store } = appWith(new ApnsSender(cfg(), recording().transport));
  const device = { token: TOKEN, environment: "production" };
  expect((await register(app, { ...device, relayRemote: false })).status).toBe(200);
  expect(store.listPushSubs()[0]).toMatchObject({ relayRemote: false, coveredInstances: [] });
  expect((await register(app, { ...device, coveredInstances: ["b"] })).status).toBe(200);
  expect(store.listPushSubs()[0]).toMatchObject({ relayRemote: true, coveredInstances: ["b"] });
  expect((await register(app, { ...device, coveredInstances: [7] })).status).toBe(400);
  expect((await register(app, { ...device, relayRemote: 1 })).status).toBe(400);
});
