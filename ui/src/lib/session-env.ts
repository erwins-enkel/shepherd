import { m } from "$lib/paraglide/messages";
import { modelLabel, runtimeModelLabel } from "$lib/model-label";
import { effortLabel } from "$lib/effort-guidance";
import type { Session, SessionActivity } from "$lib/types";

/** A session's coding environment, resolved for display. `segments` is what a `·`-joined line should
 *  print after the task id — one entry when nothing concrete is known, two when it is. */
export interface SessionEnvironment {
  /** Model segment; the localized "default" when neither an observed nor a configured value exists. */
  model: string;
  /** True when `model` is what the agent was OBSERVED to run, false when it is the configured value
   *  (or the default standing in for one). */
  modelObserved: boolean;
  /** Effort segment, or null when it is not worth its own segment (see {@link segments}). */
  effort: string | null;
  /** True when `effort` is observed rather than configured. Always false for Claude sessions, whose
   *  transcripts record no effort at all. */
  effortObserved: boolean;
  segments: string[];
  /** Ready-to-show explanation: one complete sentence per rendered segment, each naming where THAT
   *  segment came from. Both session surfaces show this verbatim. */
  tooltip: string;
}

/**
 * Resolve what a session's model and effort should read as.
 *
 * Precedence is observed → configured → default, per field and independently:
 *   1. `activity.runtime*` — the live SSE signal, freshest while a session runs.
 *   2. `session.runtime*` — the same thing persisted, so it survives idle + restart (#1823).
 *   3. `session.model` / `session.effort` — what the operator CONFIGURED. Null whenever the pickers
 *      were left on default, in which case no flag is passed and the CLI chooses for itself.
 *   4. The localized "default", which honestly means "we never learned what ran".
 *
 * Observed values are labeled with `runtimeModelLabel` (concrete provider ids like `gpt-6-astra`)
 * and configured ones with `modelLabel` (spawn-time aliases); mixing the two would relabel an
 * already-run session.
 *
 * **Provenance is per FIELD, and so is the tooltip.** A mixed identity is the NORMAL case, not an
 * edge one: `claudeRuntimeIdentity()` only ever reports a model, so an ordinary Claude session has
 * an observed model beside a configured effort. One flag covering both segments would let the
 * tooltip claim the runtime log named a value it never mentioned, so each segment carries its own
 * sentence saying where it came from.
 *
 * **Never two identical default labels.** With both fields unknown, the model and effort segments
 * would both render the same localized "default" word, which says nothing twice. `segments` then
 * collapses to a single entry standing for the whole environment.
 */
export function sessionEnvironment(
  session: Pick<Session, "model" | "effort" | "runtimeModel" | "runtimeEffort">,
  activity?: SessionActivity,
): SessionEnvironment {
  const observedModel = activity?.runtimeModel ?? session.runtimeModel ?? null;
  const observedEffort = activity?.runtimeEffort ?? session.runtimeEffort ?? null;
  const configuredModel = session.model ?? null;
  const configuredEffort = session.effort ?? null;

  const model = observedModel
    ? runtimeModelLabel(observedModel)
    : configuredModel
      ? modelLabel(configuredModel)
      : m.newtask_model_default();
  const knownEffort = observedEffort ?? configuredEffort;
  const effort = knownEffort ? effortLabel(knownEffort) : m.effort_default();

  const modelObserved = !!observedModel;
  const effortObserved = !!observedEffort;
  const effortKnown = !!knownEffort;

  // One complete sentence per rendered segment — never assembled from fragments, so both locales
  // keep their own word order. An unknown effort renders no segment and gets no sentence: saying
  // nothing about it is the honest option when nothing is known.
  const sentences = [
    modelObserved
      ? m.session_env_model_observed({ model })
      : m.session_env_model_configured({ model }),
    ...(effortKnown
      ? [
          effortObserved
            ? m.session_env_effort_observed({ effort })
            : m.session_env_effort_configured({ effort }),
        ]
      : []),
  ];

  return {
    model,
    modelObserved,
    effort: effortKnown ? effort : null,
    effortObserved,
    // The model segment always stands, so the operator can always see which model a task ran on;
    // the effort segment joins it only when there is something concrete to say. Dropping an unknown
    // effort is exactly what keeps a fully-unknown environment from printing the same word twice.
    segments: effortKnown ? [model, effort] : [model],
    tooltip: sentences.join(" "),
  };
}
