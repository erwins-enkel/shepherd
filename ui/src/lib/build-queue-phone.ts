import type { BuildStep } from "./types";

/** The step the collapsed phone bar names on its second line: the running step,
 *  else the next pending one, else none (all resolved / empty). */
export function focusStep(steps: readonly BuildStep[]): BuildStep | null {
  return (
    steps.find((s) => s.status === "active") ?? steps.find((s) => s.status === "pending") ?? null
  );
}

/** Whether the panel renders. On a phone a queue with steps stays visible as its
 *  collapsed bar even under the folded session details; an empty queue keeps the
 *  fold rule so it never spends a row on nothing. */
export function panelVisible(o: {
  phone: boolean;
  enabled: boolean;
  stepCount: number;
  folded: boolean;
  actionable: boolean;
  acting: boolean;
}): boolean {
  if (o.acting) return true;
  if (!o.enabled && o.stepCount === 0) return false;
  if (o.phone && o.stepCount > 0) return true;
  return !o.folded || o.actionable;
}
