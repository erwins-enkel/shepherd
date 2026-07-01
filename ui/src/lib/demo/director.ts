// The demo "liveness" engine. Two jobs:
//
//   1. Ambient liveness — for every WORKING session it periodically emits an
//      evolving `session:activity` frame (so the heartbeat/heat-strip ticks) and
//      pushes a short, tasteful terminal line to whatever `PtySocket` is attached
//      (so the live terminal keeps flowing past the transcript's idle "Waiting…").
//
//   2. Mutation reactions — when a demo mutation's IMMEDIATE frame appears on the
//      bus (e.g. `session:merging` from `mergePr`), it schedules the believable
//      FOLLOW-UP sequence (land the PR, post the recap, …). The follow-ups emit
//      their own frames, so each reaction is a BOUNDED sequence that can never
//      re-trigger itself: while the director runs any of its own code it sets a
//      re-entrancy flag, and its bus listener ignores frames raised under that flag
//      (this covers both direct emits and emits raised by `demoState` mutators the
//      director calls). External (router/mutator) frames alone drive reactions.
//
// Dependency direction is one-way: the director imports `demoState`; `state.ts`
// never imports the director (it exposes `onReset` so the director can hook in).
// EVERY timer is tracked and cleared in `stopAll()` — nothing leaks past teardown
// or a reset.

import type { WsEvent, SessionActivity } from "$lib/types";
import { bus } from "./bus";
import { demoState } from "./state";
import { ptyStream } from "./pty/stream";

// ── ANSI palette (xterm consumes raw bytes; colors close within each push) ──────
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";
const NL = "\r\n";

/** A short rolling set of plausible "still working" terminal lines. */
const AMBIENT_LINES: string[] = [
  `${CYAN}● Read(src/lib/pricing/apply.ts)${RESET}${NL}${GRAY}  ⎿ Read 42 lines${RESET}${NL}`,
  `● Refining the rounding so the discount lands on whole cents.${NL}`,
  `${CYAN}● Update(src/routes/checkout/Summary.svelte)${RESET}${NL}${GRAY}  ⎿ Updated  (+3 -1)${RESET}${NL}`,
  `${CYAN}● Bash(bun test src/lib/pricing)${RESET}${NL}    ${GREEN}✓${RESET} 4 pass${DIM}, 0 fail${RESET}${NL}`,
  `● Wiring the summary total to the new discount path.${NL}`,
];

/** Rolling tool-use summaries for the activity heartbeat (verbatim, like the server). */
const AMBIENT_SUMMARIES: string[] = [
  "Read(src/lib/pricing/apply.ts)",
  "editing Summary.svelte",
  "$ bun test src/lib/pricing",
  'grep "discount" src/routes',
  "running the type check",
];

// ── lifecycle state ─────────────────────────────────────────────────────────────
let enabled = false; // whether the director is meant to be live
let selfEmitting = false; // re-entrancy guard: ignore bus frames raised by our own code
let busUnsub: (() => void) | null = null;
let resetRegistered = false;

/** Every pending timer the director owns. A tick removes its own timer as it fires,
 *  so this set holds only still-pending timers; `stopAll()` clears whatever remains. */
const timers = new Set<ReturnType<typeof setTimeout>>();

/** The current pending ambient-loop timer per session id — presence means the loop
 *  is live (used to keep `startAmbient` idempotent). */
const ambientLoops = new Map<string, ReturnType<typeof setTimeout>>();

/** Schedule `fn` after `ms`, tracked so `stopAll()` can clear it; self-removes on fire. */
function schedule(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
  return t;
}

/** Run `fn` with the re-entrancy flag set so any bus frame it raises (directly or via
 *  a `demoState` mutator) is ignored by our own listener — no reaction re-triggers. */
function asSelf<T>(fn: () => T): T {
  const prev = selfEmitting;
  selfEmitting = true;
  try {
    return fn();
  } finally {
    selfEmitting = prev;
  }
}

/** Emit a director-originated frame (marked self, so it never re-triggers a reaction). */
function emit(ev: WsEvent): void {
  asSelf(() => bus.emit(ev));
}

// ── ambient liveness ────────────────────────────────────────────────────────────

/** Deterministic per-session cadence so the two working sessions don't tick in lockstep. */
function intervalFor(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 3000 + (h % 5) * 350; // 3.0s–4.4s
}

/** Shared predicate for "actively WORKING" — reused by `workingIds()` and by
 *  `reactSteer` to decide whether a reply-resumed session needs ambient liveness. */
function isWorking(s: { status: string; lastState: string }): boolean {
  return s.status === "running" && s.lastState === "working";
}

/** Ids of sessions that are actively WORKING in the CURRENT (post-seed/reset) world. */
function workingIds(): string[] {
  return demoState
    .sessions()
    .filter(isWorking)
    .map((s) => s.id);
}

/** Begin (or no-op if already running) an ambient loop for `id`: each tick emits an
 *  evolving `session:activity` frame and pushes one rolling terminal line. */
function startAmbient(id: string): void {
  if (ambientLoops.has(id)) return; // idempotent — never double-spin a loop
  const recentTs: number[] = [];
  let step = 0;
  const interval = intervalFor(id);

  const tick = (): void => {
    const now = Date.now();
    recentTs.push(now);
    if (recentTs.length > 12) recentTs.shift(); // bounded heat-strip window
    const activity: SessionActivity = {
      lastActivityTs: now,
      summary: AMBIENT_SUMMARIES[step % AMBIENT_SUMMARIES.length],
      recentTs: [...recentTs],
      recentErrTs: [],
    };
    emit({ event: "session:activity", data: { id, activity } });
    ptyStream.push(id, AMBIENT_LINES[step % AMBIENT_LINES.length]);
    step++;
    ambientLoops.set(id, schedule(tick, interval)); // chain the next tick
  };

  ambientLoops.set(id, schedule(tick, interval));
}

/** Start ambient loops for every currently-working session (idempotent per id). */
function startAmbientWorkingSet(): void {
  for (const id of workingIds()) startAmbient(id);
}

/** Stop (or no-op if absent) the ambient loop for `id` — an already-cleared or
 *  never-started id is a safe no-op, so this can't throw on a stale/unknown id. */
function stopAmbient(id: string): void {
  const t = ambientLoops.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(t);
  }
  ambientLoops.delete(id);
}

// ── mutation reactions (each a BOUNDED, self-marked follow-up sequence) ──────────

/** Push a small bounded burst of terminal lines on a staggered cadence. */
function pushBurst(id: string, lines: string[], baseDelay: number): void {
  lines.forEach((line, i) => schedule(() => ptyStream.push(id, line), baseDelay + i * 500));
}

/** merge → after a beat, land the PR (git merged + status + mergetrain:landed) and
 *  post the recap payoff (idempotent — a re-land of the same id is a no-op past
 *  the first call, so it can never stack). */
function reactMerge(id: string): void {
  pushBurst(id, [`${GRAY}  ⎿ merging…${RESET}${NL}`], 600);
  schedule(() => {
    asSelf(() => demoState.landMerge(id));
    const recap = asSelf(() => demoState.landRecap(id));
    if (recap) emit({ event: "session:recap", data: { id, recap } });
    ptyStream.push(id, `${GREEN}✓${RESET} Merged — landed on the default branch.${NL}`);
  }, 1800);
}

/** plan-gate release → after a beat the agent starts executing: status running,
 *  terminal bytes, and ambient liveness takes over. */
function reactPlanGate(id: string): void {
  pushBurst(
    id,
    [
      `● Plan approved — starting implementation.${NL}`,
      `${CYAN}● Update(migrations/0007_refresh_tokens.sql)${RESET}${NL}`,
    ],
    700,
  );
  schedule(() => {
    emit({ event: "session:status", data: { id, status: "running" } });
    startAmbient(id);
  }, 1600);
}

/** steer/reply → after a beat the agent acknowledges, pushes a few lines, then settles
 *  (and, if the reply resumed a held session into WORKING, keeps it ticking via ambient).
 *  A plan-question answer (`answerPlanQuestions`) routes through the same
 *  `session:activity` frame but the session is still PLANNING, not working — that gets
 *  a short plan-appropriate acknowledgment instead of a code-editing burst. */
function reactSteer(id: string): void {
  const session = demoState.sessions().find((s) => s.id === id);
  // Plan-question answer: still PLANNING and not yet working (`answerPlanQuestions`
  // touches neither status nor lastState) → a short plan-appropriate ack, no code burst.
  // A `reply` to the SAME plan-gate session resumes it to working (status running +
  // lastState working) without clearing planPhase, so gate on `!isWorking` — otherwise
  // it would take the plan branch and never start ambient, going working-but-silent.
  if (session && !isWorking(session) && session.planPhase === "planning") {
    pushBurst(id, [`● Noted — folding the answer into the plan.${NL}`], 600);
    return;
  }

  pushBurst(
    id,
    [
      `● On it — folding that into the current change.${NL}`,
      `${CYAN}● Update(src/lib/pricing/apply.ts)${RESET}${NL}${GRAY}  ⎿ Updated  (+5 -1)${RESET}${NL}`,
      `${GREEN}✓${RESET} Done — continuing.${NL}`,
    ],
    600,
  );
  schedule(() => {
    const now = Date.now();
    emit({
      event: "session:activity",
      data: {
        id,
        activity: {
          lastActivityTs: now,
          summary: "editing apply.ts",
          recentTs: [now],
          recentErrTs: [],
        },
      },
    });
    // A reply can resume a held/paused session (e.g. `neon`) straight to working —
    // pick it up in the ambient set so the heartbeat/terminal keep ticking past the
    // burst. Idempotent, so an already-ambient session (e.g. `coupon`) is unaffected.
    if (workingIds().includes(id)) startAmbient(id);
  }, 2200);
}

/** epic advance → after a beat, spawn the next child session and start driving it. */
function reactEpic(repoPath: string, parent: number): void {
  schedule(() => {
    const child = asSelf(() => demoState.spawnEpicChild(repoPath, parent));
    if (!child) return;
    pushBurst(child.id, [`${DIM}  Spawning ${child.desig}…${RESET}${NL}`], 400);
    startAmbient(child.id);
  }, 1500);
}

/** spawn-from-held (or any external session:new) → drive the newcomer. */
function reactSpawn(id: string): void {
  schedule(() => {
    ptyStream.push(id, `${DIM}  attaching…${RESET}${NL}`);
    startAmbient(id);
  }, 800);
}

/** Bus listener: react only to EXTERNAL (mutator/router) frames — anything the
 *  director itself raised is flagged `selfEmitting` and skipped, so nothing loops. */
function onBusEvent(ev: WsEvent): void {
  if (selfEmitting) return;
  switch (ev.event) {
    case "session:merging":
      reactMerge(ev.data.id);
      break;
    case "session:plangate":
      if (ev.data.planPhase === "executing") reactPlanGate(ev.data.id);
      break;
    case "session:activity":
      reactSteer(ev.data.id);
      break;
    case "epic:update":
      reactEpic(ev.data.repoPath, ev.data.parentIssueNumber);
      break;
    case "session:new":
      reactSpawn(ev.data.id);
      break;
    case "session:archived":
      stopAmbient(ev.data.id);
      break;
  }
}

/** Clear every pending timer + ambient-loop bookkeeping (no lifecycle flag change). */
function clearTimers(): void {
  for (const t of timers) clearTimeout(t);
  timers.clear();
  ambientLoops.clear();
}

/** Reset hook (registered once): drop the previous run's timers and restart ambient
 *  for the freshly re-seeded working set. Bus reactions stay subscribed. */
function onReset(): void {
  if (!enabled) return;
  clearTimers();
  startAmbientWorkingSet();
}

export const director = {
  /** Idempotent: subscribe to the bus for reactions, register the reset hook (once),
   *  and begin ambient loops for the current working set. */
  start(): void {
    if (enabled) return;
    enabled = true;
    if (!resetRegistered) {
      demoState.onReset(onReset);
      resetRegistered = true;
    }
    busUnsub = bus.subscribe(onBusEvent);
    startAmbientWorkingSet();
  },

  /** Tear down: clear every timer and unsubscribe from the bus — leave nothing running. */
  stopAll(): void {
    enabled = false;
    clearTimers();
    if (busUnsub) {
      busUnsub();
      busUnsub = null;
    }
  },
};
