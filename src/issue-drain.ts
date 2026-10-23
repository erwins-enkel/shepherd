import { ACTIVE_LABEL, PRIORITY_LABEL } from "./drain-core";
import type { GitForge, Issue } from "./forge/types";

/** The narrow payload shared by the operator route and Assistant action. */
export type IssueDrainOperation =
  | { operation: "queue"; enabled: boolean }
  | { operation: "priority"; priority: "high" | "normal" | "low" }
  | { operation: "release" };

export function parseIssueDrainOperation(raw: unknown): IssueDrainOperation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const keys = Object.keys(a);
  if (a.operation === "queue" && keys.length === 2 && typeof a.enabled === "boolean")
    return { operation: "queue", enabled: a.enabled };
  if (
    a.operation === "priority" &&
    keys.length === 2 &&
    (a.priority === "high" || a.priority === "normal" || a.priority === "low")
  )
    return { operation: "priority", priority: a.priority };
  if (a.operation === "release" && keys.length === 1) return { operation: "release" };
  return null;
}

export const LOW_PRIORITY_LABEL = "shepherd:low-priority";

/** Only scalars and fixed markers reach the Assistant; issue prose is untrusted. */
export function issueDrainState(issue: Issue, autoLabel: string) {
  return {
    issueNumber: issue.number,
    state: issue.state ?? null,
    queued: issue.labels.includes(autoLabel),
    claimed: issue.labels.includes(ACTIVE_LABEL),
    priority: issue.labels.includes(PRIORITY_LABEL)
      ? "high"
      : issue.labels.includes(LOW_PRIORITY_LABEL)
        ? "low"
        : "normal",
    priorityLabels: [PRIORITY_LABEL, LOW_PRIORITY_LABEL].filter((l) => issue.labels.includes(l)),
  };
}

/** Apply only the selected markers. The caller owns capability and claim-release guards. */
export async function applyIssueDrainLabels(
  forge: GitForge,
  issue: Issue,
  autoLabel: string,
  operation: IssueDrainOperation,
): Promise<Issue> {
  const labels = new Set(issue.labels);
  const remove: string[] = [];
  const add: string[] = [];
  if (operation.operation === "queue") {
    (operation.enabled ? add : remove).push(autoLabel);
  } else if (operation.operation === "priority") {
    remove.push(PRIORITY_LABEL, LOW_PRIORITY_LABEL);
    if (operation.priority !== "normal")
      add.push(operation.priority === "high" ? PRIORITY_LABEL : LOW_PRIORITY_LABEL);
  } else {
    remove.push(ACTIVE_LABEL);
  }
  for (const label of remove.filter((label) => labels.has(label) && !add.includes(label))) {
    await forge.removeIssueLabel!(issue.number, label);
    labels.delete(label);
  }
  for (const label of add.filter((label) => !labels.has(label))) {
    await forge.addIssueLabel!(issue.number, label);
    labels.add(label);
  }
  return { ...issue, labels: [...labels] };
}
