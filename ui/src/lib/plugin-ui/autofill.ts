// Autofill guard for every plugin-ui input node (issue #1978).
//
// A plugin panel is a CONFIGURATION surface: none of its fields is ever a credential the
// browser should remember or replay. Left unguarded, a panel that puts a `secret: true` field
// next to a plain one reproduces the exact shape a password manager hunts for — a password box
// plus an adjacent text box — and fills the text box with the stored USERNAME. Observed in
// buzz-bridge: an `npub1…` (the public half of the very credential whose secret half is the
// key) landed in `key env var`, a field that holds the NAME of an environment variable, and the
// plugin's own validator accepted it because an npub satisfies every POSIX name rule.
//
// No single lever covers every filler, so the guard is three layers:
//
//   1. `autocomplete` — the platform signal. Honoured unevenly, and Chromium ignores it
//      outright on `type="password"`. Applied by each component, NOT returned here (see below).
//   2. A non-guessable `name` — these controls used to render with NO name at all, which leaves
//      a heuristic falling back to the label/placeholder text. A meaningless per-instance token
//      gives it something stable and inert to latch onto instead.
//   3. Per-manager opt-out attributes — the only thing 1Password / Bitwarden / LastPass /
//      Dashlane / Proton Pass actually obey. Each vendor invented its own; there is no standard
//      and no negotiation, so all five ship together.
//
// None of this is a spec guarantee — it is the documented behaviour of the fillers that exist.
// A manager honouring none of these conventions is not defeated by anything the platform offers.

/** The vendor opt-outs, one per password manager that publishes one. A bare HTML attribute
 *  serialises as `=""`, so the empty values here are exactly what each vendor documents. */
const IGNORE = {
  "data-1p-ignore": "", // 1Password
  "data-bwignore": "", // Bitwarden
  "data-lpignore": "true", // LastPass
  "data-form-type": "other", // Dashlane
  "data-protonpass-ignore": "", // Proton Pass
} as const;

/** Attributes that make one plugin-ui control invisible to autofill.
 *
 *  Call ONCE per component instance, never inside `$derived`: the generated `name` must stay
 *  frozen for the control's lifetime, and a plugin re-publishing its panel on a timer would
 *  otherwise churn it on every render for nothing.
 *
 *  The rendered `name` is deliberately DECORATIVE — nothing reads it. The value a control
 *  submits is keyed on the plugin's own `name` prop through the form scope (see
 *  `field.svelte.ts`), so scrambling the DOM name costs the submit contract nothing.
 *
 *  `autocomplete` is deliberately NOT included. `PuiTextInput` needs `new-password` when the
 *  field is `secret` and `off` otherwise — and `secret` is reactive, so a re-publish can flip
 *  it — while `PuiCheckbox` needs none at all, the attribute not applying to `type="checkbox"`.
 *  Each component states its own.
 */
export function noAutofill(): Record<string, string> {
  // `getRandomValues`, NOT `randomUUID`: the latter is gated to secure contexts, so it is
  // `undefined` over plain http and would throw here — crashing the whole panel for the sake
  // of a name nothing reads. This one carries no such restriction, so no fallback branch is
  // needed for a case that would otherwise be very easy to ship broken.
  const token = [...crypto.getRandomValues(new Uint8Array(4))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { name: `pui-${token}`, ...IGNORE };
}
