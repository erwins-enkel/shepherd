/**
 * Endless animations come to rest when nothing is happening (#3035). Shepherd sits open for days
 * as a HUD; a single running pulse keeps the compositor (and the OS window server) producing
 * frames forever. So after `idleMs` without input or a status change, every running infinite
 * animation is cancelled — it shows its static base style, the status colour stays — and any
 * input or status change plays them again for another `idleMs`.
 *
 * Only infinite animations are touched: one-shot ones (entrances, toast countdowns) finish on
 * their own. Animations inside an in-flight action (`aria-busy`) or an open modal keep running,
 * since the operator is waiting on exactly that. While settled, a rescan every `idleMs` catches
 * infinite animations that started since.
 */
const SETTLE_IDLE_MS = 15_000;

/** Store events that change what a pulse signals; each one wakes the motion (HerdStore.apply).
 *  High-frequency events (activity, plugin, drain, usage) are deliberately absent — they would
 *  keep everything awake. */
const MOTION_WAKE_EVENTS: ReadonlySet<string> = new Set([
  "session:new",
  "session:archived",
  "session:status",
  "session:ready",
  "session:block",
  "session:hold",
  "session:halt",
  "session:merging",
  "session:reviewing",
  "session:review",
  "session:plangate",
  "session:plangate-reviewing",
  "session:working-blocked",
  "session:login-request",
  "session:git",
]);

const EXEMPT = '[aria-busy="true"], dialog[open], .overlay';
const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "focus"];

export interface MotionSettle {
  /** Install the input listeners and arm the idle timer. Returns a disposer. */
  start(): () => void;
  /** Something happened: play rested animations again and restart the idle period. */
  wake(): void;
  readonly settled: boolean;
}

function effectOf(a: Animation): KeyframeEffect | null {
  return a.effect instanceof KeyframeEffect ? a.effect : null;
}

const nameOf = (a: Animation) => (a as CSSAnimation).animationName as string | undefined;

/**
 * Whether a cancelled animation may be played again. A cancelled CSS animation no longer follows
 * its rule, so play() would revive it even after the rule stopped applying (a pip that went idle
 * would pulse again) or duplicate the fresh animation the rule created since.
 */
function stillWanted(a: Animation, live: Animation[]): boolean {
  const effect = effectOf(a);
  const target = effect?.target;
  if (!target?.isConnected) return false;
  const name = nameOf(a);
  if (name === undefined) return true; // a script animation: no rule to consult
  const pseudo = effect!.pseudoElement;
  const styled = getComputedStyle(target, pseudo).animationName.split(/,\s*/);
  if (!styled.includes(name)) return false;
  return !live.some((b) => {
    const e = effectOf(b);
    return e?.target === target && e.pseudoElement === pseudo && nameOf(b) === name;
  });
}

export function createMotionSettle({
  idleMs = SETTLE_IDLE_MS,
}: { idleMs?: number } = {}): MotionSettle {
  let started = false;
  let settled = false;
  let lastWake = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resting: Animation[] = [];

  const arm = (ms: number) => {
    timer = setTimeout(onTimer, ms);
  };

  const settle = () => {
    settled = true;
    for (const a of document.getAnimations()) {
      if (a.playState !== "running") continue;
      const effect = effectOf(a);
      if (effect?.getComputedTiming().iterations !== Infinity) continue;
      if (effect.target?.closest(EXEMPT)) continue;
      a.cancel();
      resting.push(a);
    }
  };

  function onTimer() {
    timer = null;
    const quiet = Date.now() - lastWake;
    // Woken since this timer was armed: wait out the rest of the idle period first.
    if (!settled && quiet < idleMs) return arm(idleMs - quiet);
    settle();
    arm(idleMs);
  }

  const wake = () => {
    if (!started) return;
    lastWake = Date.now();
    if (!settled) return; // the armed timer re-arms itself for the remainder
    settled = false;
    const live = document.getAnimations();
    for (const a of resting) if (stillWanted(a, live)) a.play();
    resting = [];
    if (timer) clearTimeout(timer);
    arm(idleMs);
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") wake();
  };

  const api: MotionSettle = {
    start() {
      started = true;
      lastWake = Date.now();
      for (const type of INPUT_EVENTS)
        window.addEventListener(type, wake, { capture: true, passive: true });
      document.addEventListener("visibilitychange", onVisibility);
      arm(idleMs);
      return () => {
        wake(); // leave nothing cancelled behind
        started = false;
        if (timer) clearTimeout(timer);
        timer = null;
        for (const type of INPUT_EVENTS) window.removeEventListener(type, wake, { capture: true });
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
    wake,
    get settled() {
      return settled;
    },
  };
  return api;
}

/** The app-wide instance: started by the root layout, woken by the store on status events. */
export const motionSettle = createMotionSettle();

/** Wake the app-wide instance when a pushed event changes what a pulse signals. */
export function wakeMotionOn(event: string): void {
  if (MOTION_WAKE_EVENTS.has(event)) motionSettle.wake();
}
