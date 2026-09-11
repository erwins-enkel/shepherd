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
  /** True when a model is actually KNOWN (observed or configured), false when `model` is only the
   *  localized "default" standing in for one. Distinct from {@link modelObserved}, which says where
   *  a known value came from. Read by {@link modelsMixed}, so the precedence below stays in one
   *  place instead of being re-derived by every caller that needs to know. */
  modelKnown: boolean;
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
 * The model segment's label, observed → configured → the honest "default".
 *
 * Its own function rather than a ternary chain inside the resolver below: that chain plus the
 * per-field provenance bookkeeping put `sessionEnvironment` over the repo's cognitive-complexity
 * bar. The labeling split matters — see {@link sessionEnvironment} on why observed and configured
 * values must not share one vocabulary.
 */
function modelSegment(observed: string | null, configured: string | null): string {
  if (observed) return runtimeModelLabel(observed);
  if (configured) return modelLabel(configured);
  return m.newtask_model_default();
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

  const model = modelSegment(observedModel, configuredModel);
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
    modelKnown: !!(observedModel ?? configuredModel),
    effort: effortKnown ? effort : null,
    effortObserved,
    // The model segment always stands, so the operator can always see which model a task ran on;
    // the effort segment joins it only when there is something concrete to say. Dropping an unknown
    // effort is exactly what keeps a fully-unknown environment from printing the same word twice.
    segments: effortKnown ? [model, effort] : [model],
    tooltip: sentences.join(" "),
  };
}

/**
 * Do the sessions on display run MORE THAN ONE model?
 *
 * The session list prints each row's model, which is only worth the line when the rows differ:
 * a herd where every session ran the same model repeats one word down the whole rail and tells
 * the operator nothing. Callers gate the model segment on this.
 *
 * Two rules, both deliberate:
 *
 *   - **The comparison is over the WHOLE visible list**, so every row agrees — either all of them
 *     print their model or none does. Deciding per group would show the same model in one group
 *     and hide it in the next, and a row would gain or lose its label just by moving between
 *     lifecycle stages.
 *   - **Sessions with no known model do not count.** Their label is the localized "default", which
 *     says only that we never learned what ran; letting that stand as a distinct value would call
 *     almost every list mixed and leave the label permanently on.
 *
 * "Same model" means the same rendered LABEL, not the same underlying id: a configured floating
 * alias (`opus`, never run) reads differently from an observed `Opus 5` and genuinely looks like a
 * second model on screen. The client cannot know which concrete model an alias resolved to, so
 * folding the two together would be a guess.
 */
export function modelsMixed(
  sessions: readonly Pick<Session, "id" | "model" | "effort" | "runtimeModel" | "runtimeEffort">[],
  activity: Record<string, SessionActivity>,
): boolean {
  const labels = new Set<string>();
  for (const session of sessions) {
    const env = sessionEnvironment(session, activity[session.id]);
    if (!env.modelKnown) continue;
    labels.add(env.model);
    if (labels.size > 1) return true;
  }
  return false;
}

/**
 * Do the sessions on display run MORE THAN ONE coding CLI?
 *
 * The rail marks each row with its CLI. Like the model segment above, that chip is worth its space
 * only when the rows differ: an operator running Claude across the board reads the same word on
 * every card and learns nothing from it. Same two-rule shape as {@link modelsMixed} — decided over
 * the whole visible list so every row agrees — with one difference: a provider is never unknown.
 * An absent `agentProvider` is a pre-field row, which was Claude, so it counts as Claude rather
 * than as a second CLI. That default MUST match the one CliBadge renders with, or a pre-field row
 * would turn the chips on for a herd that is in fact all-Claude.
 */
export function providersMixed(sessions: readonly Pick<Session, "agentProvider">[]): boolean {
  const providers = new Set<string>();
  for (const session of sessions) {
    providers.add(session.agentProvider ?? "claude");
    if (providers.size > 1) return true;
  }
  return false;
}
