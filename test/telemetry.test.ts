import { test, expect } from "bun:test";
import {
  TelemetryService,
  resolveAptabaseHost,
  normalizeLocale,
  createDefaultPost,
  normalizeTelemetryHealth,
  type PostEventFn,
} from "../src/telemetry";

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

test("normalizeLocale strips encoding, normalizes, caps at 10 (Aptabase's Locale limit)", () => {
  // glibc LANG forms Aptabase rejects verbatim (encoding suffix + underscore + >10 chars)
  expect(normalizeLocale("en_US.UTF-8")).toBe("en-US");
  expect(normalizeLocale("de_DE.UTF-8")).toBe("de-DE");
  // already-clean tags pass through
  expect(normalizeLocale("en-US")).toBe("en-US");
  // unset / empty fall back
  expect(normalizeLocale(undefined)).toBe("en");
  expect(normalizeLocale("")).toBe("en");
  // never exceeds Aptabase's 10-char cap, even for a long tag
  const long = normalizeLocale("ca_ES_valencia_extra.UTF-8");
  expect(long.length).toBeLessThanOrEqual(10);
});

test("emitted systemProps.locale is <=10 chars for a glibc LANG", async () => {
  const prev = process.env.LANG;
  process.env.LANG = "en_US.UTF-8";
  try {
    const { s, calls } = svc();
    s.event("app_launched");
    await s.flush();
    const locale = calls[0]!.batch[0].systemProps.locale as string;
    expect(locale).toBe("en-US");
    expect(locale.length).toBeLessThanOrEqual(10);
  } finally {
    if (prev === undefined) delete process.env.LANG;
    else process.env.LANG = prev;
  }
});

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

// ── send health ────────────────────────────────────────────────────────────
// Telemetry errors are never surfaced to callers, so the recorded outcome is the only
// evidence that the pipeline works. These pin that evidence down.

/** Minimal Response stand-in for createDefaultPost — only `ok`/`status` are read. */
function res(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

/** Suppress the auto-flush so these tests own exactly when (and how often) a send happens. */
const noAutoFlush = () => {};

/** Clock that advances 1000ms per read, so sent/error ordering is unambiguous. */
function tickingNow(): () => number {
  let t = 0;
  return () => (t += 1000);
}

test("createDefaultPost posts to the events path and resolves on 2xx", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const post = createDefaultPost((async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return res(200);
  }) as unknown as typeof fetch);
  await post("https://eu.aptabase.com", "A-EU-1", [{ eventName: "app_launched" }]);
  expect(seen.length).toBe(1);
  expect(seen[0]!.url).toBe("https://eu.aptabase.com/api/v0/events");
  expect((seen[0]!.init.headers as Record<string, string>)["App-Key"]).toBe("A-EU-1");
});

test("createDefaultPost rejects on non-2xx (fetch alone resolves for a rejected batch)", async () => {
  const post = createDefaultPost((async () => res(400)) as unknown as typeof fetch);
  await expect(post("https://eu.aptabase.com", "A-EU-1", [])).rejects.toThrow("HTTP 400");
});

test("a rejected batch records the status and leaves lastSentAt untouched", async () => {
  const post = createDefaultPost((async () => res(400)) as unknown as typeof fetch);
  const { s } = svc({ postEvent: post, now: tickingNow(), schedule: noAutoFlush });
  s.event("app_launched");
  await s.flush();
  const h = s.health();
  expect(h.lastError).toBe("HTTP 400");
  expect(h.lastErrorAt).not.toBeNull();
  expect(h.lastSentAt).toBeNull();
});

test("an accepted batch advances lastSentAt", async () => {
  const post = createDefaultPost((async () => res(200)) as unknown as typeof fetch);
  const { s } = svc({ postEvent: post, now: tickingNow(), schedule: noAutoFlush });
  s.event("app_launched");
  await s.flush();
  const h = s.health();
  expect(h.lastSentAt).not.toBeNull();
  expect(h.lastError).toBeNull();
});

test("health() returns a copy, not the live state", async () => {
  const { s } = svc({ now: tickingNow(), schedule: noAutoFlush });
  s.event("app_launched");
  await s.flush();
  const h = s.health();
  h.lastSentAt = 999_999;
  expect(s.health().lastSentAt).not.toBe(999_999);
});

test("restore seeds health; persist receives it after each attempt", async () => {
  const seeded = { lastSentAt: 42, lastErrorAt: null, lastError: null };
  const written: unknown[] = [];
  const { s } = svc({
    restore: () => seeded,
    persist: (h) => written.push(h),
    now: tickingNow(),
    schedule: noAutoFlush,
  });
  expect(s.health().lastSentAt).toBe(42);
  s.event("app_launched");
  await s.flush();
  expect(written.length).toBe(1);
  expect((written[0] as { lastSentAt: number }).lastSentAt).toBeGreaterThan(42);
});

test("logs once per failure streak and once on recovery", async () => {
  const warns: string[] = [];
  const logs: string[] = [];
  const realWarn = console.warn;
  const realLog = console.log;
  console.warn = (m: string) => void warns.push(String(m));
  console.log = (m: string) => void logs.push(String(m));
  try {
    let status = 500;
    const post = createDefaultPost((async () => res(status)) as unknown as typeof fetch);
    const { s } = svc({ postEvent: post, now: tickingNow(), schedule: noAutoFlush });
    for (let i = 0; i < 3; i++) {
      s.event("app_launched");
      await s.flush();
    }
    expect(warns.length).toBe(1); // a persistent outage must not log per event
    expect(warns[0]).toContain("HTTP 500");
    status = 200;
    s.event("app_launched");
    await s.flush();
    expect(logs.filter((l) => l.includes("sending again")).length).toBe(1);
  } finally {
    console.warn = realWarn;
    console.log = realLog;
  }
});

test("normalizeTelemetryHealth degrades a hand-edited row instead of throwing", () => {
  expect(
    normalizeTelemetryHealth({ lastSentAt: 5, lastErrorAt: 6, lastError: "HTTP 400" }),
  ).toEqual({ lastSentAt: 5, lastErrorAt: 6, lastError: "HTTP 400" });
  // wrong types degrade field-wise
  expect(normalizeTelemetryHealth({ lastSentAt: "nope", lastError: 7 })).toEqual({
    lastSentAt: null,
    lastErrorAt: null,
    lastError: null,
  });
  // NaN/Infinity are not usable timestamps
  expect(normalizeTelemetryHealth({ lastSentAt: NaN })!.lastSentAt).toBeNull();
  // non-objects have no salvageable shape
  expect(normalizeTelemetryHealth(null)).toBeNull();
  expect(normalizeTelemetryHealth("granted")).toBeNull();
  expect(normalizeTelemetryHealth([1, 2])).toBeNull();
  // an over-long reason is capped before it reaches the settings row
  const long = normalizeTelemetryHealth({ lastError: "x".repeat(500) })!.lastError!;
  expect(long.length).toBeLessThanOrEqual(120);
});

test("a throwing persist never escapes flush, and never reads as a send failure", async () => {
  // Production persist is a synchronous SQLite write (store.setSetting) that can throw
  // SQLITE_BUSY. Both setHealth call sites sit inside flush's try/catch, so an unguarded
  // throw would be misrecorded as a send failure and then rethrow out of flush itself —
  // which callers invoke as a bare `void this.flush()`.
  const post = createDefaultPost((async () => res(200)) as unknown as typeof fetch);
  const { s } = svc({
    postEvent: post,
    now: tickingNow(),
    schedule: noAutoFlush,
    persist: () => {
      throw new Error("SQLITE_BUSY: database is locked");
    },
  });
  s.event("app_launched");
  await s.flush(); // must not reject
  const h = s.health();
  expect(h.lastSentAt).not.toBeNull(); // the send did succeed
  expect(h.lastError).toBeNull(); // and must not be blamed for the persist failure
});

test("a throwing restore is the caller's problem, not a silent wrong state", () => {
  // Guard the contract in the other direction: restore is documented as must-not-throw,
  // so index.ts owns the try/catch. This pins that the service does not quietly swallow
  // a broken restore into a wrong-looking "healthy" state.
  expect(() =>
    svc({
      restore: () => {
        throw new Error("corrupt row");
      },
    }),
  ).toThrow("corrupt row");
});
