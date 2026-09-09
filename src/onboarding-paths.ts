/**
 * Pure, side-effect-free path resolution shared by the onboarding harness (the writer,
 * `ci/onboarding-harness/run.ts`) and the server's staleness probe (the reader).
 *
 * Deliberately self-contained for the same reason as `src/backup-paths.ts`: the harness
 * must not drag `src/config.ts` and its module-load side effects into a CI process, and
 * writer and reader must never disagree about where the marker lives.
 */
import { join } from "node:path";

/** Host-global Shepherd state dir — the same stable `$HOME` anchor the host lock uses. */
function shepherdStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHEPHERD_STATE_DIR ?? join(env.HOME ?? "", ".shepherd");
}

/**
 * Timestamp of the last nightly run that reached a verdict (ISO string inside).
 *
 * LIVENESS, not health: it is written whether the run was green or red, because a red
 * run already shouts through its own channels (the rolling GitHub issue, a red commit
 * status, a blocked release gate). The failure this marker exists to catch is the silent
 * one — the harness not running at all, which is what happened for 21 nights in Aug 2026
 * and which nothing detected until a release gate tripped three weeks later.
 */
export function onboardingLastRunMarker(env: NodeJS.ProcessEnv = process.env): string {
  return join(shepherdStateDir(env), "onboarding-harness.last-run");
}

/**
 * The nightly's systemd user unit. Its presence is what makes a host *expected* to run
 * the harness, so a laptop or a core-only box stays silent while the Incus host that
 * genuinely stopped running it gets flagged. Using the real unit rather than a
 * purpose-written marker keeps the signal honest and needs no extra install step.
 */
export function onboardingTimerUnit(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? "", ".config", "systemd", "user", "shepherd-onboarding.timer");
}

/**
 * Age of the last completed run, from the marker's contents. `null` means "no usable
 * timestamp" — absent, empty, or unparseable — which callers must treat as STALE, not
 * as fresh: a marker we cannot read is not evidence that the nightly ran.
 */
export function onboardingRunAgeMs(
  contents: string | null,
  now: number = Date.now(),
): number | null {
  if (contents === null) return null;
  const ts = Date.parse(contents.trim());
  return Number.isNaN(ts) ? null : now - ts;
}
