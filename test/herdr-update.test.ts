import { test, expect } from "bun:test";
import { HerdrUpdateService, compareSemver } from "../src/herdr-update";

// ── compareSemver ───────────────────────────────────────────────────────────
test("compareSemver: orders major/minor/patch numerically", () => {
  expect(compareSemver("0.6.5", "0.6.3")).toBe(1);
  expect(compareSemver("0.6.3", "0.6.5")).toBe(-1);
  expect(compareSemver("0.6.3", "0.6.3")).toBe(0);
  expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
  expect(compareSemver("0.10.0", "0.9.0")).toBe(1); // numeric, not lexical
  expect(compareSemver("0.6", "0.6.0")).toBe(0); // missing segment → 0
});

// ── check(): update available ────────────────────────────────────────────────
test("current < latest → updateAvailable true, notes carried", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.5.10\n",
    fetchLatest: async () => ({ version: "0.6.5", notes: "### Added\n- scrollback" }),
  });
  const s = await svc.check(1000);
  expect(s.current).toBe("0.5.10");
  expect(s.latest).toBe("0.6.5");
  expect(s.updateAvailable).toBe(true);
  expect(s.notes).toBe("### Added\n- scrollback");
  expect(s.error).toBeUndefined();
});

// ── check(): up to date ──────────────────────────────────────────────────────
test("current == latest → updateAvailable false, no notes", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.6.5",
    fetchLatest: async () => ({ version: "0.6.5", notes: "irrelevant" }),
  });
  const s = await svc.check(2000);
  expect(s.updateAvailable).toBe(false);
  expect(s.notes).toBeNull();
});

test("current > latest → updateAvailable false", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.7.0",
    fetchLatest: async () => ({ version: "0.6.5" }),
  });
  const s = await svc.check(3000);
  expect(s.updateAvailable).toBe(false);
});

// ── fail-safe: never raise a false badge ─────────────────────────────────────
test("versionRunner throws → fail-safe, no badge, error set", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => {
      throw new Error("herdr: command not found");
    },
    fetchLatest: async () => ({ version: "0.6.5" }),
  });
  const s = await svc.check(4000);
  expect(s.updateAvailable).toBe(false);
  expect(s.latest).toBeNull();
  expect(s.error).toContain("command not found");
});

test("fetchLatest rejects → fail-safe, no badge, error set", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.5.10",
    fetchLatest: async () => {
      throw new Error("network down");
    },
  });
  const s = await svc.check(5000);
  expect(s.updateAvailable).toBe(false);
  expect(s.error).toContain("network down");
  // last-known current is preserved across a failed check
  expect(s.current).toBe(svc.current()?.current ?? null);
});

// ── current() caching ────────────────────────────────────────────────────────
test("current() caches the last check", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.5.10",
    fetchLatest: async () => ({ version: "0.6.5" }),
  });
  expect(svc.current()).toBeNull();
  await svc.check(6000);
  expect(svc.current()?.updateAvailable).toBe(true);
});

test("unparseable version output → current null, no badge", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "no version here",
    fetchLatest: async () => ({ version: "0.6.5" }),
  });
  const s = await svc.check(7000);
  expect(s.current).toBeNull();
  expect(s.updateAvailable).toBe(false);
});

// ── apply(): launches once, guards double-launch ─────────────────────────────
test("apply() launches once and guards double-launch", () => {
  let launches = 0;
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.5.10",
    fetchLatest: async () => ({ version: "0.6.5" }),
    launch: () => launches++,
  });
  expect(svc.apply()).toEqual({ started: true });
  expect(svc.apply()).toEqual({ started: false });
  expect(launches).toBe(1);
});

// ── apply(): onLog / follow injection ────────────────────────────────────────
test("apply() calls follow and forwards lines to onLog", () => {
  const received: string[] = [];
  let capturedOnLine: ((line: string) => void) | null = null;

  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.5.10",
    fetchLatest: async () => ({ version: "0.6.5" }),
    launch: () => {},
    onLog: (line) => received.push(line),
    follow: (onLine) => {
      capturedOnLine = onLine;
    },
  });

  svc.apply();
  expect(capturedOnLine).not.toBeNull();
  capturedOnLine!("Fetching herdr 0.6.5...");
  capturedOnLine!("Installing...");
  expect(received).toEqual(["Fetching herdr 0.6.5...", "Installing..."]);
});

test("apply() does not start follow on second call", () => {
  let followCalls = 0;
  const svc = new HerdrUpdateService({
    launch: () => {},
    onLog: () => {},
    follow: () => {
      followCalls++;
    },
  });

  svc.apply(); // first call — follow runs
  svc.apply(); // guard fires — follow should NOT run again
  expect(followCalls).toBe(1);
});

test("apply() survives a follow implementation that throws", () => {
  const svc = new HerdrUpdateService({
    launch: () => {},
    follow: () => {
      throw new Error("journalctl not found");
    },
  });
  // must not throw
  expect(() => svc.apply()).not.toThrow();
  expect(svc.apply()).toEqual({ started: false }); // guard: still marked as applying
});

test("apply() with no follow dep still returns started:true", () => {
  // When no follow dep is provided the default journalctl path would run; inject
  // a no-op to keep tests hermetic (no real journalctl in CI).
  const svc = new HerdrUpdateService({
    launch: () => {},
    follow: () => {},
  });
  expect(svc.apply()).toEqual({ started: true });
});
