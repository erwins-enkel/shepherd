import { m } from "$lib/paraglide/messages";
import { modelLabel, runtimeModelLabel } from "$lib/model-label";
import { effortLabel } from "$lib/effort-guidance";
import type { Session, SessionActivity } from "$lib/types";

/** A session's coding environment, resolved for display. `segments` is what a `·`-joined line should
 *  print after the task id — one entry when nothing concrete is known, two when it is. */
export interface SessionEnvironment {
  /** Model segment; the localized "default" when neither an observed nor a configured value exists. */
  model: string;
  /** Effort segment, or null when it is not worth its own segment (see {@link segments}). */
  effort: string | null;
  /** True when at least one segment comes from what the agent was OBSERVED to run, rather than from
   *  what the operator configured — drives which explanatory tooltip a surface shows. */
  observed: boolean;
  segments: string[];
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

  const effortKnown = !!knownEffort;
  return {
    model,
    effort: effortKnown ? effort : null,
    observed: !!(observedModel || observedEffort),
    // The model segment always stands, so the operator can always see which model a task ran on;
    // the effort segment joins it only when there is something concrete to say. Dropping an unknown
    // effort is exactly what keeps a fully-unknown environment from printing the same word twice.
    segments: effortKnown ? [model, effort] : [model],
  };
}
