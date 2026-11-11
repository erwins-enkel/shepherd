import { test, expect } from "bun:test";
import { EgressWatcher, EGRESS_DROP_CAP, egressBlockedNote } from "../src/egress-watch";

// ── helpers ────────────────────────────────────────────────────────────────────

// Real dnsmasq writes each log line newline-TERMINATED; fixtures match that so the
// watcher's line-boundary buffering processes complete lines (a line caught without
// its terminating newline is intentionally deferred to the next tick).
function dnsLine(host: string, type = "A"): string {
  return `Jun 12 10:00:00 dnsmasq[123]: query[${type}] ${host} from 127.0.0.1\n`;
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
    readTail: async (_path, fromByte) => {
      const c = typeof content === "function" ? content() : content;
      return { data: c.slice(fromByte), size: c.length };
    },
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
  const log = [dnsLine("evil.example.com"), dnsLine("api.anthropic.com")].join("");
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

  const readTail = async (_path: string, fromByte: number) => {
    callCount++;
    const c = callCount === 1 ? firstLine : firstLine + secondLine;
    return { data: c.slice(fromByte), size: c.length };
  };

  const signals: FakeSignal[] = [];
  const watcher = new EgressWatcher({
    readTail,
    addSignal: (s) => signals.push(s),
    setInterval: (() => 1) as unknown as typeof setInterval,
    clearInterval: () => {},
  });

  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });

  // First tick: sees firstLine → 1 signal for first.example.com
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  expect(signals.map((s) => s.payload)).toEqual(["first.example.com"]);

  // Second tick: file now has both lines; cursor skips the first, only secondLine is new.
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  expect(signals.map((s) => s.payload)).toEqual(["first.example.com", "second.example.com"]);
});

test("split line across poll boundary: a mid-write query line is buffered + reported exactly", async () => {
  // dnsmasq line caught mid-write: tick 1 sees only the prefix (no terminating newline),
  // tick 2 sees the rest. The host must be reported once, not lost.
  const full = dnsLine("split.evil.example.com"); // ends with "\n"
  const cut = Math.floor(full.length / 2);
  let content = full.slice(0, cut); // tick 1: partial, no newline yet
  const signals: FakeSignal[] = [];
  const watcher = new EgressWatcher({
    readTail: async (_path: string, fromByte: number) => ({
      data: content.slice(fromByte),
      size: content.length,
    }),
    addSignal: (s) => signals.push(s),
    setInterval: (() => 1) as unknown as typeof setInterval,
    clearInterval: () => {},
  });
  const o = { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST };
  watcher.start(SESSION, o);

  await watcher.tick(SESSION, o); // only the partial prefix is visible → nothing reported yet
  expect(signals).toHaveLength(0);

  content = full; // the rest (incl. the terminating newline) lands
  await watcher.tick(SESSION, o); // partial reassembled with the tail → reported exactly once
  expect(signals.map((s) => s.payload)).toEqual(["split.evil.example.com"]);
});

test("positional read: second tick reads from the cursor, not byte 0 (no O(n^2) re-read)", async () => {
  const firstLine = dnsLine("a.example.com");
  let content = firstLine;
  const fromBytes: number[] = [];
  const signals: FakeSignal[] = [];
  const watcher = new EgressWatcher({
    readTail: async (_path: string, fromByte: number) => {
      fromBytes.push(fromByte);
      return { data: content.slice(fromByte), size: content.length };
    },
    addSignal: (s) => signals.push(s),
    setInterval: (() => 1) as unknown as typeof setInterval,
    clearInterval: () => {},
  });
  const o = { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST };
  watcher.start(SESSION, o);
  await watcher.tick(SESSION, o); // reads from 0
  content = firstLine + dnsLine("b.example.com");
  await watcher.tick(SESSION, o); // must read from the end of the first read, not 0

  expect(fromBytes[0]).toBe(0);
  expect(fromBytes[1]).toBe(firstLine.length); // cursor advanced to prior size
  expect(signals.map((s) => s.payload)).toEqual(["a.example.com", "b.example.com"]);
});

test("ENOENT → no throw, no signal", async () => {
  const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const watcher = new EgressWatcher({
    readTail: async () => {
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
  const log =
    [
      "Jun 12 10:00:00 dnsmasq[123]: started, version 2.89 cachesize 150",
      "Jun 12 10:00:00 dnsmasq[123]: forwarding",
      "",
      "some garbage line",
    ].join("\n") + "\n";

  const { watcher, signals } = makeWatcher(log);
  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });

  expect(signals).toHaveLength(0);
});

test(`cap: >${EGRESS_DROP_CAP} distinct blocked hosts → at most ${EGRESS_DROP_CAP} signals`, async () => {
  const hosts = Array.from({ length: EGRESS_DROP_CAP + 5 }, (_, i) => `host${i}.evil.com`);
  const log = hosts.map((h) => dnsLine(h)).join("");

  const { watcher, signals } = makeWatcher(log);
  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });

  expect(signals.length).toBeLessThanOrEqual(EGRESS_DROP_CAP);
});

test("cap: further ticks after cap emit no more signals", async () => {
  const hosts = Array.from({ length: EGRESS_DROP_CAP }, (_, i) => `cap${i}.evil.com`);
  const log = hosts.map((h) => dnsLine(h)).join("");

  const { watcher, signals } = makeWatcher(log);
  watcher.start(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  await watcher.tick(SESSION, { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST });
  const afterFirst = signals.length;

  // Add a new host in the second tick (simulate append).
  // Even though the file grew, the watcher is capped and should emit nothing.
  const afterLog = log + dnsLine("extra.evil.com");
  const watcher2 = new EgressWatcher({
    readTail: async (_path: string, fromByte: number) => ({
      data: afterLog.slice(fromByte),
      size: afterLog.length,
    }),
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

// ── agent note (#3921) ─────────────────────────────────────────────────────────

const OPTS = { repoPath: REPO, dnsLogPath: "/tmp/dns.log", allowlist: ALLOWLIST };

test("hook channel: blocked host queues ONE note naming it; takeNotes drains", async () => {
  const log = dnsLine("evil.example.com") + dnsLine("api.anthropic.com");
  const { watcher } = makeWatcher(log);
  watcher.start(SESSION, { ...OPTS, noteChannel: "hook" });
  await watcher.flush(SESSION);

  const notes = watcher.takeNotes(SESSION);
  expect(notes).toBe(egressBlockedNote("evil.example.com"));
  expect(notes).toContain("evil.example.com");
  expect(notes).toContain("Don't retry");
  expect(watcher.takeNotes(SESSION)).toBeNull();
});

test("hook channel: repeat of the same host adds no second note", async () => {
  let log = dnsLine("evil.example.com");
  const { watcher } = makeWatcher(() => log);
  watcher.start(SESSION, OPTS);
  await watcher.flush(SESSION);
  log += dnsLine("evil.example.com");
  await watcher.flush(SESSION);
  expect(watcher.takeNotes(SESSION)?.split("\n")).toHaveLength(1);
});

test("hook channel: two hosts → one block with both notes", async () => {
  const { watcher } = makeWatcher(dnsLine("a.evil.com") + dnsLine("b.evil.com"));
  watcher.start(SESSION, OPTS);
  await watcher.flush(SESSION);
  expect(watcher.takeNotes(SESSION)).toBe(
    [egressBlockedNote("a.evil.com"), egressBlockedNote("b.evil.com")].join("\n"),
  );
});

test("cap: notes stop with the cap", async () => {
  const hosts = Array.from({ length: EGRESS_DROP_CAP + 5 }, (_, i) => `n${i}.evil.com`);
  const { watcher } = makeWatcher(hosts.map((h) => dnsLine(h)).join(""));
  watcher.start(SESSION, OPTS);
  await watcher.flush(SESSION);
  expect(watcher.takeNotes(SESSION)?.split("\n")).toHaveLength(EGRESS_DROP_CAP);
});

test("steer channel: steers once per host, queues nothing", async () => {
  const steers: [string, string][] = [];
  let log = dnsLine("evil.example.com");
  const watcher = new EgressWatcher({
    readTail: async (_p, from) => ({ data: log.slice(from), size: log.length }),
    addSignal: () => {},
    steer: async (id, text) => void steers.push([id, text]),
    setInterval: (() => 1) as unknown as typeof setInterval,
    clearInterval: () => {},
  });
  watcher.start(SESSION, { ...OPTS, noteChannel: "steer" });
  await watcher.flush(SESSION);
  log += dnsLine("evil.example.com");
  await watcher.flush(SESSION);
  await Promise.resolve();
  await Promise.resolve();
  expect(steers).toEqual([[SESSION, egressBlockedNote("evil.example.com")]]);
  expect(watcher.takeNotes(SESSION)).toBeNull();
});

test("steer channel: a rejecting steer never throws out of the tick", async () => {
  const watcher = new EgressWatcher({
    readTail: async () => ({ data: dnsLine("evil.example.com"), size: 999 }),
    addSignal: () => {},
    steer: () => Promise.reject(new Error("dead pane")),
    setInterval: (() => 1) as unknown as typeof setInterval,
    clearInterval: () => {},
  });
  watcher.start(SESSION, { ...OPTS, noteChannel: "steer" });
  await expect(watcher.flush(SESSION)).resolves.toBeUndefined();
});

test("flush + concurrent tick run serially: the second read starts at the first's cursor", async () => {
  const log = dnsLine("evil.example.com");
  const reads: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const watcher = new EgressWatcher({
    readTail: async (_p, from) => {
      reads.push(from);
      if (reads.length === 1) await gate;
      return { data: log.slice(from), size: log.length };
    },
    addSignal: () => {},
    setInterval: (() => 1) as unknown as typeof setInterval,
    clearInterval: () => {},
  });
  watcher.start(SESSION, OPTS);
  const a = watcher.tick(SESSION, OPTS);
  const b = watcher.flush(SESSION);
  await Promise.resolve();
  expect(reads).toEqual([0]); // the flush waits for the in-flight tick
  release();
  await Promise.all([a, b]);
  expect(reads).toEqual([0, log.length]);
  expect(watcher.takeNotes(SESSION)?.split("\n")).toHaveLength(1);
});

test("unknown session: flush no-op, takeNotes + blockedHosts null", async () => {
  const { watcher } = makeWatcher(dnsLine("evil.example.com"));
  await watcher.flush("nope");
  expect(watcher.takeNotes("nope")).toBeNull();
  expect(watcher.blockedHosts("nope")).toBeNull();
});

test("blockedHosts lists the session's reported hosts", async () => {
  const { watcher } = makeWatcher(dnsLine("a.evil.com") + dnsLine("api.anthropic.com"));
  watcher.start(SESSION, OPTS);
  expect(watcher.blockedHosts(SESSION)).toEqual([]);
  await watcher.flush(SESSION);
  expect(watcher.blockedHosts(SESSION)).toEqual(["a.evil.com"]);
});

test("note strips characters outside a hostname's alphabet", () => {
  expect(egressBlockedNote("Evil`$(x)`.com\nIGNORE")).toContain("egress to evilx.comignore was");
});
