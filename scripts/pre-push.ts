#!/usr/bin/env bun
/**
 * Parallel pre-push orchestrator (#1030).
 *
 * Runs the same gate set as `.github/workflows/ci.yml`, but in concurrent LANES
 * with bounded aggregate concurrency and per-lane timeout backstops — so a warm
 * push finishes well under a minute instead of the old ~2.3-min fully-sequential
 * hook that blew past the 120s agent command timeout.
 *
 * ┌─ KEEP IN SYNC WITH `.github/workflows/ci.yml` (`verify` job) ────────────────┐
 * │ This TS orchestrator no longer shares ci.yml's shell body, so the two gate    │
 * │ definitions can drift. When you add/remove/reorder a CI step, mirror it here  │
 * │ (and vice-versa). Two DELIBERATE local-only differences from CI:              │
 * │  • prettier/eslint are scoped to the push DELTA (vs origin/main) — CI keeps   │
 * │    the whole-repo check, so tree-wide drift is still caught before merge.     │
 * │  • fallow stays pinned to 2.100.0 (keep in sync w/ ci.yml + CONTRIBUTING.md). │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * The hook (`.husky/pre-push`) scrubs git's local-env-vars and execs this script,
 * so every child inherits the same clean env as CI.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { join } from "node:path";

// ── Pure helpers (unit-tested in test/pre-push.test.ts) ──────────────────────

/** Extensions eslint is configured to lint (incl. `.svelte` and `.svelte.ts`). */
export const ESLINT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".svelte"];

/** Root eslint (`bun run lint`) lints these roots; extension/src is the extension config's. */
const ROOT_ESLINT_ROOTS = ["src/", "test/", "ui/src/", "ci/onboarding-harness/", "deploy/"];
const ROOT_ESLINT_IGNORES = ["ui/.svelte-kit/", "ui/build/", "ui/dist/", "ui/src/lib/paraglide/"];
const EXT_ESLINT_ROOT = "extension/src/";
const EXT_ESLINT_IGNORES = ["extension/src/lib/paraglide/"];

export function isEslintFile(path: string): boolean {
  return ESLINT_EXTENSIONS.some((e) => path.endsWith(e));
}

/**
 * Route changed files to the correct eslint invocation. `ui/` has no own lint
 * script — `ui/src` is linted by the ROOT eslint; `extension/src` by the
 * EXTENSION eslint (run with cwd=extension, so paths are returned relative to it).
 */
export function routeEslintFiles(changed: string[]): { root: string[]; ext: string[] } {
  const root: string[] = [];
  const ext: string[] = [];
  for (const f of changed) {
    if (!isEslintFile(f)) continue;
    if (f.startsWith(EXT_ESLINT_ROOT)) {
      if (!EXT_ESLINT_IGNORES.some((i) => f.startsWith(i))) ext.push(f.slice("extension/".length));
      continue;
    }
    if (
      ROOT_ESLINT_ROOTS.some((r) => f.startsWith(r)) &&
      !ROOT_ESLINT_IGNORES.some((i) => f.startsWith(i))
    ) {
      root.push(f);
    }
  }
  return { root, ext };
}

/**
 * Guard against argv flag smuggling: a file whose name begins with `-` (e.g.
 * `--config`, `-rf`) would be parsed as an OPTION rather than a path if spread
 * into a linter's argv. We never lint such a path, so drop it at the source.
 */
export function isSafePath(f: string): boolean {
  return !f.startsWith("-");
}

/**
 * Assemble a tool argv with a `--` option terminator before a spread file list,
 * so a dash-leading filename can't smuggle a flag into prettier/eslint. Verified
 * empirically that bunx forwards the first `--` and both binaries honor a bare
 * `--` (prettier v3, eslint v10). See `changedFiles`/`isSafePath` for the
 * upstream defense-in-depth layer.
 */
export function withFileArgs(flags: string[], files: string[]): string[] {
  return [...flags, "--", ...files];
}

/**
 * Bound the AGGREGATE worker count, not just the lane count. Several lanes each
 * spawn multi-worker tools (vitest ×2, chromium, `bun test`); running them all
 * unbounded oversubscribes a modest box. Cap lane fan-out scaled to cores, then
 * cap each heavy tool's workers so `laneCap × maxWorkers ≤ cores`.
 */
export function computeConcurrency(
  cores: number,
  numLanes: number,
  override?: number,
): { laneCap: number; maxWorkers: number } {
  let laneCap: number;
  if (override && override > 0) {
    laneCap = Math.min(override, numLanes);
  } else {
    const byCores = cores <= 4 ? 2 : cores <= 8 ? 3 : cores <= 16 ? 5 : numLanes;
    laneCap = Math.max(2, Math.min(byCores, numLanes));
  }
  const maxWorkers = Math.max(1, Math.floor(cores / laneCap));
  return { laneCap, maxWorkers };
}

// ── Lane scheduler (injectable for tests) ────────────────────────────────────

export interface StepResult {
  ok: boolean;
  logPath?: string;
  failedStep?: string;
}
export interface LaneHandle {
  done: Promise<StepResult>;
  kill: () => void;
  /** The lane's log path, known synchronously so a TIMEOUT (done never resolves) can still cite it. */
  logPath?: string;
}
export interface LaneSpec {
  name: string;
  timeoutMs: number;
  steps: { label: string; cmd: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }[];
}
export type LaneStatus = "PASS" | "FAIL" | "TIMEOUT";
export interface LaneOutcome {
  name: string;
  status: LaneStatus;
  durationMs: number;
  logPath?: string;
  failedStep?: string;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run lanes through a bounded pool. Each lane is raced against its wall-clock
 * timeout; on expiry the lane's `kill()` is invoked (the real implementation
 * kills the whole process group) so a hung child or pool deadlock can NEVER
 * block the push indefinitely — the worst case is one timeout, not a hang.
 *
 * `start` is injected so tests can drive the scheduling/timeout/aggregation
 * lifecycle with fakes instead of real processes.
 */
export async function runLanes(
  lanes: LaneSpec[],
  opts: {
    laneCap: number;
    start: (lane: LaneSpec) => LaneHandle;
    onSettle?: (o: LaneOutcome) => void;
    graceMs?: number;
    nowMs?: () => number;
  },
): Promise<{ outcomes: LaneOutcome[]; maxConcurrent: number }> {
  const { start, onSettle, laneCap } = opts;
  const graceMs = opts.graceMs ?? 8000;
  const now = opts.nowMs ?? (() => Date.now());
  const outcomes: LaneOutcome[] = new Array(lanes.length);
  let next = 0;
  let running = 0;
  let maxConcurrent = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= lanes.length) return;
      const lane = lanes[i]!;
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      const startedAt = now();
      const { done, kill, logPath } = start(lane);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"__timeout__">((res) => {
        timer = setTimeout(() => res("__timeout__"), lane.timeoutMs);
      });
      const race = await Promise.race([
        done.then((r) => ({ kind: "done" as const, r })),
        timedOut.then(() => ({ kind: "timeout" as const })),
      ]);
      if (timer) clearTimeout(timer);

      let outcome: LaneOutcome;
      if (race.kind === "timeout") {
        kill();
        // Give the killed child a bounded grace to exit and be reaped.
        await Promise.race([done.catch(() => undefined), delay(graceMs)]);
        outcome = { name: lane.name, status: "TIMEOUT", durationMs: now() - startedAt, logPath };
      } else {
        outcome = {
          name: lane.name,
          status: race.r.ok ? "PASS" : "FAIL",
          durationMs: now() - startedAt,
          logPath: race.r.logPath,
          failedStep: race.r.failedStep,
        };
      }
      outcomes[i] = outcome;
      onSettle?.(outcome);
      running--;
    }
  }

  await Promise.all(Array.from({ length: Math.min(laneCap, lanes.length) }, () => worker()));
  return { outcomes, maxConcurrent };
}

// ── Real lane runner (process-group spawn + SIGTERM→SIGKILL kill) ─────────────

const SIGKILL_GRACE_MS = 5000;

/**
 * PIDs (= process-group leaders, since lanes spawn `detached`) of currently-live
 * lane children. A SIGINT/SIGTERM handler in main() walks this to reap every lane
 * group before exiting — without it, an external kill of the push (the agent-timeout
 * this PR targets) would orphan the detached groups and leave them running.
 */
const liveProcessGroups = new Set<number>();

/** SIGKILL every live lane process group (used by both per-lane kill paths and the signal trap). */
function killAllProcessGroups(): void {
  for (const pid of liveProcessGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function makeStarter(logDir: string, stamp: string): (lane: LaneSpec) => LaneHandle {
  return (lane) => {
    const logPath = join(logDir, `prepush-${lane.name}-${stamp}.log`);
    const log = createWriteStream(logPath);
    let killed = false;
    let current: ReturnType<typeof spawn> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const done: Promise<StepResult> = (async () => {
      for (const step of lane.steps) {
        if (killed) {
          log.end();
          return { ok: false, logPath };
        }
        log.write(`\n▶ ${lane.name}: ${step.label}\n   $ ${step.cmd} ${step.args.join(" ")}\n`);
        const code = await new Promise<number>((resolve) => {
          // detached → own process group, so kill(-pid) reaps the whole subtree
          // (vitest workers / chromium / svelte-kit), not just the bun parent.
          const child = spawn(step.cmd, step.args, {
            cwd: step.cwd,
            env: step.env ?? process.env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          current = child;
          if (child.pid) liveProcessGroups.add(child.pid);
          const forget = () => {
            if (child.pid) liveProcessGroups.delete(child.pid);
          };
          child.stdout?.pipe(log, { end: false });
          child.stderr?.pipe(log, { end: false });
          child.on("error", (e) => {
            forget();
            log.write(`\n✗ spawn error: ${String(e)}\n`);
            resolve(1);
          });
          child.on("close", (c) => {
            forget();
            resolve(c ?? 1);
          });
        });
        current = null;
        if (code !== 0) {
          log.end();
          return { ok: false, logPath, failedStep: step.label };
        }
      }
      log.end();
      return { ok: true, logPath };
    })();

    const kill = () => {
      killed = true;
      const child = current;
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* already gone */
          }
        }, SIGKILL_GRACE_MS);
      }
    };
    void done.finally(() => {
      if (killTimer) clearTimeout(killTimer);
    });
    return { done, kill, logPath };
  };
}

// ── Git delta ────────────────────────────────────────────────────────────────

function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

function hasOriginMain(): boolean {
  return git(["rev-parse", "--verify", "--quiet", "origin/main"]).ok;
}

/** Files changed (added/copied/modified/renamed) vs the origin/main merge-base that still exist. */
function changedFiles(repoRoot: string): string[] {
  const base = git(["merge-base", "origin/main", "HEAD"]);
  if (!base.ok || !base.out) return [];
  const diff = git(["diff", "--name-only", "--diff-filter=ACMR", base.out, "HEAD"]);
  if (!diff.ok) return [];
  return diff.out
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => isSafePath(f) && existsSync(join(repoRoot, f)));
}

// ── Lane assembly + main ──────────────────────────────────────────────────────

/**
 * Number of lanes `buildLanes` will produce, computed WITHOUT side effects so
 * concurrency can be sized before the single (temp-dir-creating) build. MUST mirror
 * `buildLanes`' lane-inclusion logic: gates/tsc/root-tests/ui/ext always run;
 * prettier/eslint are conditional under delta scoping.
 */
export function plannedLaneCount(delta: boolean, changed: string[]): number {
  let n = 5; // gates, tsc, root-tests, ui, ext
  if (delta) {
    if (changed.length) n++; // prettier (delta)
    const routed = routeEslintFiles(changed);
    if (routed.root.length || routed.ext.length) n++; // eslint (delta)
  } else {
    n += 2; // prettier + eslint (whole-repo fallback)
  }
  return n;
}

function buildLanes(
  repoRoot: string,
  opts: { delta: boolean; changed: string[]; maxWorkers: number; laneTimeoutOverride?: number },
): LaneSpec[] {
  const ui = join(repoRoot, "ui");
  const ext = join(repoRoot, "extension");
  const W = String(opts.maxWorkers);
  const t = (def: number) => opts.laneTimeoutOverride ?? def;

  const lanes: LaneSpec[] = [];

  lanes.push({
    name: "gates",
    timeoutMs: t(120_000),
    steps: [
      {
        label: "branch hygiene",
        cmd: "bash",
        args: ["scripts/check-branch-hygiene.sh"],
        cwd: repoRoot,
      },
      {
        label: "feature catalog",
        cmd: "bash",
        args: ["scripts/check-feature-catalog.sh"],
        cwd: repoRoot,
      },
      {
        label: "generated docs",
        cmd: "bash",
        args: ["scripts/check-generated-docs.sh"],
        cwd: repoRoot,
      },
      { label: "glossary", cmd: "node", args: ["scripts/check-glossary.mjs"], cwd: repoRoot },
      {
        label: "announcement versions",
        cmd: "node",
        args: ["scripts/check-announcement-versions.mjs"],
        cwd: repoRoot,
      },
      { label: "herdr types", cmd: "bun", args: ["run", "check:herdr-types"], cwd: repoRoot },
    ],
  });

  // prettier — delta-scoped (honors .prettierignore; --ignore-unknown skips non-code).
  if (opts.delta) {
    if (opts.changed.length) {
      lanes.push({
        name: "prettier",
        timeoutMs: t(120_000),
        steps: [
          {
            label: "prettier --check (delta)",
            cmd: "bunx",
            // `--` terminator: dash-leading paths are already dropped upstream by
            // `isSafePath` in `changedFiles`; this is the second layer guarding the spread.
            // --cache flags mirror ci.yml (#1192); content strategy + .cache/ location.
            args: withFileArgs(
              [
                "prettier",
                "--check",
                "--ignore-unknown",
                "--cache",
                "--cache-strategy",
                "content",
                "--cache-location",
                ".cache/prettier",
              ],
              opts.changed,
            ),
            cwd: repoRoot,
          },
        ],
      });
    }
  } else {
    lanes.push({
      name: "prettier",
      timeoutMs: t(120_000),
      steps: [
        {
          label: "prettier --check (whole repo)",
          cmd: "bunx",
          // --cache flags mirror ci.yml (#1192); content strategy + .cache/ location.
          args: [
            "prettier",
            "--check",
            "--cache",
            "--cache-strategy",
            "content",
            "--cache-location",
            ".cache/prettier",
            ".",
          ],
          cwd: repoRoot,
        },
      ],
    });
  }

  // eslint — delta-scoped + routed to the correct config (root vs extension).
  if (opts.delta) {
    const routed = routeEslintFiles(opts.changed);
    const steps: LaneSpec["steps"] = [];
    if (routed.root.length)
      steps.push({
        label: "eslint root (delta)",
        cmd: "bunx",
        // `--` terminator: defense-in-depth — `routeEslintFiles` only admits
        // `src/`/`test/`/`ui/src/`-prefixed paths, so these can't be dash-leading.
        // --cache flags mirror the root `lint` npm script + ci.yml (#1192).
        args: withFileArgs(
          [
            "eslint",
            "--cache",
            "--cache-strategy",
            "content",
            "--cache-location",
            ".cache/eslint",
            "--no-error-on-unmatched-pattern",
          ],
          routed.root,
        ),
        cwd: repoRoot,
      });
    if (routed.ext.length)
      steps.push({
        label: "eslint extension (delta)",
        cmd: "bunx",
        // `--` terminator: defense-in-depth — routed paths are `extension/src/`-prefixed.
        // --cache flags mirror the extension `lint` npm script + ci.yml (#1192);
        // cwd=extension → .cache/eslint resolves to extension/.cache/eslint.
        args: withFileArgs(
          [
            "eslint",
            "--cache",
            "--cache-strategy",
            "content",
            "--cache-location",
            ".cache/eslint",
            "--no-error-on-unmatched-pattern",
          ],
          routed.ext,
        ),
        cwd: ext,
      });
    if (steps.length) lanes.push({ name: "eslint", timeoutMs: t(120_000), steps });
  } else {
    lanes.push({
      name: "eslint",
      timeoutMs: t(120_000),
      steps: [
        { label: "eslint root (whole)", cmd: "bun", args: ["run", "lint"], cwd: repoRoot },
        { label: "eslint extension (whole)", cmd: "bun", args: ["run", "lint"], cwd: ext },
      ],
    });
  }

  lanes.push({
    name: "tsc",
    timeoutMs: t(300_000),
    steps: [{ label: "root typecheck", cmd: "bun", args: ["run", "typecheck"], cwd: repoRoot }],
  });

  lanes.push({
    name: "root-tests",
    timeoutMs: t(300_000),
    steps: [
      {
        label: "bun test ./test",
        cmd: "bun",
        args: ["test", "./test"],
        cwd: repoRoot,
        // Point server.test.ts's throwaway repo at a unique temp dir (never the real root).
        env: {
          ...process.env,
          SHEPHERD_REPO_ROOT: mkdtempSync(join(tmpdir(), "shepherd-reporoot-")),
        },
      },
    ],
  });

  // ui — serial WITHIN the lane: check/test/build each run paraglide+svelte-kit
  // codegen, which races on .svelte-kit/ + src/lib/paraglide/ if run concurrently.
  lanes.push({
    name: "ui",
    timeoutMs: t(600_000),
    steps: [
      { label: "svelte-check", cmd: "bun", args: ["run", "check"], cwd: ui },
      { label: "i18n parity", cmd: "bun", args: ["run", "check:i18n"], cwd: ui },
      {
        label: "docs manifest freshness",
        cmd: "bun",
        args: ["run", "check:docs-manifest"],
        cwd: ui,
      },
      {
        label: "playwright chromium (idempotent)",
        cmd: "bunx",
        args: ["playwright", "install", "chromium"],
        cwd: ui,
      },
      { label: "vitest", cmd: "bun", args: ["run", "test", "--maxWorkers", W], cwd: ui },
      // Same script CI's "Build (ui)" step runs (ci.yml:24-29 requires the two to stay
      // in sync): builds, then fails on Rollup's INEFFECTIVE_DYNAMIC_IMPORT — a static
      // import that defeats a dynamic one, for any module. Rollup does not warn for
      // every static importer (a plain ui/src/lib/*.ts helper produces none), so the
      // eslint no-restricted-imports rule covers those files for the named libraries.
      // The two are complementary; see the header in check-ui-build.sh.
      { label: "build", cmd: join(repoRoot, "scripts/check-ui-build.sh"), args: [], cwd: ui },
    ],
  });

  lanes.push({
    name: "ext",
    timeoutMs: t(300_000),
    steps: [
      { label: "svelte-check", cmd: "bun", args: ["run", "check"], cwd: ext },
      { label: "i18n parity", cmd: "bun", args: ["run", "check:i18n"], cwd: ext },
      { label: "vitest", cmd: "bun", args: ["run", "test", "--maxWorkers", W], cwd: ext },
      { label: "build", cmd: "bun", args: ["run", "build"], cwd: ext },
    ],
  });

  return lanes;
}

function pruneLogs(logDir: string, keep = 20): void {
  try {
    const logs = readdirSync(logDir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => ({ f, m: statSync(join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const { f } of logs.slice(keep)) rmSync(join(logDir, f), { force: true });
  } catch {
    /* best effort */
  }
}

async function main(): Promise<void> {
  // When the push is killed externally (the agent-timeout this PR targets), reap the
  // detached lane process groups so they don't orphan and keep running. 130 = "killed
  // by signal" exit convention; git aborts the push on any non-zero hook exit.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.error(
        `\n✗ pre-push: received ${sig} — killing ${liveProcessGroups.size} live lane group(s)`,
      );
      killAllProcessGroups();
      process.exit(130);
    });
  }

  const repoRoot = process.cwd();
  const cores = (availableParallelism?.() ?? cpus().length) || 4;
  const delta = hasOriginMain();
  const changed = delta ? changedFiles(repoRoot) : [];

  const laneOverride = Number(process.env.SHEPHERD_PREPUSH_LANES) || undefined;
  const laneTimeoutOverride = Number(process.env.SHEPHERD_PREPUSH_LANE_TIMEOUT_MS) || undefined;

  const logDir = join(repoRoot, ".test-logs");
  mkdirSync(logDir, { recursive: true });
  pruneLogs(logDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // Size concurrency from the side-effect-free lane count, then build lanes ONCE
  // (buildLanes creates the root-tests temp dir, so it must not run twice).
  const numLanes = plannedLaneCount(delta, changed);
  const { laneCap, maxWorkers } = computeConcurrency(cores, numLanes, laneOverride);
  const lanes = buildLanes(repoRoot, { delta, changed, maxWorkers, laneTimeoutOverride });

  console.log(
    `▶ pre-push: ${lanes.length} lanes · laneCap ${laneCap} · ${maxWorkers} workers/lane · ${cores} cores` +
      (delta
        ? ` · delta-scoped lint (${changed.length} changed files)`
        : " · whole-repo lint (no origin/main)"),
  );

  const start = makeStarter(logDir, stamp);
  const t0 = Date.now();
  const { outcomes, maxConcurrent } = await runLanes(lanes, {
    laneCap,
    start,
    onSettle: (o) => {
      const secs = (o.durationMs / 1000).toFixed(1);
      if (o.status === "PASS") console.log(`  ✓ ${o.name} (${secs}s)`);
      else if (o.status === "TIMEOUT")
        console.log(
          `  ✗ ${o.name} TIMEOUT after ${secs}s — killed (hung child or pool deadlock); see ${o.logPath ?? "(no log)"}`,
        );
      else console.log(`  ✗ ${o.name} FAILED at "${o.failedStep}" (${secs}s) — see ${o.logPath}`);
    },
  });

  const failed = outcomes.filter((o) => o.status !== "PASS");
  if (failed.length) {
    console.error(
      `\n✗ pre-push failed: ${failed.map((f) => `${f.name}(${f.status})`).join(", ")} [peak ${maxConcurrent} lanes]`,
    );
    process.exit(1);
  }

  // fallow runs only after every lane passes (delta vs origin/main). Skipped when
  // origin/main is unavailable (offline) so a push isn't wedged. Pinned 2.100.0 —
  // keep in sync with .github/workflows/ci.yml + CONTRIBUTING.md.
  if (delta) {
    console.log("  → fallow audit (delta vs origin/main)");
    // Bounded so a cold `bunx fallow@…` download that hangs can't wedge the push —
    // honors the "no child wedges the push" guarantee for this post-lanes step too.
    const fallowTimeoutMs = Number(process.env.SHEPHERD_PREPUSH_LANE_TIMEOUT_MS) || 300_000;
    const r = spawnSync(
      "bunx",
      ["fallow@2.100.0", "audit", "--base", "origin/main", "--fail-on-issues"],
      { cwd: repoRoot, stdio: "inherit", timeout: fallowTimeoutMs, killSignal: "SIGKILL" },
    );
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      console.error(
        `✗ pre-push failed: fallow audit timed out after ${fallowTimeoutMs}ms (cold download hang?)`,
      );
      process.exit(1);
    }
    if (r.status !== 0) {
      console.error("✗ pre-push failed: fallow audit");
      process.exit(1);
    }
  }

  console.log(
    `✓ pre-push passed in ${((Date.now() - t0) / 1000).toFixed(1)}s [peak ${maxConcurrent} lanes]`,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("✗ pre-push orchestrator crashed:", e);
    process.exit(1);
  });
}
