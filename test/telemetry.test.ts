import { test, expect } from "bun:test";
import { TelemetryService, resolveAptabaseHost, type PostEventFn } from "../src/telemetry";

const sync = (fn: () => void) => fn();

function svc(over: Partial<ConstructorParameters<typeof TelemetryService>[0]> = {}) {
  const calls: { host: string; appKey: string; batch: any[] }[] = [];
  const postEvent: PostEventFn = async (host, appKey, batch) => {
    calls.push({ host, appKey, batch });
  };
  const s = new TelemetryService({
    appKey: "A-US-1234567890",
    hostOverride: null,
    enabled: () => true,
    postEvent,
    schedule: sync,
    now: () => 0,
    ...over,
  });
  return { s, calls };
}

test("resolveAptabaseHost derives region host, requires override for SH", () => {
  expect(resolveAptabaseHost("A-US-x", null)).toBe("https://us.aptabase.com");
  expect(resolveAptabaseHost("A-EU-x", null)).toBe("https://eu.aptabase.com");
  expect(resolveAptabaseHost("A-SH-x", null)).toBeNull();
  expect(resolveAptabaseHost("A-SH-x", "https://a.example.com/")).toBe("https://a.example.com");
  expect(resolveAptabaseHost(null, null)).toBeNull();
  expect(resolveAptabaseHost(null, "https://x.example.com")).toBeNull();
});

test("emits a POST with correct host/App-Key/body when enabled", async () => {
  const { s, calls } = svc();
  s.event("app_launched", { arch: "arm64" });
  await s.flush();
  expect(calls.length).toBe(1);
  expect(calls[0]!.host).toBe("https://us.aptabase.com");
  expect(calls[0]!.appKey).toBe("A-US-1234567890");
  const ev = calls[0]!.batch[0];
  expect(ev.eventName).toBe("app_launched");
  expect(ev.props).toEqual({ arch: "arm64" });
  expect(typeof ev.systemProps.osName).toBe("string");
  expect(ev.systemProps.sdkVersion).toBe("shepherd-telemetry@1");
  expect(typeof ev.systemProps.arch).toBe("string");
  expect(ev.systemProps.arch).toBe(process.arch);
  expect((ev.systemProps.arch as string).length).toBeGreaterThan(0);
});

test("no-op when consent not granted", async () => {
  const { s, calls } = svc({ enabled: () => false });
  s.event("app_launched");
  await s.flush();
  expect(calls.length).toBe(0);
});

test("no-op when App-Key absent", async () => {
  const { s, calls } = svc({ appKey: null });
  s.event("app_launched");
  await s.flush();
  expect(calls.length).toBe(0);
});

test("never leaks host/username/path in systemProps", async () => {
  const { s, calls } = svc();
  s.event("app_launched");
  await s.flush();
  const sp = JSON.stringify(calls[0]!.batch[0].systemProps);
  expect(sp).not.toContain(process.env.HOME ?? " nope");
  expect(sp.toLowerCase()).not.toContain("username");
});

test("batches in slices of <=25", async () => {
  // Deferred schedule: coalesces like production setTimeout, so all 30 events
  // accumulate in the buffer before a single flush slices them into batches.
  let scheduled: (() => void) | undefined;
  const defer = (fn: () => void) => {
    scheduled = fn;
  };
  const { s, calls } = svc({ schedule: defer });
  for (let i = 0; i < 30; i++) s.event("session_created");
  expect(scheduled).toBeDefined();
  scheduled?.();
  await Promise.resolve();
  const total = calls.reduce((n, c) => n + c.batch.length, 0);
  expect(total).toBe(30);
  expect(calls.length).toBe(2);
  expect(calls[0]!.batch.length).toBe(25);
  expect(calls[1]!.batch.length).toBe(5);
});

test("swallows postEvent failure (never throws)", async () => {
  const boom: PostEventFn = async () => {
    throw new Error("network down");
  };
  const { s } = svc({ postEvent: boom });
  s.event("app_launched");
  await s.flush(); // must not reject
  expect(true).toBe(true);
});
