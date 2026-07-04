import type { CompletedEpic } from "$lib/types";

/**
 * Which plain-language line the "Integrated epics" band shows in the collapsed-footer
 * (non-`open`) state. Kept as a pure function so every (landingState × merged-count)
 * combination is unit-testable — the real `none` state rarely reproduces on a branch backend.
 *
 * Only `opening` / `nothing-merged` / `nothing-to-land` are ever rendered by the footer
 * (IntegratedEpicLanding's final `!isOpen` branch); `open` / `landed` / `error` are returned
 * for totality but handled by their own dedicated UI (Land CTA, `landing_pr_merged`,
 * `landing_failed`) — the footer never asks for them.
 */
export type FooterSituation =
  "open" | "landed" | "error" | "opening" | "nothing-merged" | "nothing-to-land";

export function deriveFooterSituation(
  epic: Pick<CompletedEpic, "landingState" | "children">,
): FooterSituation {
  switch (epic.landingState) {
    case "open":
      return "open";
    case "merged":
      return "landed";
    case "error":
      return "error";
    case "pending":
      return "opening";
    // "none" (and any other terminal state): the epic completed but there is nothing to land.
    // Distinguish "Shepherd merged nothing" from "landed work netted to nothing", but assert NO
    // cause — `none` also arises from a human closing the landing PR unmerged, so reason-free copy
    // is the whole point (a confident-but-wrong line is the defect this band is fixing).
    default: {
      const merged = epic.children.filter((c) => c.integrated).length;
      return merged === 0 ? "nothing-merged" : "nothing-to-land";
    }
  }
}
