import type { Session } from "$lib/types";

/** One comparison experiment: the same-prompt variant runs + an optional comparison session. */
export type ExperimentGroup = {
  experimentId: string;
  /** Headline derived from a member's name (variants share the original's prompt → same name). */
  label: string;
  variants: Session[];
  comparison: Session | null;
};

/**
 * Partition sessions into comparison-experiment groups + the rest. Mirrors `groupSessionsByEpic`:
 * grouped sessions are pulled OUT so the caller can render them under one header, and the `rest`
 * flows into the normal lifecycle partition. A group needs ≥2 visible variants (or a comparison
 * session) to be worth grouping — a lone surviving variant falls back into `rest`.
 */
export function groupSessionsByExperiment(sessions: Session[]): {
  groups: ExperimentGroup[];
  rest: Session[];
} {
  const byId = new Map<string, Session[]>();
  const rest: Session[] = [];
  for (const s of sessions) {
    if (s.experimentId) {
      const arr = byId.get(s.experimentId) ?? [];
      arr.push(s);
      byId.set(s.experimentId, arr);
    } else {
      rest.push(s);
    }
  }

  const groups: ExperimentGroup[] = [];
  for (const [experimentId, members] of byId) {
    const variants = members
      .filter((m) => m.experimentRole === "variant")
      .sort((a, b) => a.createdAt - b.createdAt);
    const comparison = members.find((m) => m.experimentRole === "comparison") ?? null;
    // Not a meaningful comparison set (e.g. only one variant still visible) → leave in the flow.
    if (variants.length < 2 && !comparison) {
      rest.push(...members);
      continue;
    }
    groups.push({
      experimentId,
      label: variants[0]?.name ?? members[0]!.name,
      variants,
      comparison,
    });
  }
  groups.sort((a, b) => (a.variants[0]?.createdAt ?? 0) - (b.variants[0]?.createdAt ?? 0));
  return { groups, rest };
}
