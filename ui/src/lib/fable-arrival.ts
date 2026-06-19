// Decision logic for the one-time "Fable has arrived" hero, extracted so it can
// be unit-tested without mounting the whole +page route.
//
// The flip to show the hero is deferred until settings load (so it can honor
// `fableAvailable`), but `loadSettings()` also re-fires on tab return — a
// persisting eligibility flag would therefore re-show the hero after the user
// dismissed it. This helper makes the decision ONE-SHOT (eligibility is
// consumed) and re-checks `seen`, so a dismissed or already-seen arrival never
// reappears.

export interface FableArrivalDecision {
  /** Next value for the caller's eligibility flag (always consumed to false). */
  eligible: boolean;
  /** Whether to show the hero now. */
  show: boolean;
}

/**
 * @param eligible       current eligibility (set true once in onMount when the
 *                       feature entry is present and unseen)
 * @param seen           whether the arrival was already seen/dismissed
 * @param fableAvailable the loaded `fableAvailable` setting (undefined ⇒ treat
 *                       as available, matching the "no flag" default)
 */
export function resolveFableArrival(
  eligible: boolean,
  seen: boolean,
  fableAvailable: boolean | undefined,
): FableArrivalDecision {
  if (!eligible) return { eligible: false, show: false };
  return { eligible: false, show: !seen && fableAvailable !== false };
}
