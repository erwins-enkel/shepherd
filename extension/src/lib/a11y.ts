import type { A11yFinding } from "./signals";

/** Minimal shape of the axe-core results we read (axe types not imported). */
interface AxeNode {
  target?: unknown[];
}
interface AxeViolation {
  id?: string;
  impact?: string | null;
  help?: string;
  nodes?: AxeNode[];
}
export interface AxeResults {
  violations?: AxeViolation[];
}

const IMPACT_ORDER: Record<A11yFinding["impact"], number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
  unknown: 4,
};
const MAX_FINDINGS = 20;
const MAX_SELECTORS = 3;

function normImpact(v: string | null | undefined): A11yFinding["impact"] {
  if (v === "critical" || v === "serious" || v === "moderate" || v === "minor") return v;
  return "unknown";
}

/** Summarize raw axe results into compact, capped findings sorted critical→minor. */
export function summarizeAxeResults(raw: AxeResults): A11yFinding[] {
  return (raw.violations ?? [])
    .map((v): A11yFinding => {
      const nodes = v.nodes ?? [];
      const sampleSelectors = nodes
        .slice(0, MAX_SELECTORS)
        .map((n) => (Array.isArray(n.target) ? n.target.join(" ") : ""))
        .filter((s) => s !== "");
      return {
        id: v.id ?? "unknown",
        impact: normImpact(v.impact),
        help: v.help ?? "",
        nodeCount: nodes.length,
        sampleSelectors,
      };
    })
    .sort((a, b) => IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact])
    .slice(0, MAX_FINDINGS);
}
