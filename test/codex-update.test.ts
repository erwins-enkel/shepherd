import { test, expect } from "bun:test";
import {
  CodexUpdateService,
  buildUpdateScript,
  CODEX_UPDATE_LOG_PREFIX,
  type CodexUpdateResult,
} from "../src/codex-update";

const LOG = "/home/op/.shepherd/codex-update.log";
const CB = "codex";

// ── buildUpdateScript: `codex update` with npm fallback, durable audit log ─────
test("buildUpdateScript: runs `codex update` and keeps an npm fallback", () => {
  const s = buildUpdateScript(LOG, "0.142.2", "0.142.4", CB);
  expect(s).toContain('"$CX" update'); // primary: codex's own install-kind-aware updater
  expect(s).toContain("npm install -g @openai/codex"); // fallback for a codex lacking `update`
  expect(s).toContain(`CX='${CB}'`);
});

test("buildUpdateScript: probes the subcommand and runs non-interactively", () => {
  const s = buildUpdateScript(LOG, "0.142.2", "0.142.4", CB);
  // `--help` probe guards against a too-old codex treating `update` as an agent prompt
  expect(s).toContain('"$CX" --help');
  expect(s).toContain("export CODEX_NON_INTERACTIVE=1");
});

test("buildUpdateScript: gates the npm fallback on version NON-advancement, not exit code", () => {
  const s = buildUpdateScript(LOG, "0.142.2", "0.142.4", CB);
  expect(s).toContain('[ "$after" = "$before" ]');
});

test("buildUpdateScript: emits portable duplicate diagnostics via `type -a codex`", () => {
  const s = buildUpdateScript(LOG, "0.142.2", "0.142.4", CB);
  expect(s).toContain("type -a codex"); // bare name reveals PATH dups even if CODEX_BIN is absolute
  expect(s).not.toContain("which -a"); // non-POSIX, deliberately avoided
});

test("buildUpdateScript: never restarts a server, herdr, shepherd, or shells systemd", () => {
  const s = buildUpdateScript(LOG, "0.142.2", "0.142.4", CB);
  // codex updates are non-destructive: no handoff, no server restart, no systemd.
  expect(s).not.toContain("--handoff");
  expect(s).not.toContain("herdr");
  expect(s).not.toContain("systemctl");
  expect(s).not.toContain("systemd-run");
});

test("buildUpdateScript: echoes greppable markers for the update + fallback steps", () => {
  const s = buildUpdateScript(LOG, "0.142.2", "0.142.4", CB);
  expect(s).toContain(`${CODEX_UPDATE_LOG_PREFIX} running codex update`);
  expect(s).toContain(`${CODEX_UPDATE_LOG_PREFIX} codex update exited rc=$rc`);
  expect(s).toContain(`${CODEX_UPDATE_LOG_PREFIX} falling back to npm install -g @openai/codex`);
  expect(s).toContain(`${CODEX_UPDATE_LOG_PREFIX} npm install exited rc=$rc`);
});

test("buildUpdateScript: appends a delimited, timestamped, versioned block", () => {
  const s = buildUpdateScript(LOG, "0.142.2", "0.142.4", CB);
  expect(s).toContain(`LOG='${LOG}'`);
  expect(s).toContain('| tee -a "$LOG"');
  expect(s).toContain("=== codex-update $(date -u +%Y-%m-%dT%H:%M:%SZ) 0.142.2 -> 0.142.4 ===");
  expect(s).toContain('mkdir -p "$(dirname "$LOG")"');
});

test("buildUpdateScript: sanitizes versions so a payload can't inject shell", () => {
  const s = buildUpdateScript(LOG, "0.142.2", '0.142.4"; rm -rf ~ #', CB);
  expect(s).not.toContain("rm -rf");
  expect(s).toContain("0.142.2 -> 0.142.4 ===");
});

test("buildUpdateScript: missing versions degrade to 'unknown'", () => {
  const s = buildUpdateScript(LOG, null, undefined, CB);
  expect(s).toContain("unknown -> unknown ===");
});

// ── check(): version compare against the npm registry ─────────────────────────
test("current < latest → updateAvailable true", async () => {
  const svc = new CodexUpdateService({
    versionRunner: () => "@openai/codex 0.142.2\n",
    fetchLatest: async () => ({ version: "0.142.4" }),
  });
  const s = await svc.check(1000);
  expect(s.current).toBe("0.142.2");
  expect(s.latest).toBe("0.142.4");
  expect(s.updateAvailable).toBe(true);
  expect(s.notes).toBe(null);
});

test("current == latest → updateAvailable false", async () => {
  const svc = new CodexUpdateService({
    versionRunner: () => "@openai/codex 0.142.4",
    fetchLatest: async () => ({ version: "0.142.4" }),
  });
  const s = await svc.check(2000);
  expect(s.updateAvailable).toBe(false);
});

test("versionRunner throws → fail-safe, no badge, error set", async () => {
  const svc = new CodexUpdateService({
    versionRunner: () => {
      throw new Error("codex: command not found");
    },
    fetchLatest: async () => ({ version: "0.142.4" }),
  });
  const s = await svc.check(4000);
  expect(s.updateAvailable).toBe(false);
  expect(s.error).toContain("command not found");
});

// ── apply(): success/failure detection from a re-read version ──────────────────

/** Build a service primed with a known current→latest, injecting all seams so
 *  no real process spawns. `runUpdate` resolves immediately by default. */
function primed(opts: {
  installedAfter: string; // what `codex --version` reports AFTER the update
  latest?: string;
  current?: string;
  runUpdate?: (onLine: (l: string) => void, signal: AbortSignal) => Promise<void>;
  resolveOnPathBinary?: () => string | null;
  watchdogMs?: number;
}) {
  const dones: CodexUpdateResult[] = [];
  let versionCalls = 0;
  const svc = new CodexUpdateService({
    // first call (during check) returns `current`; later calls return installedAfter
    versionRunner: () => {
      versionCalls++;
      return `@openai/codex ${versionCalls === 1 ? (opts.current ?? "0.142.2") : opts.installedAfter}`;
    },
    fetchLatest: async () => ({ version: opts.latest ?? "0.142.4" }),
    runUpdate: opts.runUpdate ?? (async () => {}),
    // default null so failure-path tests stay hermetic (no real PATH scan)
    resolveOnPathBinary: opts.resolveOnPathBinary ?? (() => null),
    onLog: () => {},
    onStatus: () => {},
    onDone: (r) => dones.push(r),
    watchdogMs: opts.watchdogMs ?? 300_000,
  });
  return { svc, dones };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test("apply(): success when the re-read version advances past the prior version", async () => {
  const { svc, dones } = primed({ installedAfter: "0.142.4", latest: "0.142.4" });
  await svc.check(1); // sets current=0.142.2, latest=0.142.4, updateAvailable
  expect(svc.apply()).toEqual({ started: true });
  await settle();
  expect(dones).toHaveLength(1);
  expect(dones[0]).toMatchObject({ ok: true, to: "0.142.4" });
});

test("apply(): success is by ADVANCEMENT, not npm-latest match (standalone channel skew)", async () => {
  // A standalone `codex update` landed 0.142.9 while npm-latest reports 0.143.0 —
  // the version advanced, so this is a success reported at the ACTUAL version.
  const { svc, dones } = primed({
    current: "0.142.2",
    installedAfter: "0.142.9",
    latest: "0.143.0",
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(dones[0]).toMatchObject({ ok: true, to: "0.142.9" });
});

test("apply(): non-advancement attaches the on-PATH binary for the stuck-update message", async () => {
  const { svc, dones } = primed({
    current: "0.142.2",
    installedAfter: "0.142.2", // update ran but version did not move (PATH dup / already-latest)
    latest: "0.142.4",
    resolveOnPathBinary: () => "/home/op/.local/bin/codex",
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(dones[0]).toMatchObject({
    ok: false,
    to: "0.142.2",
    onPathBinary: "/home/op/.local/bin/codex",
  });
});

test("apply(): failure when version unchanged even though the child exits 0", async () => {
  const { svc, dones } = primed({ installedAfter: "0.142.2", latest: "0.142.4" });
  await svc.check(1); // current=0.142.2
  svc.apply();
  await settle();
  expect(dones[0]).toMatchObject({ ok: false });
});

test("apply(): when runUpdate throws, reports the ACTUAL version, not the target", async () => {
  const { svc, dones } = primed({
    installedAfter: "0.142.2",
    latest: "0.142.4",
    runUpdate: async () => {
      throw new Error("spawn failed");
    },
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(dones[0]).toMatchObject({
    ok: false,
    to: "0.142.2",
    error: expect.stringContaining("spawn failed"),
  });
  expect(dones[0]!.to).not.toBe("0.142.4"); // never the target we did NOT reach
});

test("apply(): watchdog timeout reports the ACTUAL version, not the target", async () => {
  const { svc, dones } = primed({
    installedAfter: "0.142.2", // hung update never swapped the binary
    latest: "0.142.4",
    watchdogMs: 20,
    runUpdate: (_onLine, signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  });
  await svc.check(1);
  svc.apply();
  await new Promise((r) => setTimeout(r, 60));
  expect(dones[0]).toMatchObject({
    ok: false,
    to: "0.142.2",
    error: expect.stringContaining("timed out"),
  });
  expect(dones[0]!.to).not.toBe("0.142.4");
});

test("apply(): double-launch guarded while one is in flight", async () => {
  let runs = 0;
  const { svc } = primed({
    installedAfter: "0.142.4",
    runUpdate: async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 30));
    },
  });
  await svc.check(1);
  expect(svc.apply()).toEqual({ started: true });
  expect(svc.apply()).toEqual({ started: false }); // still applying
  await new Promise((r) => setTimeout(r, 60));
  expect(runs).toBe(1);
});

test("apply(): streams runUpdate lines to onLog", async () => {
  const received: string[] = [];
  const svc = new CodexUpdateService({
    versionRunner: () => "@openai/codex 0.142.4",
    fetchLatest: async () => ({ version: "0.142.4" }),
    runUpdate: async (onLine) => {
      onLine("changed 1 package");
      onLine("updated @openai/codex");
    },
    onLog: (l) => received.push(l),
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(received).toEqual(["changed 1 package", "updated @openai/codex"]);
});
