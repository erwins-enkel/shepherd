// Fable 5 launch window.
//
// During the window the New Task picker defaults to Fable so the new top tier is
// front-and-center. After it, the picker reverts to the prior default ("default"
// = claude's own model, no --model flag) so the premium tier — Fable costs more
// per token than Opus — is never left selected by default and quietly running up
// spend. Fable stays selectable from the picker at all times; only the *default*
// selection is time-gated.
//
// Cutoff is end-of-day June 22, 2026 in Berlin (CEST, UTC+2) — inclusive.
export const FABLE_PROMO_UNTIL = new Date("2026-06-22T23:59:59+02:00");

/** The New Task picker's default model selection, time-gated by the promo window.
 *  `now` is injectable for tests. */
export function defaultModel(now: Date = new Date()): "fable" | "default" {
  return now.getTime() <= FABLE_PROMO_UNTIL.getTime() ? "fable" : "default";
}
