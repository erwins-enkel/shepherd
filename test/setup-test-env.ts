import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Preloaded before any test module (bunfig.toml → [test] preload), which means it runs
// BEFORE `src/config.ts` is first imported. That ordering is the whole point: `config` is a
// single object literal that snapshots ~100 `SHEPHERD_*` env vars at import and never re-reads
// them. When `bun test` runs inside a live Shepherd session (dogfooding), the operator's runtime
// toggles — `SHEPHERD_HOOKS_INGEST=1`, `SHEPHERD_DOC_AGENT=1`, `SHEPHERD_PASSWORD=…`, etc. — are
// inherited by the spawned agent's env and leak into that snapshot, flipping config away from the
// defaults the suite assumes. Concretely, `spawnSettingsOverlay()` starts emitting a `hooks` blob
// and 8 spawn/resume snapshot tests fail. CI stays green only because it happens to run with none
// of these set — so the failure is invisible until you run the suite (or `git push`, via the
// pre-push hook's test lane) from inside Shepherd.
//
// Fix the class, not the instances: strip the operator's entire ambient Shepherd config so every
// `bun test` invocation sees CI-equivalent defaults regardless of who launched it. Any FUTURE
// feature flag is neutralised automatically — no per-flag maintenance. We keep only the short
// allowlist of resource/harness vars that tests and the pre-push lane deliberately provide;
// deleting those would be actively harmful (e.g. `SHEPHERD_DB` unset falls back to the real
// `~/.shepherd/shepherd.db`, and the pre-push lane sets `SHEPHERD_REPO_ROOT` to a temp dir for
// repo-discovery isolation).
const KEEP = new Set([
  "SHEPHERD_DB", // resource path — never let tests fall back to the real user DB
  "SHEPHERD_FORGES", // resource path (derived from the DB dir)
  "SHEPHERD_PLUGINS_DIR", // resource path (derived from the DB dir)
  "SHEPHERD_REPO_ROOT", // pre-push lane sets a temp root for repo-discovery isolation
  "SHEPHERD_TMP_SWEEP_DIR", // scratchpad*.test.ts set + restore this per-test
  "SHEPHERD_PROFILE_LOOP", // instrument.test.ts sets + restores this
  "SHEPHERD_NODE_COMPILE_CACHE", // herdr.test.ts sets this sentinel
  "SHEPHERD_PREPUSH_LANES", // consumed by scripts/pre-push.ts
  "SHEPHERD_PREPUSH_LANE_TIMEOUT_MS", // consumed by scripts/pre-push.ts
]);

for (const key of Object.keys(process.env)) {
  if (key.startsWith("SHEPHERD_") && !KEEP.has(key)) delete process.env[key];
}

// #740 flipped BOTH hook flags to default-ON (kill-switch `!== "0"` form) — ingest first, then
// signals. The strip above removes the ambient vars, so config would otherwise read the *code*
// defaults (on) and spawnSettingsOverlay would bake a `hooks` blob into every spawn/resume argv —
// breaking the snapshot tests this preload exists to keep deterministic. Pin both hook flags OFF
// so the suite keeps CI-equivalent, hooks-off isolation. The on-path stays covered by the tests
// that set `config.hooksIngest` / `config.hooksSignals` directly (service.test.ts, poller*.test.ts).
process.env.SHEPHERD_HOOKS_INGEST = "0";
process.env.SHEPHERD_HOOKS_SIGNALS = "0";

// ── Per-run TMPDIR (#1862) ───────────────────────────────────────────────────
//
// 144 files under `test/` call `mkdtempSync(join(tmpdir(), …))` and most never clean up, so every
// run leaked hundreds of dirs into the shared temp root — 119,640 entries / ~2.0M inodes had
// accumulated on one host in 53 days, and nothing reclaimed them: the sweep's REGENERABLE_CACHE
// allowlist matches none of those names. Before #1875 pointed agents at a disk-backed TMPDIR that
// output went straight to the `/tmp` tmpfs, whose INODE table it is easily large enough to exhaust
// (ENOSPC with bytes to spare — the failure #1862 reports).
//
// Fix the class, not the instances: point the whole run at one throwaway root and drop it at the
// end. `os.tmpdir()` re-reads `process.env.TMPDIR` on every call, so all 518 existing call sites
// relocate with no per-test change, and spawned child processes inherit it. TMP/TEMP are set too
// for tools that read those instead.
//
// `mkdtempSync` deliberately runs BEFORE the reassignment, so the run root is created in the
// INHERITED temp dir rather than inside itself.
//
// Cleanup runs from a preload-level `afterAll`, which Bun fires ONCE after the whole run. It is
// deliberately NOT `process.on("exit")` / `"beforeExit"`: verified empirically, Bun's test runner
// fires NEITHER from a preload, so an exit handler here is dead code that silently leaks every
// run. A run KILLED mid-flight still leaves its root behind — `shepherd-test-run-` is in
// `REGENERABLE_CACHE`, so the age-gated sweep reclaims those.
const runTmpRoot = mkdtempSync(join(tmpdir(), "shepherd-test-run-"));
process.env.TMPDIR = runTmpRoot;
process.env.TMP = runTmpRoot;
process.env.TEMP = runTmpRoot;
afterAll(() => {
  try {
    rmSync(runTmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort: never fail a green run over cleanup */
  }
});
