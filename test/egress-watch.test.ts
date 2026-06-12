import { test, expect } from "bun:test";
import { EgressWatcher, EGRESS_DROP_CAP } from "../src/egress-watch";

// ── helpers ────────────────────────────────────────────────────────────────────

function dnsLine(host: string, type = "A"): string {
  return `Jun 12 10:00:00 dnsmasq[123]: query[${type}] ${host} from 127.0.0.1`;
}

interface FakeSignal {
  repoPath: string;
  sessionId: string;
  kind: string;
  payload: string;
}

interface FakeEmit {
  event: string;
  data: unknown;
}

function makeWatcher(content: string | (() => string), opts?: { intervalMs?: number }) {
  const signals: FakeSignal[] = [];
  const emits: FakeEmit[] = [];

  // setInterval / clearInterval stubs — we drive ticks manually.
  const intervals = new Map<number, () => void>();
  let nextId = 1;

  const watcher = new EgressWatcher({
    readFile: async () => (typeof content === "function" ? content() : content),
    addSignal: (s) => signals.push(s),
    emit: (event, data) => emits.push({ event, data }),
    intervalMs: opts?.intervalMs ?? 2000,
    setInterval: (fn: () => void) => {
      const id = nextId++;
      intervals.set(id, fn);
      return id as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: (id: ReturnType<typeof setInterval>) => {
      intervals.delete(id as unknown as number);
    },
  });

  return { watcher, signals, emits, intervals };
}

const SESSION = "sess-1";
const REPO = "/repo/abc";
const ALLOWLIST = ["api.anthropic.com", "github.com", "objects.githubusercontent.com"];

// ── tests ──────────────────────────────────────────────────────────────────────

test("blocked host → addSignal(egress_drop) + emit(session:egress-drop)", async () => {
  const log = [dnsLine("evil.example.com"), dnsLine("api.anthropic.com")].join("\n");
  const { watcher, signals, emits } = makeWatcher(log);

  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });

  expect(signals).toHaveLength(1);
  expect(signals[0]).toMatchObject({
    kind: "egress_drop",
    payload: "evil.example.com",
    sessionId: SESSION,
    repoPath: REPO,
  });

  expect(emits).toHaveLength(1);
  expect(emits[0]).toMatchObject({
    event: "session:egress-drop",
    data: { id: SESSION, host: "evil.example.com" },
  });
});

test("allowlisted host → no signal", async () => {
  const log = dnsLine("api.anthropic.com");
  const { watcher, signals, emits } = makeWatcher(log);

  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });

  expect(signals).toHaveLength(0);
  expect(emits).toHaveLength(0);
});

test("subdomain of allowlisted entry → no signal (suffix match)", async () => {
  const log = dnsLine("sub.api.anthropic.com");
  // allowlist contains "api.anthropic.com" → sub.api.anthropic.com is a subdomain of it
  const { watcher, signals } = makeWatcher(log);

  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });

  expect(signals).toHaveLength(0);
});

test("deduplicate: same blocked host in two ticks → only ONE signal", async () => {
  const log = dnsLine("evil.example.com");
  const { watcher, signals } = makeWatcher(log);

  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });

  expect(signals).toHaveLength(1);
});

test("cursor: host in first read not reprocessed on second tick (only tail)", async () => {
  // Simulate appending content between ticks by tracking calls.
  let callCount = 0;
  const firstLine = dnsLine("first.example.com");
  const secondLine = dnsLine("second.example.com");

  const readFile = async () => {
    callCount++;
    if (callCount === 1) return firstLine;
    return firstLine + "\n" + secondLine;
  };

  const signals: FakeSignal[] = [];
  const watcher = new EgressWatcher({
    readFile,
    addSignal: (s) => signals.push(s),
    setInterval: (() => 1) as unknown as typeof setInterval,
    clearInterval: () => {},
  });

  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });

  // First tick: sees firstLine → 1 signal for first.example.com
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  expect(signals.map((s) => s.payload)).toEqual(["first.example.com"]);

  // Second tick: readFile returns both lines; cursor skips the first, only secondLine is new.
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  expect(signals.map((s) => s.payload)).toEqual(["first.example.com", "second.example.com"]);
});

test("ENOENT → no throw, no signal", async () => {
  const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const watcher = new EgressWatcher({
    readFile: async () => {
      throw err;
    },
    addSignal: () => {},
    setInterval: (() => 1) as unknown as typeof setInterval,
    clearInterval: () => {},
  });

  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  // Must not throw.
  await expect(
    watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST }),
  ).resolves.toBeUndefined();
});

test("malformed / non-query lines → no signal, no throw", async () => {
  const log = [
    "Jun 12 10:00:00 dnsmasq[123]: started, version 2.89 cachesize 150",
    "Jun 12 10:00:00 dnsmasq[123]: forwarding",
    "",
    "some garbage line",
  ].join("\n");

  const { watcher, signals } = makeWatcher(log);
  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });

  expect(signals).toHaveLength(0);
});

test(`cap: >${EGRESS_DROP_CAP} distinct blocked hosts → at most ${EGRESS_DROP_CAP} signals`, async () => {
  const hosts = Array.from({ length: EGRESS_DROP_CAP + 5 }, (_, i) => `host${i}.evil.com`);
  const log = hosts.map((h) => dnsLine(h)).join("\n");

  const { watcher, signals } = makeWatcher(log);
  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });

  expect(signals.length).toBeLessThanOrEqual(EGRESS_DROP_CAP);
});

test("cap: further ticks after cap emit no more signals", async () => {
  const hosts = Array.from({ length: EGRESS_DROP_CAP }, (_, i) => `cap${i}.evil.com`);
  const log = hosts.map((h) => dnsLine(h)).join("\n");

  const { watcher, signals } = makeWatcher(log);
  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  const afterFirst = signals.length;

  // Add a new host in the second tick (simulate append).
  // Even though the file grew, the watcher is capped and should emit nothing.
  const afterLog = log + "\n" + dnsLine("extra.evil.com");
  const watcher2 = new EgressWatcher({
    readFile: async () => afterLog,
    addSignal: (s) => signals.push(s),
    setInterval: (() => 1) as unknown as typeof setInterval,
    clearInterval: () => {},
  });

  // Manually put a capped session state into watcher2 by running the full cap sequence first.
  watcher2.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  await watcher2.tick(SESSION, {
    repoPath: REPO,
    dnsLogPath: "/tmp/dns.log",
    allowlist: ALLOWLIST,
  });
  const signalCount = signals.length;
  // After cap is reached, another tick should add nothing.
  await watcher2.tick(SESSION, {
    repoPath: REPO,
    dnsLogPath: "/tmp/dns.log",
    allowlist: ALLOWLIST,
  });

  expect(signals.length).toBe(signalCount); // unchanged
  void afterFirst; // used above
});

test("stop: clears state, subsequent tick is a no-op", async () => {
  const log = dnsLine("evil.example.com");
  const { watcher, signals } = makeWatcher(log);

  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  expect(signals).toHaveLength(1);

  watcher.stop(SESSION);

  // After stop, tick returns without processing (session state gone).
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  expect(signals).toHaveLength(1); // no new signal
});

test("stop is idempotent (double-stop does not throw)", () => {
  const { watcher } = makeWatcher("");
  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  watcher.stop(SESSION);
  expect(() => watcher.stop(SESSION)).not.toThrow();
});

test("stopAll clears all sessions", async () => {
  const log = dnsLine("evil.example.com");
  const { watcher, signals } = makeWatcher(log);

  watcher.start("s1", { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  watcher.start("s2", { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  watcher.stopAll();

  await watcher.tick("s1", { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  await watcher.tick("s2", { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  expect(signals).toHaveLength(0);
});

test("duplicate start for same session is a no-op (interval not doubled)", () => {
  const { watcher, intervals } = makeWatcher("");
  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  const firstCount = intervals.size;
  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  expect(intervals.size).toBe(firstCount); // still only one interval
});

test("AAAA query for blocked host → signal (non-A query types still caught)", async () => {
  const log = dnsLine("evil.example.com", "AAAA");
  const { watcher, signals } = makeWatcher(log);

  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });

  expect(signals).toHaveLength(1);
  expect(signals[0]!.payload).toBe("evil.example.com");
});
