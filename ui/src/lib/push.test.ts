import { test, expect, vi, beforeEach } from "vitest";
import { urlBase64ToUint8Array, pushState, enablePush, disablePush } from "./push";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("urlBase64ToUint8Array decodes a url-safe base64 key", () => {
  // "hi" => base64 "aGk=" => url-safe "aGk"
  const out = urlBase64ToUint8Array("aGk");
  expect(Array.from(out)).toEqual([104, 105]);
});

test("pushState reports unsupported when serviceWorker is absent", async () => {
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", {});
  const s = await pushState();
  expect(s.supported).toBe(false);
});

test("pushState reports permission + subscribed when supported", async () => {
  const subscription = { endpoint: "e1" };
  vi.stubGlobal("Notification", { permission: "granted" });
  vi.stubGlobal("window", { PushManager: function () {} });
  vi.stubGlobal("navigator", {
    serviceWorker: {
      register: vi.fn(),
      ready: Promise.resolve({ pushManager: { getSubscription: async () => subscription } }),
    },
  });
  const s = await pushState();
  expect(s).toMatchObject({ supported: true, permission: "granted", subscribed: true });
});

test("enablePush requests permission, subscribes, and POSTs to the server", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ publicKey: "aGk" }) }) // /api/push/vapid
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) }); // /api/push/subscribe
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Notification", {
    permission: "default",
    requestPermission: async () => "granted",
  });
  vi.stubGlobal("window", { PushManager: function () {} });
  const subscribe = vi.fn(async () => ({
    toJSON: () => ({ endpoint: "e1", keys: { p256dh: "p", auth: "a" } }),
  }));
  vi.stubGlobal("navigator", {
    serviceWorker: { register: vi.fn(), ready: Promise.resolve({ pushManager: { subscribe } }) },
  });
  const ok = await enablePush();
  expect(ok).toBe(true);
  expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/push/subscribe",
    expect.objectContaining({ method: "POST" }),
  );
});

test("enablePush returns false when permission denied", async () => {
  vi.stubGlobal("Notification", { permission: "default", requestPermission: async () => "denied" });
  vi.stubGlobal("window", { PushManager: function () {} });
  vi.stubGlobal("navigator", { serviceWorker: { register: vi.fn(), ready: Promise.resolve({}) } });
  expect(await enablePush()).toBe(false);
});

test("disablePush unsubscribes and notifies the server", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetchMock);
  const unsubscribe = vi.fn(async () => true);
  vi.stubGlobal("window", { PushManager: function () {} });
  vi.stubGlobal("navigator", {
    serviceWorker: {
      ready: Promise.resolve({
        pushManager: { getSubscription: async () => ({ endpoint: "e1", unsubscribe }) },
      }),
    },
  });
  await disablePush();
  expect(unsubscribe).toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/push/unsubscribe",
    expect.objectContaining({ method: "POST" }),
  );
});
