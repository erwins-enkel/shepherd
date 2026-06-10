// Fable 5 launch window.
//
// During the window the New Task picker defaults to Fable. This is a DELIBERATE,
// operator-requested launch-window choice: new tasks default to the most
// expensive tier (Fable costs more per token than Opus) unless the user picks
// another model. That in-window spend is the accepted, time-boxed cost of
// showcasing the new top tier — it is exactly why the window has a hard cutoff.
//
// After the cutoff the picker reverts to the prior default ("default" = claude's
// own model, no --model flag), so the premium tier is NOT left as the standing
// default and quietly running up spend indefinitely. Fable stays selectable from
// the picker at all times; only the *default* selection is time-gated.
//
// Cutoff is end-of-day June 22, 2026 in Berlin (CEST, UTC+2) — inclusive.
export const FABLE_PROMO_UNTIL = new Date("2026-06-22T23:59:59+02:00");

/** The New Task picker's client-side promo default, time-gated by the launch window.
 *  `now` is injectable for tests. */
export function promoDefaultModel(now: Date = new Date()): "fable" | "default" {
  return now.getTime() <= FABLE_PROMO_UNTIL.getTime() ? "fable" : "default";
}
